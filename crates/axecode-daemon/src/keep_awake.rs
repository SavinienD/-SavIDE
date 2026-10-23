//! axe:eveil — garde Windows éveillé tant qu'au moins une session tourne.
//!
//! Pourquoi : la nuit du 20/10/2026, le PC de l'utilisateur (sur batterie) s'est mis
//! en veille après 3 min sans clavier ni souris et tous les agents en cours
//! sont morts. Un tour d'agent compte donc comme une activité.
//!
//! - Seules les transitions 0 -> 1 et 1 -> 0 sessions en cours comptent
//!   ([`transition`], fonction pure testée).
//! - L'état posé par `SetThreadExecutionState` appartient au thread qui
//!   l'appelle : un thread dédié le tient (jamais une tâche tokio, qui peut
//!   changer de thread d'un appel à l'autre).
//! - Drapeaux ([`flags`], fonction pure testée) : `ES_CONTINUOUS |
//!   ES_SYSTEM_REQUIRED` tant qu'une session tourne, plus
//!   `ES_DISPLAY_REQUIRED` sur batterie. Ce PC a une veille moderne (S0, pas
//!   de S3) : sur batterie, l'écran qui s'éteint (180 s) la déclenche, et
//!   `ES_SYSTEM_REQUIRED` ne la retarde que de 5 min ; ensuite le réseau est
//!   coupé (21/10/2026, 22h41 : deux tours morts à la sortie de veille). Sur
//!   secteur, la demande bloque la veille : l'écran peut s'éteindre.
//! - Le thread relit l'alimentation toutes les 30 s ([`REFRESH`]) et
//!   réapplique la demande ([`hold_loop`]) : le 21/10/2026, posée une seule
//!   fois au passage 0 -> 1, elle avait disparu après cette veille
//!   (`SystemExecutionState` = 0x0 à 23h00, session toujours en cours) et rien
//!   ne la reposait.
//! - Hors Windows : rien.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// What the system is asked when the number of running sessions changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Awake {
    /// No session was running and one starts: keep the machine awake.
    Hold,
    /// The last running session stops: the machine may sleep again.
    Release,
}

/// Pure rule: only the 0 <-> non-zero edges change the request.
pub fn transition(before: usize, after: usize) -> Option<Awake> {
    match (before == 0, after == 0) {
        (true, false) => Some(Awake::Hold),
        (false, true) => Some(Awake::Release),
        _ => None,
    }
}

/// `SetThreadExecutionState` flags (winbase.h).
pub const ES_CONTINUOUS: u32 = 0x8000_0000;
/// Keeps the system out of sleep (modern standby: 5 min at most on battery).
pub const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
/// Keeps the screen on: on battery its idle-off starts the modern standby.
pub const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

/// How often the dedicated thread re-reads the power source and re-applies.
pub const REFRESH: Duration = Duration::from_secs(30);

/// Pure rule: the execution state wanted while sessions are `running` (or
/// not) on this power source. `ES_CONTINUOUS` alone releases.
pub fn flags(running: bool, on_battery: bool) -> u32 {
    match (running, on_battery) {
        (false, _) => ES_CONTINUOUS,
        (true, false) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
        (true, true) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
    }
}

