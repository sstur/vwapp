use crate::{
    Error, Result,
    config::{Config, IntegrityRequest, IntegrityToken},
    process,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode, body::Incoming, header, server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use nix::fcntl::{Flock, FlockArg};
use serde_json::json;
use std::{
    convert::Infallible,
    ffi::OsString,
    fs::OpenOptions,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    process::Command,
    sync::{Semaphore, oneshot, watch},
    task::JoinSet,
    time::timeout,
};

#[derive(Clone)]
pub struct Worker {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub deadline: Duration,
}
impl Worker {
    pub fn native(config: &Path) -> Result<Self> {
        Ok(Self {
            executable: std::env::current_exe()?,
            args: vec!["mint".into(), "--config".into(), config.into()],
            deadline: Duration::from_secs(75),
        })
    }
    async fn execute(&self, body: &IntegrityRequest) -> Result<IntegrityToken> {
        let mut cmd = Command::new(&self.executable);
        cmd.args(&self.args);
        let input = serde_json::to_vec(body).map_err(|_| Error::Request)?;
        let out = process::run(&mut cmd, &input, self.deadline, 65536).await?;
        if !out.success {
            return Err(Error::Child);
        }
        serde_json::from_slice::<IntegrityToken>(&out.stdout)
            .map_err(|_| Error::Rejected)?
            .validate()
    }
}
struct State {
    key: Vec<u8>,
    worker: Worker,
    slot: Arc<Semaphore>,
    last_success: AtomicU64,
    lock: PathBuf,
}
type Reply = Response<Full<Bytes>>;
fn reply(status: StatusCode, value: serde_json::Value) -> Reply {
    let bytes = Bytes::from(value.to_string());
    let len = bytes.len();
    let mut res = Response::new(Full::new(bytes));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    if let Ok(length) = header::HeaderValue::from_str(&len.to_string()) {
        res.headers_mut().insert(header::CONTENT_LENGTH, length);
    }
    res
}
fn error(status: StatusCode, code: &str) -> Reply {
    reply(status, json!({"error":code}))
}

async fn handle(
    req: Request<Incoming>,
    state: Arc<State>,
) -> std::result::Result<Reply, Infallible> {
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .map_or(&[][..], |h| h.as_bytes());
    if !bool::from(state.key.ct_eq(supplied)) {
        return Ok(error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    let path = req.uri().path_and_query().map(|p| p.as_str());
    if req.method() == Method::GET && path == Some("/healthz") {
        let success = state.last_success.load(Ordering::Relaxed);
        return Ok(reply(
            StatusCode::OK,
            json!({"ok":true,"service":"vw-integrity","lastSuccessAt":if success == 0 {None} else {Some(success)}}),
        ));
    }
    if req.method() != Method::POST || path != Some("/v1/integrity") {
        return Ok(error(StatusCode::NOT_FOUND, "NOT_FOUND"));
    }
    let size = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            if v.bytes().all(|b| b.is_ascii_digit()) {
                v.parse::<usize>().ok()
            } else {
                None
            }
        });
    if !matches!(size, Some(1..=1024)) || req.headers().contains_key(header::TRANSFER_ENCODING) {
        return Ok(error(StatusCode::BAD_REQUEST, "INVALID_REQUEST"));
    }
    let body = match timeout(
        Duration::from_secs(5),
        Limited::new(req.into_body(), 1024).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => return Ok(error(StatusCode::BAD_REQUEST, "INVALID_REQUEST")),
    };
    let body = match IntegrityRequest::parse(&body) {
        Ok(body) => body,
        Err(_) => return Ok(error(StatusCode::BAD_REQUEST, "INVALID_REQUEST")),
    };
    let permit = match Arc::clone(&state.slot).try_acquire_owned() {
        Ok(p) => p,
        Err(_) => return Ok(error(StatusCode::SERVICE_UNAVAILABLE, "BRIDGE_BUSY")),
    };
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&state.lock)
    {
        Ok(file) => file,
        Err(_) => {
            return Ok(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "INTEGRITY_UNAVAILABLE",
            ));
        }
    };
    let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => lock,
        Err(_) => return Ok(error(StatusCode::SERVICE_UNAVAILABLE, "BRIDGE_BUSY")),
    };
    let (tx, rx) = oneshot::channel();
    // A client disconnect must not release the lock while its native child lives.
    tokio::spawn(async move {
        let _permit = permit;
        let _lock = lock;
        let start = Instant::now();
        let result = state.worker.execute(&body).await;
        if result.is_ok() {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            state
                .last_success
                .store(u64::try_from(millis).unwrap_or(u64::MAX), Ordering::Relaxed);
        }
        eprintln!(
            "{}",
            json!({"event":"integrity_request","durationMs":start.elapsed().as_millis(),"ok":result.is_ok()})
        );
        let _ = tx.send(result);
    });
    Ok(match rx.await {
        Ok(Ok(token)) => reply(StatusCode::OK, json!({"token":token.token})),
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "INTEGRITY_UNAVAILABLE"),
    })
}

/// Single-threaded HTTP runtime; bounded sockets and one isolated mint worker.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    worker: Worker,
    lock: PathBuf,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let state = Arc::new(State {
        key: format!("Bearer {}", config.api_key).into_bytes(),
        worker,
        slot: Arc::new(Semaphore::new(1)),
        last_success: AtomicU64::new(0),
        lock,
    });
    let sockets = Arc::new(Semaphore::new(64));
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            incoming = listener.accept() => {
                let (socket, _) = incoming?;
                let Ok(permit) = Arc::clone(&sockets).try_acquire_owned() else { continue; };
                let state = Arc::clone(&state);
                let mut stopping = shutdown.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let mut builder = http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5)).max_buf_size(8192).keep_alive(false);
                    let conn = builder.serve_connection(TokioIo::new(socket), service_fn(move |req| handle(req, Arc::clone(&state))));
                    tokio::pin!(conn);
                    tokio::select! {
                        _ = &mut conn => {},
                        _ = stopping.changed() => { conn.as_mut().graceful_shutdown(); let _ = conn.await; }
                    }
                });
            }
        }
    }
    drop(listener);
    // No new requests after SIGTERM. Drain the one active mint and its response.
    let drain = async {
        while tasks.join_next().await.is_some() {}
        let _ = state.slot.acquire().await;
    };
    let _ = timeout(Duration::from_secs(80), drain).await;
    Ok(())
}
