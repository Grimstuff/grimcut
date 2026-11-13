//! Advanced key: an on-demand, self-contained CorridorKey install and runner.
//!
//! Nothing is bundled with Grimcut. When the user asks, this downloads into
//! `<app local data>\corridorkey\`: a standalone `uv` (Python/package manager), a
//! uv-managed Python, a venv holding only what CorridorKey's keyer needs (torch,
//! torchvision, timm, safetensors, numpy, opencv-headless; none of its GVM/VideoMaMa
//! extras), the `CorridorKeyModule` folder from a pinned commit of the official repo,
//! and the official weights from Hugging Face. Removing that folder uninstalls it.
//!
//! A run streams the clip through FFmpeg → `grimcut_ck.py` → FFmpeg and writes a VP9
//! WebM with alpha that replaces the clip's source.

use crate::{ffmpeg_bin, hidden_command, key_filter, off_thread, uuid_like, KeyDto};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const UV_VERSION: &str = "0.9.5";
/// Pinned CorridorKey commit (2026-05-28) so a later upstream change can't break the runner.
const CK_COMMIT: &str = "97e55a453060745bead1befd293f6e523c4b845c";
const GREEN_MODEL_URL: &str =
    "https://huggingface.co/nikopueringer/CorridorKey_v1.0/resolve/main/CorridorKey_v1.0.safetensors";
const BLUE_MODEL_URL: &str =
    "https://huggingface.co/nikopueringer/CorridorKeyBlue_1.0/resolve/main/CorridorKeyBlue_1.0.safetensors";
const RUNNER: &str = include_str!("ck_runner.py");
const PACKAGES: &[&str] = &[
    "torch==2.8.0",
    "torchvision==0.23.0",
    "timm==1.0.26",
    "safetensors",
    "numpy",
    "opencv-python-headless",
];

static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);

fn ck_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("corridorkey"))
}

fn venv_python(dir: &Path) -> PathBuf {
    dir.join("venv").join("Scripts").join("python.exe")
}

fn model_path(dir: &Path, blue: bool) -> PathBuf {
    dir.join("models").join(if blue {
        "CorridorKeyBlue_1.0.safetensors"
    } else {
        "CorridorKey_v1.0.safetensors"
    })
}

fn emit(app: &AppHandle, label: &str, pct: f64, line: &str) {
    let _ = app.emit(
        "ck-progress",
        serde_json::json!({ "label": label, "pct": pct, "line": line }),
    );
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallInfo {
    device: String,
    commit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CkStatus {
    installed: bool,
    /// "cuda" or "cpu" for an existing install.
    device: Option<String>,
    nvidia: bool,
    gpu: Option<String>,
    vram_mb: Option<u64>,
    dir: String,
    size_mb: u64,
    busy: bool,
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// (is NVIDIA, adapter name, VRAM MB). nvidia-smi gives exact VRAM; other GPUs only a name.
fn detect_gpu() -> (bool, Option<String>, Option<u64>) {
    if let Ok(out) = hidden_command("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().find(|l| !l.trim().is_empty()) {
                let mut parts = line.rsplitn(2, ',');
                let mb = parts.next().and_then(|s| s.trim().parse::<u64>().ok());
                let name = parts.next().map(|s| s.trim().to_string());
                return (true, name, mb);
            }
        }
    }
    let name = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic|Virtual|Remote' } | Select-Object -First 1 -ExpandProperty Name)",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    (false, name, None)
}

fn read_info(dir: &Path) -> Option<InstallInfo> {
    serde_json::from_str(&fs::read_to_string(dir.join("install.json")).ok()?).ok()
}

fn is_installed(dir: &Path) -> bool {
    venv_python(dir).is_file()
        && dir.join("CorridorKeyModule").join("inference_engine.py").is_file()
        && model_path(dir, false).is_file()
        && read_info(dir).is_some()
}

#[tauri::command]
pub async fn ck_status(app: AppHandle) -> Result<CkStatus, String> {
    off_thread(move || {
        let dir = ck_dir(&app)?;
        let (nvidia, gpu, vram_mb) = detect_gpu();
        let installed = is_installed(&dir);
        Ok(CkStatus {
            installed,
            device: read_info(&dir).map(|i| i.device),
            nvidia,
            gpu,
            vram_mb,
            size_mb: if dir.exists() { dir_size(&dir) / 1_048_576 } else { 0 },
            dir: dir.to_string_lossy().into_owned(),
            busy: BUSY.load(Ordering::SeqCst),
        })
    })
    .await
}

struct BusyGuard;
impl BusyGuard {
    fn take() -> Result<Self, String> {
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err("Advanced key is already busy.".into());
        }
        CANCEL.store(false, Ordering::SeqCst);
        Ok(BusyGuard)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
        *CHILD.lock().unwrap() = None;
    }
}

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::SeqCst) {
        Err("Cancelled.".into())
    } else {
        Ok(())
    }
}

