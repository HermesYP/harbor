use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const METADATA_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const CACHE_MAX_BYTES: u64 = 1_500_000_000;
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const FORMAT_LOW: &str =
    "18/best[height<=360][ext=mp4][vcodec!=none][acodec!=none]/worst[ext=mp4][vcodec!=none][acodec!=none]";
const FORMAT_HIGH: &str =
    "22/18/best[ext=mp4][vcodec!=none][acodec!=none][height<=720]/best[vcodec!=none][acodec!=none]";
const FORMAT_1080: &str =
    "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best";
const FORMAT_BEST: &str = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";

/// Parent of the per-invocation scratch directories, owned by Harbor alone.
const SCRATCH_PARENT: &str = "harbor-yt-dlp";

/// How long a signalled child gets to confirm its exit before cleanup is denied.
const REAP_WINDOW: Duration = Duration::from_secs(5);

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("harbor-trailers")
}

fn sanitize_id(id: &str) -> Result<String, String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("invalid video id".to_string());
    }
    Ok(safe)
}

fn normalize_quality(q: Option<String>) -> &'static str {
    match q.as_deref() {
        Some("low") | Some("360p") => "360p",
        Some("1080p") => "1080p",
        Some("best") => "best",
        _ => "720p",
    }
}

fn quality_path(id: &str, quality: &str) -> PathBuf {
    cache_dir().join(format!("{}-{}.mp4", id, quality))
}

fn format_for(quality: &str) -> &'static str {
    match quality {
        "360p" => FORMAT_LOW,
        "1080p" => FORMAT_1080,
        "best" => FORMAT_BEST,
        _ => FORMAT_HIGH,
    }
}

fn needs_merge(quality: &str) -> bool {
    matches!(quality, "1080p" | "best")
}

fn cached_info(path: &Path, quality: &str, size: u64) -> TrailerInfo {
    TrailerInfo {
        file_path: path.to_string_lossy().to_string(),
        quality: quality.to_string(),
        duration_seconds: 0,
        title: String::new(),
        size_bytes: size,
    }
}

struct YtDlpOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TreeExit {
    Confirmed,
    /// Not enough evidence that the scratch directory is unused, so it is kept.
    Unknown,
}

/// The part of a spawned sidecar the watcher needs. Production supplies the
/// plugin child; the seam lets tests drive the same lifecycle with a real process.
trait SpawnedChild {
    fn pid(&self) -> u32;
    fn request_kill(self);
}

impl SpawnedChild for CommandChild {
    fn pid(&self) -> u32 {
        CommandChild::pid(self)
    }

    fn request_kill(self) {
        let _ = CommandChild::kill(self);
    }
}

