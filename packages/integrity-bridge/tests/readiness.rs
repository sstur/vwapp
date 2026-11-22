use std::{fs, io::Read, net::TcpListener, process::Stdio, time::Duration};
use tokio::process::Command;
use vw_integrity_bridge::readiness;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn readiness_rejects_stale_pid_partial_and_unbounded_records() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("ready.json");
    fs::write(&path, [])?;
    readiness::publish(&path, "127.0.0.1:8791".parse()?)?;
    assert!(readiness::matches(&path, std::process::id()));
    assert!(!readiness::matches(&path, std::process::id() + 1));
    fs::write(&path, "{\"pid\":")?;
    assert!(!readiness::matches(&path, std::process::id()));
    fs::write(&path, " ".repeat(1025))?;
    assert!(!readiness::matches(&path, std::process::id()));
    Ok(())
}

#[tokio::test]
async fn localhost_fallback_reports_actual_socket_without_contacting_decoy() -> TestResult {
    let dir = tempfile::tempdir()?;
    let decoy = TcpListener::bind(("::1", 0))?;
    let port = decoy.local_addr()?.port();
    decoy.set_nonblocking(true)?;
    let config = dir.path().join("config.json");
    fs::write(
        &config,
        serde_json::json!({
            "serial":"test", "adb":"/does/not/exist", "apiKey":"a".repeat(48),
            "host":"localhost", "port":port, "package":"com.vw.carnet.release",
            "versionCode":"1800220674", "activity":"com.vw.myVW.activities.RoutingActivity",
            "fridaServer":"/tmp/frida"
        })
        .to_string(),
    )?;
    let ready = dir.path().join("ready.json");
    fs::write(&ready, [])?;
    let mut child = Command::new(env!("CARGO_BIN_EXE_vw-integrity-bridge"))
        .arg("serve")
        .arg("--config")
        .arg(config)
        .arg("--ready-file")
        .arg(&ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let pid = child.id().ok_or("missing child pid")?;
    let check: TestResult = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !readiness::matches(&ready, pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&ready)?)?;
        let expected = format!("127.0.0.1:{port}");
        assert_eq!(
            value.get("address").and_then(serde_json::Value::as_str),
            Some(expected.as_str())
        );
        assert_eq!(
            decoy
                .accept()
                .err()
                .ok_or("unexpected contact with IPv6 decoy")?
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port))?;
        std::io::Write::write_all(&mut socket, b"GET /healthz HTTP/1.1\r\nHost: test\r\n\r\n")?;
        socket.set_read_timeout(Some(Duration::from_secs(1)))?;
        let mut response = String::new();
        socket.read_to_string(&mut response)?;
        assert!(response.starts_with("HTTP/1.1 401"));
        Ok(())
    }
    .await;
    child.kill().await?;
    child.wait().await?;
    check
}
