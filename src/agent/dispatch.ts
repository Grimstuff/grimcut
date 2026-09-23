import { collapseBlank, collectLaneSpans, tryDeleteSpans, trySlice } from "../core/edits";
import type { ClipKind } from "../core/types";
import type { AgentHost } from "./host";
import type { AgentOp, AgentResult } from "./protocol";

function num(v: unknown, fallback = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown) {
  return typeof v === "string" ? v : "";
}

export async function dispatchAgent(host: AgentHost, op: AgentOp, args: Record<string, unknown> = {}): Promise<AgentResult> {
  try {
    switch (op) {
      case "status":
        break;
      case "open": {
        const path = str(args.path);
        if (!path) return fail(host, "path is required");
        await host.open(path);
        break;
      }
      case "close":
        host.close();
        break;
      case "playhead":
        host.setPlayhead(num(args.time, num(args.t)));
        break;
      case "slice": {
        const p = host.project();
        if (!p) return fail(host, "No project open.");
        const at = args.time != null || args.at != null ? num(args.time ?? args.at) : host.snapshot().playhead;
        const r = trySlice(p, at);
        if (!r.ok) return fail(host, r.error);
        host.applyClips(r.clips, "Slice");
        break;
      }
      case "delete_range": {
        const p = host.project();
        if (!p) return fail(host, "No project open.");
        const start = num(args.start);
        const end = num(args.end);
        if (end <= start) return fail(host, "end must be greater than start");
        const lane = str(args.lane) || "both";
        const kinds: ClipKind[] = lane === "audio" ? ["audio"] : lane === "video" ? ["video"] : ["video", "audio"];
        const spans = kinds.flatMap((k) => collectLaneSpans(p, k, start, end));
        const uniq = spans.filter(
          (s, i) => spans.findIndex((x) => x.clipId === s.clipId && x.start === s.start && x.end === s.end) === i,
        );
        const r = tryDeleteSpans(p, uniq);
        if (!r.ok) return fail(host, r.error);
        host.applyClips(r.clips, "Delete range");
        break;
      }
      case "collapse_blank": {
        if (args.enabled != null) host.setCollapseBlank(Boolean(args.enabled));
        const p = host.project();
        if (p && args.apply !== false) {
          host.applyClips(collapseBlank(p.clips), "Collapse blank");
        }
        break;
      }
      case "undo":
        host.undo();
        break;
      case "redo":
        host.redo();
        break;
      case "export": {
        const profile = str(args.profile) || "quick";
        const outputPath = str(args.outputPath || args.out) || undefined;
        await host.exportVideo({ profile, outputPath });
        break;
      }
      case "select":
        host.setPlayhead(num(args.time ?? args.start));
        break;
      case "frame": {
        const t = args.time != null ? num(args.time) : host.snapshot().playhead;
        const framePath = await host.grabFrame(t);
        return { ok: true, snapshot: host.snapshot(), framePath };
      }
      default:
        return fail(host, `Unknown op: ${op}`);
    }
    return { ok: true, snapshot: host.snapshot() };
  } catch (e) {
    return fail(host, String(e));
  }
}

function fail(host: AgentHost, error: string): AgentResult {
  return { ok: false, error, snapshot: host.snapshot() };
}