/// Collects one child's output and remembers whether its own termination event
/// arrived, so an event delivered after the timeout is still recorded.
#[derive(Default)]
struct SidecarCollector {
    terminated: bool,
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl SidecarCollector {
    /// Consumes events for up to `window`; `true` means the stream closed.
    async fn drain(
        &mut self,
        events: &mut tokio::sync::mpsc::Receiver<CommandEvent>,
        window: Duration,
    ) -> bool {
        loop {
            match tokio::time::timeout(window, events.recv()).await {
                Ok(Some(event)) => self.handle(event),
                Ok(None) => return true,
                Err(_) => return false,
            }
        }
    }

    fn handle(&mut self, event: CommandEvent) {
        match event {
            CommandEvent::Stdout(bytes) => self.stdout.extend(bytes),
            CommandEvent::Stderr(bytes) => self.stderr.extend(bytes),
            CommandEvent::Terminated(payload) => {
                self.success = payload.code == Some(0);
                self.terminated = true;
            }
            CommandEvent::Error(error) => self.stderr.extend_from_slice(error.as_bytes()),
            _ => {}
        }
    }

    fn output(&self) -> YtDlpOutput {
        YtDlpOutput {
            success: self.success,
            stdout: self.stdout.clone(),
            stderr: self.stderr.clone(),
        }
    }

    /// Only a delivered termination event confirms the child exited.
    fn tree_exit(&self) -> TreeExit {
        match self.terminated {
            true => TreeExit::Confirmed,
            false => TreeExit::Unknown,
        }
    }
}

/// Watches one spawned child and classifies its exit. On timeout the tree is
/// signalled and killed first, then a bounded drain waits for the termination
/// evidence; without it the exit stays unconfirmed so the caller keeps the
/// scratch directory instead of deleting it under a process that may still write.
async fn watch_sidecar<C: SpawnedChild>(
    mut events: tokio::sync::mpsc::Receiver<CommandEvent>,
    child: C,
    timeout: Duration,
    label: &str,
) -> (Result<YtDlpOutput, String>, TreeExit) {
    let mut collector = SidecarCollector::default();
    if collector.drain(&mut events, timeout).await {
        return (Ok(collector.output()), collector.tree_exit());
    }
    let pid = child.pid();
    crate::process::terminate_descendants(pid).await;
    child.request_kill();
    // The tree is signalled; this drain waits for the exit instead of assuming it.
    let _ = collector.drain(&mut events, REAP_WINDOW).await;
    (
        Err(format!("yt-dlp {label} timed out")),
        collector.tree_exit(),
    )
}

/// The temp directory of a single yt-dlp invocation.
///
/// The bundled yt-dlp is a PyInstaller onefile binary whose bootloader extracts
/// `_MEI<pid>xxxxxx` below `TMPDIR`/`TEMP`/`TMP` and never cleans up when killed.
/// The path is private and only [`TempScope::create`] produces it, so cleanup can
/// only ever reach a directory this invocation owns.
struct TempScope {
    root: PathBuf,
}

impl TempScope {
    fn create() -> Result<Self, String> {
        let root = scratch_parent_dir().join(format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).map_err(|error| format!("yt-dlp scratch dir: {error}"))?;
        Ok(Self { root })
    }

