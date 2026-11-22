use crate::{Error, Result, config::Config, process};
use std::time::Duration;
use tokio::{process::Command, time::sleep};

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
pub fn parse_pid(s: &str) -> Result<Option<u32>> {
    match s.split_whitespace().next() {
        None => Ok(None),
        Some(value) => {
            let pid: u32 = value.parse().map_err(|_| Error::Pid)?;
            if pid == 0 || pid > i32::MAX as u32 {
                return Err(Error::Pid);
            }
            Ok(Some(pid))
        }
    }
}
pub fn matches_version(output: &str, package: &str, version: &str) -> bool {
    let header = format!("  Package [{package}] (");
    let mut active_section = false;
    let mut target_record = false;
    let mut records = 0;
    let mut versions = Vec::new();
    for line in output.lines() {
        if !line.is_empty() && !line.starts_with(char::is_whitespace) {
            active_section = line == "Packages:";
            target_record = false;
        } else if active_section && line.starts_with("  Package [") {
            target_record = line.starts_with(&header);
            if target_record {
                records += 1;
            }
        } else if target_record {
            versions.extend(
                line.split_whitespace()
                    .filter_map(|field| field.strip_prefix("versionCode=")),
            );
        }
    }
    records == 1 && versions == [version]
}
pub struct Device<'a> {
    pub config: &'a Config,
}
impl Device<'_> {
    async fn shell(&self, args: &[&str], check: bool) -> Result<String> {
        let mut cmd = Command::new(&self.config.adb);
        cmd.args([
            "-s",
            &self.config.serial,
            "shell",
            &args
                .iter()
                .map(|s| shell_quote(s))
                .collect::<Vec<_>>()
                .join(" "),
        ]);
        // Inherit the worker group so a parent deadline also kills stuck ADB.
        let output = process::run_inherited(&mut cmd, Duration::from_secs(15), 2 * 1024 * 1024)
            .await
            .map_err(|_| Error::Adb)?;
        if check && !output.success {
            return Err(Error::Adb);
        }
        Ok(String::from_utf8(output.stdout)
            .map_err(|_| Error::Adb)?
            .trim()
            .to_owned())
    }
    async fn pid(&self, name: &str) -> Result<Option<u32>> {
        parse_pid(&self.shell(&["pidof", name], false).await?)
    }
    pub async fn ready(&self) -> Result<u32> {
        if self.shell(&["getprop", "sys.boot_completed"], true).await? != "1" {
            return Err(Error::Boot);
        }
        let version = self
            .shell(&["dumpsys", "package", &self.config.package], true)
            .await?;
        if !matches_version(&version, &self.config.package, &self.config.version_code) {
            return Err(Error::Version);
        }
        if self.pid("frida-server").await?.is_none() {
            let server = self.config.frida_server.to_str().ok_or(Error::Config)?;
            self.shell(
                &[
                    "su",
                    "-c",
                    &format!("{} -D </dev/null >/dev/null 2>&1", shell_quote(server)),
                ],
                true,
            )
            .await?;
            let mut started = false;
            for _ in 0..20 {
                if self.pid("frida-server").await?.is_some() {
                    started = true;
                    break;
                }
                sleep(Duration::from_millis(250)).await;
            }
            if !started {
                return Err(Error::FridaStart);
            }
        }
        let mut pid = self.pid(&self.config.package).await?;
        if pid.is_none() {
            self.shell(
                &[
                    "am",
                    "start",
                    "-n",
                    &format!("{}/{}", self.config.package, self.config.activity),
                ],
                true,
            )
            .await?;
            for _ in 0..40 {
                pid = self.pid(&self.config.package).await?;
                if pid.is_some() {
                    break;
                }
                sleep(Duration::from_millis(250)).await;
            }
            if pid.is_none() {
                return Err(Error::AppStart);
            }
            // Required on Android 16: do not attach during ART's collector change.
            sleep(Duration::from_secs(10)).await;
        }
        let pid = pid.ok_or(Error::AppStart)?;
        if self
            .shell(&["cmd", "activity", "isfrozen", &pid.to_string()], true)
            .await?
            == "true"
        {
            self.shell(&["cmd", "activity", "unfreeze", &pid.to_string()], true)
                .await?;
        }
        Ok(pid)
    }
}
