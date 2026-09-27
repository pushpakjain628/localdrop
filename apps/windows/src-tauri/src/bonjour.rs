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

/// Fallback host label when a computer name has no characters usable in a DNS label.
const FALLBACK_HOST_LABEL: &str = "localdrop-pc";

/// Reduces a Windows computer name to a single DNS label.
///
/// mDNS instance names may contain spaces, so "Anna's PC" advertises fine as the name the user
/// sees. The *host* in the SRV record is a DNS label and cannot contain spaces or apostrophes, so
/// everything else becomes a hyphen - which is what other responders do with these names anyway.
fn dns_label(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() {
        FALLBACK_HOST_LABEL.to_string()
    } else {
        trimmed.to_string()
    }
}

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

        // `mdns-sd` takes the service type *and* the domain as a single string, and its third
        // argument is the host name - there is no separate `domain` parameter. Passing
        // `SERVICE_TYPE` on its own built a record whose fully qualified name was
        // `TEST-PC._localdrop._tcp`, and `register` rejected it with "must end with
        // '._tcp.local.'", so the iPhone never discovered this PC at all.
        let service_type_domain = format!("{SERVICE_TYPE}.{DOMAIN}");
        // `check_hostname` requires a `.local.` suffix, which `DOMAIN` already carries.
        let host = format!("{}.{}", dns_label(server_name), DOMAIN);

        // `0.0.0.0` tells `mdns-sd` to publish every non-loopback IPv4 address on this machine,
        // which is what we want: a desktop with a wired and a Wi-Fi adapter should be reachable
        // on both. A VPN adapter would also be published, but the phone resolves the name to
        // whichever address it can actually reach.
        let service = match ServiceInfo::new(
            &service_type_domain,
            server_name,
            &host,
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
            service = %service_type_domain,
            host = %host,
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
    fn the_service_type_and_domain_combine_into_what_mdns_sd_validates() {
        // `ServiceInfo::new` does *not* validate the type, so the only place this could be caught
        // is the fully qualified name it derives - and `register` is the thing that actually
        // fails, on a machine with a network stack. Asserting the derived name here is what makes
        // the registration failure a test failure instead of a log line nobody reads.
        let combined = format!("{SERVICE_TYPE}.{DOMAIN}");
        assert!(
            combined.ends_with("._tcp.local."),
            "mdns-sd rejects anything that is not '._tcp.local.': {combined}"
        );
    }

    #[test]
    fn the_host_name_is_a_dns_label_ending_in_local() {
        // `check_hostname` rejects a host that does not end in `.local.`, and a space or an
        // apostrophe in the label would produce an SRV record no resolver can answer.
        let host = format!("{}.{}", dns_label("Anna's PC"), DOMAIN);
        assert_eq!(host, "Anna-s-PC.local.");
        assert!(host.ends_with(".local."), "{host}");
        assert!(!host.contains(' '), "{host}");

        // An empty or punctuation-only name still has to yield something registrable.
        assert_eq!(
            format!("{}.{}", dns_label("***"), DOMAIN),
            "localdrop-pc.local."
        );
        assert_eq!(
            format!("{}.{}", dns_label(""), DOMAIN),
            "localdrop-pc.local."
        );
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
            &format!("{SERVICE_TYPE}.{DOMAIN}"),
            "TEST-PC",
            &format!("{}.{}", dns_label("TEST-PC"), DOMAIN),
            AUTO_ADDRESS,
            47821,
            &properties[..],
        );
        assert!(info.is_ok(), "the TXT record must be valid: {info:?}");

        // The record has to be registrable, which is a stricter bar than "it constructed".
        let info = info.expect("built above");
        assert!(
            info.get_fullname().ends_with("._tcp.local."),
            "register() would reject this fullname: {}",
            info.get_fullname()
        );
        assert!(
            info.get_hostname().ends_with(".local."),
            "register() would reject this hostname: {}",
            info.get_hostname()
        );
    }

    #[test]
    fn a_computer_name_with_spaces_is_accepted() {
        // Windows machines are frequently named "DESKTOP-ABC123" but users rename them to
        // things like "Anna's PC"; a name that cannot be advertised would silently break
        // discovery for the exact users most likely to rename their machine.
        let properties: Vec<(&str, &str)> = vec![("fullName", PRODUCT_NAME)];
        let info = ServiceInfo::new(
            &format!("{SERVICE_TYPE}.{DOMAIN}"),
            "Anna's PC",
            &format!("{}.{}", dns_label("Anna's PC"), DOMAIN),
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

    #[test]
    fn the_record_we_build_is_accepted_by_the_registrar() {
        // `ServiceInfo::new` happily builds a record the registrar will reject, so the only way
        // to know the shape is right is to hand it to a real `ServiceDaemon`. A network that
        // refuses multicast is a legitimate outcome and is not what this test is about, so only
        // the "it was rejected as malformed" case fails.
        let daemon = ServiceDaemon::new().expect("the test host has a usable interface list");

        let port_text = 47821.to_string();
        let properties: Vec<(&str, &str)> = vec![("port", port_text.as_str())];
        let info = ServiceInfo::new(
            &format!("{SERVICE_TYPE}.{DOMAIN}"),
            "TEST-PC",
            &format!("{}.{}", dns_label("TEST-PC"), DOMAIN),
            AUTO_ADDRESS,
            47821,
            &properties[..],
        )
        .expect("the record is well formed");

        if let Err(e) = daemon.register(info) {
            let message = e.to_string();
            assert!(
                !message.contains("must end with") && !message.contains("Hostname must end"),
                "the record is malformed, which is a bug here and not a network problem: {message}"
            );
        }
    }
}