    /// The bootloader resolves a relative temp directory against the child's own
    /// working directory, so the override has to be absolute.
    fn env(&self) -> [(&'static str, String); 3] {
        let dir = self.root.to_string_lossy().into_owned();
        [("TMPDIR", dir.clone()), ("TMP", dir.clone()), ("TEMP", dir)]
    }

    /// Removal refuses any path that is not a direct child of Harbor's scratch
    /// parent, so a corrupted scope can at worst leak its own directory.
    async fn remove(&self, parent: &Path) {
        if self.root.parent() != Some(parent) {
            eprintln!(
                "[harbor::trailer] refusing to remove unexpected scratch path {}",
                self.root.display()
            );
            return;
        }
        match tokio::fs::remove_dir_all(&self.root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "[harbor::trailer] yt-dlp scratch cleanup failed for {}: {error}",
                self.root.display()
            ),
        }
    }
}

fn scratch_parent_dir() -> PathBuf {
    std::env::temp_dir().join(SCRATCH_PARENT)
}

/// Fallback used only when the bundled sidecar could not be started.
#[cfg(target_os = "linux")]
async fn run_system_yt_dlp(
    args: Vec<String>,
    timeout: Duration,
    label: &str,
    scope: &TempScope,
) -> (Result<YtDlpOutput, String>, TreeExit) {
    let mut command = tokio::process::Command::new("yt-dlp");
    command.args(args).envs(scope.env());
    match crate::process::output_with_timeout(&mut command, timeout).await {
        // The helper reaps the child itself, so a returned exit status means the
        // directory is no longer in use even when yt-dlp reported failure.
        Ok(output) => (
            Ok(YtDlpOutput {
                success: output.status.success(),
                stdout: output.stdout,
                stderr: output.stderr,
            }),
            TreeExit::Confirmed,
        ),
        Err(error) => (Err(format!("yt-dlp {label}: {error}")), TreeExit::Unknown),
    }
}

/// Runs the bundled sidecar and preserves the Linux fallback to a system yt-dlp,
/// which is used only when the sidecar could not start at all. A platform without
/// that fallback has no child to wait for, so its scratch directory is released.
async fn launch_yt_dlp(
    app: &tauri::AppHandle,
    args: Vec<String>,
    timeout: Duration,
    label: &str,
    scope: &TempScope,
) -> (Result<YtDlpOutput, String>, TreeExit) {
    let command = match app.shell().sidecar("yt-dlp") {
        Ok(command) => command,
        Err(error) => {
            eprintln!("[harbor::trailer] yt-dlp sidecar init failed: {error}");
            #[cfg(target_os = "linux")]
            {
                return run_system_yt_dlp(args, timeout, label, scope).await;
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = (args, timeout);
                return (Err(format!("yt-dlp {label}: {error}")), TreeExit::Confirmed);
            }
        }
    };
    match command.args(args).envs(scope.env()).spawn() {
        Ok((events, child)) => watch_sidecar(events, child, timeout, label).await,
        Err(error) => {
            eprintln!("[harbor::trailer] yt-dlp sidecar unavailable: {error}");
            // No child exists, so the scratch directory is free to remove.
            (
                Err(format!("yt-dlp {label}: sidecar unavailable")),
                TreeExit::Confirmed,
            )
        }
    }
}

/// Removes the scratch directory once the process exit is confirmed, and
/// deliberately keeps it otherwise.
async fn finish_scope(scope: &TempScope, parent: &Path, tree_exit: TreeExit) {
    if tree_exit == TreeExit::Confirmed {
        scope.remove(parent).await;
    } else {
        eprintln!(
            "[harbor::trailer] yt-dlp exit not confirmed; keeping {}",
            scope.root.display()
        );
    }
}

/// Runs one yt-dlp invocation under a scratch directory owned by a task that
/// outlives the caller.
///
/// The task owns the scope, the command, and the child. A cancelled or timed-out
/// `fetch_trailer` drops only the `JoinHandle`, which detaches the task instead of
/// aborting it, so the child is still signalled and the directory removed once its
/// exit is confirmed. The caller can therefore neither orphan a scratch directory
/// nor delete one that is still in use.
async fn supervise(
    app: tauri::AppHandle,
    args: Vec<String>,
    timeout: Duration,
    label: String,
) -> Result<YtDlpOutput, String> {
    let scope = TempScope::create()?;
    let parent = scratch_parent_dir();
    tokio::spawn(async move {
        let (output, tree_exit) = launch_yt_dlp(&app, args, timeout, &label, &scope).await;
        finish_scope(&scope, &parent, tree_exit).await;
        output
    })
    .await
    .map_err(|error| format!("yt-dlp supervisor stopped unexpectedly: {error}"))?
}

async fn run_yt_dlp(
    app: &tauri::AppHandle,
    args: Vec<String>,
    timeout: Duration,
    label: &str,
) -> Result<YtDlpOutput, String> {
    supervise(app.clone(), args, timeout, label.to_string()).await
}

pub fn sweep_cache() {
    let dir = cache_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = SystemTime::now();
    let mut keep: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(now);
        let age = now.duration_since(mtime).unwrap_or_default();
        if age > CACHE_MAX_AGE {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        keep.push((path, mtime, meta.len()));
    }
    let total: u64 = keep.iter().map(|(_, _, s)| s).sum();
    if total <= CACHE_MAX_BYTES {
        return;
    }
    keep.sort_by_key(|(_, m, _)| *m);
    let mut to_evict = total - CACHE_MAX_BYTES;
    for (path, _, size) in keep {
        if to_evict == 0 {
            break;
        }
        let _ = std::fs::remove_file(&path);
        to_evict = to_evict.saturating_sub(size);
    }
}

#[derive(Serialize)]
pub struct TrailerInfo {
    pub file_path: String,
    pub quality: String,
    pub duration_seconds: u64,
    pub title: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn fetch_trailer(
    video_id: String,
    quality: Option<String>,
    app: tauri::AppHandle,
) -> Result<TrailerInfo, String> {
    let quality = normalize_quality(quality);
    let safe_id = sanitize_id(&video_id)?;
    let dir = cache_dir();
    let file_path = quality_path(&safe_id, quality);

    if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.len() > 1024 {
            return Ok(cached_info(&file_path, quality, meta.len()));
        }
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("cache dir: {}", e))?;
    let url = format!("https://www.youtube.com/watch?v={}", video_id);

