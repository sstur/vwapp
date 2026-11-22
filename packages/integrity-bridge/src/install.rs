//! System launchd installation. The installed service runs as the user, not root.
use crate::{Error, Result, config::Config};
use nix::unistd::{Gid, Uid, User, chown, geteuid};
use plist::{Dictionary, Value};
use std::{
    fs::{self, OpenOptions, Permissions},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LABEL: &str = "com.vwapp.integrity-bridge";
const TUNNEL: &str = "com.vwapp.android-tunnel";
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
fn command(program: &str, args: &[&str]) -> Result<bool> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if start.elapsed() > Duration::from_secs(100) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Timeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
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
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)?;
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
fn health(config: &Config) -> bool {
    let host = if config.host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        &config.host
    };
    let Some(address) = (host, config.port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
    else {
        return false;
    };
    let Ok(mut socket) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
        return false;
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = socket.set_write_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "GET /healthz HTTP/1.1\r\nHost: bridge\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        config.api_key
    );
    if socket.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    socket.take(4096).read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("vw-integrity")
}
struct Job {
    label: &'static str,
    system: PathBuf,
    previous: Option<Vec<u8>>,
    system_loaded: bool,
    legacy: PathBuf,
    legacy_bytes: Option<Vec<u8>>,
    legacy_loaded: bool,
    value: Value,
}
impl Job {
    fn new(label: &'static str, home: &Path, gui: &str, value: Value) -> Result<Self> {
        let system = PathBuf::from(format!("/Library/LaunchDaemons/{label}.plist"));
        let legacy = home.join(format!("Library/LaunchAgents/{label}.plist"));
        Ok(Self {
            label,
            previous: read_optional(&system)?,
            system_loaded: loaded("system", label)?,
            legacy_bytes: read_optional(&legacy)?,
            legacy_loaded: loaded(gui, label)?,
            system,
            legacy,
            value,
        })
    }
    fn activate(&self, gui: &str) -> Result<()> {
        stop(gui, self.label)?;
        stop("system", self.label)?;
        atomic(&self.system, &plist_bytes(&self.value)?, 0o644)?;
        start("system", &self.system)
    }
    fn restore(&self, gui: &str) -> Result<()> {
        stop(gui, self.label)?;
        stop("system", self.label)?;
        if let Some(bytes) = &self.previous {
            atomic(&self.system, bytes, 0o644)?;
            if self.system_loaded {
                start("system", &self.system)?;
            }
        } else if self.system.exists() {
            fs::remove_file(&self.system)?;
        }
        if let Some(bytes) = &self.legacy_bytes {
            atomic(&self.legacy, bytes, 0o600)?;
        }
        if self.legacy_loaded {
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
    let config = Config::load(&config_path)?;
    let original_config = fs::read(&config_path)?;
    let home = &user.dir;
    let gui = format!("gui/{}", user.uid);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Install)?
        .as_nanos();
    let base = Path::new("/Library/Application Support/VWIntegrityBridge");
    fs::create_dir_all(base)?;
    fs::set_permissions(base, Permissions::from_mode(0o755))?;
    let release = base.join(format!("2.0.0-{stamp}"));
    fs::create_dir(&release)?;
    fs::set_permissions(&release, Permissions::from_mode(0o755))?;
    let binary = release.join("vw-integrity-bridge");
    fs::copy(std::env::current_exe()?, &binary)?;
    // macOS copyfile may preserve the source owner even when called as root.
    chown(&binary, Some(Uid::from_raw(0)), Some(Gid::from_raw(0))).map_err(|_| Error::Install)?;
    fs::set_permissions(&binary, Permissions::from_mode(0o755))?;
    let adb = release.join("adb");
    fs::copy(&config.adb, &adb)?;
    chown(&adb, Some(Uid::from_raw(0)), Some(Gid::from_raw(0))).map_err(|_| Error::Install)?;
    fs::set_permissions(&adb, Permissions::from_mode(0o755))?;
    if !command(&text(&binary)?, &["--version"])? || !command(&text(&adb)?, &["version"])? {
        return Err(Error::Install);
    }
    let mut updated: serde_json::Value =
        serde_json::from_slice(&original_config).map_err(|_| Error::Config)?;
    updated["adb"] = serde_json::Value::String(text(&adb)?);
    let new_config = serde_json::to_vec_pretty(&updated).map_err(|_| Error::Config)?;
    let mut jobs = vec![Job::new(
        LABEL,
        home,
        &gui,
        job_plist(
            LABEL,
            &binary,
            vec!["serve".into(), "--config".into(), text(&config_path)?],
            &config_path,
            name,
            home,
        )?,
    )?];
    let tunnel_gui = home.join(format!("Library/LaunchAgents/{TUNNEL}.plist"));
    let tunnel_system = PathBuf::from(format!("/Library/LaunchDaemons/{TUNNEL}.plist"));
    let tunnel_source = if tunnel_system.exists() {
        &tunnel_system
    } else {
        &tunnel_gui
    };
    if tunnel_source.exists() {
        let mut tunnel = Value::from_file(tunnel_source).map_err(|_| Error::Install)?;
        let d = tunnel.as_dictionary_mut().ok_or(Error::Install)?;
        d.remove("LimitLoadToSessionType");
        d.insert("UserName".into(), string(name));
        d.insert("RunAtLoad".into(), Value::Boolean(true));
        d.insert("KeepAlive".into(), Value::Boolean(true));
        d.insert("ThrottleInterval".into(), Value::Integer(5.into()));
        let mut env = Dictionary::new();
        env.insert("HOME".into(), string(text(home)?));
        d.insert("EnvironmentVariables".into(), Value::Dictionary(env));
        jobs.push(Job::new(TUNNEL, home, &gui, tunnel)?);
    }
    let backup = config_path
        .parent()
        .ok_or(Error::Config)?
        .join(format!("before-rust-{stamp}"));
    fs::create_dir(&backup)?;
    chown(&backup, Some(user.uid), Some(user.gid)).map_err(|_| Error::Install)?;
    fs::write(backup.join("config.json"), &original_config)?;
    for job in &jobs {
        if let Some(b) = &job.previous {
            fs::write(backup.join(format!("system-{}.plist", job.label)), b)?;
        }
        if let Some(b) = &job.legacy_bytes {
            fs::write(backup.join(format!("gui-{}.plist", job.label)), b)?;
        }
    }
    let result: Result<()> = (|| {
        atomic(&config_path, &new_config, 0o600)?;
        chown(&config_path, Some(user.uid), Some(user.gid)).map_err(|_| Error::Install)?;
        for job in &jobs {
            job.activate(&gui)?;
            if job.label == LABEL {
                let until = Instant::now() + Duration::from_secs(15);
                while !health(&config) {
                    if Instant::now() >= until {
                        return Err(Error::Install);
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
        for job in &jobs {
            if job.legacy.exists() {
                fs::remove_file(&job.legacy)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        atomic(&config_path, &original_config, 0o600)?;
        chown(&config_path, Some(user.uid), Some(user.gid)).map_err(|_| Error::Install)?;
        let mut restored = true;
        for job in jobs.iter().rev() {
            if job.restore(&gui).is_err() {
                restored = false;
            }
        }
        eprintln!("Installation failed; previous jobs restored: {restored}");
        return Err(Error::Install);
    }
    println!(
        "Installed system LaunchDaemon as {name}; local health verified. Binary: {}",
        binary.display()
    );
    Ok(())
}