/// Run a child, streaming its stdout+stderr lines to `on_line`. Cancel kills it.
fn run_streamed(mut cmd: std::process::Command, mut on_line: impl FnMut(&str)) -> Result<(), String> {
    cancelled()?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    *CHILD.lock().unwrap() = Some(child);
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [out.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), err.map(|s| Box::new(s) as _)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            // uv redraws progress with \r; split on both.
            let mut r = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match r.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        for part in String::from_utf8_lossy(&buf).split('\r') {
                            let t = part.trim();
                            if !t.is_empty() {
                                let _ = tx.send(t.to_string());
                            }
                        }
                    }
                }
            }
        }));
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    for line in rx {
        on_line(&line);
        tail.push(line);
        if tail.len() > 12 {
            tail.remove(0);
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = {
        let mut g = CHILD.lock().unwrap();
        let st = g.as_mut().map(|c| c.wait());
        *g = None;
        st
    };
    cancelled()?;
    match status {
        Some(Ok(s)) if s.success() => Ok(()),
        _ => Err(tail.join("\n")),
    }
}

/// Download with curl.exe (ships with Windows 10+), reporting MB as it grows.
fn download(app: &AppHandle, url: &str, dest: &Path, label: &str, pct0: f64, pct1: f64, approx_mb: f64) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);
    let mut cmd = hidden_command("curl.exe");
    cmd.args(["-L", "--fail", "--silent", "--show-error", "--retry", "3", "-o"])
        .arg(&part)
        .arg(url);
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let watch = {
        let (app, part, done, label) = (app.clone(), part.clone(), done.clone(), label.to_string());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let mb = fs::metadata(&part).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
                let f = (mb / approx_mb.max(1.0)).min(0.99);
                emit(&app, &label, pct0 + (pct1 - pct0) * f, &format!("{mb:.0} MB"));
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        })
    };
    let r = run_streamed(cmd, |_| {});
    done.store(true, Ordering::SeqCst);
    let _ = watch.join();
    if let Err(e) = r {
        let _ = fs::remove_file(&part);
        return Err(if e.is_empty() { format!("Download failed: {url}") } else { format!("Download failed: {e}") });
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    emit(app, label, pct1, "");
    Ok(())
}

fn uv_cmd(dir: &Path) -> std::process::Command {
    let mut cmd = hidden_command(dir.join("uv").join("uv.exe"));
    cmd.env("UV_PYTHON_INSTALL_DIR", dir.join("python"))
        .env("UV_CACHE_DIR", dir.join("cache"))
        .env("UV_LINK_MODE", "copy")
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_PROGRESS", "1")
        .current_dir(dir);
    cmd
}

