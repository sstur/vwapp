use std::{fs, os::unix::fs::PermissionsExt};
use tempfile::TempDir;
use vw_integrity_bridge::{Error, config::Config, device::Device};

type TestResult = Result<(), Box<dyn std::error::Error>>;
fn fixture(script: &str) -> Result<(TempDir, Config), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let adb = dir.path().join("adb");
    fs::write(&adb, format!("#!/bin/sh\n{script}\n"))?;
    fs::set_permissions(&adb, fs::Permissions::from_mode(0o755))?;
    let config: Config = serde_json::from_value(serde_json::json!({
        "serial":"test", "adb":adb, "apiKey":"a".repeat(48),
        "host":"127.0.0.1", "port":8792, "package":"com.vw.carnet.release",
        "versionCode":"1800220674", "activity":"com.vw.myVW.activities.RoutingActivity",
        "fridaServer":"/data/local/tmp/frida-server"
    }))?;
    Ok((dir, config))
}

#[tokio::test]
async fn rejects_unbooted_phone_and_unexpected_apk_before_attaching() -> TestResult {
    let (_dir, config) = fixture("echo 0")?;
    assert!(matches!(
        Device { config: &config }.ready().await,
        Err(Error::Boot)
    ));
    let (_dir, config) = fixture(
        "case \"$4\" in *getprop*) echo 1;; *dumpsys*) echo versionCode=999;; *) exit 99;; esac",
    )?;
    assert!(matches!(
        Device { config: &config }.ready().await,
        Err(Error::Version)
    ));
    Ok(())
}

#[tokio::test]
async fn unfreezes_existing_process_without_restarting_it() -> TestResult {
    let (dir, config) = fixture(
        r#"
case "$4" in
  *getprop*) echo 1;;
  *dumpsys*) echo 'versionCode=1800220674 minSdk=28';;
  *pidof*frida-server*) echo 123;;
  *pidof*com.vw.carnet.release*) echo 456;;
  *isfrozen*) echo true;;
  *unfreeze*) touch "$(dirname "$0")/unfrozen";;
  *) exit 99;;
esac
"#,
    )?;
    assert_eq!(Device { config: &config }.ready().await?, 456);
    assert!(dir.path().join("unfrozen").exists());
    Ok(())
}

#[tokio::test]
async fn adb_failure_is_sanitized() -> TestResult {
    let (_dir, config) = fixture("echo secret >&2; exit 1")?;
    let result = Device { config: &config }.ready().await;
    assert!(matches!(result, Err(Error::Adb)));
    Ok(())
}