    let meta_output = run_yt_dlp(
        &app,
        vec![
            "-j".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--skip-download".into(),
            url.clone(),
        ],
        METADATA_TIMEOUT,
        "metadata",
    )
    .await?;

    if !meta_output.success {
        let stderr = String::from_utf8_lossy(&meta_output.stderr);
        return Err(format!("yt-dlp failed: {}", stderr));
    }

    let meta: serde_json::Value = serde_json::from_slice(&meta_output.stdout)
        .map_err(|e| format!("metadata parse: {}", e))?;

    let title = meta["title"].as_str().unwrap_or("").to_string();
    let duration_seconds = meta["duration"].as_f64().unwrap_or(0.0) as u64;

    let file_path_str = file_path.to_string_lossy().to_string();
    let ffmpeg = crate::transcode::locate_ffmpeg();
    let wants_merge = needs_merge(quality) && ffmpeg.is_some();
    let effective_format = if needs_merge(quality) && ffmpeg.is_none() {
        FORMAT_HIGH
    } else {
        format_for(quality)
    };
    let mut dl_args: Vec<String> = vec![
        "-f".into(),
        effective_format.into(),
        "-o".into(),
        file_path_str.clone(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--quiet".into(),
        "--force-overwrites".into(),
    ];
    if wants_merge {
        if let Some(ff) = &ffmpeg {
            dl_args.push("--ffmpeg-location".into());
            dl_args.push(ff.to_string_lossy().to_string());
        }
        dl_args.push("--merge-output-format".into());
        dl_args.push("mp4".into());
    }
    dl_args.push(url.clone());
    let dl_timeout = if wants_merge {
        Duration::from_secs(240)
    } else {
        DOWNLOAD_TIMEOUT
    };
    let download_output = run_yt_dlp(&app, dl_args, dl_timeout, "download").await?;

    if !download_output.success {
        let stderr = String::from_utf8_lossy(&download_output.stderr);
        return Err(format!("yt-dlp download failed: {}", stderr));
    }

    let file_meta = std::fs::metadata(&file_path).map_err(|e| format!("file check: {}", e))?;
    let size_bytes = file_meta.len();

    if size_bytes < 1024 {
        let _ = std::fs::remove_file(&file_path);
        return Err("downloaded file is too small".to_string());
    }

    sweep_cache();

    Ok(TrailerInfo {
        file_path: file_path_str,
        quality: quality.to_string(),
        duration_seconds,
        title,
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Removes a test-owned directory even if a test fails early.
    struct RemovedOnDrop(PathBuf);

    impl Drop for RemovedOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Owns a scratch scope whose directory is always removed afterwards, since
    /// the production type deliberately has no `Drop` cleanup.
    struct TestScope {
        scope: TempScope,
        _guard: RemovedOnDrop,
    }

    impl TestScope {
        fn create() -> Self {
            let scope = TempScope::create().expect("scratch scope");
            let guard = RemovedOnDrop(scope.root.clone());
            Self {
                scope,
                _guard: guard,
            }
        }
    }

    impl std::ops::Deref for TestScope {
        type Target = TempScope;

        fn deref(&self) -> &TempScope {
            &self.scope
        }
    }

    /// Fills a scope with the shape a PyInstaller onefile bootloader creates.
    fn write_extraction(scope_root: &Path) {
        let payload = scope_root.join("_MEI_test").join("yt_dlp");
        std::fs::create_dir_all(&payload).expect("create extraction dir");
        std::fs::write(payload.join("__init__.py"), b"stub").expect("write extraction file");
    }

    /// A real process behind the production seam. Only how the child is obtained
    /// differs from the shipped sidecar; the watcher, its timeout, the kill, and
    /// the confirmation rule are the production ones.
    struct TestChild {
        pid: u32,
        kill: tokio::sync::watch::Sender<bool>,
    }

    /// A child whose stream closes without ever announcing its exit.
    struct SilentChild {
        pid: u32,
        kill: tokio::sync::watch::Sender<bool>,
    }

    impl SpawnedChild for TestChild {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn request_kill(self) {
            let _ = self.kill.send(true);
        }
    }

    impl SpawnedChild for SilentChild {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn request_kill(self) {
            let _ = self.kill.send(true);
        }
    }

    /// True while the operating system still knows the pid.
    fn pid_exists(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("tasklist");
            command.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
            let output = command.output().expect("tasklist");
            String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
        }
        #[cfg(unix)]
        {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }
    }

    #[cfg(windows)]
    fn shell_command(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("cmd");
        command.args(["/C", script]);
        command
    }

    #[cfg(not(windows))]
    fn shell_command(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", script]);
        command
    }

    /// Spawns a real child whose exit is announced the way the plugin announces it:
    /// a `Terminated` payload carrying the real exit code, then end of stream.
    fn spawn_real_child(script: &str) -> (tokio::sync::mpsc::Receiver<CommandEvent>, TestChild) {
        let mut child = shell_command(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn test child");
        let pid = child.id().expect("child pid");
        let (sender, events) = tokio::sync::mpsc::channel(8);
        let (kill, mut kill_rx) = tokio::sync::watch::channel(false);

        // One task owns the child, so the stream closes exactly when it has exited
        // and its termination has been announced.
        tokio::spawn(async move {
            let status = loop {
                tokio::select! {
                    status = child.wait() => break status.ok(),
                    _ = kill_rx.changed() => {
                        let _ = child.start_kill();
                    }
                }
            };
            let payload = tauri_plugin_shell::process::TerminatedPayload {
                code: status.and_then(|status| status.code()),
                signal: None,
            };
            let _ = sender.send(CommandEvent::Terminated(payload)).await;
        });
        (events, TestChild { pid, kill })
    }

    /// The same real child with a stream that closes without announcing its exit.
    fn spawn_silent_child(
        script: &str,
    ) -> (tokio::sync::mpsc::Receiver<CommandEvent>, SilentChild) {
        let mut child = shell_command(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn test child");
        let pid = child.id().expect("child pid");
        let (kill, mut kill_rx) = tokio::sync::watch::channel(false);
        let (sender, events) = tokio::sync::mpsc::channel(1);
        drop(sender);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = child.wait() => break,
                    _ = kill_rx.changed() => {
                        let _ = child.start_kill();
                    }
                }
            }
        });
        (events, SilentChild { pid, kill })
    }

