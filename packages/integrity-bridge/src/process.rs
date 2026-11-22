use crate::{Error, Result};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use std::{os::unix::process::CommandExt, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

struct ProcessGroup(Pid);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = killpg(self.0, Signal::SIGKILL);
    }
}
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
}

/// Bounded pipes and deadline; cancellation also kills the entire process group.
pub async fn run(
    command: &mut Command,
    input: &[u8],
    deadline: Duration,
    limit: usize,
) -> Result<Output> {
    run_inner(command, input, deadline, limit, true).await
}
pub async fn run_inherited(
    command: &mut Command,
    deadline: Duration,
    limit: usize,
) -> Result<Output> {
    run_inner(command, &[], deadline, limit, false).await
}
async fn run_inner(
    command: &mut Command,
    input: &[u8],
    deadline: Duration,
    limit: usize,
    new_group: bool,
) -> Result<Output> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if new_group {
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .ok_or(Error::Child)?;
    let group = if new_group {
        Some(ProcessGroup(Pid::from_raw(pid)))
    } else {
        None
    };
    let mut stdin = child.stdin.take().ok_or(Error::Child)?;
    let stdout = child.stdout.take().ok_or(Error::Child)?;
    let work = async {
        stdin.write_all(input).await?;
        drop(stdin);
        let read = async {
            let mut bytes = Vec::new();
            stdout
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > limit {
                return Err(Error::OutputLimit);
            }
            Ok(bytes)
        };
        let (stdout, status) =
            tokio::try_join!(read, async { child.wait().await.map_err(Error::from) })?;
        Ok(Output {
            success: status.success(),
            stdout,
        })
    };
    let result = timeout(deadline, work).await.unwrap_or(Err(Error::Timeout));
    drop(group);
    if result.is_err() {
        let _ = child.start_kill();
    }
    // Reap on failure as well, before allowing another token operation.
    let _ = child.wait().await;
    result
}
