#!/usr/bin/env npx tsx
import { dispatchAgent } from "../agent/dispatch";
import { createHeadlessHost } from "../agent/headlessHost";
import { liveHealth, rpcLive } from "../agent/client";
import type { AgentHost } from "../agent/host";
import type { AgentOp, AgentResult } from "../agent/protocol";

function usage() {
  console.log(`grimcut — agent CLI (headless by default; uses the app if it is running)

  grimcut status
  grimcut open <file>
  grimcut close
  grimcut playhead <seconds>
  grimcut slice [seconds]
  grimcut delete-range <start> <end>
  grimcut collapse-blank
  grimcut undo | redo
  grimcut frame [seconds]
  grimcut export <out.mp4> [quick]

  --app     require the running Grimcut window
  --headless  never talk to the GUI
`);
}

async function run(op: AgentOp, args: Record<string, unknown>, prefer: "auto" | "app" | "headless"): Promise<AgentResult> {
  if (prefer !== "headless" && (await liveHealth())) {
    return rpcLive(op, args);
  }
  if (prefer === "app") throw new Error("Grimcut app is not running.");
  const host: AgentHost = createHeadlessHost();
  return dispatchAgent(host, op, args);
}

async function main() {
  const argv = process.argv.slice(2);
  let prefer: "auto" | "app" | "headless" = "auto";
  const args: string[] = [];
  for (const a of argv) {
    if (a === "--app") prefer = "app";
    else if (a === "--headless") prefer = "headless";
    else args.push(a);
  }
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  const map: Record<string, () => Promise<AgentResult>> = {
    status: () => run("status", {}, prefer),
    open: () => run("open", { path: args[1] }, prefer),
    close: () => run("close", {}, prefer),
    playhead: () => run("playhead", { time: Number(args[1]) }, prefer),
    slice: () => run("slice", args[1] != null ? { time: Number(args[1]) } : {}, prefer),
    "delete-range": () => run("delete_range", { start: Number(args[1]), end: Number(args[2]) }, prefer),
    "collapse-blank": () => run("collapse_blank", {}, prefer),
    undo: () => run("undo", {}, prefer),
    redo: () => run("redo", {}, prefer),
    frame: () => run("frame", args[1] != null ? { time: Number(args[1]) } : {}, prefer),
    export: () => run("export", { outputPath: args[1], profile: args[2] || "quick" }, prefer),
  };
  const fn = map[cmd];
  if (!fn) {
    usage();
    process.exit(1);
  }
  const result = await fn();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
