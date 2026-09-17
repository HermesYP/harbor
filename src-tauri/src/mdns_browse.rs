//! Shared mDNS browse lifecycle for cast discovery.
//!
//! `mdns_sd::ServiceDaemon` spawns a daemon thread that binds a UDP socket per
//! network interface, and the handle has no `Drop` that stops it: the thread
//! exits only after it processes a shutdown command. Dropping a daemon therefore
//! leaves the thread and its 5353 sockets running for the rest of the process.
//!
//! Every browse goes through [`browse_all`], which keeps one daemon for the
//! whole discovery pass, stops each browse it started, and waits for the daemon
//! to confirm shutdown before returning.

use mdns_sd::{DaemonStatus, Receiver, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Longest a single `recv_timeout` may block while draining one browse receiver.
/// The drain loop still stops at the pass deadline.
const BROWSE_POLL_INTERVAL: Duration = Duration::from_millis(120);

/// Upper bound for the daemon's shutdown acknowledgement.
const SHUTDOWN_ACK_TIMEOUT: Duration = Duration::from_secs(3);

/// Upper bound for one daemon status round-trip while confirming teardown.
const STATUS_CHECK_TIMEOUT: Duration = Duration::from_millis(500);

/// Outcome of releasing the daemon used for one discovery pass.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DaemonCleanup {
    /// No daemon was created, so nothing can be left running.
    #[default]
    NotStarted,
    /// The daemon confirmed shutdown and closed its command channel, which means
    /// the thread that owned the mDNS sockets has exited.
    Acknowledged,
    /// Teardown could not be confirmed; the daemon may still be running.
    Unconfirmed(String),
}

/// Result of one discovery pass.
#[derive(Debug, Default)]
pub struct BrowseResult {
    /// Resolved services, keyed by the service type they were browsed for.
    pub services: HashMap<String, Vec<ServiceInfo>>,
    /// How the daemon was released. Callers and tests should inspect this.
    pub cleanup: DaemonCleanup,
}

/// Browses `service_types` with a single daemon for up to `timeout`, then stops
/// every browse and shuts the daemon down.
///
/// Blocks for at most `timeout` plus [`SHUTDOWN_ACK_TIMEOUT`]; call it from a
/// blocking context.
pub fn browse_all(service_types: &[&str], timeout: Duration) -> BrowseResult {
    let mut result = BrowseResult::default();

    let Ok(daemon) = ServiceDaemon::new() else {
        eprintln!("[harbor::mdns] could not create a service daemon; skipping discovery");
        return result;
    };
    let mut guard = DaemonGuard::new(daemon);

    let mut started = Vec::new();
    let mut receivers: Vec<(&str, Receiver<ServiceEvent>)> = Vec::new();
    for service_type in service_types {
        match guard.daemon.browse(service_type) {
            Ok(receiver) => {
                started.push(*service_type);
                receivers.push((*service_type, receiver));
            }
            Err(error) => eprintln!("[harbor::mdns] browse {service_type} failed: {error}"),
        }
    }

    if !receivers.is_empty() {
        let deadline = Instant::now() + timeout;
        while remaining_until(deadline).is_some() {
            // A closed receiver means the daemon stopped answering, so waiting
            // for the rest of the window would only burn the deadline.
            if receivers
                .iter()
                .any(|(_, receiver)| receiver.is_disconnected())
            {
                break;
            }
            for (service_type, receiver) in &receivers {
                let Some(remaining) = remaining_until(deadline) else {
                    break;
                };
                if let Ok(ServiceEvent::ServiceResolved(info)) =
                    receiver.recv_timeout(remaining.min(BROWSE_POLL_INTERVAL))
                {
                    result
                        .services
                        .entry((*service_type).to_string())
                        .or_default()
                        .push(info);
                }
            }
        }
    }

    for service_type in started {
        if let Err(error) = guard.daemon.stop_browse(service_type) {
            eprintln!("[harbor::mdns] stop browse {service_type} failed: {error}");
        }
    }

    result.cleanup = guard.shutdown();
    if let DaemonCleanup::Unconfirmed(detail) = &result.cleanup {
        eprintln!("[harbor::mdns] daemon shutdown unconfirmed: {detail}");
    }
    result
}

/// Owns the daemon for one pass and guarantees teardown even on early return.
struct DaemonGuard {
    daemon: ServiceDaemon,
    cleanup: Option<DaemonCleanup>,
}

impl DaemonGuard {
    fn new(daemon: ServiceDaemon) -> Self {
        Self {
            daemon,
            cleanup: None,
        }
    }

