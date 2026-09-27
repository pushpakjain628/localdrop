//! Fan-out of server events to the Windows dashboard.
//!
//! A `tokio::broadcast` channel is the right shape here: N dashboard tabs subscribe, slow
//! subscribers drop the oldest events rather than stalling an in-flight upload, and the
//! upload path never blocks on a UI that is minimised.

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::broadcast;

use crate::protocol::ServerEvent;

/// Events buffered per subscriber before the oldest are dropped.
const CHANNEL_CAPACITY: usize = 256;

#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<ServerEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        EventBus { sender }
    }

    /// Publishes an event. Never fails: with no subscribers the send is simply dropped.
    pub fn publish(&self, event: ServerEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.sender.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Now, formatted the way the protocol expects.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// A running transfer's progress, used both for events and for the `/api/stats` payload.
#[derive(Debug, Clone)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub bytes_received: u64,
    pub total_bytes: u64,
    pub bytes_per_second: f64,
}

impl TransferProgress {
    pub fn percent(&self) -> f64 {
        if self.total_bytes == 0 {
            return 0.0;
        }
        ((self.bytes_received as f64 / self.total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    }

    /// Seconds left at the current rate, or `None` while the rate is still unknown.
    pub fn eta_seconds(&self) -> Option<f64> {
        if self.bytes_per_second <= 0.0 {
            return None;
        }
        let remaining = self.total_bytes.saturating_sub(self.bytes_received);
        Some(remaining as f64 / self.bytes_per_second)
    }
}

/// Smoothed transfer rate.
///
/// A raw instantaneous rate makes the dashboard number jump wildly, and the very first
/// sample after a connection is made is always misleadingly high. An EWMA over a short window
/// gives a number a human can read while still reacting within a couple of seconds.
#[derive(Debug)]
pub struct RateMeter {
    last_bytes: u64,
    last_at: Option<std::time::Instant>,
    smoothed_bps: f64,
}

const EWMA_ALPHA: f64 = 0.3;

impl Default for RateMeter {
    fn default() -> Self {
        RateMeter::new()
    }
}

impl RateMeter {
    pub fn new() -> Self {
        RateMeter {
            last_bytes: 0,
            last_at: None,
            smoothed_bps: 0.0,
        }
    }

    /// Feeds a new cumulative byte count and returns the smoothed rate in bytes/second.
    pub fn sample(&mut self, bytes: u64) -> f64 {
        let now = std::time::Instant::now();
        let Some(last_at) = self.last_at else {
            self.last_at = Some(now);
            self.last_bytes = bytes;
            return 0.0;
        };
        let elapsed = now.duration_since(last_at).as_secs_f64();
        if elapsed <= 0.0 {
            return self.smoothed_bps;
        }
        let delta = bytes.saturating_sub(self.last_bytes);
        self.last_at = Some(now);
        self.last_bytes = bytes;
        if delta == 0 {
            return self.smoothed_bps;
        }
        let instant = delta as f64 / elapsed;
        self.smoothed_bps = if self.smoothed_bps <= 0.0 {
            instant
        } else {
            EWMA_ALPHA * instant + (1.0 - EWMA_ALPHA) * self.smoothed_bps
        };
        self.smoothed_bps
    }

    pub fn current(&self) -> f64 {
        self.smoothed_bps
    }
}

pub type SharedEventBus = Arc<EventBus>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn publishes_to_a_subscriber() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(ServerEvent::ServerStarted {
            server_name: "PC".into(),
            backup_directory: "D:/backup".into(),
            at: now_iso(),
        });
        match rx.recv().await.unwrap() {
            ServerEvent::ServerStarted { server_name, .. } => assert_eq!(server_name, "PC"),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn publishing_with_no_subscribers_is_not_an_error() {
        let bus = EventBus::new();
        bus.publish(ServerEvent::StatsChanged {
            stats: Default::default(),
            at: now_iso(),
        });
    }

    #[tokio::test]
    async fn every_subscriber_receives_the_event() {
        let bus = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 2);
        bus.publish(ServerEvent::ClientDisconnected {
            device_name: "iPhone".into(),
            device_id: "d1".into(),
            at: now_iso(),
        });
        assert!(a.recv().await.is_ok());
        assert!(b.recv().await.is_ok());
    }

    #[test]
    fn progress_percent_and_eta() {
        let p = TransferProgress {
            transfer_id: "t".into(),
            bytes_received: 500,
            total_bytes: 1000,
            bytes_per_second: 100.0,
        };
        assert_eq!(p.percent(), 50.0);
        assert_eq!(p.eta_seconds(), Some(5.0));
    }

    #[test]
    fn progress_handles_unknown_total_and_rate() {
        let p = TransferProgress {
            transfer_id: "t".into(),
            bytes_received: 10,
            total_bytes: 0,
            bytes_per_second: 0.0,
        };
        assert_eq!(p.percent(), 0.0);
        assert_eq!(p.eta_seconds(), None);
    }

    #[test]
    fn progress_clamps_beyond_total() {
        let p = TransferProgress {
            transfer_id: "t".into(),
            bytes_received: 1200,
            total_bytes: 1000,
            bytes_per_second: 1.0,
        };
        assert_eq!(p.percent(), 100.0);
    }

    #[test]
    fn rate_meter_starts_at_zero() {
        let mut meter = RateMeter::new();
        assert_eq!(meter.sample(0), 0.0);
    }

    #[test]
    fn rate_meter_smooths_and_converges() {
        let mut meter = RateMeter::new();
        meter.sample(0);
        // Force a measurable interval between samples.
        std::thread::sleep(Duration::from_millis(20));
        let first = meter.sample(1_000_000);
        assert!(
            first > 0.0,
            "a real byte delta over 20ms must produce a rate"
        );

        std::thread::sleep(Duration::from_millis(20));
        let second = meter.sample(1_000_000);
        // No new bytes: the smoothed value must be retained rather than dropping to zero.
        assert_eq!(second, meter.current());
        assert!(second > 0.0);
    }

    #[test]
    fn rate_meter_retains_its_value_when_no_new_bytes_arrive() {
        let mut meter = RateMeter::new();
        meter.sample(0);
        std::thread::sleep(Duration::from_millis(20));
        let measured = meter.sample(1_000_000);
        assert!(measured > 0.0);

        // A stall in the middle of a transfer must show the last known rate rather than
        // dropping the dashboard's number to zero.
        std::thread::sleep(Duration::from_millis(20));
        let stalled = meter.sample(1_000_000);
        assert_eq!(stalled, measured);
        assert_eq!(meter.current(), measured);
    }

    #[test]
    fn rate_meter_never_reports_a_negative_rate() {
        let mut meter = RateMeter::new();
        meter.sample(1_000_000);
        // A counter reset (a new transfer reusing the meter) must not produce a negative rate.
        let rate = meter.sample(0);
        assert!(rate >= 0.0, "rate went negative: {rate}");
    }
}
