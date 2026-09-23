#!/usr/bin/env npx tsx
/** Minimal MCP stdio server — named Grimcut ops, no GUI required. */
import { readFileSync } from "node:fs";

import { dispatchAgent } from "../agent/dispatch";
import { createHeadlessHost } from "../agent/headlessHost";
import { liveHealth, rpcLive } from "../agent/client";
import type { AgentHost } from "../agent/host";
import type { AgentOp, AgentResult } from "../agent/protocol";

const host: AgentHost = createHeadlessHost();

async function call(op: AgentOp, args: Record<string, unknown>): Promise<AgentResult> {
  if (await liveHealth()) return rpcLive(op, args);
  return dispatchAgent(host, op, args);
}

const tools = [
  {
    name: "grimcut_status",
    description: "Current Grimcut project snapshot (clips, playhead, duration). Headless if the app is not open.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grimcut_open",
    description: "Open a local video file as the current project.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "grimcut_close",
    description: "Close the current project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grimcut_delete_range",
    description: "Delete a timeline range in seconds (e.g. first minute: start=0 end=60). Use collapse_blank after to pack left.",
    inputSchema: {
      type: "object",
      properties: { start: { type: "number" }, end: { type: "number" }, lane: { type: "string", description: "video | audio | both" } },
      required: ["start", "end"],
    },
  },
  {
    name: "grimcut_slice",
    description: "Slice clips at a timeline time (seconds). Defaults to playhead.",
    inputSchema: { type: "object", properties: { time: { type: "number" } } },
  },
  {
    name: "grimcut_collapse_blank",
    description: "Pack remaining clips left, closing timeline holes.",
    inputSchema: { type: "object", properties: { enabled: { type: "boolean" } } },
  },
  {
    name: "grimcut_playhead",
    description: "Set playhead time in seconds.",
    inputSchema: { type: "object", properties: { time: { type: "number" } }, required: ["time"] },
  },
  {
    name: "grimcut_frame",
    description: "Grab a JPEG still of the picture at a timeline time (ffmpeg, not a GUI screenshot). Returns a file path.",
    inputSchema: { type: "object", properties: { time: { type: "number" } } },
  },
  {
    name: "grimcut_export",
    description: "Export. Headless requires outputPath and currently supports a single remaining video clip. Multi-clip/overlay needs the Grimcut app running.",
    inputSchema: {
      type: "object",
      properties: { outputPath: { type: "string" }, profile: { type: "string", description: "quick | youtube | discord | manual" } },
      required: ["outputPath"],
    },
  },
  {
    name: "grimcut_undo",
    description: "Undo last edit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grimcut_redo",
    description: "Redo last undone edit.",
    inputSchema: { type: "object", properties: {} },
  },
];

const opByTool: Record<string, AgentOp> = {
  grimcut_status: "status",
  grimcut_open: "open",
  grimcut_close: "close",
  grimcut_delete_range: "delete_range",
  grimcut_slice: "slice",
  grimcut_collapse_blank: "collapse_blank",
  grimcut_playhead: "playhead",
  grimcut_frame: "frame",
  grimcut_export: "export",
  grimcut_undo: "undo",
  grimcut_redo: "redo",
};

function send(msg: unknown) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

async function onMessage(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "grimcut", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    const op = opByTool[name];
    if (!op) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } });
      return;
    }
    try {
      const result = await call(op, args);
      const parts: { type: string; text?: string; data?: string; mimeType?: string }[] = [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ];
      if (result.framePath) {
        try {
          const data = readFileSync(result.framePath).toString("base64");
          parts.push({ type: "image", data, mimeType: "image/jpeg" });
        } catch {
          /* path only */
        }
      }
      send({
        jsonrpc: "2.0",
        id,
        result: { content: parts, isError: !result.ok },
      });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e) }], isError: true } });
    }
    return;
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
}

function main() {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const json = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      try {
        void onMessage(JSON.parse(json));
      } catch {
        /* ignore */
      }
    }
  });
}

main();
