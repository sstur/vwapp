use std::{path::PathBuf, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::{sleep, timeout},
};
use vw_integrity_bridge::{
    config::Config,
    server::{Worker, serve},
};

type TestResult = Result<(), Box<dyn std::error::Error>>;
const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn body() -> String {
    format!(r#"{{"requestHash":"{}="}}"#, "a".repeat(43))
}
fn success() -> String {
    format!(
        "cat >/dev/null; printf '%s' '{{\"token\":\"{}\"}}'",
        "t".repeat(150)
    )
}
struct Harness {
    port: u16,
    stop: watch::Sender<bool>,
    _dir: TempDir,
}
impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
impl Harness {
    async fn new(script: &str, deadline: Duration) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let config: Config = serde_json::from_value(
            serde_json::json!({"serial":"test","adb":"/test/adb","apiKey":KEY,"host":"127.0.0.1","port":8792,"package":"com.vw.carnet.release","versionCode":"1800220674","activity":"com.vw.myVW.activities.RoutingActivity","fridaServer":"/tmp/frida"}),
        )?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (stop, rx) = watch::channel(false);
        let worker = Worker {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            deadline,
        };
        let lock = dir.path().join("lock");
        tokio::spawn(async move {
            let _ = serve(listener, config, worker, lock, rx).await;
        });
        Ok(Self {
            port,
            stop,
            _dir: dir,
        })
    }
    async fn raw(&self, request: &str) -> Result<String, Box<dyn std::error::Error>> {
        raw(self.port, request).await
    }
    async fn post(&self, body: &str) -> Result<String, Box<dyn std::error::Error>> {
        self.raw(&post(body)).await
    }
    async fn health(&self) -> Result<String, Box<dyn std::error::Error>> {
        self.raw(&format!(
            "GET /healthz HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {KEY}\r\n\r\n"
        ))
        .await
    }
}
fn post(body: &str) -> String {
    format!(
        "POST /v1/integrity HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {KEY}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
async fn raw(port: u16, request: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(request.as_bytes()).await?;
    let mut out = String::new();
    timeout(Duration::from_secs(8), socket.read_to_string(&mut out)).await??;
    Ok(out)
}
#[tokio::test]
async fn auth_routes_and_exact_json_contract() -> TestResult {
    let h = Harness::new(&success(), Duration::from_secs(2)).await?;
    assert!(
        h.raw("GET /healthz HTTP/1.1\r\nHost: test\r\n\r\n")
            .await?
            .starts_with("HTTP/1.1 401")
    );
    assert!(
        h.raw(&post(&body()).replace("/v1/integrity", "/command"))
            .await?
            .starts_with("HTTP/1.1 404")
    );
    for b in [
        "[]".into(),
        "null".into(),
        "{".into(),
        "{}".into(),
        r#"{"password":"secret"}"#.into(),
        body().replace("=\"}", "=\\n\"}"),
        format!("{{\"requestHash\":\"{}=\",\"extra\":1}}", "a".repeat(43)),
        format!("{{\"requestHash\":\"{}\"}}", "a".repeat(2048)),
    ] {
        assert!(h.post(&b).await?.starts_with("HTTP/1.1 400"));
    }
    assert!(h.health().await?.contains("\"lastSuccessAt\":null"));
    let ok = h.post(&body()).await?;
    assert!(ok.starts_with("HTTP/1.1 200"));
    assert!(ok.to_lowercase().contains("cache-control: no-store"));
    assert!(!h.health().await?.contains("\"lastSuccessAt\":null"));
    Ok(())
}
#[tokio::test]
async fn rejects_chunking_and_duplicate_fields() -> TestResult {
    let h = Harness::new("exit 99", Duration::from_secs(1)).await?;
    let request = format!(
        "POST /v1/integrity HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {KEY}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
    );
    assert!(h.raw(&request).await?.starts_with("HTTP/1.1 400"));
    let duplicate = format!(
        r#"{{"requestHash":"{}=","requestHash":"{}="}}"#,
        "a".repeat(43),
        "a".repeat(43)
    );
    assert!(h.post(&duplicate).await?.starts_with("HTTP/1.1 400"));
    Ok(())
}
#[tokio::test]
async fn concurrency_disconnect_and_health() -> TestResult {
    let h = Harness::new(&format!("sleep 0.4; {}", success()), Duration::from_secs(2)).await?;
    let mut client = TcpStream::connect(("127.0.0.1", h.port)).await?;
    client.write_all(post(&body()).as_bytes()).await?;
    sleep(Duration::from_millis(60)).await;
    drop(client);
    assert!(h.post(&body()).await?.contains("BRIDGE_BUSY"));
    assert!(
        timeout(Duration::from_millis(150), h.health())
            .await??
            .starts_with("HTTP/1.1 200")
    );
    sleep(Duration::from_millis(500)).await;
    assert!(h.post(&body()).await?.starts_with("HTTP/1.1 200"));
    Ok(())
}
#[tokio::test]
async fn crashes_timeouts_bad_tokens_do_not_leak_or_poison_slot() -> TestResult {
    for script in [
        "printf 'secret'; exit 1",
        "printf '{\"token\":\"secret\"}'",
        "sleep 30",
    ] {
        let h = Harness::new(script, Duration::from_millis(150)).await?;
        for _ in 0..2 {
            let r = h.post(&body()).await?;
            assert!(r.starts_with("HTTP/1.1 503"));
            assert!(r.contains("INTEGRITY_UNAVAILABLE"));
            assert!(!r.contains("secret"));
        }
        assert!(h.health().await?.contains("\"lastSuccessAt\":null"));
    }
    Ok(())
}
#[tokio::test]
async fn incomplete_body_has_a_deadline() -> TestResult {
    let h = Harness::new("exit 99", Duration::from_secs(1)).await?;
    let request = format!(
        "POST /v1/integrity HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {KEY}\r\nContent-Length: 500\r\n\r\n{{"
    );
    assert!(h.raw(&request).await?.starts_with("HTTP/1.1 400"));
    assert!(h.health().await?.starts_with("HTTP/1.1 200"));
    Ok(())
}

#[tokio::test]
async fn shutdown_drains_an_active_mint() -> TestResult {
    let h = Harness::new(&format!("sleep 0.2; {}", success()), Duration::from_secs(2)).await?;
    let mut socket = TcpStream::connect(("127.0.0.1", h.port)).await?;
    socket.write_all(post(&body()).as_bytes()).await?;
    sleep(Duration::from_millis(50)).await;
    h.stop.send(true)?;
    let mut response = String::new();
    timeout(Duration::from_secs(2), socket.read_to_string(&mut response)).await??;
    assert!(response.starts_with("HTTP/1.1 200"));
    Ok(())
}
#[test]
fn launchd_runs_unprivileged_at_boot() -> TestResult {
    let p = vw_integrity_bridge::install::job_plist(
        "test",
        &PathBuf::from("/Library/test/bin"),
        vec!["serve".into()],
        &PathBuf::from("/Users/me/config.json"),
        "me",
        &PathBuf::from("/Users/me"),
    )?;
    let d = p.as_dictionary().ok_or("not a dictionary")?;
    assert_eq!(
        d.get("UserName").and_then(plist::Value::as_string),
        Some("me")
    );
    assert_eq!(
        d.get("KeepAlive").and_then(plist::Value::as_boolean),
        Some(true)
    );
    assert_eq!(
        d.get("RunAtLoad").and_then(plist::Value::as_boolean),
        Some(true)
    );
    assert!(d.get("LimitLoadToSessionType").is_none());
    Ok(())
}
