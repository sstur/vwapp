//! The only unsafe application module. Frida C objects never leave this worker
//! thread; GLib owns callback data until the signal closure is finalized.
use crate::{
    Error, Result,
    config::{Config, IntegrityToken},
};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    ptr::{self, NonNull},
    sync::mpsc::{Receiver, SyncSender, sync_channel},
    time::{Duration, Instant},
};

// Bindgen emits upstream C layouts, including bitfield accessors. Application
// unsafe operations below still require individual safety documentation.
#[allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    dead_code,
    clippy::all,
    clippy::undocumented_unsafe_blocks
)]
mod ffi {
    include!(concat!(env!("OUT_DIR"), "/frida.rs"));
}

struct Object<T>(NonNull<T>);
impl<T> Object<T> {
    fn new(p: *mut T) -> Result<Self> {
        NonNull::new(p).map(Self).ok_or(Error::Native)
    }
    fn ptr(&self) -> *mut T {
        self.0.as_ptr()
    }
}
impl<T> Drop for Object<T> {
    fn drop(&mut self) {
        // SAFETY: each Object owns exactly one Frida GObject reference returned
        // by a constructor/getter; wrappers never clone that ownership.
        unsafe {
            ffi::frida_unref(self.ptr().cast());
        }
    }
}
fn check(error: *mut ffi::GError) -> Result<()> {
    if error.is_null() {
        return Ok(());
    }
    // SAFETY: non-null errors are owned allocations returned through GError**.
    unsafe {
        ffi::g_error_free(error);
    }
    Err(Error::Native)
}
unsafe extern "C" fn on_message(
    _: *mut ffi::FridaScript,
    message: *const c_char,
    _: *mut ffi::GBytes,
    data: *mut c_void,
) {
    // SAFETY: Frida supplies a live NUL-terminated string for this callback;
    // data is the boxed sender registered below, owned by the GLib closure.
    unsafe {
        if message.is_null() || data.is_null() {
            return;
        }
        let bytes = CStr::from_ptr(message).to_bytes();
        if bytes.len() > 65536 {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        if value.get("type").and_then(Value::as_str) != Some("send") {
            return;
        }
        let Some(payload) = value.get("payload") else {
            return;
        };
        if payload.get(0).and_then(Value::as_str) != Some("frida:rpc") {
            return;
        }
        let tx = &*data.cast::<SyncSender<Value>>();
        let _ = tx.try_send(payload.clone());
    }
}
unsafe extern "C" fn destroy_sender(data: *mut c_void, _: *mut ffi::GClosure) {
    // SAFETY: GLib calls this exactly once when the signal closure is finalized,
    // after in-flight callbacks; ownership came from Box::into_raw below.
    unsafe {
        drop(Box::from_raw(data.cast::<SyncSender<Value>>()));
    }
}
struct Script {
    object: Object<ffi::FridaScript>,
    signal: u64,
    rx: Receiver<Value>,
    next_id: u64,
}
impl Drop for Script {
    fn drop(&mut self) {
        // SAFETY: signal belongs to our live script; disconnect prevents further
        // callbacks and lets GLib free its boxed sender before object release.
        unsafe {
            ffi::g_signal_handler_disconnect(self.object.ptr().cast(), self.signal);
        }
    }
}
impl Script {
    fn call(&mut self, method: &str, args: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let request = CString::new(json!(["frida:rpc", id, "call", method, args]).to_string())
            .map_err(|_| Error::Request)?;
        // SAFETY: script is live, CString remains valid during synchronous post;
        // Frida copies the message and no binary data is supplied.
        unsafe {
            ffi::frida_script_post(self.object.ptr(), request.as_ptr(), ptr::null_mut());
        }
        let until = Instant::now() + Duration::from_secs(25);
        loop {
            let remaining = until.saturating_duration_since(Instant::now());
            let value = self
                .rx
                .recv_timeout(remaining)
                .map_err(|_| Error::Timeout)?;
            if value.get(1).and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if value.get(2).and_then(Value::as_str) != Some("ok") {
                return Err(Error::Rejected);
            }
            return value.get(3).cloned().ok_or(Error::Rejected);
        }
    }
    fn wait(&mut self) -> Result<Value> {
        let until = Instant::now() + Duration::from_secs(25);
        while Instant::now() < until {
            let value = self.call("poll", json!([]))?;
            if value.get("error").is_some() {
                return Err(Error::Rejected);
            }
            if value == json!({"pending":true}) {
                std::thread::sleep(Duration::from_millis(200));
            } else {
                return Ok(value);
            }
        }
        Err(Error::Timeout)
    }
}

pub fn mint(config: &Config, pid: u32, request_hash: &str) -> Result<IntegrityToken> {
    let serial = CString::new(config.serial.as_str()).map_err(|_| Error::Config)?;
    let source = CString::new(include_str!("../assets/agent.js")).map_err(|_| Error::Native)?;
    // SAFETY: initialized once in this single-use worker, never in the HTTP
    // process. All pointers are checked; owned objects outlive their callbacks.
    unsafe {
        ffi::frida_init();
        let manager = Object::new(ffi::frida_device_manager_new())?;
        let mut error = ptr::null_mut();
        let device = ffi::frida_device_manager_get_device_by_id_sync(
            manager.ptr(),
            serial.as_ptr(),
            10000,
            ptr::null_mut(),
            &mut error,
        );
        check(error)?;
        let device = Object::new(device)?;
        let session = ffi::frida_device_attach_sync(
            device.ptr(),
            pid,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut error,
        );
        check(error)?;
        let session = Object::new(session)?;
        let options = Object::new(ffi::frida_script_options_new())?;
        ffi::frida_script_options_set_runtime(
            options.ptr(),
            ffi::FridaScriptRuntime_FRIDA_SCRIPT_RUNTIME_QJS,
        );
        let object = ffi::frida_session_create_script_sync(
            session.ptr(),
            source.as_ptr(),
            options.ptr(),
            ptr::null_mut(),
            &mut error,
        );
        check(error)?;
        let object = Object::new(object)?;
        let (tx, rx) = sync_channel(16);
        let callback = std::mem::transmute::<
            unsafe extern "C" fn(
                *mut ffi::FridaScript,
                *const c_char,
                *mut ffi::GBytes,
                *mut c_void,
            ),
            unsafe extern "C" fn(),
        >(on_message);
        let signal = ffi::g_signal_connect_data(
            object.ptr().cast(),
            c"message".as_ptr(),
            Some(callback),
            Box::into_raw(Box::new(tx)).cast(),
            Some(destroy_sender),
            0,
        );
        let mut script = Script {
            object,
            signal,
            rx,
            next_id: 0,
        };
        ffi::frida_script_load_sync(script.object.ptr(), ptr::null_mut(), &mut error);
        check(error)?;
        let result = (|| {
            if script.call("prepare", json!([]))? != json!({"started":true}) {
                return Err(Error::Rejected);
            }
            if script.wait()? != json!({"ready":true}) {
                return Err(Error::Rejected);
            }
            if script.call("request", json!([request_hash]))? != json!({"started":true}) {
                return Err(Error::Rejected);
            }
            serde_json::from_value::<IntegrityToken>(script.wait()?)
                .map_err(|_| Error::Rejected)?
                .validate()
        })();
        ffi::frida_script_unload_sync(script.object.ptr(), ptr::null_mut(), &mut error);
        let unloaded = check(error);
        error = ptr::null_mut();
        drop(script);
        ffi::frida_session_detach_sync(session.ptr(), ptr::null_mut(), &mut error);
        let detached = check(error);
        unloaded?;
        detached?;
        result
    }
    // Process exit reclaims the Frida runtime. Never deinit it under callbacks.
}
