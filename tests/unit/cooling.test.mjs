/* 连续失败的源降频：连续 3 轮失败后平时跳过、每 6 小时试一次；试成功就恢复。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { coolingOf, coolingMap } from "../../engine/pipeline/cooling.mjs";

test("降频：连续失败不到 3 轮不动；到了 3 轮就跳过，6 小时后放行一次；中间成功过就重新计数", () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-cool-")), "n.sqlite"));
  const now = Date.parse("2026-11-12T12:00:00Z");
  const at = (h) => new Date(now - h * 3600000).toISOString().replace("T", " ").slice(0, 19);
  let k = 0;
  const round = (src, hoursAgo, status, note) => { const id = "r" + (++k); db.prepare("INSERT INTO runs (run_id, started_at, mode) VALUES (?,?, 'cycle')").run(id, at(hoursAgo)); db.prepare("INSERT INTO continuity (run_id, source_id, status, note) VALUES (?,?,?,?)").run(id, src, status, note || null); };
  round("x", 5, "failed", "browse:timeout"); round("x", 3, "failed", "browse:timeout");
  assert.equal(coolingOf(db, "x", { now }), null, "两轮：照常抓");
  round("x", 1, "failed", "browse:timeout -> http:unknown");
  const c = coolingOf(db, "x", { now });
  assert.equal(c.fails, 3);
  assert.equal(c.reason, "http:unknown");
  assert.equal(c.probe_due, false, "刚失败过：跳过");
  assert.equal(c.since, at(5));
  assert.equal(coolingOf(db, "x", { now: now + 5.5 * 3600000 }).probe_due, true, "离上次尝试满 6 小时：试一次");
  round("y", 9, "failed"); round("y", 7, "failed"); round("y", 5, "ok"); round("y", 3, "failed"); round("y", 1, "failed");
  assert.equal(coolingOf(db, "y", { now }), null, "中间成功过：只算之后的两轮");
  assert.deepEqual([...coolingMap(db, ["x", "y", "z"], { now }).keys()], ["x"]);
  round("x", 0.1, "ok");
  assert.equal(coolingOf(db, "x", { now }), null, "试成功：恢复");
  db.close();
});