#[tauri::command]
pub async fn ck_install(app: AppHandle, device: String) -> Result<(), String> {
    off_thread(move || {
        let _busy = BusyGuard::take()?;
        let dir = ck_dir(&app)?;
        let r = install(&app, &dir, if device == "cuda" { "cuda" } else { "cpu" });
        // The wheel cache is the big leftover; the venv has its own copies.
        let _ = fs::remove_dir_all(dir.join("cache"));
        let _ = fs::remove_file(dir.join("uv.zip"));
        let _ = fs::remove_file(dir.join("ck.zip"));
        if r.is_err() {
            let _ = fs::remove_file(dir.join("install.json"));
        }
        r
    })
    .await
}

fn install(app: &AppHandle, dir: &Path, device: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // 1. uv (single exe).
    let uv_exe = dir.join("uv").join("uv.exe");
    if !uv_exe.is_file() {
        let zip = dir.join("uv.zip");
        download(
            app,
            &format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-x86_64-pc-windows-msvc.zip"),
            &zip,
            "Downloading uv…",
            0.0,
            4.0,
            20.0,
        )?;
        fs::create_dir_all(dir.join("uv")).map_err(|e| e.to_string())?;
        let mut tar = hidden_command("tar.exe");
        tar.arg("-xf").arg(&zip).arg("-C").arg(dir.join("uv"));
        run_streamed(tar, |_| {}).map_err(|e| format!("Could not unpack uv: {e}"))?;
        if !uv_exe.is_file() {
            return Err("uv.exe missing after unpack.".into());
        }
    }

    // 2. CorridorKeyModule + licence from the pinned commit.
    if !dir.join("CorridorKeyModule").join("inference_engine.py").is_file() {
        let zip = dir.join("ck.zip");
        download(
            app,
            &format!("https://github.com/nikopueringer/CorridorKey/archive/{CK_COMMIT}.zip"),
            &zip,
            "Downloading CorridorKey…",
            4.0,
            6.0,
            1.0,
        )?;
        let root = format!("CorridorKey-{CK_COMMIT}");
        let mut tar = hidden_command("tar.exe");
        tar.arg("-xf")
            .arg(&zip)
            .arg("-C")
            .arg(dir)
            .arg("--strip-components=1")
            .arg(format!("{root}/CorridorKeyModule"))
            .arg(format!("{root}/LICENSE"));
        run_streamed(tar, |_| {}).map_err(|e| format!("Could not unpack CorridorKey: {e}"))?;
    }

    // 3. Python + venv (uv-managed, inside this folder).
    if !venv_python(dir).is_file() {
        emit(app, "Setting up Python…", 7.0, "");
        let mut cmd = uv_cmd(dir);
        cmd.args(["venv", "--python", "3.12", "--no-project", "venv"]);
        run_streamed(cmd, |l| emit(app, "Setting up Python…", 8.0, l))
            .map_err(|e| format!("Python setup failed: {e}"))?;
    }

    // 4. Packages: only the keyer's own needs.
    let index = if device == "cuda" {
        "https://download.pytorch.org/whl/cu128"
    } else {
        "https://download.pytorch.org/whl/cpu"
    };
    let label = if device == "cuda" {
        "Installing PyTorch (CUDA, ~2.8 GB)…"
    } else {
        "Installing PyTorch (CPU, ~250 MB)…"
    };
    emit(app, label, 10.0, "");
    let mut cmd = uv_cmd(dir);
    cmd.arg("pip")
        .arg("install")
        .arg("--python")
        .arg(venv_python(dir))
        .args(["--extra-index-url", index])
        .args(PACKAGES);
    let mut pct = 10.0;
    run_streamed(cmd, |l| {
        if l.starts_with("Downloading") || l.starts_with("Downloaded") || l.starts_with("Prepared") || l.starts_with("Installed") {
            pct = (pct + 3.0f64).min(72.0);
        }
        emit(app, label, pct, l);
    })
    .map_err(|e| format!("Package install failed: {e}"))?;

    // 5. Weights.
    let model = model_path(dir, false);
    if !model.is_file() {
        download(app, GREEN_MODEL_URL, &model, "Downloading the CorridorKey model…", 74.0, 96.0, 300.0)?;
    }

    // 6. Runner + check.
    fs::write(dir.join("grimcut_ck.py"), RUNNER).map_err(|e| e.to_string())?;
    emit(app, "Checking the install…", 97.0, "");
    let mut check = hidden_command(venv_python(dir));
    check.current_dir(dir).args([
        "-c",
        "import torch, timm, cv2, safetensors; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())",
    ]);
    let mut seen = String::new();
    run_streamed(check, |l| seen = l.to_string()).map_err(|e| format!("Install check failed: {e}"))?;
    let info = InstallInfo { device: device.into(), commit: CK_COMMIT.into() };
    fs::write(dir.join("install.json"), serde_json::to_string(&info).unwrap()).map_err(|e| e.to_string())?;
    emit(app, "Advanced key is ready.", 100.0, &seen);
    Ok(())
}

