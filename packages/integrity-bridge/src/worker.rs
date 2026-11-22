use crate::{
    Error, Result,
    config::{Config, IntegrityRequest},
    device::Device,
    native,
};
use nix::{
    fcntl::{Flock, FlockArg},
    sys::signal::{Signal, killpg},
    unistd::{getpid, getppid},
};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::Duration,
};

pub fn mint(config_path: &Path) -> Result<()> {
    // An HTTP-process crash must not leave a native worker alive indefinitely.
    // The server places workers in their own process groups before exec.
    let parent = getppid();
    if parent.as_raw() == 1 {
        return Err(Error::Child);
    }
    let worker = getpid();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            if getppid() != parent {
                let _ = killpg(worker, Signal::SIGKILL);
                std::process::exit(1);
            }
        }
    });
    let config = Config::load(config_path)?;
    // Also lock in the worker: after SIGKILL the supervisor's lock disappears
    // before the watchdog notices. A replacement must not attach in that gap.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(config_path.with_file_name(".integrity-native.lock"))?;
    let _device_lock =
        Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|_| Error::Child)?;
    let mut input = Vec::new();
    std::io::stdin().take(1025).read_to_end(&mut input)?;
    let request = IntegrityRequest::parse(&input)?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let pid = rt.block_on(Device { config: &config }.ready())?;
    drop(rt);
    let token = native::mint(&config, pid, &request.request_hash)?;
    serde_json::to_writer(std::io::stdout().lock(), &token).map_err(|_| Error::Child)?;
    std::io::stdout().flush()?;
    Ok(())
}