    /// A child that exits on its own releases its scratch directory.
    #[tokio::test]
    async fn a_finished_child_releases_its_scratch_directory() {
        let (events, child) = spawn_real_child("exit 0");

        let (output, tree_exit) =
            watch_sidecar(events, child, Duration::from_secs(20), "fake").await;

        assert!(output.expect("output").success, "exit code 0 is reported");
        assert_eq!(tree_exit, TreeExit::Confirmed);
    }

    /// A failing exit is still a reaped child, so its directory is released.
    #[tokio::test]
    async fn a_failed_child_still_releases_its_directory() {
        let (events, child) = spawn_real_child("exit 3");

        let (output, tree_exit) =
            watch_sidecar(events, child, Duration::from_secs(20), "fake").await;

        assert!(!output.expect("output").success, "the failure is reported");
        assert_eq!(tree_exit, TreeExit::Confirmed);
    }

    /// A child that outlives the timeout is killed, and the directory is only
    /// released once its exit has been confirmed.
    #[tokio::test]
    async fn a_timed_out_child_is_killed_before_cleanup() {
        let script = if cfg!(windows) {
            "ping -n 30 127.0.0.1"
        } else {
            "sleep 30"
        };
        let (events, child) = spawn_real_child(script);
        let pid = child.pid;

        let (output, tree_exit) =
            watch_sidecar(events, child, Duration::from_millis(300), "fake").await;

        assert!(output.is_err(), "the call must report the timeout");
        assert!(!pid_exists(pid), "the killed child must be gone");
        assert_eq!(tree_exit, TreeExit::Confirmed);
    }

