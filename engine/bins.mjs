/**
 * 外部命令探测：browse / agent-reach / mcporter。
 * 优先用调用方显式给的路径；否则查 PATH；再试常见安装位置。找不到返回 null（对应通道视为不可用，自动降级）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  browse: ["~/.npm-global/bin/browse", "/opt/homebrew/bin/browse", "/usr/local/bin/browse"],
  "agent-reach": ["~/.agent-reach-venv/bin/agent-reach", "~/.local/bin/agent-reach", "/opt/homebrew/bin/agent-reach", "/usr/local/bin/agent-reach"],
  mcporter: ["~/.npm-global/bin/mcporter", "/opt/homebrew/bin/mcporter", "/usr/local/bin/mcporter"],
};

export function expandHome(p) { return typeof p === "string" && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p; }

const cache = new Map();

/** @returns 可执行文件绝对路径，或 null。 */
export function findBin(name, explicit) {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    const e = expandHome(explicit.trim());
    return existsSync(e) ? e : null;
  }
  if (cache.has(name)) return cache.get(name);
  let hit = null;
  try {
    const out = execFileSync("which", [name], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out && existsSync(out)) hit = out;
  } catch {
    // 不在 PATH 里
  }
  if (!hit) for (const c of CANDIDATES[name] || []) { const e = expandHome(c); if (existsSync(e)) { hit = e; break; } }
  cache.set(name, hit);
  return hit;
}

/** agent-reach 是 venv 里的入口脚本；同目录的 python3 带 feedparser。 */
export function agentReachPython(agentReachBin) {
  if (!agentReachBin) return null;
  for (const base of [path.dirname(agentReachBin), path.dirname(safeReal(agentReachBin))]) {
    const py = path.join(base, "python3");
    if (existsSync(py)) return py;
  }
  return null;
}

function safeReal(p) { try { return realpathSync(p); } catch { return p; } }