/// Body of the dedicated thread. `set` is `SetThreadExecutionState` (returns
/// the previous state of the thread, 0 on failure), `on_battery` reads the
/// power source. Wakes up on every request and at least every `refresh`:
/// while holding, the state is applied again each time, even unchanged
/// (Windows may have dropped it). Releases and returns once every sender is
/// gone.
pub fn hold_loop(
    requests: Receiver<Awake>,
    refresh: Duration,
    mut on_battery: impl FnMut() -> bool,
    mut set: impl FnMut(u32) -> u32,
) {
    let mut running = false;
    let mut applied = ES_CONTINUOUS;
    loop {
        match requests.recv_timeout(refresh) {
            Ok(request) => running = request == Awake::Hold,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let wanted = flags(running, running && on_battery());
        if !running && wanted == applied {
            continue;
        }
        let previous = set(wanted);
        if previous == 0 {
            tracing::warn!("keep-awake: SetThreadExecutionState({wanted:#x}) failed");
        } else if wanted != applied {
            tracing::info!("keep-awake: execution state {wanted:#x}");
        } else if previous != applied {
            tracing::warn!(
                "keep-awake: execution state was {previous:#x} instead of {applied:#x}, applied again"
            );
        }
        applied = wanted;
    }
    if applied != ES_CONTINUOUS {
        set(ES_CONTINUOUS);
    }
}

/// Receives the requests ([`KeepAwake::system`] or a test recorder).
pub type Sink = Box<dyn Fn(Awake) + Send + Sync>;

/// Last known number of running sessions, driving the keep-awake request.
pub struct KeepAwake {
    running: Mutex<usize>,
    sink: Sink,
}

impl std::fmt::Debug for KeepAwake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeepAwake")
            .field("running", &self.running)
            .finish_non_exhaustive()
    }
}

impl KeepAwake {
    /// Windows: dedicated thread running [`hold_loop`] with
    /// `SetThreadExecutionState`. Elsewhere: does nothing.
    pub fn system() -> Self {
        Self::with_sink(system_sink())
    }

    pub fn with_sink(sink: Sink) -> Self {
        Self {
            running: Mutex::new(0),
            sink,
        }
    }

    /// Reports how many sessions are running now.
    pub fn update(&self, running: usize) {
        let mut current = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = transition(*current, running) {
            (self.sink)(request);
        }
        *current = running;
    }
}

#[cfg(windows)]
mod win {
    /// SYSTEM_POWER_STATUS (winbase.h).
    #[repr(C)]
    #[derive(Default)]
    pub struct SystemPowerStatus {
        pub ac_line_status: u8,
        pub battery_flag: u8,
        pub battery_life_percent: u8,
        pub system_status_flag: u8,
        pub battery_life_time: u32,
        pub battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }

    /// Previous state of the calling thread, 0 on failure.
    pub fn set(flags: u32) -> u32 {
        // SAFETY: plain Win32 call, no pointer involved.
        unsafe { SetThreadExecutionState(flags) }
    }

    pub fn power_status() -> Option<SystemPowerStatus> {
        let mut status = SystemPowerStatus::default();
        // SAFETY: the call fills a struct we own, laid out as documented.
        (unsafe { GetSystemPowerStatus(&mut status) } != 0).then_some(status)
    }
}

