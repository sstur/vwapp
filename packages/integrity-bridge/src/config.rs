use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

// Deliberately no Debug: the bearer key must not appear in diagnostics.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    pub serial: String,
    pub adb: PathBuf,
    pub api_key: String,
    pub host: String,
    pub port: u16,
    pub package: String,
    pub version_code: String,
    pub activity: String,
    pub frida_server: PathBuf,
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|_| Error::Config)?;
        if bytes.len() > 16384 {
            return Err(Error::Config);
        }
        let c: Self = serde_json::from_slice(&bytes).map_err(|_| Error::Config)?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        let identifier = |s: &str, dollar: bool| {
            !s.is_empty()
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || (dollar && b == b'$')
                })
        };
        if self.serial.is_empty()
            || self.serial.contains('\0')
            || !self.adb.is_absolute()
            || !self.frida_server.is_absolute()
            || self.api_key.len() < 32
            || !self.api_key.bytes().all(|b| (0x21..=0x7e).contains(&b))
            || self.host.is_empty()
            || self.port == 0
            || !identifier(&self.package, false)
            || !identifier(&self.activity, true)
            || self.version_code.is_empty()
            || !self.version_code.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(Error::Config);
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntegrityRequest {
    pub request_hash: String,
}
impl IntegrityRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 1024 {
            return Err(Error::Request);
        }
        let r: Self = serde_json::from_slice(bytes).map_err(|_| Error::Request)?;
        let b = r.request_hash.as_bytes();
        if b.len() != 44
            || b[43] != b'='
            || !b[..43]
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        {
            return Err(Error::Request);
        }
        Ok(r)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrityToken {
    pub token: String,
}
impl IntegrityToken {
    pub fn validate(self) -> Result<Self> {
        if !(101..20000).contains(&self.token.len()) {
            return Err(Error::Rejected);
        }
        Ok(self)
    }
}
