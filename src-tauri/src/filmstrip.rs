use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilmThumbDto {
    pub time: f64,
    pub path: String,
}

fn cache_dir(src: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    let len = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    std::env::temp_dir()
        .join("grimcut-strip")
        .join(format!("{:x}-{len}", h.finish()))
}

#[tauri::command]
pub async fn filmstrip_luma(app: AppHandle, path: String, count: u32) -> Result<Vec<u8>, String> {
    crate::off_thread(move || filmstrip_luma_sync(app, path, count)).await
}

fn filmstrip_luma_sync(app: AppHandle, path: String, count: u32) -> Result<Vec<u8>, String> {
    if !Path::new(&path).is_file() {
        return Err("File not found.".into());
    }
    let n = count.clamp(24, 1200) as f64;
    let ffmpeg = crate::ffmpeg_bin(&app, "ffmpeg");
    let ffprobe = crate::ffmpeg_bin(&app, "ffprobe");
    let (stdout, _, code) = crate::run_cmd(
        &ffprobe,
        &["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", &path],
    )?;
    if code != 0 {
        return Err("Could not read duration.".into());
    }
    let dur: f64 = stdout.trim().parse::<f64>().unwrap_or(1.0).max(0.2);
    let fps = (n / dur).clamp(0.05, 30.0);
    let fps_s = format!("{fps:.4}");
    let args = [
        "-hide_banner",
        "-y",
        "-i",
        &path,
        "-an",
        "-vf",
        &format!("fps={fps_s},scale=1:1:flags=fast_bilinear,format=gray"),
        "-f",
        "rawvideo",
        "pipe:1",
    ];
    let mut cmd = crate::hidden_command(&ffmpeg);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(crate::trim_ffmpeg_err(&String::from_utf8_lossy(&out.stderr)));
    }
    let mut bytes = out.stdout;
    if bytes.len() as f64 > n * 1.5 {
        bytes.truncate(n as usize);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn filmstrip_thumbs(app: AppHandle, path: String, times: Vec<f64>) -> Result<Vec<FilmThumbDto>, String> {
    crate::off_thread(move || filmstrip_thumbs_sync(app, path, times)).await
}

fn filmstrip_thumbs_sync(app: AppHandle, path: String, times: Vec<f64>) -> Result<Vec<FilmThumbDto>, String> {
    if !Path::new(&path).is_file() {
        return Err("File not found.".into());
    }
    let dir = cache_dir(&path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ffmpeg = crate::ffmpeg_bin(&app, "ffmpeg");
    let mut out = Vec::new();
    for t in times {
        if !t.is_finite() || t < 0.0 {
            continue;
        }
        let key = (t * 20.0).round() / 20.0;
        let dest = dir.join(format!("{key:.2}.jpg"));
        let dest_s = dest.to_string_lossy().into_owned();
        if dest.is_file() && dest.metadata().map(|m| m.len() > 80).unwrap_or(false) {
            out.push(FilmThumbDto { time: key, path: dest_s });
            continue;
        }
        let ts = format!("{key:.3}");
        let args = [
            "-hide_banner",
            "-y",
            "-ss",
            &ts,
            "-i",
            &path,
            "-frames:v",
            "1",
            "-vf",
            "scale=96:54:force_original_aspect_ratio=decrease,pad=96:54:(ow-iw)/2:(oh-ih)/2",
            "-q:v",
            "6",
            &dest_s,
        ];
        let (_, _, code) = crate::run_cmd(&ffmpeg, &args)?;
        if code == 0 && dest.is_file() {
            out.push(FilmThumbDto { time: key, path: dest_s });
        }
    }
    Ok(out)
}