/// On battery: `ACLineStatus == 0` (1 = mains, 255 = unknown). Never
/// outside Windows.
pub fn on_battery() -> bool {
    #[cfg(windows)]
    {
        win::power_status().is_some_and(|status| status.ac_line_status == 0)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn system_sink() -> Sink {
    let (tx, rx) = std::sync::mpsc::channel::<Awake>();
    let thread = std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || hold_loop(rx, REFRESH, on_battery, win::set));
    match thread {
        Ok(_) => Box::new(move |request| {
            let _ = tx.send(request);
        }),
        Err(error) => {
            tracing::warn!("keep-awake thread not started: {error}");
            Box::new(|_| {})
        }
    }
}

#[cfg(not(windows))]
fn system_sink() -> Sink {
    Box::new(|_| {})
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    };
    use std::time::{Duration, Instant};

    use super::{
        flags, hold_loop, transition, Awake, KeepAwake, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
        ES_SYSTEM_REQUIRED,
    };

    #[test]
    fn only_the_zero_edges_change_the_request() {
        assert_eq!(transition(0, 1), Some(Awake::Hold));
        assert_eq!(transition(0, 3), Some(Awake::Hold));
        assert_eq!(transition(1, 2), None);
        assert_eq!(transition(2, 1), None);
        assert_eq!(transition(1, 0), Some(Awake::Release));
        assert_eq!(transition(3, 0), Some(Awake::Release));
        assert_eq!(transition(0, 0), None);
    }

    #[test]
    fn zero_one_zero_holds_once_then_releases_once() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let awake = KeepAwake::with_sink(Box::new(move |request| {
            recorder.lock().unwrap().push(request);
        }));
        for running in [0, 1, 2, 1, 1, 0, 0, 1, 0] {
            awake.update(running);
        }
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Awake::Hold, Awake::Release, Awake::Hold, Awake::Release]
        );
    }

    #[test]
    fn flags_follow_the_sessions_and_the_power_source() {
        assert_eq!(flags(false, false), ES_CONTINUOUS);
        assert_eq!(flags(false, true), ES_CONTINUOUS);
        assert_eq!(flags(true, false), ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        assert_eq!(
            flags(true, true),
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        );
        assert_eq!(flags(true, false), 0x8000_0001);
        assert_eq!(flags(true, true), 0x8000_0003);
    }

    /// `hold_loop` with a fake power source and a fake
    /// `SetThreadExecutionState` recording every call.
    struct Fake {
        calls: Arc<Mutex<Vec<u32>>>,
        battery: Arc<AtomicBool>,
        requests: mpsc::Sender<Awake>,
        thread: std::thread::JoinHandle<()>,
    }

    impl Fake {
        fn start() -> Self {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let battery = Arc::new(AtomicBool::new(false));
            let (requests, rx) = mpsc::channel();
            let (record, power) = (calls.clone(), battery.clone());
            let thread = std::thread::spawn(move || {
                hold_loop(
                    rx,
                    Duration::from_millis(10),
                    move || power.load(Ordering::SeqCst),
                    move |wanted| {
                        let mut calls = record.lock().unwrap();
                        let previous = calls.last().copied().unwrap_or(ES_CONTINUOUS);
                        calls.push(wanted);
                        previous
                    },
                )
            });
            Self {
                calls,
                battery,
                requests,
                thread,
            }
        }

        fn calls(&self) -> Vec<u32> {
            self.calls.lock().unwrap().clone()
        }

        /// Waits until `done` holds for the recorded calls.
        fn wait(&self, what: &str, done: impl Fn(&[u32]) -> bool) {
            let started = Instant::now();
            while !done(&self.calls()) {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "{what}: {:x?}",
                    self.calls()
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }

    #[test]
    fn the_hold_is_applied_again_and_follows_the_power_source() {
        let fake = Fake::start();
        std::thread::sleep(Duration::from_millis(50));
        assert!(fake.calls().is_empty(), "nothing applied while idle");

        fake.requests.send(Awake::Hold).unwrap();
        let mains = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        fake.wait("held on mains, applied again", |c| {
            c.len() >= 3 && c.iter().all(|&f| f == mains)
        });

        fake.battery.store(true, Ordering::SeqCst);
        let battery = mains | ES_DISPLAY_REQUIRED;
        fake.wait("display kept on, on battery", |c| {
            c.iter().filter(|&&f| f == battery).count() >= 2
        });

        fake.requests.send(Awake::Release).unwrap();
        fake.wait("released", |c| c.last() == Some(&ES_CONTINUOUS));
        let released = fake.calls().len();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            fake.calls().len(),
            released,
            "nothing applied once released"
        );

        drop(fake.requests);
        fake.thread.join().unwrap();
        let calls = fake.calls.lock().unwrap().len();
        assert_eq!(calls, released, "already released: no extra call");
    }

    #[test]
    fn dropping_every_sender_releases() {
        let fake = Fake::start();
        fake.requests.send(Awake::Hold).unwrap();
        fake.wait("held", |c| !c.is_empty());
        drop(fake.requests);
        fake.thread.join().unwrap();
        assert_eq!(fake.calls.lock().unwrap().last(), Some(&ES_CONTINUOUS));
    }

    #[test]
    fn system_sink_is_harmless() {
        // Linux: no-op. Windows: thread started, hold then release.
        let awake = KeepAwake::system();
        awake.update(1);
        awake.update(0);
    }
}
