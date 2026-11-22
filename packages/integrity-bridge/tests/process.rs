use std::time::Duration;
use tokio::process::Command;
use vw_integrity_bridge::{
    config::IntegrityRequest,
    device::{matches_version, parse_pid, shell_quote},
    process,
};
type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn pipes_are_bounded_and_failure_does_not_include_stderr() -> TestResult {
    let mut echo = Command::new("/bin/sh");
    echo.args(["-c", "cat; echo 'secret diagnostic' >&2"]);
    let result = process::run(&mut echo, b"hello", Duration::from_secs(2), 64).await?;
    assert!(result.success);
    assert_eq!(result.stdout, b"hello");
    let mut overflow = Command::new("/usr/bin/yes");
    assert!(matches!(
        process::run(&mut overflow, &[], Duration::from_secs(2), 64).await,
        Err(vw_integrity_bridge::Error::OutputLimit)
    ));
    Ok(())
}
#[tokio::test]
async fn deadline_kills_descendants_and_reaps() -> TestResult {
    let dir = tempfile::tempdir()?;
    let file = dir.path().join("pid");
    let script = format!(
        "sleep 30 & echo $! > {}; wait",
        shell_quote(file.to_str().ok_or("path")?)
    );
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &script]);
    assert!(matches!(
        process::run(&mut cmd, &[], Duration::from_millis(200), 64).await,
        Err(vw_integrity_bridge::Error::Timeout)
    ));
    let pid: i32 = std::fs::read_to_string(file)?.trim().parse()?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
    Ok(())
}
#[tokio::test]
async fn cancellation_cleans_up_process_group() -> TestResult {
    let dir = tempfile::tempdir()?;
    let file = dir.path().join("pid");
    let script = format!(
        "echo $$ > {}; sleep 30",
        shell_quote(file.to_str().ok_or("path")?)
    );
    let task = tokio::spawn(async move {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        process::run(&mut cmd, &[], Duration::from_secs(30), 64).await
    });
    for _ in 0..100 {
        if file.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid: i32 = std::fs::read_to_string(file)?.trim().parse()?;
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
    Ok(())
}
#[test]
fn apk_pid_hash_and_shell_boundaries() -> TestResult {
    assert_eq!(parse_pid("")?, None);
    assert_eq!(parse_pid("12 13")?, Some(12));
    assert!(parse_pid("0").is_err());
    assert!(parse_pid("-1").is_err());
    assert!(parse_pid("oops").is_err());
    assert_eq!(shell_quote("it's $(unsafe)"), "'it'\\''s $(unsafe)'");
    assert!(matches_version(
        " versionCode=1800220674 minSdk=28",
        "1800220674"
    ));
    assert!(!matches_version(
        " versionCode=18002206740 minSdk=28",
        "1800220674"
    ));
    assert!(!matches_version("unsupported", "1800220674"));
    assert!(
        IntegrityRequest::parse(format!(r#"{{"requestHash":"{}="}}"#, "a".repeat(43)).as_bytes())
            .is_ok()
    );
    assert!(
        IntegrityRequest::parse(format!(r#"{{"requestHash":"{}=\n"}}"#, "a".repeat(43)).as_bytes())
            .is_err()
    );
    Ok(())
}
