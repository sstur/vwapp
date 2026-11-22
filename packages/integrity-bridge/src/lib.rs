#![deny(unsafe_code)]

pub mod config;
pub mod device;
pub mod install;
#[allow(unsafe_code)]
mod native;
pub mod process;
pub mod server;
pub mod worker;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("INVALID_CONFIG")]
    Config,
    #[error("INVALID_REQUEST")]
    Request,
    #[error("ADB_UNAVAILABLE")]
    Adb,
    #[error("DEVICE_NOT_BOOTED")]
    Boot,
    #[error("UNSUPPORTED_APP_VERSION")]
    Version,
    #[error("FRIDA_NOT_STARTED")]
    FridaStart,
    #[error("APP_NOT_STARTED")]
    AppStart,
    #[error("INVALID_PID")]
    Pid,
    #[error("NATIVE_OPERATION_FAILED")]
    Native,
    #[error("INTEGRITY_REJECTED")]
    Rejected,
    #[error("INTEGRITY_TIMEOUT")]
    Timeout,
    #[error("CHILD_FAILED")]
    Child,
    #[error("OUTPUT_LIMIT")]
    OutputLimit,
    #[error("IO_FAILED")]
    Io(#[from] std::io::Error),
    #[error("INSTALL_FAILED")]
    Install,
}
pub type Result<T> = std::result::Result<T, Error>;
