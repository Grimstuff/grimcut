use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
struct RpcIn {
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize, Clone)]
struct RpcFwd {
    id: String,
    op: String,
    args: Value,
}

static PENDING: OnceLock<Mutex<HashMap<String, Sender<Value>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Sender<Value>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn agent_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Grimcut").join("agent.json")
}

pub fn write_agent_file(port: u16) {
    let p = agent_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "port": port, "pid": std::process::id() });
    let _ = std::fs::write(p, body.to_string());
}

pub fn clear_agent_file() {
    let _ = std::fs::remove_file(agent_path());
}

#[tauri::command]
pub fn agent_reply(id: String, body: Value) {
    if let Ok(mut g) = pending().lock() {
        if let Some(tx) = g.remove(&id) {
            let _ = tx.send(body);
        }
    }
}

#[tauri::command]
pub fn grab_frame(app: AppHandle, path: String, time: f64) -> Result<String, String> {
    let ffmpeg = crate::ffmpeg_bin(&app, "ffmpeg");
    let dest = std::env::temp_dir().join(format!("grimcut-frame-{}.jpg", crate::uuid_like()));
    let dest_s = dest.to_string_lossy().into_owned();
    let t = format!("{:.3}", time.max(0.0));
    let args = [
        "-hide_banner",
        "-y",
        "-ss",
        &t,
        "-i",
        &path,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        &dest_s,
    ];
    let (_, err, code) = crate::run_cmd(&ffmpeg, &args)?;
    if code != 0 {
        return Err(crate::trim_ffmpeg_err(&err));
    }
    Ok(dest_s)
}

pub fn start_agent_server(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
            return;
        };
        let Ok(addr) = listener.local_addr() else {
            return;
        };
        write_agent_file(addr.port());
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || handle(stream, app));
        }
    });
}

fn handle(mut stream: std::net::TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 1_000_000 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let first = head.lines().next().unwrap_or("");
    if first.starts_with("GET /health") {
        respond(&mut stream, 200, r#"{"ok":true,"service":"grimcut"}"#);
        return;
    }
    if !first.starts_with("POST /v1/rpc") {
        respond(&mut stream, 404, r#"{"ok":false,"error":"not found"}"#);
        return;
    }
    let mut len = 0usize;
    for line in head.lines() {
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = rest.as_bytes().to_vec();
    while body.len() < len {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    body.truncate(len);
    let Ok(rpc) = serde_json::from_slice::<RpcIn>(&body) else {
        respond(&mut stream, 400, r#"{"ok":false,"error":"bad json"}"#);
        return;
    };
    let (tx, rx) = mpsc::channel();
    {
        let mut g = pending().lock().unwrap_or_else(|e| e.into_inner());
        g.insert(rpc.id.clone(), tx);
    }
    let _ = app.emit(
        "agent-request",
        RpcFwd {
            id: rpc.id.clone(),
            op: rpc.op,
            args: rpc.args,
        },
    );
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(v) => respond(&mut stream, 200, &v.to_string()),
        Err(_) => {
            pending().lock().ok().map(|mut g| g.remove(&rpc.id));
            respond(&mut stream, 504, r#"{"ok":false,"error":"timeout — is Grimcut UI listening?"}"#);
        }
    }
}

fn respond(stream: &mut std::net::TcpStream, code: u16, body: &str) {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let msg = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes());
}
