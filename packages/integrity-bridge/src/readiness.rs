//! Private installation handshake: never sends the bearer key to a TCP listener.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::SocketAddr,
    path::Path,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    pid: u32,
    address: SocketAddr,
}

pub fn publish(path: &Path, address: SocketAddr) -> Result<()> {
    // The installer pre-creates this file with the service UID and mode 0600
    // inside the new root-owned release directory. No path is created here.
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    let value = Ready {
        pid: std::process::id(),
        address,
    };
    file.write_all(&serde_json::to_vec(&value).map_err(|_| Error::Install)?)?;
    file.sync_all()?;
    Ok(())
}

pub fn matches(path: &Path, expected_pid: u32) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(1025).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 {
        return false;
    }
    serde_json::from_slice::<Ready>(&bytes)
        .is_ok_and(|r| r.pid == expected_pid && r.pid != 0 && r.address.port() != 0)
}
