mod agent;
mod filmstrip;
mod windows_sizing;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfoDto {
    pub path: String,
    pub duration: f64,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub audio_codec: Option<String>,
    pub frame_rate: Option<f64>,
    pub has_audio: bool,
    pub keyframe_times: Vec<f64>,
    #[serde(default)]
    pub subtitles: Vec<SubtitleTrackDto>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackDto {
    pub index: i32,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub text: bool,
    pub sidecar: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipDto {
    #[serde(default)]
    pub gap: bool,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub source_start: f64,
    #[serde(default)]
    pub source_end: f64,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub gain_db: f64,
}

fn default_one() -> f64 {
    1.0
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompLayerDto {
    pub source_path: String,
    pub source_start: f64,
    pub source_end: f64,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "default_one")]
    pub scale: f64,
    #[serde(default)]
    pub scale_x: Option<f64>,
    #[serde(default)]
    pub scale_y: Option<f64>,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub src_width: i32,
    #[serde(default)]
    pub src_height: i32,
    #[serde(default)]
    pub blur: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompSliceDto {
    pub duration: f64,
    #[serde(default)]
    pub layers: Vec<CompLayerDto>,
    #[serde(default)]
    pub texts: Vec<CompTextDto>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompTextDto {
    pub text: String,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_size: f64,
    #[serde(default)]
    pub align: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub box_w: f64,
    #[serde(default)]
    pub box_h: f64,
    #[serde(default)]
    pub shadow: bool,
    #[serde(default)]
    pub stroke: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub source_path: String,
    pub output_path: String,
    pub clips: Vec<ClipDto>,
    pub audio_clips: Option<Vec<ClipDto>>,
    #[serde(default)]
    pub audio_overlay: Option<Vec<ClipDto>>,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub use_stream_copy: bool,
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
    #[serde(default)]
    pub frame_rate: Option<f64>,
    #[serde(default)]
    pub comp_slices: Option<Vec<CompSliceDto>>,
    #[serde(default)]
    pub burn_subs: bool,
    #[serde(default)]
    pub subtitle_stream: Option<i32>,
    #[serde(default)]
    pub subtitle_file: Option<String>,
    #[serde(default)]
    pub subtitle_font: Option<String>,
    #[serde(default)]
    pub subtitle_color: Option<String>,
    #[serde(default)]
    pub subtitle_size: Option<f64>,
    #[serde(default)]
    pub subtitle_shadow: Option<bool>,
    #[serde(default)]
    pub subtitle_stroke: Option<bool>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub video_bitrate: Option<String>,
    #[serde(default)]
    pub audio_bitrate: Option<String>,
    #[serde(default)]
    pub crf: Option<i32>,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub x264_preset: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultDto {
    pub success: bool,
    pub output_path: String,
    pub mode: String,
    pub clip_count: usize,
    pub message: String,
}

fn ffmpeg_ok(dir: &Path) -> bool {
    dir.join("ffmpeg.exe").is_file() && dir.join("ffprobe.exe").is_file()
}

fn find_ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir);
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(&pf).join("ffmpeg").join("bin"));
        candidates.push(PathBuf::from(&pf).join("FFmpeg").join("bin"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&home).join("scoop").join("apps").join("ffmpeg").join("current").join("bin"));
        candidates.push(PathBuf::from(&home).join("scoop").join("shims"));
    }
    if let Ok(data) = app.path().app_local_data_dir() {
        candidates.push(data.join("ffmpeg"));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(la).join("Grimcut").join("ffmpeg"));
    }
    // Dev checkout only — not shipped.
    let mut dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dev.pop();
    candidates.push(dev.join("tools").join("ffmpeg"));
    for c in candidates {
        if ffmpeg_ok(&c) {
            return Some(c);
        }
    }
    None
}

fn offer_ffmpeg_install() -> bool {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONINFORMATION, MB_YESNO};
        let r = unsafe {
            MessageBoxW(
                None,
                w!("Grimcut needs FFmpeg to open, preview, and export video.\n\nInstall FFmpeg now? (~80 MB download)\n\nThis is like a DirectX runtime for games. You can also install FFmpeg yourself and add it to PATH."),
                w!("Grimcut — FFmpeg required"),
                MB_YESNO | MB_ICONINFORMATION,
            )
        };
        r == IDYES
    }
    #[cfg(not(windows))]
    {
        true
    }
}

pub(crate) fn ffmpeg_bin(app: &AppHandle, name: &str) -> PathBuf {
    let dir = match ensure_ffmpeg(app) {
        Ok(d) => d,
        Err(_) => find_ffmpeg_dir(app).unwrap_or_else(|| PathBuf::from(".")),
    };
    dir.join(format!("{name}.exe"))
}

fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = find_ffmpeg_dir(app) {
        return Ok(dir);
    }
    static OFFERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if OFFERED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("FFmpeg is not installed. Restart Grimcut to install, or add ffmpeg.exe and ffprobe.exe to PATH.".into());
    }
    if !offer_ffmpeg_install() {
        return Err("FFmpeg is required. Install it (winget install Gyan.FFmpeg) or restart Grimcut and choose Yes.".into());
    }
    let dest = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("ffmpeg");
    let _ = app.emit(
        "export-progress",
        serde_json::json!({ "label": "Downloading FFmpeg…", "pct": 8.0 }),
    );
    fetch_ffmpeg(&dest)?;
    if ffmpeg_ok(&dest) {
        let _ = app.emit(
            "export-progress",
            serde_json::json!({ "label": "FFmpeg installed.", "pct": 100.0 }),
        );
        Ok(dest)
    } else {
        Err("FFmpeg download finished but ffmpeg.exe is missing.".into())
    }
}

#[tauri::command]
fn ensure_ffmpeg_cmd(app: AppHandle) -> Result<String, String> {
    ensure_ffmpeg(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Same script the installer runs: picks the newest stable FFmpeg release build.
const INSTALL_FFMPEG_PS1: &str = include_str!("../../scripts/install-ffmpeg.ps1");

fn fetch_ffmpeg(dest: &Path) -> Result<(), String> {
    let script = std::env::temp_dir().join("grimcut-install-ffmpeg.ps1");
    // BOM so Windows PowerShell reads the script as UTF-8.
    fs::write(&script, format!("\u{feff}{INSTALL_FFMPEG_PS1}")).map_err(|e| e.to_string())?;
    let mut cmd = hidden_command("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Dest")
        .arg(dest);
    let status = cmd.status().map_err(|e| format!("Could not start download: {e}"));
    let _ = fs::remove_file(&script);
    if !status?.success() {
        return Err("FFmpeg download failed. Get a Windows GPL build from https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds/releases and put ffmpeg.exe + ffprobe.exe (and DLLs) next to Grimcut.exe in an ffmpeg folder.".into());
    }
    Ok(())
}

pub(crate) fn hidden_command(bin: impl AsRef<Path>) -> Command {
    let mut cmd = Command::new(bin.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub(crate) async fn off_thread<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static CANCEL: AtomicBool = AtomicBool::new(false);
static JOB: Mutex<Option<std::process::Child>> = Mutex::new(None);

#[derive(Clone, Serialize)]
struct ProgressEvt {
    label: String,
    pct: f64,
}

fn emit_prog(app: &AppHandle, label: &str, pct: f64) {
    let _ = app.emit(
        "export-progress",
        ProgressEvt {
            label: label.into(),
            pct: pct.clamp(0.0, 99.5),
        },
    );
}

fn kill_job() {
    CANCEL.store(true, Ordering::SeqCst);
    if let Ok(mut g) = JOB.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[tauri::command]
fn cancel_export() {
    kill_job();
}

fn run_ffmpeg_progress(
    app: &AppHandle,
    ffmpeg: &Path,
    args: &[String],
    total_sec: f64,
    label: &str,
) -> Result<(String, i32), String> {
    CANCEL.store(false, Ordering::SeqCst);
    kill_job();
    CANCEL.store(false, Ordering::SeqCst);
    let mut argv = args.to_vec();
    if let Some(out) = argv.pop() {
        argv.push("-progress".into());
        argv.push("pipe:1".into());
        argv.push("-nostats".into());
        argv.push(out);
    }
    let mut cmd = hidden_command(ffmpeg);
    cmd.args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", ffmpeg.display()))?;
    let stdout = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    {
        *JOB.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    }
    if let Some(out) = stdout {
        let r = BufReader::new(out);
        for line in r.lines().map_while(Result::ok) {
            if CANCEL.load(Ordering::SeqCst) {
                break;
            }
            let line = line.trim();
            if let Some(v) = line.strip_prefix("out_time_ms=") {
                if let Ok(raw) = v.parse::<f64>() {
                    if total_sec > 0.05 {
                        let sec = if raw > total_sec * 2000.0 {
                            raw / 1_000_000.0
                        } else {
                            raw / 1000.0
                        };
                        emit_prog(app, label, (sec / total_sec) * 100.0);
                    }
                }
            } else if let Some(v) = line.strip_prefix("out_time=") {
                // HH:MM:SS.micro
                if let Some(sec) = parse_out_time(v) {
                    if total_sec > 0.05 {
                        emit_prog(app, label, (sec / total_sec) * 100.0);
                    }
                }
            }
        }
    }
    let mut err = String::new();
    if let Some(s) = stderr_pipe {
        err = BufReader::new(s).lines().map_while(Result::ok).collect::<Vec<_>>().join("\n");
    }
    let cancelled = CANCEL.load(Ordering::SeqCst);
    let code = {
        let mut g = JOB.lock().unwrap_or_else(|e| e.into_inner());
        if cancelled {
            if let Some(c) = g.as_mut() {
                let _ = c.kill();
            }
        }
        match g.take() {
            Some(mut c) => c.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
            None => -1,
        }
    };
    if cancelled {
        return Err("Export cancelled.".into());
    }
    Ok((err, code))
}

fn parse_out_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s == "N/A" {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let sec: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + sec)
    } else {
        s.parse().ok()
    }
}

fn plan_secs(plan: &ExportPlan) -> f64 {
    plan.clips
        .iter()
        .map(|c| {
            if c.gap {
                c.duration.max(0.02)
            } else {
                (c.source_end - c.source_start).max(c.duration).max(0.02)
            }
        })
        .sum()
}

pub(crate) fn run_cmd(bin: &Path, args: &[&str]) -> Result<(String, String, i32), String> {
    let out = hidden_command(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to start {}: {e}", bin.display()))?;
    let code = out.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    Ok((stdout, stderr, code))
}

fn parse_rate(s: &str) -> Option<f64> {
    if s == "0/0" || s.is_empty() {
        return None;
    }
    if let Some((n, d)) = s.split_once('/') {
        let num: f64 = n.parse().ok()?;
        let den: f64 = d.parse().ok()?;
        if den != 0.0 {
            return Some(num / den);
        }
    }
    s.parse().ok()
}

#[tauri::command]
async fn probe(app: AppHandle, path: String) -> Result<MediaInfoDto, String> {
    off_thread(move || probe_sync(app, path)).await
}

#[tauri::command]
async fn probe_quick(app: AppHandle, path: String) -> Result<f64, String> {
    off_thread(move || probe_quick_sync(app, path)).await
}

fn probe_quick_sync(app: AppHandle, path: String) -> Result<f64, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("File not found: {path}"));
    }
    let ffprobe = ffmpeg_bin(&app, "ffprobe");
    let (stdout, _, code) = run_cmd(
        &ffprobe,
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            &path,
        ],
    )?;
    if code != 0 {
        return Err("Could not read duration.".into());
    }
    stdout
        .trim()
        .parse::<f64>()
        .map_err(|_| "Could not read duration.".into())
}

