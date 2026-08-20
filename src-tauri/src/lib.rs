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
    pub rotation: f64,
    #[serde(default)]
    pub src_width: i32,
    #[serde(default)]
    pub src_height: i32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompSliceDto {
    pub duration: f64,
    #[serde(default)]
    pub layers: Vec<CompLayerDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub source_path: String,
    pub output_path: String,
    pub clips: Vec<ClipDto>,
    pub audio_clips: Option<Vec<ClipDto>>,
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

fn tools_dir(app: &AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let next_to_exe = dir.join("ffmpeg");
            if next_to_exe.join("ffmpeg.exe").exists() {
                return next_to_exe;
            }
            let tools = dir.join("tools").join("ffmpeg");
            if tools.join("ffmpeg.exe").exists() {
                return tools;
            }
        }
    }
    // Dev: src-tauri/../../tools/ffmpeg
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.pop();
    dir.push("tools");
    dir.push("ffmpeg");
    if dir.join("ffmpeg.exe").exists() {
        return dir;
    }
    // Walk up from resource dir
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("tools").join("ffmpeg");
        if p.join("ffmpeg.exe").exists() {
            return p;
        }
    }
    dir
}

fn ffmpeg_bin(app: &AppHandle, name: &str) -> PathBuf {
    tools_dir(app).join(format!("{name}.exe"))
}

