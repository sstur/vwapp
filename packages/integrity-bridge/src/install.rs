//! System launchd installation. The installed service runs as the user, not root.
use crate::{Error, Result, config::Config};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Gid, Pid, Uid, User, chown, fchown, geteuid},
};
use plist::{Dictionary, Value};
use std::{
    fs::{self, OpenOptions, Permissions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LABEL: &str = "com.vwapp.integrity-bridge";
fn string(value: impl Into<String>) -> Value {
    Value::String(value.into())
}
fn text(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or(Error::Install)
}
pub fn job_plist(
    label: &str,
    program: &Path,
    args: Vec<String>,
    config: &Path,
    user: &str,
    home: &Path,
) -> Result<Value> {
    let logs = config.parent().ok_or(Error::Config)?;
    let mut env = Dictionary::new();
    env.insert("HOME".into(), string(text(home)?));
    env.insert("USER".into(), string(user));
    env.insert("PATH".into(), string("/usr/bin:/bin:/usr/sbin:/sbin"));
    let mut d = Dictionary::new();
    d.insert("Label".into(), string(label));
    d.insert("UserName".into(), string(user));
    d.insert(
        "ProgramArguments".into(),
        Value::Array(
            std::iter::once(text(program)?)
                .chain(args)
                .map(string)
                .collect(),
        ),
    );
    d.insert("WorkingDirectory".into(), string(text(home)?));
    d.insert("EnvironmentVariables".into(), Value::Dictionary(env));
    d.insert("RunAtLoad".into(), Value::Boolean(true));
    d.insert("KeepAlive".into(), Value::Boolean(true));
    d.insert("ThrottleInterval".into(), Value::Integer(5.into()));
    d.insert("ExitTimeOut".into(), Value::Integer(90.into()));
    d.insert("Umask".into(), Value::Integer(63.into()));
    d.insert("ProcessType".into(), string("Background"));
    d.insert(
        "StandardOutPath".into(),
        string(text(&logs.join(format!("{label}.log")))?),
    );
    d.insert(
        "StandardErrorPath".into(),
        string(text(&logs.join(format!("{label}-error.log")))?),
    );
    Ok(Value::Dictionary(d))
}
fn execute(mut command: Command) -> Result<bool> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    let pid = Pid::from_raw(i32::try_from(child.id()).map_err(|_| Error::Install)?);
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let _ = killpg(pid, Signal::SIGKILL);
            return Ok(status.success());
        }
        if start.elapsed() > Duration::from_secs(100) {
            let _ = killpg(pid, Signal::SIGKILL);
            let _ = child.wait();
            return Err(Error::Timeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn command(program: &str, args: &[&str]) -> Result<bool> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    execute(cmd)
}
fn user_command(user: &User, program: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("/usr/bin/sudo");
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", &user.dir)
        .env("USER", &user.name)
        .args([
            "-n",
            "-H",
            "-u",
            &format!("#{}", user.uid),
            "-g",
            &format!("#{}", user.gid),
            "--",
        ])
        .arg(program)
        .args(args);
    cmd
}
fn as_user(user: &User, program: &Path, args: &[&str]) -> Result<bool> {
    execute(user_command(user, program, args))
}
fn capture(cmd: Command, deadline: Duration, limit: usize) -> Result<crate::process::Output> {
    let mut cmd = tokio::process::Command::from(cmd);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(crate::process::run(&mut cmd, &[], deadline, limit))
}
fn read_as_user(user: &User, reader: &Path, path: &Path) -> Result<Option<Vec<u8>>> {
    let output = capture(
        user_command(user, reader, &["inspect-file", "--path", &text(path)?]),
        Duration::from_secs(15),
        FILE_LIMIT * 5 + 4,
    )?;
    if !output.success {
        return Err(Error::Install);
    }
    let bytes: Option<Vec<u8>> =
        serde_json::from_slice(&output.stdout).map_err(|_| Error::Install)?;
    if bytes.as_ref().is_some_and(|b| b.len() > FILE_LIMIT) {
        return Err(Error::Install);
    }
    Ok(bytes)
}
fn loaded(domain: &str, label: &str) -> Result<bool> {
    command("/bin/launchctl", &["print", &format!("{domain}/{label}")])
}
fn stop(domain: &str, label: &str) -> Result<()> {
    if loaded(domain, label)?
        && !command("/bin/launchctl", &["bootout", &format!("{domain}/{label}")])?
    {
        return Err(Error::Install);
    }
    Ok(())
}
fn start(domain: &str, path: &Path) -> Result<()> {
    for _ in 0..40 {
        if command("/bin/launchctl", &["bootstrap", domain, &text(path)?])? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(Error::Install)
}
const FILE_LIMIT: usize = 65536;
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(Error::Install);
    }
    let mut bytes = Vec::new();
    file.take((FILE_LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > FILE_LIMIT {
        return Err(Error::OutputLimit);
    }
    Ok(Some(bytes))
}
/// Internal bounded file probe, invoked as the service user by the installer.
pub fn inspect_file(path: &Path) -> Result<()> {
    serde_json::to_writer(std::io::stdout().lock(), &read_optional(path)?)
        .map_err(|_| Error::Install)
}
/// Check access to both real lock files, without taking either lock.
pub fn check_locks(path: &Path) -> Result<()> {
    let config = Config::load(path)?;
    for name in [".integrity-device.lock", ".integrity-native.lock"] {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(config.lock_directory(path).join(name))?;
        if !file.metadata()?.is_file() {
            return Err(Error::Install);
        }
    }
    Ok(())
}
fn require_definition(loaded: bool, bytes: Option<&[u8]>, label: &str, path: &Path) -> Result<()> {
    let valid = bytes
        .and_then(|b| Value::from_reader(std::io::Cursor::new(b)).ok())
        .is_some_and(|v| {
            v.as_dictionary()
                .and_then(|d| d.get("Label"))
                .and_then(Value::as_string)
                == Some(label)
        });
    if loaded && !valid {
        eprintln!(
            "Refusing to stop loaded {label}: no valid recoverable definition at {}",
            path.display()
        );
        return Err(Error::Install);
    }
    Ok(())
}
fn loaded_at(domain: &str, label: &str, expected: &Path) -> Result<bool> {
    let mut cmd = Command::new("/bin/launchctl");
    cmd.args(["print", &format!("{domain}/{label}")]);
    let output = capture(cmd, Duration::from_secs(5), 65536)?;
    if !output.success {
        return Ok(false);
    }
    let status = String::from_utf8_lossy(&output.stdout);
    let path = status
        .lines()
        .find_map(|line| line.trim().strip_prefix("path = "));
    let actual = path.and_then(|p| fs::canonicalize(p).ok());
    if actual.is_none() || actual != fs::canonicalize(expected).ok() {
        eprintln!(
            "Refusing to replace {domain}/{label}: loaded definition is not {}",
            expected.display()
        );
        return Err(Error::Install);
    }
    Ok(true)
}
fn atomic(path: &Path, bytes: &[u8], mode: u32, owner: Option<(Uid, Gid)>) -> Result<()> {
    struct Temporary(PathBuf);
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)?;
    let _cleanup = Temporary(temp.clone());
    if let Some((uid, gid)) = owner {
        fchown(&file, Some(uid), Some(gid)).map_err(|_| Error::Install)?;
    }
    file.set_permissions(Permissions::from_mode(mode))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    Ok(())
}
fn plist_bytes(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|_| Error::Install)?;
    Ok(bytes)
}
fn wait_ready(path: &Path, label: &str, deadline: Duration) -> Result<()> {
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        let mut cmd = Command::new("/bin/launchctl");
        cmd.args(["print", &format!("system/{label}")]);
        let output = capture(cmd, until.saturating_duration_since(Instant::now()), 65536)?;
        let status = String::from_utf8_lossy(&output.stdout);
        if status
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("pid = ")
                    .and_then(|p| p.parse::<u32>().ok())
            })
            .is_some_and(|pid| crate::readiness::matches(path, pid))
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(Error::Install)
}
struct Job {
    label: &'static str,
    system: PathBuf,
    previous: Option<Vec<u8>>,
    system_loaded: bool,
    legacy: PathBuf,
    legacy_bytes: Option<Vec<u8>>,
    previous_mode: u32,
    system_changed: bool,
    replacement_published: bool,
    legacy_stopped: bool,
    legacy_loaded: bool,
    value: Value,
}
impl Job {
    fn new(
        label: &'static str,
        user: &User,
        reader: &Path,
        gui: &str,
        value: Value,
    ) -> Result<Self> {
        let system = PathBuf::from(format!("/Library/LaunchDaemons/{label}.plist"));
        let legacy = user.dir.join(format!("Library/LaunchAgents/{label}.plist"));
        let previous = read_optional(&system)?;
        let legacy_bytes = read_as_user(user, reader, &legacy)?;
        let system_loaded = loaded_at("system", label, &system)?;
        let legacy_loaded = loaded_at(gui, label, &legacy)?;
        require_definition(system_loaded, previous.as_deref(), label, &system)?;
        require_definition(legacy_loaded, legacy_bytes.as_deref(), label, &legacy)?;
        Ok(Self {
            label,
            previous,
            previous_mode: fs::metadata(&system)
                .map(|m| m.mode() & 0o777)
                .unwrap_or(0o600),
            system_changed: false,
            replacement_published: false,
            legacy_stopped: false,
            system_loaded,
            legacy_bytes,
            legacy_loaded,
            system,
            legacy,
            value,
        })
    }
    fn activate(&mut self, gui: &str) -> Result<()> {
        if self.legacy_loaded {
            stop(gui, self.label)?;
            self.legacy_stopped = true;
        }
        stop("system", self.label)?;
        self.system_changed = true;
        atomic(&self.system, &plist_bytes(&self.value)?, 0o600, None)?;
        self.replacement_published = true;
        start("system", &self.system)
    }
    fn restore(&self, gui: &str) -> Result<()> {
        if self.system_changed {
            stop("system", self.label)?;
            if let Some(bytes) = &self.previous {
                if self.replacement_published {
                    atomic(&self.system, bytes, self.previous_mode, None)?;
                }
                if self.system_loaded {
                    start("system", &self.system)?;
                }
            } else if self.replacement_published && self.system.exists() {
                fs::remove_file(&self.system)?;
            }
        }
        // The legacy plist is never rewritten; ownership/mode remain intact.
        if self.legacy_stopped && !loaded(gui, self.label)? {
            start(gui, &self.legacy)?;
        }
        Ok(())
    }
}
pub fn install(config_path: &Path, name: &str) -> Result<()> {
    if !geteuid().is_root() {
        eprintln!("Install requires sudo; the daemon runs as the specified user.");
        return Err(Error::Install);
    }
    let user = User::from_name(name)
        .map_err(|_| Error::Install)?
        .ok_or(Error::Install)?;
    if user.uid.is_root() {
        return Err(Error::Install);
    }
    let config_path = fs::canonicalize(config_path)?;
    let home = &user.dir;
    let gui = format!("gui/{}", user.uid);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Install)?
        .as_nanos();
    let base = Path::new("/Library/Application Support/VWIntegrityBridge");
    fs::create_dir_all(base)?;
    let metadata = fs::symlink_metadata(base)?;
    if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(Error::Install);
    }
    fs::set_permissions(base, Permissions::from_mode(0o755))?;
    let release = base.join(format!("2.0.0-{stamp}"));
    fs::create_dir(&release)?;
    fs::set_permissions(&release, Permissions::from_mode(0o755))?;
    let binary = release.join("vw-integrity-bridge");
    fs::copy(std::env::current_exe()?, &binary)?;
    // macOS copyfile may preserve the source owner even when called as root.
    chown(&binary, Some(Uid::from_raw(0)), Some(Gid::from_raw(0))).map_err(|_| Error::Install)?;
    fs::set_permissions(&binary, Permissions::from_mode(0o755))?;
    let original_config = read_as_user(&user, &binary, &config_path)?.ok_or(Error::Config)?;
    let config = Config::parse(&original_config)?;
    let adb = release.join("adb");
    // Read and copy the configured executable without root privileges.
    atomic(&adb, &[], 0o600, Some((user.uid, user.gid)))?;
    if !as_user(
        &user,
        Path::new("/bin/cp"),
        &[&text(&config.adb)?, &text(&adb)?],
    )? {
        return Err(Error::Install);
    }
    chown(&adb, Some(Uid::from_raw(0)), Some(Gid::from_raw(0))).map_err(|_| Error::Install)?;
    fs::set_permissions(&adb, Permissions::from_mode(0o755))?;
    if !as_user(&user, &binary, &["--version"])? || !as_user(&user, &adb, &["version"])? {
        return Err(Error::Install);
    }
    let mut updated: serde_json::Value =
        serde_json::from_slice(&original_config).map_err(|_| Error::Config)?;
    updated["adb"] = serde_json::Value::String(text(&adb)?);
    updated["lockDirectory"] =
        serde_json::Value::String(text(&config.lock_directory(&config_path))?);
    let new_config = serde_json::to_vec_pretty(&updated).map_err(|_| Error::Config)?;
    let deployed_config = release.join("config.json");
    atomic(
        &deployed_config,
        &new_config,
        0o600,
        Some((user.uid, user.gid)),
    )?;
    if !as_user(
        &user,
        &binary,
        &["check-locks", "--config", &text(&deployed_config)?],
    )? {
        return Err(Error::Install);
    }
    let ready_file = release.join("ready.json");
    atomic(&ready_file, &[], 0o600, Some((user.uid, user.gid)))?;
    for name in [format!("{LABEL}.log"), format!("{LABEL}-error.log")] {
        atomic(&release.join(name), &[], 0o600, Some((user.uid, user.gid)))?;
    }
    let mut job = Job::new(
        LABEL,
        &user,
        &binary,
        &gui,
        job_plist(
            LABEL,
            &binary,
            vec![
                "serve".into(),
                "--config".into(),
                text(&deployed_config)?,
                "--ready-file".into(),
                text(&ready_file)?,
            ],
            &deployed_config,
            name,
            home,
        )?,
    )?;
    // Root never writes into the user-controlled source config/backup directory.
    let backup = release.join("backup");
    fs::create_dir(&backup)?;
    fs::set_permissions(&backup, Permissions::from_mode(0o700))?;
    atomic(&backup.join("config.json"), &original_config, 0o600, None)?;
    if let Some(bytes) = &job.previous {
        atomic(&backup.join("system.plist"), bytes, 0o600, None)?;
    }
    if let Some(bytes) = &job.legacy_bytes {
        atomic(&backup.join("gui.plist"), bytes, 0o600, None)?;
    }
    let result: Result<()> = (|| {
        job.activate(&gui)?;
        wait_ready(&ready_file, LABEL, Duration::from_secs(15))?;
        // Commit last: no later fallible operation can require restoring this file.
        if job.legacy.exists()
            && !as_user(
                &user,
                Path::new("/bin/rm"),
                &["-f", "--", &text(&job.legacy)?],
            )?
        {
            return Err(Error::Install);
        }
        Ok(())
    })();
    if result.is_err() {
        let restored = job.restore(&gui).is_ok();
        eprintln!("Installation failed; previous job restored: {restored}");
        return Err(Error::Install);
    }
    println!(
        "Installed system LaunchDaemon as {name}; new process readiness verified. Binary: {}",
        binary.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;
    fn fixture(dir: &Path) -> Result<Job> {
        let system = dir.join("system.plist");
        let legacy = dir.join("legacy.plist");
        fs::write(&system, b"replacement")?;
        fs::write(&legacy, b"original GUI plist")?;
        fs::set_permissions(&legacy, Permissions::from_mode(0o640))?;
        Ok(Job {
            label: "com.vwapp.nonexistent-installer-fixture",
            system,
            legacy,
            previous: Some(b"original system plist".to_vec()),
            previous_mode: 0o640,
            system_loaded: false,
            legacy_loaded: false,
            legacy_bytes: Some(b"original GUI plist".to_vec()),
            system_changed: false,
            replacement_published: false,
            legacy_stopped: false,
            value: Value::Dictionary(Dictionary::new()),
        })
    }
    #[test]
    fn rollback_only_touches_activated_job_and_preserves_legacy_file() -> TestResult {
        let dir = tempfile::tempdir()?;
        let mut job = fixture(dir.path())?;
        let original = fs::metadata(&job.legacy)?;
        job.restore("gui/0")?;
        assert_eq!(fs::read(&job.system)?, b"replacement");
        job.system_changed = true;
        job.replacement_published = true;
        job.restore("gui/0")?;
        assert_eq!(fs::read(&job.system)?, b"original system plist");
        assert_eq!(fs::metadata(&job.system)?.mode() & 0o777, 0o640);
        let restored = fs::metadata(&job.legacy)?;
        assert_eq!(
            (
                original.ino(),
                original.uid(),
                original.gid(),
                original.mode()
            ),
            (
                restored.ino(),
                restored.uid(),
                restored.gid(),
                restored.mode()
            )
        );
        assert_eq!(fs::read(&job.legacy)?, b"original GUI plist");
        Ok(())
    }
    #[test]
    fn atomic_publication_preserves_private_metadata_and_rejects_temp_symlinks() -> TestResult {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("config.json");
        atomic(&path, b"old", 0o600, None)?;
        let old = fs::metadata(&path)?;
        atomic(
            &path,
            b"new",
            0o600,
            Some((Uid::from_raw(old.uid()), Gid::from_raw(old.gid()))),
        )?;
        let new = fs::metadata(&path)?;
        assert_eq!(
            (new.uid(), new.gid(), new.mode() & 0o777),
            (old.uid(), old.gid(), 0o600)
        );
        let temp = path.with_extension(format!("tmp-{}", std::process::id()));
        std::os::unix::fs::symlink(&path, temp)?;
        assert!(atomic(&path, b"must not write", 0o600, None).is_err());
        assert_eq!(fs::read(path)?, b"new");
        Ok(())
    }
    /// Opt-in, isolated real launchd rollback exercise. Does not touch production.
    #[test]
    #[ignore = "requires sudo and VW_BRIDGE_TEST_USER; uses an isolated launchd label"]
    fn privileged_preflight_and_failed_launchagent_migration() -> TestResult {
        assert!(geteuid().is_root());
        let name = std::env::var("VW_BRIDGE_TEST_USER")?;
        let user = User::from_name(&name)?.ok_or("unknown test user")?;
        assert!(!user.uid.is_root());
        let label = "com.vwapp.integrity-installer-regression";
        let gui = format!("gui/{}", user.uid);
        let legacy = user.dir.join(format!("Library/LaunchAgents/{label}.plist"));
        let system = PathBuf::from(format!("/Library/LaunchDaemons/{label}.plist"));
        assert!(!legacy.exists() && !system.exists());
        assert!(!loaded(&gui, label)? && !loaded("system", label)?);
        // root's per-user macOS TMPDIR has non-traversable ancestors.
        let dir = tempfile::tempdir_in("/private/tmp")?;
        fs::set_permissions(dir.path(), Permissions::from_mode(0o755))?;
        let marker = dir.path().join("preflight-user");
        atomic(&marker, &[], 0o600, Some((user.uid, user.gid)))?;
        let probe = dir.path().join("adb-probe");
        let script = format!(
            "#!/bin/sh\n/usr/bin/id -u > '{}'\n/usr/bin/id -g >> '{}'\n",
            marker.display(),
            marker.display()
        );
        atomic(&probe, script.as_bytes(), 0o755, None)?;
        assert!(as_user(&user, &probe, &["version"])?);
        assert_eq!(
            fs::read_to_string(&marker)?,
            format!("{}\n{}\n", user.uid, user.gid)
        );
        let staged = dir.path().join("stage.json");
        atomic(
            &staged,
            b"private config",
            0o600,
            Some((user.uid, user.gid)),
        )?;
        let reader = PathBuf::from(std::env::var("VW_BRIDGE_TEST_BINARY")?);
        assert_eq!(
            read_as_user(&user, &reader, &staged)?.ok_or("missing staged file")?,
            b"private config"
        );
        assert_eq!(
            read_as_user(&user, &reader, &dir.path().join("absent"))?,
            None
        );
        let unreadable = dir.path().join("root-only");
        atomic(&unreadable, b"root private", 0o600, None)?;
        assert!(read_as_user(&user, &reader, &unreadable).is_err());
        let lock_config = dir.path().join("locks-config.json");
        let config = serde_json::json!({
            "serial":"test", "adb":"/bin/false", "apiKey":"a".repeat(48),
            "host":"127.0.0.1", "port":8792, "package":"com.vw.carnet.release",
            "versionCode":"1800220674", "activity":"com.vw.myVW.activities.RoutingActivity",
            "fridaServer":"/tmp/frida", "lockDirectory":dir.path()
        });
        atomic(
            &lock_config,
            &serde_json::to_vec(&config)?,
            0o600,
            Some((user.uid, user.gid)),
        )?;
        assert!(!as_user(
            &user,
            &reader,
            &["check-locks", "--config", &text(&lock_config)?]
        )?);
        for name in [".integrity-device.lock", ".integrity-native.lock"] {
            atomic(
                &dir.path().join(name),
                &[],
                0o600,
                Some((user.uid, user.gid)),
            )?;
        }
        let held_file = fs::File::open(dir.path().join(".integrity-device.lock"))?;
        let held_lock =
            nix::fcntl::Flock::lock(held_file, nix::fcntl::FlockArg::LockExclusiveNonblock)
                .map_err(|(_, e)| e)?;
        assert!(as_user(
            &user,
            &reader,
            &["check-locks", "--config", &text(&lock_config)?]
        )?);
        drop(held_lock);
        let mut original = Dictionary::new();
        original.insert("Label".into(), string(label));
        original.insert(
            "ProgramArguments".into(),
            Value::Array(vec![string("/bin/sleep"), string("300")]),
        );
        original.insert("RunAtLoad".into(), Value::Boolean(true));
        let bytes = plist_bytes(&Value::Dictionary(original))?;
        // Test fixture only: production never rewrites a user-owned LaunchAgent.
        atomic(&legacy, &bytes, 0o640, Some((user.uid, user.gid)))?;
        let result: TestResult = (|| {
            start(&gui, &legacy)?;
            let before = fs::metadata(&legacy)?;
            let replacement = job_plist(
                label,
                Path::new("/usr/bin/false"),
                vec![],
                &staged,
                &name,
                &user.dir,
            )?;
            let displaced = dir.path().join("displaced.plist");
            fs::rename(&legacy, &displaced)?;
            let refused = Job::new(label, &user, &reader, &gui, replacement.clone()).is_err();
            fs::rename(&displaced, &legacy)?;
            assert!(refused && loaded(&gui, label)?);
            let mut job = Job::new(label, &user, &reader, &gui, replacement)?;
            job.activate(&gui)?;
            assert!(
                wait_ready(
                    &dir.path().join("absent-ready"),
                    label,
                    Duration::from_millis(500)
                )
                .is_err()
            );
            job.restore(&gui)?;
            assert!(loaded(&gui, label)?);
            assert!(!loaded("system", label)? && !system.exists());
            let after = fs::metadata(&legacy)?;
            assert_eq!(
                (before.ino(), before.uid(), before.gid(), before.mode()),
                (after.ino(), after.uid(), after.gid(), after.mode())
            );
            assert_eq!(fs::read(&legacy)?, bytes);
            Ok(())
        })();
        let _ = stop(&gui, label);
        let _ = stop("system", label);
        let _ = fs::remove_file(legacy);
        let _ = fs::remove_file(system);
        result
    }
    #[test]
    fn loaded_jobs_require_a_valid_recoverable_definition() -> TestResult {
        let path = Path::new("/missing/plist");
        assert!(require_definition(false, None, "test", path).is_ok());
        assert!(require_definition(true, None, "test", path).is_err());
        assert!(require_definition(true, Some(b"invalid plist"), "test", path).is_err());
        let mut d = Dictionary::new();
        d.insert("Label".into(), string("test"));
        let bytes = plist_bytes(&Value::Dictionary(d))?;
        assert!(require_definition(true, Some(&bytes), "test", path).is_ok());
        assert!(require_definition(true, Some(&bytes), "other", path).is_err());
        Ok(())
    }
    #[test]
    fn snapshot_reads_reject_nonregular_and_oversized_files() -> TestResult {
        let dir = tempfile::tempdir()?;
        assert_eq!(read_optional(&dir.path().join("absent"))?, None);
        assert!(read_optional(dir.path()).is_err());
        let fifo = dir.path().join("fifo");
        nix::unistd::mkfifo(
            &fifo,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )?;
        let start = Instant::now();
        assert!(read_optional(&fifo).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        let big = dir.path().join("large");
        fs::write(&big, vec![b'x'; FILE_LIMIT + 1])?;
        assert!(matches!(read_optional(&big), Err(Error::OutputLimit)));
        Ok(())
    }
    #[test]
    fn subprocess_capture_deadline_kills_and_reaps_stalled_probe() -> TestResult {
        let dir = tempfile::tempdir()?;
        let marker = dir.path().join("pid");
        let script = format!("echo $$ > '{}'; exec /bin/sleep 30", marker.display());
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        let start = Instant::now();
        assert!(matches!(
            capture(cmd, Duration::from_millis(200), 1024),
            Err(Error::Timeout)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
        let pid = Pid::from_raw(fs::read_to_string(marker)?.trim().parse()?);
        assert!(nix::sys::signal::kill(pid, None).is_err());
        Ok(())
    }
}