    /// A stream that ends without a termination event is not proof that the child
    /// is gone, so cleanup must stay unconfirmed.
    #[tokio::test]
    async fn stream_end_without_termination_stays_unconfirmed() {
        let (events, child) = spawn_silent_child("exit 0");

        let (output, tree_exit) =
            watch_sidecar(events, child, Duration::from_secs(20), "fake").await;

        assert!(output.is_ok(), "output is still collected");
        assert_eq!(tree_exit, TreeExit::Unknown);
    }

    fn temp_probe_command() -> std::process::Command {
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "echo %TMP%"]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "echo \"$TMPDIR\""]);
            command
        }
    }

    #[test]
    fn each_invocation_gets_its_own_scratch_directory() {
        let first = TestScope::create();
        let second = TestScope::create();

        assert!(first.root.is_dir(), "scratch dir must exist");
        assert!(
            first.root.starts_with(scratch_parent_dir()),
            "scratch dirs stay under Harbor's own parent"
        );
        assert_ne!(
            first.root, second.root,
            "concurrent invocations must not share a scratch dir"
        );
    }

    #[test]
    fn child_temp_variables_point_at_the_scratch_directory() {
        let scope = TestScope::create();
        let env = scope.env();

        assert_eq!(env.len(), 3, "POSIX and Windows variables are both set");
        for (key, value) in env {
            assert!(matches!(key, "TMPDIR" | "TMP" | "TEMP"), "key was {key}");
            assert!(
                Path::new(&value).is_absolute(),
                "the bootloader needs an absolute base dir, got {value}"
            );
            assert_eq!(
                Path::new(&value).canonicalize().expect("resolve override"),
                scope.root.canonicalize().expect("resolve scratch dir")
            );
        }
        assert!(
            !std::env::temp_dir().starts_with(&scope.root),
            "Harbor's own temp directory must not be redirected"
        );
    }

    #[tokio::test]
    async fn removing_a_scope_deletes_the_whole_extraction_tree() {
        let scope = TestScope::create();
        write_extraction(&scope.root);

        scope.remove(&scratch_parent_dir()).await;

        assert!(!scope.root.exists(), "scratch dir must be gone");
    }

    #[tokio::test]
    async fn removing_a_scope_is_idempotent() {
        let scope = TestScope::create();
        let root = scope.root.clone();
        std::fs::remove_dir_all(&root).expect("pre-remove scratch dir");

        scope.remove(&scratch_parent_dir()).await;

        assert!(!root.exists());
    }

    #[tokio::test]
    async fn removal_refuses_a_scope_outside_harbors_scratch_parent() {
        let scope = TestScope::create();
        write_extraction(&scope.root);
        let elsewhere = std::env::temp_dir().join("harbor-foreign-parent");
        std::fs::create_dir_all(&elsewhere).expect("create foreign parent");

        scope.remove(&elsewhere).await;

        assert!(
            scope.root.exists(),
            "a scope must only ever be removed through its real parent"
        );
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    /// A child started with the scope's temp variables must resolve its temporary
    /// directory inside the scope; that is the property the whole fix rests on.
    #[test]
    fn child_temp_environment_resolves_inside_the_scope() {
        let scope = TestScope::create();
        let mut command = temp_probe_command();
        for (key, value) in scope.env() {
            command.env(key, value);
        }
        let output = command.output().expect("run temp probe");
        assert!(output.status.success(), "probe should succeed");
        let reported = String::from_utf8_lossy(&output.stdout);
        let reported = reported.trim();

        assert!(
            reported.starts_with(&scope.root.to_string_lossy().into_owned()),
            "child temp dir {reported} must be inside {}",
            scope.root.display()
        );
    }

    /// A scratch directory left behind with an extraction tree is never removed by
    /// anything other than that invocation's own scope.
    #[tokio::test]
    async fn cleanup_only_touches_its_own_scope() {
        let mine = TestScope::create();
        let other = TestScope::create();
        write_extraction(&mine.root);
        write_extraction(&other.root);

        mine.remove(&scratch_parent_dir()).await;

        assert!(!mine.root.exists());
        assert!(
            other.root.join("_MEI_test").exists(),
            "a different invocation's scratch dir must be untouched"
        );
    }
}
