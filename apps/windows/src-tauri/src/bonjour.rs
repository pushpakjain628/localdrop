//! Bonjour/mDNS advertisement.
//!
//! Without this the iPhone has no way to find the PC on the LAN except by the user reading an
//! IP address off the screen, which is exactly the friction this product exists to remove. The
//! service is advertised as `_localdrop._tcp` with a TXT record carrying the name, port and
//! protocol version, so the phone can decide whether a discovered server is even compatible
//! before it opens a socket to it.
//!
//! If advertisement fails - a network that blocks multicast, a VPN that hijacks the interface -
//! the server still runs. The phone's manual IP entry is the fallback for that case, so a
//! failure here is logged and swallowed rather than fatal.

use mdns_sd::{ServiceDaemon, ServiceInfo};

use crate::protocol::{APP_VERSION, PRODUCT_NAME, PROTOCOL_VERSION};

/// Must match `BONJOUR_SERVICE_TYPE` in the shared contract and `LocalDropDiscovery.swift`.
const SERVICE_TYPE: &str = "_localdrop._tcp";

/// Domain for a link-local service.
const DOMAIN: &str = "local.";

/// Placeholder address that tells `mdns-sd` to publish every interface on this machine.
const AUTO_ADDRESS: &str = "0.0.0.0";

/// Keeps the registration alive for as long as the app runs.
///
/// Dropping this unregisters the service, which is why `lib.rs` holds it for the whole process
/// rather than discarding the result.
pub struct Advertisement {
    _daemon: ServiceDaemon,
}

impl Advertisement {
    /// Starts advertising this server. Returns `None` when the network would not allow it.
    pub fn start(server_name: &str, port: u16, backup_directory: &str) -> Option<Self> {
        let daemon = match ServiceDaemon::new() {
            Ok(daemon) => daemon,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not start the mDNS responder - iPhone users will need to enter this PC's address manually"
                );
                return None;
            }
        };

        // `ServiceInfo` owns its properties, so the values are bound to locals that outlive the
        // call. The TXT record lets the phone reject an incompatible server before opening a
        // socket, and show the library folder in its device list.
        let port_text = port.to_string();
        let protocol_text = PROTOCOL_VERSION.to_string();
        let properties: Vec<(&str, &str)> = vec![
            ("port", port_text.as_str()),
            ("protocolVersion", protocol_text.as_str()),
            ("appVersion", APP_VERSION),
            ("fullName", PRODUCT_NAME),
            ("library", backup_directory),
        ];

        // `0.0.0.0` tells `mdns-sd` to publish every non-loopback IPv4 address on this machine,
        // which is what we want: a desktop with a wired and a Wi-Fi adapter should be reachable
        // on both. A VPN adapter would also be published, but the phone resolves the name to
        // whichever address it can actually reach.
        let service = match ServiceInfo::new(
            SERVICE_TYPE,
            server_name,
            DOMAIN,
            AUTO_ADDRESS,
            port,
            &properties[..],
        ) {
            Ok(service) => service,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not build the Bonjour service record - iPhone users will need to enter this PC's address manually"
                );
                return None;
            }
        };

        if let Err(e) = daemon.register(service) {
            tracing::warn!(
                error = %e,
                "could not advertise over Bonjour - iPhone users will need to enter this PC's address manually"
            );
            return None;
        }

        tracing::info!(
            service = format!("{SERVICE_TYPE}.{DOMAIN}"),
            name = server_name,
            port,
            "advertising over Bonjour - your iPhone should find this PC automatically"
        );

        Some(Advertisement { _daemon: daemon })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_type_matches_the_phone_and_the_contract() {
        assert_eq!(SERVICE_TYPE, "_localdrop._tcp");
        assert_eq!(DOMAIN, "local.");
        assert_eq!(AUTO_ADDRESS, "0.0.0.0");
    }

    #[test]
    fn a_service_record_can_be_built_from_our_txt_keys() {
        let port_text = "47821".to_string();
        let protocol_text = PROTOCOL_VERSION.to_string();
        let properties: Vec<(&str, &str)> = vec![
            ("port", port_text.as_str()),
            ("protocolVersion", protocol_text.as_str()),
            ("appVersion", APP_VERSION),
            ("fullName", PRODUCT_NAME),
        ];
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            "TEST-PC",
            DOMAIN,
            AUTO_ADDRESS,
            47821,
            &properties[..],
        );
        assert!(info.is_ok(), "the TXT record must be valid: {info:?}");
    }

    #[test]
    fn a_computer_name_with_spaces_is_accepted() {
        // Windows machines are frequently named "DESKTOP-ABC123" but users rename them to
        // things like "Anna's PC"; a name that cannot be advertised would silently break
        // discovery for the exact users most likely to rename their machine.
        let properties: Vec<(&str, &str)> = vec![("fullName", PRODUCT_NAME)];
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            "Anna's PC",
            DOMAIN,
            AUTO_ADDRESS,
            47821,
            &properties[..],
        );
        assert!(info.is_ok(), "quoted host names must be accepted: {info:?}");
    }

    #[test]
    fn advertising_does_not_panic_when_the_network_refuses() {
        // Registration may legitimately fail in a sandboxed test environment; what matters is
        // that the call is safe and the caller gets a usable `Option` rather than a panic.
        let _ = Advertisement::start("TEST-PC", 47821, "D:/iPhone Backup");
    }
}