fn hidden_command(bin: impl AsRef<Path>) -> Command {
    let mut cmd = Command::new(bin.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run_cmd(bin: &Path, args: &[&str]) -> Result<(String, String, i32), String> {
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
fn probe(app: AppHandle, path: String) -> Result<MediaInfoDto, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("File not found: {path}"));
    }
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

    if let Some(streams) = v["streams"].as_array() {
        for s in streams {
            match s["codec_type"].as_str() {
                Some("video") if video_codec.is_none() => {
                    video_codec = s["codec_name"].as_str().map(|x| x.to_string());
                    width = s["width"].as_i64().map(|x| x as i32);
                    height = s["height"].as_i64().map(|x| x as i32);
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

    let keyframe_times = load_keyframes(&ffprobe, &path);

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
        keyframe_times,
    })
}

fn load_keyframes(ffprobe: &Path, path: &str) -> Vec<f64> {
    let Ok((stdout, _, code)) = run_cmd(
        ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,flags",
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
        let (pts, flags) = match line.split_once(',') {
            Some((p, f)) => (p, f),
            None => continue,
        };
        if !flags.contains('K') {
            continue;
        }
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
fn waveform(app: AppHandle, path: String) -> Result<Vec<f32>, String> {
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
            "8000",
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
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
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

#[tauri::command]
fn make_proxy(app: AppHandle, path: String) -> Result<String, String> {
    let ffmpeg = ffmpeg_bin(&app, "ffmpeg");
    let dest = std::env::temp_dir().join(format!(
        "grimcut-proxy-{}.mp4",
        Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("v")
    ));
    if dest.exists() {
        if let (Ok(src), Ok(dst)) = (fs::metadata(&path), fs::metadata(&dest)) {
            if dst.len() > 1000 && dst.modified().ok() >= src.modified().ok() {
                return Ok(dest.to_string_lossy().into_owned());
            }
        }
    }
    let (_, err, code) = run_cmd(
        &ffmpeg,
        &[
            "-y",
            "-i",
            &path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            dest.to_str().unwrap_or(""),
        ],
    )?;
    if code != 0 {
        return Err(trim_ffmpeg_err(&err));
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_video(app: AppHandle, plan: ExportPlan) -> Result<ExportResultDto, String> {
    let _ = app.emit("export-progress", "Starting export…");
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

    if plan.use_stream_copy && !has_gap {
        let _ = app.emit("export-progress", "Stream copy…");
        export_copy(&ffmpeg, &plan)?;
        return Ok(ExportResultDto {
            success: true,
            output_path: plan.output_path.clone(),
            mode: "stream-copy".into(),
            clip_count: plan.clips.len(),
            message: "Saved with stream copy — cut(s) landed on keyframes.".into(),
        });
    }

    let _ = app.emit("export-progress", "Re-encoding for clean cuts…");
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

fn trim_ffmpeg_err(stderr: &str) -> String {
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
    for c in plan.clips.iter().chain(plan.audio_clips.iter().flatten()) {
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

fn clip_input_index(inputs: &[String], plan: &ExportPlan, clip: &ClipDto) -> usize {
    let src = clip.source_path.as_deref().unwrap_or(&plan.source_path);
    inputs.iter().position(|p| p == src).unwrap_or(0)
}

fn contain_wh(src_w: i32, src_h: i32, canvas_w: i32, canvas_h: i32, scale: f64) -> (i32, i32) {
    let sw = src_w.max(2) as f64;
    let sh = src_h.max(2) as f64;
    let fit = (canvas_w as f64 / sw).min(canvas_h as f64 / sh) * scale.max(0.02);
    (
        even_dim((sw * fit) as i32, 2),
        even_dim((sh * fit) as i32, 2),
    )
}

fn export_composite(app: &AppHandle, ffmpeg: &Path, plan: &ExportPlan) -> Result<String, String> {
    let w = even_dim(plan.width.unwrap_or(1920), 1920);
    let h = even_dim(plan.height.unwrap_or(1080), 1080);
    let fps = plan.frame_rate.filter(|f| *f > 1.0 && *f < 240.0).unwrap_or(30.0);
    let inputs = collect_inputs(plan);
    let slices = plan.comp_slices.as_ref().unwrap();
    let mut fc = String::new();
    let mut vpads = String::new();
    for (i, slice) in slices.iter().enumerate() {
        let d = slice.duration.max(0.02);
        if slice.layers.is_empty() {
            fc.push_str(&format!(
                "color=c=black:s={w}x{h}:r={fps}:d={d:.6},format=yuv420p,setsar=1[v{i}];"
            ));
            vpads.push_str(&format!("[v{i}]"));
            continue;
        }
        fc.push_str(&format!(
            "color=c=black:s={w}x{h}:r={fps}:d={d:.6},format=yuv420p,setsar=1[bg{i}];"
        ));
        let mut prev = format!("bg{i}");
        for (j, layer) in slice.layers.iter().enumerate() {
            let idx = inputs
                .iter()
                .position(|p| p == &layer.source_path)
                .unwrap_or(0);
            let start = layer.source_start.max(0.0);
            let end = layer.source_end.max(start + 0.02);
            let (dw, dh) = contain_wh(layer.src_width, layer.src_height, w, h, layer.scale);
            let lab = format!("l{i}_{j}");
            let rot = layer.rotation;
            if rot.abs() > 0.05 {
                fc.push_str(&format!(
                    "[{idx}:v]trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={dw}:{dh}:flags=bicubic,format=rgba,rotate={rad:.6}:ow=rotw(iw):oh=roth(ih):c=none[{lab}];",
                    rad = rot * std::f64::consts::PI / 180.0
                ));
            } else {
                fc.push_str(&format!(
                    "[{idx}:v]trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={dw}:{dh}:flags=bicubic,format=yuv420p[{lab}];"
                ));
            }
            let out = if j + 1 == slice.layers.len() {
                format!("v{i}")
            } else {
                format!("t{i}_{j}")
            };
            fc.push_str(&format!(
                "[{prev}][{lab}]overlay=x=(main_w-overlay_w)/2+{x:.2}:y=(main_h-overlay_h)/2+{y:.2}:shortest=1[{out}];",
                x = layer.x,
                y = layer.y
            ));
            prev = out;
        }
        vpads.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!(
        "{}concat=n={}:v=1:a=0[vout];",
        vpads,
        slices.len()
    ));

    let audio_src = plan.audio_clips.as_ref().unwrap_or(&plan.clips);
    if plan.has_audio && !audio_src.is_empty() {
        let mut apads = String::new();
        for (i, clip) in audio_src.iter().enumerate() {
            if clip.gap {
                let d = clip.duration.max(0.02);
                fc.push_str(&format!(
                    "anullsrc=r=48000:cl=stereo:d={d:.6},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                ));
            } else {
                let start = clip.source_start.max(0.0);
                let end = clip.source_end.max(start + 0.02);
                let idx = clip_input_index(&inputs, plan, clip);
                fc.push_str(&format!(
                    "[{idx}:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                ));
            }
            apads.push_str(&format!("[a{i}]"));
        }
        fc.push_str(&format!(
            "{}concat=n={}:v=0:a=1[aout]",
            apads,
            audio_src.len()
        ));
    } else if fc.ends_with(';') {
        fc.pop();
    }

    let work = std::env::temp_dir().join(format!("grimcut-comp-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let filter_path = work.join("filter.txt");
    fs::write(&filter_path, &fc).map_err(|e| e.to_string())?;
    let filter_arg = filter_path.to_string_lossy().into_owned();
    let attempts = working_encoders(ffmpeg);
    if attempts.is_empty() {
        let _ = fs::remove_dir_all(&work);
        return Err("No H.264 encoder available.".into());
    }
    let mut last_err = String::from("encode failed");
    for (i, enc) in attempts.iter().enumerate() {
        let _ = app.emit("export-progress", format!("Trying {}…", enc.label));
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
        for inp in &inputs {
            args.push("-i".into());
            args.push(inp.clone());
        }
        args.extend([
            "-/filter_complex".into(),
            filter_arg.clone(),
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
                "192k".into(),
            ]);
        } else {
            args.push("-an".into());
        }
        for a in &enc.args {
            args.push((*a).into());
        }
        args.push(plan.output_path.clone());
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let (_, err, code) = run_cmd(ffmpeg, &arg_refs)?;
        if code == 0 {
            let _ = fs::remove_dir_all(&work);
            return Ok(enc.label.to_string());
        }
        last_err = trim_ffmpeg_err(&err);
        let _ = attempts.get(i + 1);
    }
    let _ = fs::remove_dir_all(&work);
    Err(last_err)
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
            fc.push_str(&format!(
                "[{idx}:v]trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS,scale={w}:{h}:flags=bicubic,format=yuv420p,setsar=1[v{i}];"
            ));
        }
        vpads.push_str(&format!("[v{i}]"));
    }
    fc.push_str(&format!(
        "{}concat=n={}:v=1:a=0[vout];",
        vpads,
        plan.clips.len()
    ));

    let audio_src = plan.audio_clips.as_ref().unwrap_or(&plan.clips);
    if plan.has_audio && !audio_src.is_empty() {
        let mut apads = String::new();
        for (i, clip) in audio_src.iter().enumerate() {
            if clip.gap {
                let d = clip.duration.max(0.02);
                fc.push_str(&format!(
                    "anullsrc=r=48000:cl=stereo:d={d:.6},aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                ));
            } else {
                let start = clip.source_start.max(0.0);
                let end = clip.source_end.max(start + 0.02);
                let idx = clip_input_index(&inputs, plan, clip);
                fc.push_str(&format!(
                    "[{idx}:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                ));
            }
            apads.push_str(&format!("[a{i}]"));
        }
        fc.push_str(&format!(
            "{}concat=n={}:v=0:a=1[aout]",
            apads,
            audio_src.len()
        ));
    } else if fc.ends_with(';') {
        fc.pop();
    }

    let work = std::env::temp_dir().join(format!("grimcut-export-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let filter_path = work.join("filter.txt");
    fs::write(&filter_path, &fc).map_err(|e| e.to_string())?;

    let filter_arg = filter_path.to_string_lossy().into_owned();
    let attempts = working_encoders(ffmpeg);
    if attempts.is_empty() {
        let _ = fs::remove_dir_all(&work);
        return Err("No H.264 encoder available.".into());
    }
    let _ = app.emit(
        "export-progress",
        format!("Trying {}…", attempts[0].label),
    );

    let mut last_err = String::from("encode failed");
    for (i, enc) in attempts.iter().enumerate() {
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];
        for inp in &inputs {
            args.push("-i".into());
            args.push(inp.clone());
        }
        args.extend([
            // FFmpeg 8: -/filter_complex reads the graph from a file (filter_complex_script is deprecated).
            "-/filter_complex".into(),
            filter_arg.clone(),
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
                "192k".into(),
            ]);
        } else {
            args.push("-an".into());
        }
        for a in &enc.args {
            args.push((*a).into());
        }
        args.push(plan.output_path.clone());
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let (_, err, code) = run_cmd(ffmpeg, &arg_refs)?;
        if code == 0 {
            let _ = fs::remove_dir_all(&work);
            return Ok(enc.label.to_string());
        }
        last_err = trim_ffmpeg_err(&err);
        let next = attempts.get(i + 1).map(|e| e.label).unwrap_or("CPU");
        let _ = app.emit(
            "export-progress",
            format!("{} failed, trying {next}…", enc.label),
        );
    }
    let _ = fs::remove_dir_all(&work);
    Err(last_err)
}

fn uuid_like() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                windows_sizing::set_app(app.handle().clone());
                windows_sizing::install_hook(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe,
            waveform,
            suggest_save,
            make_proxy,
            export_video,
            set_aspect_lock
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
