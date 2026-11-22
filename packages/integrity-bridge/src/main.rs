use clap::{Parser, Subcommand};
use std::path::PathBuf;
use vw_integrity_bridge::{Result, config::Config, install, server, worker};

#[derive(Parser)]
#[command(version, about = "Headless VW integrity bridge")]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    Serve {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, hide = true)]
        ready_file: Option<PathBuf>,
    },
    #[command(hide = true)]
    Mint {
        #[arg(long)]
        config: PathBuf,
    },
    Install {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        user: String,
    },
}
fn main() {
    nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    let result = match Cli::parse().command {
        Action::Mint { config } => worker::mint(&config),
        Action::Serve { config, ready_file } => run(config, ready_file),
        Action::Install { config, user } => install::install(&config, &user),
    };
    if let Err(error) = result {
        // Error's Display deliberately excludes native diagnostics and secrets.
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run(path: PathBuf, ready_file: Option<PathBuf>) -> Result<()> {
    let path = std::fs::canonicalize(path)?;
    let config = Config::load(&path)?;
    let lock = config.lock_directory(&path).join(".integrity-device.lock");
    let worker = server::Worker::native(&path)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let listener =
                tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
            if let Some(path) = ready_file {
                vw_integrity_bridge::readiness::publish(&path, listener.local_addr()?)?;
            }
            let (tx, rx) = tokio::sync::watch::channel(false);
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut interrupt =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
            tokio::spawn(async move {
                tokio::select! { _ = term.recv() => {}, _ = interrupt.recv() => {} };
                let _ = tx.send(true);
            });
            eprintln!("VW integrity bridge ready");
            server::serve(listener, config, worker, lock, rx).await
        })
}
