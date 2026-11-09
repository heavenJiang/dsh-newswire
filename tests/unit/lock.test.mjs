import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, readLock } from "../../engine/lock.mjs";

test("同一时间只能有一个持锁者；释放后可再取", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "newswire-lock-"));
  const a = acquireLock(dir, { run_id: "r1" });
  assert.equal(a.ok, true);
  const b = acquireLock(dir, { run_id: "r2" });
  assert.equal(b.ok, false);
  assert.equal(b.holder.run_id, "r1");
  a.release();
  assert.equal(readLock(dir), null);
  const c = acquireLock(dir, { run_id: "r3" });
  assert.equal(c.ok, true);
  c.release();
  rmSync(dir, { recursive: true, force: true });
});

test("持锁进程已不在或锁过期：自动接管", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "newswire-lock-"));
  writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 999999, started_at: new Date().toISOString(), run_id: "dead" }));
  const a = acquireLock(dir, { run_id: "r1" });
  assert.equal(a.ok, true, "死进程的锁");
  a.release();
  writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: process.pid, started_at: new Date(Date.now() - 3600000).toISOString(), run_id: "old" }));
  const b = acquireLock(dir, { run_id: "r2" }, 60000);
  assert.equal(b.ok, true, "过期的锁");
  b.release();
  rmSync(dir, { recursive: true, force: true });
});