fn probe_sync(app: AppHandle, path: String) -> Result<MediaInfoDto, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("File not found: {path}"));
    }
    emit_prog(&app, "Reading media…", 12.0);
    let ffprobe = ffmpeg_bin(&app, "ffprobe");
    let (stdout, stderr, code) = run_cmd(
        &ffprobe,
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ],
    )?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("ffprobe failed ({code})")
        } else {
            stderr
        });
    }
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("ffprobe json: {e}"))?;

    let mut duration = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let container = v["format"]["format_name"]
        .as_str()
        .map(|s| s.split(',').next().unwrap_or(s).to_string());

    let mut video_codec = None;
    let mut width = None;
    let mut height = None;
    let mut frame_rate = None;
    let mut audio_codec = None;
    let mut has_audio = false;
    let mut subtitles: Vec<SubtitleTrackDto> = Vec::new();

    if let Some(streams) = v["streams"].as_array() {
        for s in streams {
            match s["codec_type"].as_str() {
                Some("subtitle") => {
                    let codec = s["codec_name"].as_str().unwrap_or("unknown").to_string();
                    let index = s["index"].as_i64().unwrap_or(0) as i32;
                    let language = s["tags"]["language"].as_str().map(|x| x.to_string());
                    let title = s["tags"]["title"].as_str().map(|x| x.to_string());
                    subtitles.push(SubtitleTrackDto {
                        index,
                        codec: codec.clone(),
                        language,
                        title,
                        text: is_text_sub(&codec),
                        sidecar: None,
                    });
                }
                Some("video") if video_codec.is_none() => {
                    video_codec = s["codec_name"].as_str().map(|x| x.to_string());
                    width = s["width"].as_i64().map(|x| x as i32);
                    height = s["height"].as_i64().map(|x| x as i32);
                    // Phones store portrait video as landscape frames plus a rotation flag.
                    // FFmpeg and the webview both apply it, so report the size as displayed.
                    if is_quarter_turn(s) {
                        std::mem::swap(&mut width, &mut height);
                    }
                    frame_rate = s["avg_frame_rate"]
                        .as_str()
                        .and_then(parse_rate)
                        .or_else(|| s["r_frame_rate"].as_str().and_then(parse_rate));
                    if duration <= 0.0 {
                        if let Some(d) = s["duration"].as_str().and_then(|x| x.parse().ok()) {
                            duration = d;
                        }
                    }
                }
                Some("audio") => {
                    has_audio = true;
                    if audio_codec.is_none() {
                        audio_codec = s["codec_name"].as_str().map(|x| x.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    subtitles.extend(sidecar_subs(&path));

    Ok(MediaInfoDto {
        path,
        duration,
        container,
        video_codec,
        width,
        height,
        audio_codec,
        frame_rate,
        has_audio,
        keyframe_times: vec![],
        subtitles,
    })
}

/// Rotation of a probed video stream, from the display matrix (current FFmpeg) or the
/// legacy `rotate` tag (older FFmpeg).
fn stream_rotation(s: &serde_json::Value) -> i64 {
    let from_side = s["side_data_list"].as_array().and_then(|list| {
        list.iter().find_map(|d| d["rotation"].as_f64())
    });
    let from_tag = || s["tags"]["rotate"].as_str().and_then(|x| x.trim().parse::<f64>().ok());
    from_side.or_else(from_tag).map(|r| r.round() as i64).unwrap_or(0)
}

fn is_quarter_turn(s: &serde_json::Value) -> bool {
    stream_rotation(s).rem_euclid(180) == 90
}

fn is_text_sub(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "ass" | "ssa" | "subrip" | "srt" | "mov_text" | "webvtt" | "text" | "ttml"
    )
}

fn sidecar_subs(video_path: &str) -> Vec<SubtitleTrackDto> {
    let p = Path::new(video_path);
    let mut out = Vec::new();
    for ext in ["srt", "vtt", "ass", "ssa"] {
        let cand = p.with_extension(ext);
        if cand.is_file() {
            let codec = if ext == "vtt" { "webvtt" } else if ext == "ass" || ext == "ssa" { ext } else { "subrip" };
            out.push(SubtitleTrackDto {
                index: -1 - out.len() as i32,
                codec: codec.into(),
                language: None,
                title: Some(format!("sidecar .{ext}")),
                text: true,
                sidecar: Some(cand.to_string_lossy().into_owned()),
            });
        }
    }
    out
}

fn path_same(a: &str, b: &str) -> bool {
    let na = a.replace('\\', "/").to_ascii_lowercase();
    let nb = b.replace('\\', "/").to_ascii_lowercase();
    na == nb
}

fn ass_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 {
        return "&H00FFFFFF".into();
    }
    let r = &h[0..2];
    let g = &h[2..4];
    let b = &h[4..6];
    format!("&H00{b}{g}{r}")
}

fn subtitles_expr(ass: &Path, plan: &ExportPlan) -> String {
    let s = ass.to_string_lossy().replace('\\', "/");
    let escaped = s.replace('\'', r"\'").replace(':', r"\:");
    let font = plan
        .subtitle_font
        .as_deref()
        .unwrap_or("Segoe UI")
        .replace('\\', "")
        .replace('\'', "")
        .replace(',', " ");
    let h = plan.height.unwrap_or(1080) as f64;
    let px = plan.subtitle_size.unwrap_or(48.0).clamp(6.0, 400.0);
    let size = (px * 288.0 / h).clamp(8.0, 120.0);
    let color = ass_color(plan.subtitle_color.as_deref().unwrap_or("#ffffff"));
    let outline = if plan.subtitle_stroke.unwrap_or(true) { 1.8 } else { 0.0 };
    let shadow = if plan.subtitle_shadow.unwrap_or(true) { 0.8 } else { 0.0 };
    format!(
        "subtitles='{escaped}':force_style='Fontname={font},Fontsize={size:.1},PrimaryColour={color},OutlineColour=&H00101010,BorderStyle=1,Outline={outline},Shadow={shadow},Alignment=2,MarginV=28'"
    )
}

/// Extract text subs to ASS (or use a sidecar). Applied *before* trim so cue times match source PTS.
fn prepare_burn_subs(
    ffmpeg: &Path,
    plan: &ExportPlan,
    work: &Path,
) -> Result<Option<(String, PathBuf)>, String> {
    if !plan.burn_subs {
        return Ok(None);
    }
    if let Some(file) = plan.subtitle_file.as_deref() {
        if Path::new(file).is_file() {
            return Ok(Some((plan.source_path.clone(), PathBuf::from(file))));
        }
        return Err(format!("Subtitle file not found: {file}"));
    }
    let Some(idx) = plan.subtitle_stream else {
        return Err("No subtitle track selected.".into());
    };
    if idx < 0 {
        return Err("No subtitle track selected.".into());
    }
    fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let dest = work.join("burn.ass");
    let map = format!("0:{idx}");
    let dest_s = dest.to_string_lossy().into_owned();
    let try_extract = |codec: &str| -> Result<i32, String> {
        let args = [
            "-hide_banner",
            "-y",
            "-i",
            &plan.source_path,
            "-map",
            &map,
            "-c:s",
            codec,
            &dest_s,
        ];
        let (_, err, code) = run_cmd(ffmpeg, &args)?;
        if code != 0 {
            Err(trim_ffmpeg_err(&err))
        } else {
            Ok(code)
        }
    };
    if try_extract("ass").is_err() {
        let srt = work.join("burn.srt");
        let srt_s = srt.to_string_lossy().into_owned();
        let args = [
            "-hide_banner",
            "-y",
            "-i",
            &plan.source_path,
            "-map",
            &map,
            "-c:s",
            "srt",
            &srt_s,
        ];
        let (_, err, code) = run_cmd(ffmpeg, &args)?;
        if code != 0 {
            return Err(format!("Could not extract subtitles: {}", trim_ffmpeg_err(&err)));
        }
        return Ok(Some((plan.source_path.clone(), srt)));
    }
    Ok(Some((plan.source_path.clone(), dest)))
}

fn burn_prefix(src: &str, burn: &Option<(String, PathBuf)>, plan: &ExportPlan) -> String {
    match burn {
        Some((from, file)) if path_same(src, from) => format!("{},", subtitles_expr(file, plan)),
        _ => String::new(),
    }
}

#[tauri::command]
async fn probe_keyframes(app: AppHandle, path: String) -> Result<Vec<f64>, String> {
    off_thread(move || {
        let ffprobe = ffmpeg_bin(&app, "ffprobe");
        Ok(load_keyframes(&ffprobe, &path))
    })
    .await
}

fn load_keyframes(ffprobe: &Path, path: &str) -> Vec<f64> {
    // Keyframes only — listing every packet on a 40‑min episode is very slow.
    let Ok((stdout, _, code)) = run_cmd(
        ffprobe,
        &[
            "-v",
            "error",
            "-skip_frame",
            "nokey",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
            path,
        ],
    ) else {
        return vec![];
    };
    if code != 0 {
        return vec![];
    }
    let mut times = Vec::new();
    for line in stdout.lines() {
        let line = line.trim().trim_end_matches(',');
        if line.is_empty() {
            continue;
        }
        let pts = line.split(',').next().unwrap_or(line);
        if let Ok(sec) = pts.parse::<f64>() {
            if sec >= 0.0 {
                times.push(sec);
            }
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    times
}

#[derive(Clone)]
struct EncoderOpt {
    id: &'static str,
    label: &'static str,
    args: Vec<&'static str>,
}

fn gpu_adapter_names() -> String {
    let ps = r#"Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"#;
    if let Ok(out) = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps])
        .output()
    {
        return String::from_utf8_lossy(&out.stdout).to_lowercase();
    }
    String::new()
}

fn encoder_priority() -> Vec<&'static str> {
    let gpus = gpu_adapter_names();
    let amd = gpus.contains("amd") || gpus.contains("radeon") || gpus.contains("advanced micro");
    let nvidia = gpus.contains("nvidia") || gpus.contains("geforce") || gpus.contains("quadro");
    let intel = gpus.contains("intel") || gpus.contains("uhd") || gpus.contains("iris");
    let mut order = Vec::new();
    if nvidia {
        order.push("h264_nvenc");
    }
    if amd {
        order.push("h264_amf");
    }
    if intel {
        order.push("h264_qsv");
    }
    for id in ["h264_nvenc", "h264_amf", "h264_qsv"] {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    order.push("libx264");
    order
}

fn encoder_catalog() -> [EncoderOpt; 5] {
    [
        EncoderOpt {
            id: "h264_nvenc",
            label: "NVIDIA NVENC",
            args: vec!["-c:v", "h264_nvenc", "-cq", "19", "-preset", "p4", "-pix_fmt", "yuv420p"],
        },
        EncoderOpt {
            id: "h264_amf",
            label: "AMD AMF",
            args: vec![
                "-c:v",
                "h264_amf",
                "-usage",
                "transcoding",
                "-quality",
                "balanced",
                "-pix_fmt",
                "yuv420p",
            ],
        },
        EncoderOpt {
            id: "h264_qsv",
            label: "Intel Quick Sync",
            args: vec!["-c:v", "h264_qsv", "-global_quality", "22", "-pix_fmt", "yuv420p"],
        },
        EncoderOpt {
            id: "h264_nvenc",
            label: "NVIDIA NVENC",
            args: vec!["-c:v", "h264_nvenc", "-cq", "19", "-preset", "medium", "-pix_fmt", "yuv420p"],
        },
        EncoderOpt {
            id: "libx264",
            label: "CPU (libx264)",
            args: vec!["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"],
        },
    ]
}

fn hevc_catalog() -> [EncoderOpt; 4] {
    [
        EncoderOpt {
            id: "hevc_nvenc",
            label: "NVIDIA HEVC",
            args: vec!["-c:v", "hevc_nvenc", "-cq", "22", "-preset", "p4", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"],
        },
        EncoderOpt {
            id: "hevc_amf",
            label: "AMD HEVC",
            args: vec![
                "-c:v",
                "hevc_amf",
                "-usage",
                "transcoding",
                "-quality",
                "balanced",
                "-pix_fmt",
                "yuv420p",
                "-tag:v",
                "hvc1",
            ],
        },
        EncoderOpt {
            id: "hevc_qsv",
            label: "Intel HEVC",
            args: vec!["-c:v", "hevc_qsv", "-global_quality", "22", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"],
        },
        EncoderOpt {
            id: "libx265",
            label: "CPU (libx265)",
            args: vec!["-c:v", "libx265", "-crf", "22", "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"],
        },
    ]
}

fn av1_catalog() -> [EncoderOpt; 4] {
    [
        EncoderOpt {
            id: "av1_nvenc",
            label: "NVIDIA AV1",
            args: vec!["-c:v", "av1_nvenc", "-cq", "28", "-preset", "p4", "-pix_fmt", "yuv420p"],
        },
        EncoderOpt {
            id: "av1_amf",
            label: "AMD AV1",
            args: vec![
                "-c:v",
                "av1_amf",
                "-usage",
                "transcoding",
                "-quality",
                "balanced",
                "-pix_fmt",
                "yuv420p",
            ],
        },
        EncoderOpt {
            id: "av1_qsv",
            label: "Intel AV1",
            args: vec!["-c:v", "av1_qsv", "-global_quality", "28", "-pix_fmt", "yuv420p"],
        },
        EncoderOpt {
            id: "libsvtav1",
            label: "CPU (SVT-AV1)",
            args: vec!["-c:v", "libsvtav1", "-crf", "28", "-preset", "6", "-pix_fmt", "yuv420p"],
        },
    ]
}

fn sibling_encoder(h264_id: &str, family: &str) -> Option<&'static str> {
    Some(match (h264_id, family) {
        ("h264_nvenc", "hevc") => "hevc_nvenc",
        ("h264_amf", "hevc") => "hevc_amf",
        ("h264_qsv", "hevc") => "hevc_qsv",
        ("libx264", "hevc") => "libx265",
        ("h264_nvenc", "av1") => "av1_nvenc",
        ("h264_amf", "av1") => "av1_amf",
        ("h264_qsv", "av1") => "av1_qsv",
        ("libx264", "av1") => "libsvtav1",
        _ => return None,
    })
}

fn strip_av_flag(args: &mut Vec<String>, keys: &[&str]) {
    let mut i = 0;
    while i < args.len() {
        if keys.contains(&args[i].as_str()) {
            args.remove(i);
            if i < args.len() && !args[i].starts_with('-') {
                args.remove(i);
            }
        } else {
            i += 1;
        }
    }
}

fn bufsize_of(br: &str) -> String {
    let s = br.trim().to_ascii_lowercase();
    let (n, k) = if let Some(v) = s.strip_suffix('k') {
        (v.parse::<f64>().unwrap_or(2500.0), "k")
    } else if let Some(v) = s.strip_suffix('m') {
        (v.parse::<f64>().unwrap_or(8.0), "M")
    } else {
        (s.parse::<f64>().unwrap_or(2_500_000.0), "")
    };
    if k.is_empty() {
        format!("{}", (n * 2.0).round() as i64)
    } else {
        format!("{}{k}", (n * 2.0).round() as i64)
    }
}

fn map_nvenc_preset(p: &str) -> &'static str {
    match p {
        "ultrafast" | "superfast" | "veryfast" => "p1",
        "faster" => "p2",
        "fast" => "p3",
        "slow" => "p6",
        "slower" | "veryslow" => "p7",
        _ => "p4",
    }
}

fn pick_family(ffmpeg: &Path, family: &str, gpu_only: bool) -> Vec<EncoderOpt> {
    let catalog: Vec<EncoderOpt> = match family {
        "hevc" => hevc_catalog().into_iter().collect(),
        "av1" => av1_catalog().into_iter().collect(),
        _ => working_encoders(ffmpeg),
    };
    let mut out = Vec::new();
    for h264_id in encoder_priority() {
        let Some(id) = sibling_encoder(h264_id, family) else { continue };
        if gpu_only && (id.starts_with("lib") || id == "libsvtav1") {
            continue;
        }
        if let Some(opt) = catalog.iter().find(|e| e.id == id) {
            if out.iter().any(|p: &EncoderOpt| p.id == opt.id) {
                continue;
            }
            if encoder_smoke_test(ffmpeg, &opt.args) {
                out.push(opt.clone());
            }
        }
    }
    if !gpu_only {
        let cpu_id = if family == "hevc" {
            "libx265"
        } else if family == "av1" {
            "libsvtav1"
        } else {
            "libx264"
        };
        if let Some(opt) = catalog.iter().find(|e| e.id == cpu_id) {
            if !out.iter().any(|p| p.id == opt.id) && encoder_smoke_test(ffmpeg, &opt.args) {
                out.push(opt.clone());
            }
        }
    }
    out
}

fn pick_encoders(ffmpeg: &Path, plan: &ExportPlan) -> Vec<EncoderOpt> {
    match plan.encoder.as_deref().unwrap_or("auto") {
        "auto" | "h264" | "libx264" => working_encoders(ffmpeg),
        "hevc" | "libx265" => pick_family(ffmpeg, "hevc", false),
        "av1" | "libsvtav1" => pick_family(ffmpeg, "av1", false),
        other => working_encoders(ffmpeg)
            .into_iter()
            .filter(|e| e.id == other)
            .collect(),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportCodecDto {
    id: String,
    label: String,
}

fn codec_row(id: &str, name: &str, encoders: &[EncoderOpt]) -> Option<ExportCodecDto> {
    if encoders.is_empty() {
        return None;
    }
    let hw = encoders.iter().any(|e| !e.id.starts_with("lib"));
    Some(ExportCodecDto {
        id: id.into(),
        label: if hw {
            name.into()
        } else {
            format!("{name}*")
        },
    })
}

fn probe_export_codecs(ffmpeg: &Path) -> Vec<ExportCodecDto> {
    let mut out = Vec::new();
    if let Some(row) = codec_row("h264", "H.264", &working_encoders(ffmpeg)) {
        out.push(row);
    }
    if let Some(row) = codec_row("hevc", "H.265", &pick_family(ffmpeg, "hevc", false)) {
        out.push(row);
    }
    if let Some(row) = codec_row("av1", "AV1", &pick_family(ffmpeg, "av1", false)) {
        out.push(row);
    }
    out
}

#[tauri::command]
async fn list_export_codecs(app: AppHandle) -> Result<Vec<ExportCodecDto>, String> {
    static CACHE: std::sync::OnceLock<Vec<ExportCodecDto>> = std::sync::OnceLock::new();
    if let Some(c) = CACHE.get() {
        return Ok(c.clone());
    }
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    let list = tauri::async_runtime::spawn_blocking(move || probe_export_codecs(&ffmpeg))
        .await
        .map_err(|e| e.to_string())?;
    let _ = CACHE.set(list.clone());
    Ok(list)
}

fn video_encode_args(enc: &EncoderOpt, plan: &ExportPlan, fps: f64) -> Vec<String> {
    let mut args: Vec<String> = enc.args.iter().map(|s| (*s).to_string()).collect();
    let profile = plan.profile.as_deref().unwrap_or("quick");
    if let Some(br) = plan.video_bitrate.as_deref() {
        strip_av_flag(
            &mut args,
            &["-cq", "-crf", "-global_quality", "-b:v", "-maxrate", "-bufsize", "-rc"],
        );
        if enc.id.contains("nvenc") {
            args.extend(["-rc".into(), "vbr".into()]);
        }
        args.extend([
            "-b:v".into(),
            br.into(),
            "-maxrate".into(),
            br.into(),
            "-bufsize".into(),
            bufsize_of(br),
        ]);
    } else if let Some(crf) = plan.crf {
        strip_av_flag(&mut args, &["-cq", "-crf", "-global_quality"]);
        if enc.id.contains("nvenc") {
            args.extend(["-cq".into(), crf.to_string()]);
        } else if enc.id.contains("qsv") {
            args.extend(["-global_quality".into(), crf.to_string()]);
        } else {
            args.extend(["-crf".into(), crf.to_string()]);
        }
    }
    if let Some(p) = plan.x264_preset.as_deref() {
        strip_av_flag(&mut args, &["-preset", "-quality"]);
        if enc.id.contains("nvenc") {
            args.extend(["-preset".into(), map_nvenc_preset(p).into()]);
        } else if enc.id.contains("amf") {
            let q = if p.contains("fast") { "speed" } else if p.contains("slow") { "quality" } else { "balanced" };
            args.extend(["-quality".into(), q.into()]);
        } else {
            args.extend(["-preset".into(), p.into()]);
        }
    }
    if profile == "youtube" {
        args.extend(["-profile:v".into(), "high".into()]);
        let g = ((fps.max(24.0)) * 2.0).round() as i32;
        args.extend(["-g".into(), g.to_string(), "-bf".into(), "2".into()]);
    }
    if !args.windows(2).any(|w| w[0] == "-movflags") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    args
}

fn h264_safe_output(path: &str) -> String {
    let p = PathBuf::from(path);
    match p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" | "gif" | "webp" => p.with_extension("mp4").to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

fn run_filtered_encode(
    app: &AppHandle,
    ffmpeg: &Path,
    plan: &ExportPlan,
    inputs: &[String],
    filter_arg: &str,
    work: &Path,
    fps: f64,
) -> Result<String, String> {
    let attempts = pick_encoders(ffmpeg, plan);
    if attempts.is_empty() {
        let _ = fs::remove_dir_all(work);
        return Err("No matching encoder available.".into());
    }
    let audio_br = plan.audio_bitrate.as_deref().unwrap_or("192k");
    let dur = plan_secs(plan).max(0.05);
    let mut last_err = String::from("encode failed");
    for (i, enc) in attempts.iter().enumerate() {
        let label = format!("Encoding {}…", enc.label);
        emit_prog(app, &label, 0.0);
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
        for inp in inputs {
            let lower = inp.to_ascii_lowercase();
            if lower.ends_with(".webm") {
                // libvpx keeps VP8/VP9 WebM alpha (alpha_mode=1). Native decode often drops it.
                args.push("-c:v".into());
                args.push("libvpx-vp9".into());
            }
            args.push("-i".into());
            args.push(inp.clone());
        }
        args.extend([
            "-/filter_complex".into(),
            filter_arg.into(),
            "-map".into(),
            "[vout]".into(),
        ]);
        if plan.has_audio {
            args.extend([
                "-map".into(),
                "[aout]".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                audio_br.into(),
            ]);
        } else {
            args.push("-an".into());
        }
        args.extend(video_encode_args(enc, plan, fps));
        // Source chapter markers keep their episode timestamps and stretch the
        // seek bar past the cut. Subs are burned, not copied as a stream.
        args.extend(["-map_chapters".into(), "-1".into(), "-dn".into(), "-sn".into()]);
        args.push(plan.output_path.clone());
        let (err, code) = run_ffmpeg_progress(app, ffmpeg, &args, dur, &label)?;
        if code == 0 {
            emit_prog(app, &format!("Encoded with {}.", enc.label), 100.0);
            let _ = fs::remove_dir_all(work);
            return Ok(enc.label.to_string());
        }
        last_err = trim_ffmpeg_err(&err);
        if last_err.to_ascii_lowercase().contains("cancel") {
            let _ = fs::remove_dir_all(work);
            return Err(last_err);
        }
        let next = attempts.get(i + 1).map(|e| e.label).unwrap_or("give up");
        emit_prog(
            app,
            &format!("{} failed, encoding with {next}…", enc.label),
            0.0,
        );
    }
    let _ = fs::remove_dir_all(work);
    Err(last_err)
}

fn encoder_smoke_test(ffmpeg: &Path, args: &[&str]) -> bool {
    // AMD VCN/AMF rejects tiny frames (128x72 → Init error 5). 640x360 is safe
    // for AMF, NVENC, and QSV.
    let mut cmd = vec![
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:d=0.25:r=30",
    ];
    cmd.extend_from_slice(args);
    cmd.extend_from_slice(&["-frames:v", "8", "-f", "null", "-"]);
    matches!(run_cmd(ffmpeg, &cmd), Ok((_, _, 0)))
}

/// Encoders that actually work on this machine, GPU-first (not merely compiled into FFmpeg).
fn working_encoders(ffmpeg: &Path) -> Vec<EncoderOpt> {
    static CACHE: std::sync::OnceLock<Vec<EncoderOpt>> = std::sync::OnceLock::new();
    if let Some(c) = CACHE.get() {
        return c.clone();
    }
    let catalog = encoder_catalog();
    let mut picked: Vec<EncoderOpt> = Vec::new();
    for id in encoder_priority() {
        for opt in catalog.iter() {
            if opt.id != id {
                continue;
            }
            if picked.iter().any(|p| p.args == opt.args) {
                continue;
            }
            if encoder_smoke_test(ffmpeg, &opt.args) {
                picked.push(EncoderOpt {
                    id: opt.id,
                    label: opt.label,
                    args: opt.args.clone(),
                });
            }
        }
    }
    if !picked.iter().any(|p| p.id == "libx264") {
        if let Some(cpu) = catalog.iter().find(|o| o.id == "libx264") {
            picked.push(EncoderOpt {
                id: cpu.id,
                label: cpu.label,
                args: cpu.args.clone(),
            });
        }
    }
    CACHE.get_or_init(|| picked.clone()).clone()
}

#[tauri::command]
async fn waveform(app: AppHandle, path: String) -> Result<Vec<f32>, String> {
    off_thread(move || waveform_sync(app, path)).await
}

fn waveform_sync(app: AppHandle, path: String) -> Result<Vec<f32>, String> {
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    let out = hidden_command(&ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-i",
            &path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "4000",
            "-f",
            "u8",
            "-acodec",
            "pcm_u8",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("waveform ffmpeg: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        return Ok(vec![]);
    }
    let raw = out.stdout;
    if raw.is_empty() {
        return Ok(vec![]);
    }
    // Dense enough that zooming in still has a peak per pixel or two.
    const MAX: usize = 40000;
    let bucket = (raw.len() / MAX).max(1);
    let mut peaks = Vec::with_capacity(raw.len() / bucket + 1);
    let mut i = 0;
    while i < raw.len() {
        let end = (i + bucket).min(raw.len());
        let mut peak = 0u8;
        for &b in &raw[i..end] {
            let amp = b.abs_diff(128);
            if amp > peak {
                peak = amp;
            }
        }
        peaks.push(peak as f32 / 128.0);
        i = end;
    }
    Ok(peaks)
}

#[tauri::command]
fn set_aspect_lock(aspect: f64, extra: f64, enabled: bool) {
    windows_sizing::set_lock(aspect, extra, enabled);
}

#[tauri::command]
fn suggest_save(path: String) -> String {
    let p = PathBuf::from(&path);
    let dir = p.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let ext = "mp4";
    let candidate = dir.join(format!("{stem}_edited.{ext}"));
    if !candidate.exists() {
        return candidate.to_string_lossy().into_owned();
    }
    for i in 2..1000 {
        let c = dir.join(format!("{stem}_edited_{i}.{ext}"));
        if !c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    candidate.to_string_lossy().into_owned()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubCueDto {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

fn parse_sub_ts(raw: &str) -> Option<f64> {
    let s = raw.trim().replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let sec: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + sec)
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse().ok()?;
        let sec: f64 = parts[1].parse().ok()?;
        Some(m * 60.0 + sec)
    } else {
        s.parse().ok()
    }
}

fn strip_sub_markup(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            while let Some(n) = chars.next() {
                if n == '>' {
                    break;
                }
            }
            continue;
        }
        if c == '{' {
            while let Some(n) = chars.next() {
                if n == '}' {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out.replace("\\N", "\n").replace("\\n", "\n")
}

fn parse_arrow_times(line: &str) -> Option<(f64, f64)> {
    let idx = line.find("-->")?;
    let a = line[..idx].trim();
    let a = a.split_whitespace().last().unwrap_or(a);
    let b = line[idx + 3..].trim().split_whitespace().next()?;
    let s = parse_sub_ts(a)?;
    let e = parse_sub_ts(b)?;
    if e > s {
        Some((s, e))
    } else {
        None
    }
}

fn parse_ass_dialogue(line: &str) -> Option<SubCueDto> {
    let rest = line.strip_prefix("Dialogue:")?.trim();
    let mut start = 0;
    let mut fields: Vec<&str> = Vec::new();
    for _ in 0..9 {
        let rel = rest[start..].find(',')?;
        fields.push(rest[start..start + rel].trim());
        start += rel + 1;
    }
    if fields.len() < 3 {
        return None;
    }
    let s = parse_sub_ts(fields[1])?;
    let e = parse_sub_ts(fields[2])?;
    let t = strip_sub_markup(rest[start..].trim()).trim().to_string();
    if t.is_empty() || e <= s {
        return None;
    }
    Some(SubCueDto { start: s, end: e, text: t })
}

fn parse_srt_like(body: &str) -> Vec<SubCueDto> {
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    if body.contains("Dialogue:") {
        let ass: Vec<_> = body.lines().filter_map(parse_ass_dialogue).collect();
        if ass.len() > 1 {
            return ass;
        }
    }
    let mut cues = Vec::new();
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some((s, e)) = parse_arrow_times(trimmed) {
            i += 1;
            let mut text: Vec<String> = Vec::new();
            while i < lines.len() {
                let t = lines[i].trim();
                if parse_arrow_times(t).is_some() {
                    break;
                }
                if t.is_empty() {
                    i += 1;
                    break;
                }
                if t.eq_ignore_ascii_case("webvtt") || t.starts_with("NOTE ") {
                    i += 1;
                    continue;
                }
                if t.chars().all(|c| c.is_ascii_digit()) && text.is_empty() {
                    i += 1;
                    continue;
                }
                text.push(t.to_string());
                i += 1;
            }
            let t = strip_sub_markup(&text.join("\n")).trim().to_string();
            if !t.is_empty() {
                cues.push(SubCueDto { start: s, end: e, text: t });
            }
            continue;
        }
        i += 1;
    }
    cues
}

#[tauri::command]
async fn extract_subtitles(
    app: AppHandle,
    path: String,
    stream: Option<i32>,
    sidecar: Option<String>,
) -> Result<Vec<SubCueDto>, String> {
    off_thread(move || extract_subtitles_sync(app, path, stream, sidecar)).await
}

fn extract_subtitles_sync(
    app: AppHandle,
    path: String,
    stream: Option<i32>,
    sidecar: Option<String>,
) -> Result<Vec<SubCueDto>, String> {
    if let Some(file) = sidecar.as_deref() {
        let p = Path::new(file);
        if !p.is_file() {
            return Err(format!("Subtitle file not found: {file}"));
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "srt" || ext == "vtt" {
            let body = fs::read_to_string(p).map_err(|e| e.to_string())?;
            return Ok(parse_srt_like(&body));
        }
    }
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    let dest = std::env::temp_dir().join(format!("grimcut-subs-{}.srt", uuid_like()));
    let dest_s = dest.to_string_lossy().into_owned();
    let input = sidecar.as_deref().unwrap_or(&path);
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-i".into(),
        input.into(),
    ];
    if sidecar.is_none() {
        if let Some(idx) = stream {
            if idx >= 0 {
                args.extend(["-map".into(), format!("0:{idx}")]);
            } else {
                args.extend(["-map".into(), "0:s:0".into()]);
            }
        } else {
            args.extend(["-map".into(), "0:s:0".into()]);
        }
    }
    args.extend(["-f".into(), "srt".into(), dest_s.clone()]);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_, err, code) = run_cmd(&ffmpeg, &refs)?;
    if code != 0 {
        let _ = fs::remove_file(&dest);
        return Err(format!("Could not extract subtitles: {}", trim_ffmpeg_err(&err)));
    }
    let body = fs::read_to_string(&dest).unwrap_or_default();
    let _ = fs::remove_file(&dest);
    Ok(parse_srt_like(&body))
}

#[tauri::command]
async fn drop_preview_cache() -> Result<(), String> {
    off_thread(drop_preview_cache_sync).await
}

fn drop_preview_cache_sync() -> Result<(), String> {
    let dir = std::env::temp_dir();
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let name = ent.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("grimcut-proxy-") || n.starts_with("grimcut-px-") {
                let _ = fs::remove_file(ent.path());
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProxyDto {
    pub video: String,
    pub audio: Option<String>,
}

#[tauri::command]
async fn make_proxy(app: AppHandle, path: String, video_codec: Option<String>) -> Result<PreviewProxyDto, String> {
    off_thread(move || make_proxy_sync(app, path, video_codec)).await
}

fn make_proxy_sync(app: AppHandle, path: String, video_codec: Option<String>) -> Result<PreviewProxyDto, String> {
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    let stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("v")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect::<String>();
    let video = std::env::temp_dir().join(format!("grimcut-px-vo-{stem}.mp4"));
    let audio = std::env::temp_dir().join(format!("grimcut-px-a-{stem}.m4a"));
    let fresh = |p: &Path| {
        if !p.exists() {
            return false;
        }
        if let (Ok(src), Ok(dst)) = (fs::metadata(&path), fs::metadata(p)) {
            dst.len() > 400 && dst.modified().ok() >= src.modified().ok()
        } else {
            false
        }
    };
    if fresh(&video) && fresh(&audio) {
        return Ok(PreviewProxyDto {
            video: video.to_string_lossy().into_owned(),
            audio: Some(audio.to_string_lossy().into_owned()),
        });
    }
    let video_s = video.to_string_lossy().into_owned();
    let audio_s = audio.to_string_lossy().into_owned();
    let hevc = matches!(
        video_codec
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "hevc" | "h265" | "hev1" | "hvc1"
    );
    let _ = app.emit("export-progress", "Remuxing preview…");

    // Picture: video-only mp4. Sound is a separate m4a — never mux source AAC onto
    // <video>; WebView decodes it even when muted and one bad packet kills the picture.
    let mut vargs: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        path.clone(),
        "-map".into(),
        "0:v:0".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-c:v".into(),
        "copy".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
    ];
    if hevc {
        vargs.extend(["-tag:v".into(), "hvc1".into()]);
    }
    vargs.extend(["-movflags".into(), "+faststart".into(), video_s.clone()]);
    let vrefs: Vec<&str> = vargs.iter().map(|s| s.as_str()).collect();
    let (_, verr, vcode) = run_cmd(&ffmpeg, &vrefs)?;
    if vcode != 0 || !fresh(&video) {
        let _ = fs::remove_file(&video);
        return Err(if verr.trim().is_empty() {
            "Preview remux failed.".into()
        } else {
            trim_ffmpeg_err(&verr)
        });
    }

    let aargs = [
        "-hide_banner",
        "-y",
        "-i",
        &path,
        "-map",
        "0:a:0?",
        "-vn",
        "-sn",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        &audio_s,
    ];
    let (_, _, acode) = run_cmd(&ffmpeg, &aargs)?;
    let audio_out = if acode == 0 && fresh(&audio) {
        Some(audio_s)
    } else {
        let _ = fs::remove_file(&audio);
        None
    };
    Ok(PreviewProxyDto { video: video_s, audio: audio_out })
}

#[tauri::command]
async fn export_video(app: AppHandle, plan: ExportPlan) -> Result<ExportResultDto, String> {
    off_thread(move || export_video_sync(app, plan)).await
}

fn export_video_sync(app: AppHandle, mut plan: ExportPlan) -> Result<ExportResultDto, String> {
    plan.output_path = h264_safe_output(&plan.output_path);
    emit_prog(&app, "Starting export…", 2.0);
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    if plan.clips.is_empty() {
        return Err("Nothing to export.".into());
    }

    let has_gap = plan.clips.iter().any(|c| c.gap)
        || plan
            .audio_clips
            .as_ref()
            .map(|a| a.iter().any(|c| c.gap))
            .unwrap_or(false);

    if plan.use_stream_copy && !has_gap && !plan.burn_subs {
        emit_prog(&app, "Stream copy…", 40.0);
        export_copy(&ffmpeg, &plan)?;
        return Ok(ExportResultDto {
            success: true,
            output_path: plan.output_path.clone(),
            mode: "stream-copy".into(),
            clip_count: plan.clips.len(),
            message: "Saved with stream copy — cut(s) landed on keyframes.".into(),
        });
    }

    emit_prog(&app, "Encoding…", 4.0);
    let used = export_reencode(&app, &ffmpeg, &plan)?;
    Ok(ExportResultDto {
        success: true,
        output_path: plan.output_path.clone(),
        mode: "reencode".into(),
        clip_count: plan.clips.len(),
        message: format!("Saved with high-quality re-encode for clean cuts. Used {used}."),
    })
}

fn mp4_copy_flags(dest: &str) -> Vec<&'static str> {
    let ext = Path::new(dest)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "mp4" || ext == "m4v" || ext == "mov" {
        vec!["-movflags", "+faststart"]
    } else {
        vec![]
    }
}

fn export_copy(ffmpeg: &Path, plan: &ExportPlan) -> Result<(), String> {
    if plan.clips.len() == 1 {
        let src = plan.clips[0]
            .source_path
            .as_deref()
            .unwrap_or(&plan.source_path);
        return extract_copy(
            ffmpeg,
            src,
            &plan.clips[0],
            &plan.output_path,
            plan.has_audio,
            plan.video_codec.as_deref(),
        );
    }
    let work = std::env::temp_dir().join(format!("grimcut-export-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut list = String::new();
    for (i, clip) in plan.clips.iter().enumerate() {
        let part = work.join(format!("part_{i:03}.mkv"));
        let src = clip
            .source_path
            .as_deref()
            .unwrap_or(&plan.source_path);
        extract_copy(
            ffmpeg,
            src,
            clip,
            part.to_str().unwrap(),
            plan.has_audio,
            plan.video_codec.as_deref(),
        )?;
        let escaped = part.to_string_lossy().replace('\'', r"'\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    let list_path = work.join("concat.txt");
    fs::write(&list_path, list).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string_lossy().into_owned(),
        "-c".into(),
        "copy".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map_chapters".into(),
        "-1".into(),
        "-dn".into(),
        "-sn".into(),
    ];
    if plan.has_audio {
        args.extend(["-map".into(), "0:a:0".into()]);
    }
    hevc_tag(plan.video_codec.as_deref(), &plan.output_path, &mut args);
    for f in mp4_copy_flags(&plan.output_path) {
        args.push(f.into());
    }
    args.push(plan.output_path.clone());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_, err, code) = run_cmd(ffmpeg, &arg_refs)?;
    let _ = fs::remove_dir_all(&work);
    if code != 0 {
        return Err(trim_ffmpeg_err(&err));
    }
    Ok(())
}

fn hevc_tag(codec: Option<&str>, dest: &str, args: &mut Vec<String>) {
    let ext = Path::new(dest)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let hevc = matches!(codec.map(|c| c.to_ascii_lowercase()).as_deref(), Some("hevc" | "h265"));
    if hevc && matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }
}

fn extract_copy(
    ffmpeg: &Path,
    src: &str,
    clip: &ClipDto,
    dest: &str,
    has_audio: bool,
    video_codec: Option<&str>,
) -> Result<(), String> {
    if clip.gap {
        return Err("Stream copy cannot include timeline gaps.".into());
    }
    let start = clip.source_start.max(0.0);
    let end = clip.source_end.max(start + 0.02);
    let dur = (end - start).max(0.02);
    let start_s = format!("{start:.6}");
    let dur_s = format!("{dur:.6}");
    // Input -ss so copy begins at a keyframe. -ss after -i with -c copy often
    // drops the GOP and leaves a black still + audio.
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-ss".into(),
        start_s,
        "-i".into(),
        src.into(),
        "-t".into(),
        dur_s,
        "-c".into(),
        "copy".into(),
        "-map".into(),
        "0:v:0".into(),
        "-map_chapters".into(),
        "-1".into(),
        "-dn".into(),
        "-sn".into(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
    ];
    if has_audio {
        args.extend(["-map".into(), "0:a:0".into()]);
    }
    hevc_tag(video_codec, dest, &mut args);
    for f in mp4_copy_flags(dest) {
        args.push(f.into());
    }
    args.push(dest.into());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_, err, code) = run_cmd(ffmpeg, &arg_refs)?;
    if code != 0 {
        return Err(trim_ffmpeg_err(&err));
    }
    Ok(())
}

pub(crate) fn trim_ffmpeg_err(stderr: &str) -> String {
    let useful: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !l.starts_with("ffmpeg version")
                && !l.starts_with("Copyright")
                && !l.starts_with("built with")
                && !l.starts_with("configuration:")
                && !l.starts_with("  lib")
                && !l.starts_with("libav")
        })
        .collect();
    let take = useful.iter().rev().take(18).rev().cloned().collect::<Vec<_>>();
    if take.is_empty() {
        stderr.chars().take(1200).collect()
    } else {
        take.join("\n")
    }
}

fn even_dim(n: i32, fallback: i32) -> i32 {
    let v = if n > 1 { n } else { fallback };
    v - (v % 2)
}

fn collect_inputs(plan: &ExportPlan) -> Vec<String> {
    let mut v = vec![plan.source_path.clone()];
    let push = |v: &mut Vec<String>, p: &str| {
        if !v.iter().any(|x| x == p) {
            v.push(p.to_string());
        }
    };
    for c in plan
        .clips
        .iter()
        .chain(plan.audio_clips.iter().flatten())
        .chain(plan.audio_overlay.iter().flatten())
    {
        if c.gap {
            continue;
        }
        if let Some(p) = &c.source_path {
            push(&mut v, p);
        }
    }
    if let Some(slices) = &plan.comp_slices {
        for s in slices {
            for l in &s.layers {
                push(&mut v, &l.source_path);
            }
        }
    }
    v
}

fn append_audio_concat(
    fc: &mut String,
    inputs: &[String],
    plan: &ExportPlan,
    clips: &[ClipDto],
    out: &str,
) {
    let mut pads = String::new();
    for (i, clip) in clips.iter().enumerate() {
        let lab = format!("{out}{i}");
        if clip.gap {
            let d = clip.duration.max(0.02);
            fc.push_str(&format!(
                "anullsrc=r=48000:cl=stereo:d={d:.6},aformat=sample_fmts=fltp:channel_layouts=stereo[{lab}];"
            ));
        } else {
            let start = clip.source_start.max(0.0);
            let end = clip.source_end.max(start + 0.02);
            let idx = clip_input_index(inputs, plan, clip);
            let gain = if clip.gain_db.abs() > 0.05 {
                format!(",volume={:.2}dB", clip.gain_db)
            } else {
                String::new()
            };
            fc.push_str(&format!(
                "[{idx}:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo{gain}[{lab}];"
            ));
        }
        pads.push_str(&format!("[{lab}]"));
    }
    fc.push_str(&format!("{}concat=n={}:v=0:a=1[{out}];", pads, clips.len()));
}

fn append_audio_mix(fc: &mut String, inputs: &[String], plan: &ExportPlan) {
    if !plan.has_audio {
        if fc.ends_with(';') {
            fc.pop();
        }
        return;
    }
    let base = plan.audio_clips.as_ref().unwrap_or(&plan.clips);
    if base.is_empty() {
        if fc.ends_with(';') {
            fc.pop();
        }
        return;
    }
    let over = plan
        .audio_overlay
        .as_ref()
        .filter(|v| v.iter().any(|c| !c.gap));
    if let Some(over) = over {
        append_audio_concat(fc, inputs, plan, base, "ab");
        append_audio_concat(fc, inputs, plan, over, "ao");
        fc.push_str("[ab][ao]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]");
    } else {
        append_audio_concat(fc, inputs, plan, base, "aout");
        if fc.ends_with(';') {
            fc.pop();
        }
    }
}

fn clip_input_index(inputs: &[String], plan: &ExportPlan, clip: &ClipDto) -> usize {
    let src = clip.source_path.as_deref().unwrap_or(&plan.source_path);
    inputs.iter().position(|p| p == src).unwrap_or(0)
}

fn contain_wh(src_w: i32, src_h: i32, canvas_w: i32, canvas_h: i32, scale_x: f64, scale_y: f64) -> (i32, i32) {
    let sw = src_w.max(2) as f64;
    let sh = src_h.max(2) as f64;
    let fit = (canvas_w as f64 / sw).min(canvas_h as f64 / sh);
    (
        even_dim((sw * fit * scale_x.max(0.02)) as i32, 2),
        even_dim((sh * fit * scale_y.max(0.02)) as i32, 2),
    )
}

fn font_file(family: &str) -> String {
    let n = family.to_ascii_lowercase();
    let file = if n.contains("arial") {
        "arial.ttf"
    } else if n.contains("georgia") {
        "georgia.ttf"
    } else if n.contains("times") {
        "times.ttf"
    } else if n.contains("verdana") {
        "verdana.ttf"
    } else if n.contains("comic") {
        "comic.ttf"
    } else if n.contains("impact") {
        "impact.ttf"
    } else if n.contains("courier") {
        "cour.ttf"
    } else if n.contains("trebuchet") {
        "trebuc.ttf"
    } else {
        "segoeui.ttf"
    };
    format!("C\\:/Windows/Fonts/{file}")
}

fn drawtext_filter(src: &str, dst: &str, tx: &CompTextDto, _w: i32, _h: i32) -> String {
    let escaped = tx
        .text
        .replace('\\', "\\\\\\\\")
        .replace(':', "\\:")
        .replace('\'', "\u{2019}")
        .replace('%', "%%");
    let size = tx.font_size.max(8.0);
    let color = tx.color.trim_start_matches('#').trim();
    let color = if color.is_empty() { "ffffff" } else { color };
    let ink = contrast_ink(color);
    let mut extra = String::new();
    if tx.stroke {
        let bw = (size * 0.07).max(1.0);
        extra.push_str(&format!(":borderw={bw:.1}:bordercolor={ink}"));
    }
    if tx.shadow {
        let sx = (size * 0.05).max(1.0);
        let sy = (size * 0.07).max(1.0);
        extra.push_str(&format!(":shadowx={sx:.1}:shadowy={sy:.1}:shadowcolor=000000@0.75"));
    }
    format!(
        "[{src}]drawtext=fontfile='{font}':text='{escaped}':fontsize={size}:fontcolor={color}:x=(w-text_w)/2+{x:.2}:y=(h-text_h)/2+{y:.2}{extra}[{dst}];",
        font = font_file(&tx.font_family),
        x = tx.x,
        y = tx.y,
    )
}

fn contrast_ink(hex: &str) -> &'static str {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 {
        return "000000";
    }
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(255) as f64;
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(255) as f64;
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(255) as f64;
    if 0.2126 * r + 0.7152 * g + 0.0722 * b > 140.0 {
        "000000"
    } else {
        "ffffff"
    }
}

fn export_composite(app: &AppHandle, ffmpeg: &Path, plan: &ExportPlan) -> Result<String, String> {
    let w = even_dim(plan.width.unwrap_or(1920), 1920);
    let h = even_dim(plan.height.unwrap_or(1080), 1080);
    let fps = plan.frame_rate.filter(|f| *f > 1.0 && *f < 240.0).unwrap_or(30.0);
    let inputs = collect_inputs(plan);
    let work = std::env::temp_dir().join(format!("grimcut-comp-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let burn = match prepare_burn_subs(ffmpeg, plan, &work) {
        Ok(b) => b,
        Err(e) => {
            let _ = fs::remove_dir_all(&work);
            return Err(e);
        }
    };
    if burn.is_some() {
        let _ = app.emit("export-progress", "Burning subtitles…");
    }
    let slices = plan.comp_slices.as_ref().unwrap();
    let mut fc = String::new();
    let mut vpads = String::new();
    for (i, slice) in slices.iter().enumerate() {
        let d = slice.duration.max(0.02);
        if slice.layers.is_empty() {
            fc.push_str(&format!(
                "color=c=black:s={w}x{h}:r={fps}:d={d:.6},format=rgba,setsar=1[v{i}];"
            ));
        } else {
        fc.push_str(&format!(
            "color=c=black:s={w}x{h}:r={fps}:d={d:.6},format=rgba,setsar=1[bg{i}];"
        ));
        let mut prev = format!("bg{i}");
        for (j, layer) in slice.layers.iter().enumerate() {
            let idx = inputs
                .iter()
                .position(|p| p == &layer.source_path)
                .unwrap_or(0);
            let start = layer.source_start.max(0.0);
            let end = layer.source_end.max(start + 0.02);
            let sx = layer.scale_x.unwrap_or(layer.scale);
            let sy = layer.scale_y.unwrap_or(layer.scale);
            let (dw, dh) = contain_wh(layer.src_width, layer.src_height, w, h, sx, sy);
            let lab = format!("l{i}_{j}");
            let rot = layer.rotation;
            let blur = if layer.blur > 0.05 {
                format!(",gblur=sigma={:.2}", layer.blur.max(0.3))
            } else {
                String::new()
            };
            let sub = burn_prefix(&layer.source_path, &burn, plan);
            if rot.abs() > 0.05 {
                fc.push_str(&format!(
                    "[{idx}:v]{sub}trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={dw}:{dh}:flags=bicubic,format=rgba,rotate={rad:.6}:ow=rotw(iw):oh=roth(ih):c=none{blur}[{lab}];",
                    rad = rot * std::f64::consts::PI / 180.0
                ));
            } else if !blur.is_empty() {
                fc.push_str(&format!(
                    "[{idx}:v]{sub}trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={dw}:{dh}:flags=bicubic,format=rgba{blur}[{lab}];"
                ));
            } else {
                fc.push_str(&format!(
                    "[{idx}:v]{sub}trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={dw}:{dh}:flags=bicubic,format=rgba[{lab}];"
                ));
            }
            let out = if j + 1 == slice.layers.len() {
                format!("v{i}")
            } else {
                format!("t{i}_{j}")
            };
            fc.push_str(&format!(
                "[{prev}][{lab}]overlay=x=(main_w-overlay_w)/2+{x:.2}:y=(main_h-overlay_h)/2+{y:.2}:shortest=1:format=auto[{out}];",
                x = layer.x,
                y = layer.y
            ));
            prev = out;
        }
        } // else layers
        let mut vlab = format!("v{i}");
        for (k, tx) in slice.texts.iter().enumerate() {
            if tx.text.trim().is_empty() {
                continue;
            }
            let nxt = format!("vtx{i}_{k}");
            fc.push_str(&drawtext_filter(&vlab, &nxt, tx, w, h));
            vlab = nxt;
        }
        vpads.push_str(&format!("[{vlab}]"));
    }
    fc.push_str(&format!(
        "{}concat=n={}:v=1:a=0,format=yuv420p,setsar=1[vout];",
        vpads,
        slices.len()
    ));

    append_audio_mix(&mut fc, &inputs, plan);

    let filter_path = work.join("filter.txt");
    fs::write(&filter_path, &fc).map_err(|e| e.to_string())?;
    let filter_arg = filter_path.to_string_lossy().into_owned();
    run_filtered_encode(app, ffmpeg, plan, &inputs, &filter_arg, &work, fps)
}

fn export_reencode(app: &AppHandle, ffmpeg: &Path, plan: &ExportPlan) -> Result<String, String> {
    if plan
        .comp_slices
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return export_composite(app, ffmpeg, plan);
    }
    let w = even_dim(plan.width.unwrap_or(1920), 1920);
    let h = even_dim(plan.height.unwrap_or(1080), 1080);
    let fps = plan.frame_rate.filter(|f| *f > 1.0 && *f < 240.0).unwrap_or(30.0);
    let inputs = collect_inputs(plan);

    let work = std::env::temp_dir().join(format!("grimcut-export-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let burn = match prepare_burn_subs(ffmpeg, plan, &work) {
        Ok(b) => b,
        Err(e) => {
            let _ = fs::remove_dir_all(&work);
            return Err(e);
        }
    };
    if burn.is_some() {
        let _ = app.emit("export-progress", "Burning subtitles…");
    }

    let mut fc = String::new();
    let mut vpads = String::new();
    for (i, clip) in plan.clips.iter().enumerate() {
        if clip.gap {
            let d = clip.duration.max(0.02);
            fc.push_str(&format!(
                "color=c=black:s={w}x{h}:r={fps}:d={d:.6},format=yuv420p,setsar=1[v{i}];"
            ));
        } else {
            let start = clip.source_start.max(0.0);
            let end = clip.source_end.max(start + 0.02);
            let idx = clip_input_index(&inputs, plan, clip);
            let src = clip.source_path.as_deref().unwrap_or(&plan.source_path);
            let sub = burn_prefix(src, &burn, plan);
            fc.push_str(&format!(
                "[{idx}:v]{sub}trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={w}:{h}:flags=bicubic,format=yuv420p,setsar=1[v{i}];"
            ));
        }
        vpads.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!(
        "{}concat=n={}:v=1:a=0[vout];",
        vpads,
        plan.clips.len()
    ));

    append_audio_mix(&mut fc, &inputs, plan);

    let filter_path = work.join("filter.txt");
    fs::write(&filter_path, &fc).map_err(|e| e.to_string())?;
    let filter_arg = filter_path.to_string_lossy().into_owned();
    run_filtered_encode(app, ffmpeg, plan, &inputs, &filter_arg, &work, fps)
}

#[tauri::command]
fn log_frontend_error(app: AppHandle, message: String) -> Result<String, String> {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamp = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let body = format!("\n===== {ts} ({stamp}) =====\n{message}\n");

    let mut written: Option<PathBuf> = None;
    let mut last_err = String::from("could not write crash log");

    let mut targets: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        targets.push(dir.join("crash.log"));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("logs")
        .join("grimcut-crash.log");
    if let Some(parent) = dev.parent() {
        let _ = fs::create_dir_all(parent);
    }
    targets.push(dev);

    for path in targets {
        match fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(mut f) => {
                if f.write_all(body.as_bytes()).is_ok() {
                    written = Some(path);
                }
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    written
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or(last_err)
}

#[tauri::command]
fn append_play_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let mut paths = Vec::new();
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        paths.push(dir.join("playback.log"));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("logs")
        .join("playback.log");
    if let Some(parent) = dev.parent() {
        let _ = fs::create_dir_all(parent);
    }
    paths.push(dev);
    let body = format!("{line}\n");
    for path in paths {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(body.as_bytes());
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccentColors {
    background: String,
    foreground: String,
}

#[tauri::command]
fn get_system_accent() -> Result<AccentColors, String> {
    #[cfg(windows)]
    {
        return read_windows_accent();
    }
    #[cfg(not(windows))]
    {
        Err("System accent is only implemented on Windows".into())
    }
}

#[cfg(windows)]
fn read_windows_accent() -> Result<AccentColors, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let from_dwm = (|| -> Option<(u8, u8, u8)> {
        let dwm = hkcu.open_subkey("Software\\Microsoft\\Windows\\DWM").ok()?;
        let color: u32 = dwm.get_value("AccentColor").ok()?;
        Some(abgr_to_rgb(color))
    })();

    let from_explorer = (|| -> Option<(u8, u8, u8)> {
        let accent = hkcu
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent")
            .ok()?;
        let color: u32 = accent.get_value("AccentColorMenu").ok()?;
        Some(abgr_to_rgb(color))
    })();

    let from_colorization = (|| -> Option<(u8, u8, u8)> {
        let dwm = hkcu.open_subkey("Software\\Microsoft\\Windows\\DWM").ok()?;
        let color: u32 = dwm.get_value("ColorizationColor").ok()?;
        Some(abgr_to_rgb(color))
    })();

    let (r, g, b) = from_dwm
        .or(from_explorer)
        .or(from_colorization)
        .ok_or_else(|| "Could not read Windows accent color from registry".to_string())?;

    let background = format!("#{r:02x}{g:02x}{b:02x}");
    let foreground = if relative_luminance(r, g, b) > 0.55 {
        "#1a1a1a".to_string()
    } else {
        "#ffffff".to_string()
    };

    Ok(AccentColors {
        background,
        foreground,
    })
}

#[cfg(windows)]
fn abgr_to_rgb(color: u32) -> (u8, u8, u8) {
    let r = (color & 0xFF) as u8;
    let g = ((color >> 8) & 0xFF) as u8;
    let b = ((color >> 16) & 0xFF) as u8;
    (r, g, b)
}

#[cfg(windows)]
fn relative_luminance(r: u8, g: u8, b: u8) -> f64 {
    fn lin(c: u8) -> f64 {
        let s = c as f64 / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

pub(crate) fn uuid_like() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

/// True when this exe was put in place by the NSIS installer, which leaves
/// `uninstall.exe` beside it. The portable exe can't self-update: the updater
/// runs the installer, which would install a second copy elsewhere.
#[tauri::command]
fn is_installed_copy() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            if let Some(win) = app.get_webview_window("main") {
                windows_sizing::set_app(app.handle().clone());
                windows_sizing::install_hook(&win);
            }
            agent::start_agent_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe,
            waveform,
            suggest_save,
            make_proxy,
            drop_preview_cache,
            extract_subtitles,
            list_export_codecs,
            export_video,
            cancel_export,
            probe_quick,
            probe_keyframes,
            set_aspect_lock,
            log_frontend_error,
            append_play_log,
            get_system_accent,
            ensure_ffmpeg_cmd,
            is_installed_copy,
            agent::agent_reply,
            agent::grab_frame,
            filmstrip::filmstrip_luma,
            filmstrip::filmstrip_thumbs
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                agent::clear_agent_file();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_matrix_rotation_is_a_quarter_turn() {
        let s = json!({ "width": 1280, "height": 720,
            "side_data_list": [{ "side_data_type": "Display Matrix", "rotation": -90 }] });
        assert_eq!(stream_rotation(&s), -90);
        assert!(is_quarter_turn(&s));
    }

    #[test]
    fn legacy_rotate_tag_is_read() {
        let s = json!({ "tags": { "rotate": "270" } });
        assert!(is_quarter_turn(&s));
    }

    #[test]
    fn upright_and_upside_down_keep_their_size() {
        assert!(!is_quarter_turn(&json!({})));
        assert!(!is_quarter_turn(&json!({ "side_data_list": [{ "rotation": 180 }] })));
        assert!(!is_quarter_turn(&json!({ "side_data_list": [{ "side_data_type": "CPB" }] })));
    }
}