    /// Shuts the daemon down and waits for confirmation. Idempotent.
    fn shutdown(&mut self) -> DaemonCleanup {
        if let Some(cleanup) = &self.cleanup {
            return cleanup.clone();
        }
        let cleanup = shutdown_and_wait(&self.daemon);
        self.cleanup = Some(cleanup.clone());
        cleanup
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if matches!(self.cleanup, Some(DaemonCleanup::Acknowledged)) {
            return;
        }
        // Covers early returns and panics between construction and shutdown.
        let _ = shutdown_and_wait(&self.daemon);
    }
}

/// Sends the shutdown command and waits for the daemon to confirm it is gone.
fn shutdown_and_wait(daemon: &ServiceDaemon) -> DaemonCleanup {
    let acknowledgement = match daemon.shutdown() {
        Ok(receiver) => receiver,
        Err(error) => {
            return DaemonCleanup::Unconfirmed(format!("shutdown command failed: {error}"))
        }
    };
    match acknowledgement.recv_timeout(SHUTDOWN_ACK_TIMEOUT) {
        Ok(DaemonStatus::Shutdown) => {}
        Ok(other) => return DaemonCleanup::Unconfirmed(format!("daemon reported {other:?}")),
        Err(error) => {
            return DaemonCleanup::Unconfirmed(format!(
                "no shutdown acknowledgement within {SHUTDOWN_ACK_TIMEOUT:?}: {error}"
            ))
        }
    }

    // The daemon thread drops its command receiver and its sockets before it
    // sends this acknowledgement, and `status()` reports `Shutdown` without a
    // round-trip once that receiver is gone.
    match daemon
        .status()
        .ok()
        .and_then(|status| status.recv_timeout(STATUS_CHECK_TIMEOUT).ok())
    {
        Some(DaemonStatus::Shutdown) => DaemonCleanup::Acknowledged,
        Some(other) => DaemonCleanup::Unconfirmed(format!("daemon still {other:?}")),
        None => DaemonCleanup::Unconfirmed("daemon status unavailable after shutdown".to_string()),
    }
}

fn remaining_until(deadline: Instant) -> Option<Duration> {
    let now = Instant::now();
    if now >= deadline {
        None
    } else {
        Some(deadline - now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROMECAST: &str = "_googlecast._tcp.local.";
    const AIRPLAY: &str = "_airplay._tcp.local.";
    const QUICK: Duration = Duration::from_millis(250);

    #[test]
    fn a_pass_shuts_its_daemon_down() {
        let result = browse_all(&[CHROMECAST, AIRPLAY], QUICK);

        assert_eq!(result.cleanup, DaemonCleanup::Acknowledged);
    }

    #[test]
    fn rejected_browse_still_shuts_the_daemon_down() {
        // "not-a-service" has no mDNS domain suffix, so mdns-sd rejects it before
        // the discovery window starts. This is the early-error path that used to
        // return without stopping the daemon it had already created.
        let result = browse_all(&[CHROMECAST, "not-a-service"], QUICK);

        assert!(result.services.get("not-a-service").is_none());
        assert_eq!(result.cleanup, DaemonCleanup::Acknowledged);
    }

    #[test]
    fn rejected_only_browse_does_not_wait_out_the_window() {
        // Nothing to drain, so the pass must return instead of spinning or
        // sleeping through the whole timeout.
        let started = Instant::now();
        let result = browse_all(&["not-a-service"], Duration::from_secs(30));

        assert_eq!(result.cleanup, DaemonCleanup::Acknowledged);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "nothing was browsed but the pass waited {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn dropping_the_guard_shuts_the_daemon_down() {
        let daemon = ServiceDaemon::new().expect("mDNS daemon");
        let observer = daemon.clone();
        let guard = DaemonGuard::new(daemon);

        let running = observer
            .status()
            .expect("status command")
            .recv_timeout(Duration::from_secs(1))
            .expect("daemon status");
        assert_eq!(running, DaemonStatus::Running);

        // Simulates an early return or panic before the explicit shutdown.
        drop(guard);

        let after = observer
            .status()
            .expect("status command")
            .recv_timeout(Duration::from_secs(1))
            .expect("daemon status");
        assert_eq!(after, DaemonStatus::Shutdown, "daemon outlived its guard");
    }

    #[test]
    fn repeated_passes_each_release_their_daemon() {
        // browse_all only returns once teardown is confirmed, so three passes in
        // a row must never overlap a live daemon from the previous pass.
        for pass in 0..3 {
            let result = browse_all(&[CHROMECAST, AIRPLAY], Duration::from_millis(150));
            assert_eq!(
                result.cleanup,
                DaemonCleanup::Acknowledged,
                "pass {pass} left its daemon running"
            );
        }
    }
}
