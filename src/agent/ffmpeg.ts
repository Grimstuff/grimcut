import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clipSourcePath, mapTimelineToSource } from "../core/project";
import type { MediaInfo, VideoProject } from "../core/types";

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

export function ffmpegBin(name: "ffmpeg" | "ffprobe") {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env.GRIMCUT_FFMPEG ? join(process.env.GRIMCUT_FFMPEG, exe) : "",
    join(repoRoot(), "src-tauri", "ffmpeg", exe),
    join(repoRoot(), "tools", "ffmpeg", exe),
    exe,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === exe || existsSync(c)) return c;
  }
  return exe;
}

export function runTool(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const { stdout, stderr, code } = await runTool(ffmpegBin("ffprobe"), [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `ffprobe failed (${code})`);
  const v = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[];
  };
  let duration = Number(v.format?.duration ?? 0);
  let videoCodec: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let hasAudio = false;
  let audioCodec: string | null = null;
  let frameRate: number | null = null;
  for (const s of v.streams ?? []) {
    if (s.codec_type === "video" && !videoCodec) {
      videoCodec = s.codec_name ?? null;
      width = s.width ?? null;
      height = s.height ?? null;
      const [n, d] = (s.avg_frame_rate ?? "0/1").split("/").map(Number);
      if (d) frameRate = n / d;
    }
    if (s.codec_type === "audio") {
      hasAudio = true;
      audioCodec = s.codec_name ?? audioCodec;
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) duration = 1;
  return {
    path,
    duration,
    videoCodec,
    width,
    height,
    audioCodec,
    frameRate,
    hasAudio,
    keyframeTimes: [],
  };
}

export async function grabFrame(project: VideoProject, time: number): Promise<string> {
  const mapped = mapTimelineToSource(project, time);
  if (!mapped) throw new Error("No video at that time.");
  const src = clipSourcePath(project, mapped.clip);
  const out = join(homedir(), "AppData", "Local", "Grimcut", `frame-${Date.now()}.jpg`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(out), { recursive: true });
  const { stderr, code } = await runTool(ffmpegBin("ffmpeg"), [
    "-hide_banner",
    "-y",
    "-ss",
    String(Math.max(0, mapped.source)),
    "-i",
    src,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    out,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || "Frame grab failed.");
  return out;
}

export async function exportSimple(project: VideoProject, dest: string): Promise<void> {
  const vid = project.clips.filter((c) => c.kind === "video").sort((a, b) => a.timelineStart - b.timelineStart);
  if (!vid.length) throw new Error("No video to export.");
  const first = vid[0];
  if (vid.length === 1) {
    const { stderr, code } = await runTool(ffmpegBin("ffmpeg"), [
      "-hide_banner",
      "-y",
      "-ss",
      String(first.sourceStart),
      "-to",
      String(first.sourceEnd),
      "-i",
      clipSourcePath(project, first),
      "-c",
      "copy",
      dest,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || "Export failed.");
    return;
  }
  throw new Error("Headless export currently supports a single remaining video clip. Open Grimcut for multi-clip / overlay export, or flatten to one clip first.");
}