#[tauri::command]
pub fn ck_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
    if let Some(child) = CHILD.lock().unwrap().as_mut() {
        // /T also stops the FFmpeg processes the runner started.
        let _ = hidden_command("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .status();
        let _ = child.kill();
    }
}

#[tauri::command]
pub async fn ck_uninstall(app: AppHandle) -> Result<(), String> {
    off_thread(move || {
        let _busy = BusyGuard::take()?;
        let dir = ck_dir(&app)?;
        if !dir.exists() {
            return Ok(());
        }
        // Keep finished renders: clips in open projects may point at them.
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            if entry.file_name() == "renders" {
                continue;
            }
            let p = entry.path();
            let r = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            r.map_err(|e| format!("Could not remove {}: {e}", p.display()))?;
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CkJob {
    source_path: String,
    source_start: f64,
    source_end: f64,
    frame_rate: Option<f64>,
    width: u32,
    height: u32,
    /// Grimcut's chroma key, used as the coarse alpha hint.
    key: KeyDto,
    /// Model resolution: 1024 (faster, less memory) or 2048 (CorridorKey's native).
    img_size: u32,
    #[serde(default = "one")]
    despill: f64,
}

fn one() -> f64 {
    1.0
}

#[tauri::command]
pub async fn ck_run(app: AppHandle, job: CkJob) -> Result<String, String> {
    off_thread(move || {
        let _busy = BusyGuard::take()?;
        run_job(&app, job)
    })
    .await
}

fn run_job(app: &AppHandle, job: CkJob) -> Result<String, String> {
    let dir = ck_dir(app)?;
    if !is_installed(&dir) {
        return Err("Advanced key isn't installed yet.".into());
    }
    let info = read_info(&dir).unwrap_or_default();
    let blue = crate::key_is_blue(&job.key.color);
    let model = model_path(&dir, blue);
    if !model.is_file() {
        download(app, BLUE_MODEL_URL, &model, "Downloading the blue-screen model…", 0.0, 10.0, 300.0)?;
    }
    // Keep the runner in step with this Grimcut build.
    fs::write(dir.join("grimcut_ck.py"), RUNNER).map_err(|e| e.to_string())?;

    let ffmpeg = ffmpeg_bin(app, "ffmpeg");
    let fps = job.frame_rate.filter(|f| *f > 1.0 && *f < 240.0).unwrap_or(30.0);
    let start = job.source_start.max(0.0);
    let dur = (job.source_end - start).max(0.04);
    let (w, h) = (job.width.max(2) & !1, job.height.max(2) & !1);
    let frames = (dur * fps).round().max(1.0) as u64;

    // Hint = Grimcut's own key matte without despill; CorridorKey only needs it rough.
    let hint_key = KeyDto { spill: 0.0, ..job.key.clone() };
    let chain = key_filter(&hint_key, "h");
    let vf = format!("scale={w}:{h},{},format=rgba", chain.trim_start_matches(','));
    let ff = ffmpeg.to_string_lossy().into_owned();
    let decode: Vec<String> = vec![
        ff.clone(),
        "-v".into(),
        "error".into(),
        "-ss".into(),
        format!("{start:.6}"),
        "-i".into(),
        job.source_path.clone(),
        "-t".into(),
        format!("{dur:.6}"),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        vf,
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-".into(),
    ];
    let renders = dir.join("renders");
    fs::create_dir_all(&renders).map_err(|e| e.to_string())?;
    let stem = Path::new(&job.source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip".into());
    let stem: String = stem.chars().filter(|c| c.is_alphanumeric() || "-_ ".contains(*c)).take(40).collect();
    let out = renders.join(format!("{stem}-{}.ck.webm", uuid_like()));
    let encode: Vec<String> = vec![
        ff,
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        format!("{w}x{h}"),
        "-r".into(),
        format!("{fps:.6}"),
        "-i".into(),
        "-".into(),
        "-c:v".into(),
        "libvpx-vp9".into(),
        "-pix_fmt".into(),
        "yuva420p".into(),
        "-crf".into(),
        "18".into(),
        "-b:v".into(),
        "0".into(),
        "-row-mt".into(),
        "1".into(),
        "-deadline".into(),
        "good".into(),
        "-cpu-used".into(),
        "4".into(),
        "-auto-alt-ref".into(),
        "0".into(),
        out.to_string_lossy().into_owned(),
    ];
    let img_size = if job.img_size >= 2048 { 2048 } else { 1024 };
    let job_json = serde_json::json!({
        "module_dir": dir.to_string_lossy(),
        "checkpoint": model.to_string_lossy(),
        "device": if info.device.is_empty() { "cpu".to_string() } else { info.device.clone() },
        "img_size": img_size,
        "width": w,
        "height": h,
        "frames": frames,
        "decode": decode,
        "encode": encode,
        "despill": job.despill.clamp(0.0, 1.0),
        "despeckle": true,
        "screen_channel": if blue { 2 } else { 1 },
    });
    let job_path = std::env::temp_dir().join(format!("grimcut-ck-{}.json", uuid_like()));
    fs::write(&job_path, job_json.to_string()).map_err(|e| e.to_string())?;

    let label = "Advanced key…";
    emit(app, "Loading CorridorKey…", 0.0, "");
    let mut cmd = hidden_command(venv_python(&dir));
    cmd.current_dir(&dir)
        .env("CORRIDORKEY_SKIP_COMPILE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .arg(dir.join("grimcut_ck.py"))
        .arg(&job_path);
    let mut err_line = String::new();
    let t0 = std::time::Instant::now();
    let r = run_streamed(cmd, |l| {
        if let Some(rest) = l.strip_prefix("PROGRESS ") {
            let mut it = rest.split_whitespace().filter_map(|x| x.parse::<f64>().ok());
            if let (Some(d), Some(n)) = (it.next(), it.next()) {
                let per = t0.elapsed().as_secs_f64() / d.max(1.0);
                let left = (n - d).max(0.0) * per;
                emit(
                    app,
                    label,
                    100.0 * d / n.max(1.0),
                    &format!("Frame {d:.0} of {n:.0} · {per:.1} s/frame · ~{} left", fmt_secs(left)),
                );
            }
        } else if let Some(rest) = l.strip_prefix("ERROR ") {
            err_line = rest.to_string();
        } else if let Some(dev) = l.strip_prefix("DEVICE ") {
            emit(app, "Loading CorridorKey…", 0.0, &format!("Running on {}", dev.to_uppercase()));
        }
    });
    let _ = fs::remove_file(&job_path);
    if let Err(e) = r {
        let _ = fs::remove_file(&out);
        return Err(if err_line.is_empty() { e } else { err_line });
    }
    if !out.is_file() {
        return Err("CorridorKey finished but wrote no file.".into());
    }
    emit(app, "Advanced key done.", 100.0, "");
    Ok(out.to_string_lossy().into_owned())
}

fn fmt_secs(s: f64) -> String {
    let s = s.round() as u64;
    if s >= 3600 {
        format!("{}h {:02}m", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        format!("{}m {:02}s", s / 60, s % 60)
    } else {
        format!("{s}s")
    }
}
