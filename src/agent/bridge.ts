import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { dispatchAgent } from "./dispatch";
import type { AgentRequest } from "./protocol";
import { storeHost } from "./storeHost";

let started = false;
const seen = new Set<string>();

export function startAgentBridge() {
  if (started) return;
  started = true;
  const host = storeHost();
  void listen<AgentRequest>("agent-request", async (e) => {
    const req = e.payload;
    if (!req?.id || seen.has(req.id)) return;
    seen.add(req.id);
    const result = await dispatchAgent(host, req.op, req.args ?? {});
    try {
      await invoke("agent_reply", { id: req.id, body: result });
    } catch {
      /* ignore */
    }
  });
}
