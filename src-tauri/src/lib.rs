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
    pub source_start: f64,
    pub source_end: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub source_path: String,
    pub output_path: String,
    pub clips: Vec<ClipDto>,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub use_stream_copy: bool,
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

fn run_cmd(bin: &Path, args: &[&str]) -> Result<(String, String, i32), String> {
    let out = Command::new(bin)
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

fn detect_hw_h264(app: &AppHandle) -> Option<&'static str> {
    let ffmpeg = ffmpeg_bin(app, "ffmpeg");
    let Ok((out, err, _)) = run_cmd(&ffmpeg, &["-hide_banner", "-encoders"]) else {
        return None;
    };
    let text = format!("{out}\n{err}");
    if text.contains("h264_nvenc") {
        Some("h264_nvenc")
    } else if text.contains("h264_qsv") {
        Some("h264_qsv")
    } else if text.contains("h264_amf") {
        Some("h264_amf")
    } else {
        None
    }
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
    let ( _, err, code) = run_cmd(
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
        return Err(err);
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

    if plan.use_stream_copy {
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
    export_reencode(&app, &ffmpeg, &plan)?;
    let hw = detect_hw_h264(&app);
    let extra = match hw {
        Some(n) => format!(" Used {n}."),
        None => " Used CPU encode.".to_string(),
    };
    Ok(ExportResultDto {
        success: true,
        output_path: plan.output_path.clone(),
        mode: "reencode".into(),
        clip_count: plan.clips.len(),
        message: format!("Saved with high-quality re-encode for clean cuts.{extra}"),
    })
}

fn export_copy(ffmpeg: &Path, plan: &ExportPlan) -> Result<(), String> {
    if plan.clips.len() == 1 {
        return extract_copy(ffmpeg, &plan.source_path, &plan.clips[0], &plan.output_path);
    }
    let work = std::env::temp_dir().join(format!("grimcut-export-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let mut list = String::new();
    for (i, clip) in plan.clips.iter().enumerate() {
        let part = work.join(format!("part_{i:03}.mkv"));
        extract_copy(ffmpeg, &plan.source_path, clip, part.to_str().unwrap())?;
        let escaped = part.to_string_lossy().replace('\'', r"'\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    let list_path = work.join("concat.txt");
    fs::write(&list_path, list).map_err(|e| e.to_string())?;
    let (_, err, code) = run_cmd(
        ffmpeg,
        &[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path.to_str().unwrap(),
            "-c",
            "copy",
            "-map",
            "0",
            &plan.output_path,
        ],
    )?;
    let _ = fs::remove_dir_all(&work);
    if code != 0 {
        return Err(err);
    }
    Ok(())
}

fn extract_copy(ffmpeg: &Path, src: &str, clip: &ClipDto, dest: &str) -> Result<(), String> {
    let start = clip.source_start.max(0.0);
    let end = clip.source_end.max(start + 0.02);
    let start_s = format!("{start:.6}");
    let end_s = format!("{end:.6}");
    let (_, err, code) = run_cmd(
        ffmpeg,
        &[
            "-y",
            "-i",
            src,
            "-ss",
            &start_s,
            "-to",
            &end_s,
            "-c",
            "copy",
            "-map",
            "0",
            "-avoid_negative_ts",
            "make_zero",
            dest,
        ],
    )?;
    if code != 0 {
        return Err(err);
    }
    Ok(())
}

fn export_reencode(app: &AppHandle, ffmpeg: &Path, plan: &ExportPlan) -> Result<(), String> {
    let mut fc = String::new();
    let mut pads = String::new();
    for (i, clip) in plan.clips.iter().enumerate() {
        let start = clip.source_start.max(0.0);
        let end = clip.source_end.max(start + 0.02);
        fc.push_str(&format!(
            "[0:v]trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS[v{i}];"
        ));
        if plan.has_audio {
            fc.push_str(&format!(
                "[0:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS[a{i}];"
            ));
            pads.push_str(&format!("[v{i}][a{i}]"));
        } else {
            pads.push_str(&format!("[v{i}]"));
        }
    }
    if plan.has_audio {
        fc.push_str(&format!(
            "{}concat=n={}:v=1:a=1[vout][aout]",
            pads,
            plan.clips.len()
        ));
    } else {
        fc.push_str(&format!("{}concat=n={}:v=1:a=0[vout]", pads, plan.clips.len()));
    }

    let work = std::env::temp_dir().join(format!("grimcut-export-{}", uuid_like()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let filter_path = work.join("filter.txt");
    fs::write(&filter_path, &fc).map_err(|e| e.to_string())?;

    let hw = detect_hw_h264(app);
    let codec = plan.video_codec.as_deref().unwrap_or("h264").to_lowercase();
    let vargs: Vec<&str> = match (hw, codec.as_str()) {
        (Some("h264_nvenc"), _) => vec!["-c:v", "h264_nvenc", "-cq", "19", "-preset", "p4", "-pix_fmt", "yuv420p"],
        (Some("h264_qsv"), _) => vec!["-c:v", "h264_qsv", "-global_quality", "22", "-pix_fmt", "yuv420p"],
        (Some("h264_amf"), _) => vec!["-c:v", "h264_amf", "-qp_i", "18", "-qp_p", "20", "-pix_fmt", "yuv420p"],
        (_, "hevc" | "h265") => vec!["-c:v", "libx265", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p"],
        _ => vec!["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"],
    };

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        plan.source_path.clone(),
        "-filter_complex_script".into(),
        filter_path.to_string_lossy().into_owned(),
        "-map".into(),
        "[vout]".into(),
    ];
    if plan.has_audio {
        args.extend(["-map".into(), "[aout]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    } else {
        args.push("-an".into());
    }
    for a in vargs {
        args.push(a.into());
    }
    args.push(plan.output_path.clone());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (_, err, code) = run_cmd(ffmpeg, &arg_refs)?;
    let _ = fs::remove_dir_all(&work);
    if code != 0 {
        return Err(err);
    }
    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            probe,
            suggest_save,
            make_proxy,
            export_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
