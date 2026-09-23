import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentOp, AgentRequest, AgentResult } from "./protocol";

export type AgentFile = { port: number; pid: number };

export function agentFilePath() {
  return join(homedir(), "AppData", "Local", "Grimcut", "agent.json");
}

export function readLiveAgent(): AgentFile | null {
  const p = agentFilePath();
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as AgentFile;
    if (!j.port) return null;
    return j;
  } catch {
    return null;
  }
}

export async function rpcLive(op: AgentOp, args: Record<string, unknown> = {}): Promise<AgentResult> {
  const live = readLiveAgent();
  if (!live) throw new Error("Grimcut app is not running.");
  const body: AgentRequest = { id: `${Date.now()}`, op, args };
  const res = await fetch(`http://127.0.0.1:${live.port}/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Agent HTTP ${res.status}`);
  return (await res.json()) as AgentResult;
}

export async function liveHealth(): Promise<boolean> {
  const live = readLiveAgent();
  if (!live) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}
