use std::{
    fs,
    net::TcpListener,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn worker_lock_prevents_overlap_during_supervisor_restart()
-> Result<(), Box<dyn std::error::Error>> {
    use nix::fcntl::{Flock, FlockArg};
    let dir = tempfile::tempdir()?;
    let config = dir.path().join("config.json");
    fs::write(
        &config,
        serde_json::json!({
            "serial":"test", "adb":"/does/not/exist", "apiKey":"a".repeat(48),
            "host":"127.0.0.1", "port":8792, "package":"com.vw.carnet.release",
            "versionCode":"1800220674", "activity":"com.vw.myVW.activities.RoutingActivity",
            "fridaServer":"/tmp/frida"
        })
        .to_string(),
    )?;
    let file = fs::File::create(dir.path().join(".integrity-native.lock"))?;
    let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, e)| e)?;
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_vw-integrity-bridge"));
    command
        .args(["mint", "--config"])
        .arg(&config)
        .stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(2), command.output()).await??;
    assert!(!output.status.success());
    assert_eq!(output.stderr, b"CHILD_FAILED\n");
    drop(lock);
    Ok(())
}

/// Exercise the real executable and its ADB child, without touching a phone.
#[tokio::test]
async fn supervisor_crash_does_not_orphan_native_worker_or_adb()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let marker = dir.path().join("pids");
    let adb = dir.path().join("adb");
    fs::write(
        &adb,
        format!(
            "#!/bin/sh\necho $$ $PPID > '{}'\nsleep 30\n",
            marker.display()
        ),
    )?;
    fs::set_permissions(&adb, fs::Permissions::from_mode(0o755))?;
    let bind = TcpListener::bind("127.0.0.1:0")?;
    let port = bind.local_addr()?.port();
    drop(bind);
    let config = dir.path().join("config.json");
    let key = "a".repeat(48);
    fs::write(&config, serde_json::json!({"serial":"test","adb":adb,"apiKey":key,"host":"127.0.0.1","port":port,"package":"com.vw.carnet.release","versionCode":"1800220674","activity":"com.vw.myVW.activities.RoutingActivity","fridaServer":"/tmp/frida"}).to_string())?;
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_vw-integrity-bridge"))
        .arg("serve")
        .arg("--config")
        .arg(config)
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let work = async {
        let mut socket = loop {
            match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                Ok(socket) => break socket,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        let body = serde_json::json!({"requestHash":format!("{}=", "a".repeat(43))}).to_string();
        let request = format!(
            "POST /v1/integrity HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {key}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(request.as_bytes()).await?;
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, Box<dyn std::error::Error>>(())
    };
    let ready = tokio::time::timeout(Duration::from_secs(5), work).await;
    daemon.kill()?;
    daemon.wait()?;
    ready??;
    let pids: Vec<i32> = fs::read_to_string(marker)?
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<_, _>>()?;
    for _ in 0..100 {
        if pids
            .iter()
            .all(|p| nix::sys::signal::kill(nix::unistd::Pid::from_raw(*p), None).is_err())
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err("orphaned worker/ADB after supervisor death".into())
}
