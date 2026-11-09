/**
 * 跨进程文件锁（dataDir/run.lock）：定时任务、手动抓取、命令行直跑不会同时写库、抢同一个 browse 标签页。
 * 用 O_EXCL 创建；持锁进程已退出或超过 staleMs 视为陈旧锁，自动接管。
 */
import fs from "node:fs";
import path from "node:path";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

export function readLock(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "run.lock"), "utf8")); } catch { return null; }
}

/** @returns { ok: true, release } 或 { ok: false, holder } */
export function acquireLock(dir, info, staleMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.lock");
  const body = JSON.stringify(Object.assign({ pid: process.pid, started_at: new Date().toISOString() }, info));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      let released = false;
      return { ok: true, release: () => { if (released) return; released = true; try { if ((readLock(dir) || {}).pid === process.pid) fs.unlinkSync(file); } catch { /* 已不在 */ } } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = readLock(dir);
      const age = holder ? Date.now() - Date.parse(holder.started_at) : Infinity;
      if (holder && alive(holder.pid) && age < (staleMs || 45 * 60000)) return { ok: false, holder };
      try { fs.unlinkSync(file); } catch { /* 被别人先删了 */ }
    }
  }
  return { ok: false, holder: readLock(dir) };
}

/** 等锁：每 5 秒重试一次，最多 waitMs（定时任务两个包撞上时，后来的等前一轮结束，而不是直接跳过）。 */
export async function acquireLockWait(dir, info, staleMs, waitMs) {
  const deadline = Date.now() + (waitMs || 0);
  for (;;) {
    const r = acquireLock(dir, info, staleMs);
    if (r.ok || Date.now() >= deadline) return r;
    await new Promise((res) => setTimeout(res, Math.min(5000, Math.max(200, deadline - Date.now()))));
  }
}

