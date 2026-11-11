/* 模型调用排队（读者点的先跑、名额数、面板视图）；数据保留（版面按天留、账本留 30 天、每条故事线留最近几篇）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQueue, PRIORITY } from "../../host/queue.mjs";
import { createModel } from "../../host/model.mjs";
import { prune } from "../../host/retention.mjs";
import { openDb } from "../../engine/store/schema.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("排队：一个名额时按优先级放行，同级先到先得；读者点的插到后台任务前面", async () => {
  const q = createQueue({ slots: () => 1, graceMs: 40 });
  const order = [];
  const call = (name) => async () => { const release = await q.acquire(name); order.push(name); await tick(); release(); };
  const edition = q.run({ kind: "edition", label: "版面", priority: PRIORITY.push }, async () => { await call("write1")(); await call("write2")(); await call("write3")(); });
  await tick(); // write1 在跑
  const track = q.run({ kind: "track", label: "追踪综述：特朗普", priority: PRIORITY.idle }, call("track"));
  const detail = q.run({ kind: "detail", label: "详细报道：油轮", priority: PRIORITY.reader }, call("detail"));
  const v = q.view();
  assert.equal(v.running.length, 1);
  assert.equal(v.running[0].label, "版面");
  assert.deepEqual(v.waiting.map((x) => x.label), ["详细报道：油轮", "追踪综述：特朗普"], "排队按优先级列");
  assert.deepEqual(v.jobs.map((x) => [x.kind, x.state]), [["detail", "waiting"], ["edition", "running"], ["track", "waiting"]]);
  await Promise.all([edition, track, detail]);
  assert.deepEqual(order, ["write1", "detail", "write2", "write3", "track"], "读者点的只等正在跑的那一次调用");
  assert.deepEqual(q.view().jobs, []);
});

test("排队：两个名额时并行两个；模型调用自动领名额、出错也归还", async () => {
  const q = createQueue({ slots: () => 2 });
  let live = 0, peak = 0;
  const llm = { stream(o) { return (async function* () { live++; peak = Math.max(peak, live); await tick(); live--; if (/boom/.test(o.messages[0].content[0].text)) throw new Error("boom"); yield { type: "text-delta", text: "{}" }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  const m = createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }), slot: (step) => q.acquire(step) });
  const rs = await Promise.allSettled([m.complete("a"), m.complete("boom"), m.complete("c"), m.complete("d")]);
  assert.deepEqual(rs.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(peak, 2);
  assert.deepEqual(q.view().running, []);
});

test("数据保留：近 48 小时的版面全留，更早的每包每天留最后一份，30 天外删掉；账本留 30 天；详细报道每条留 2 篇", () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-keep-")), "n.sqlite"));
  const now = Date.parse("2026-11-20T12:00:00Z");
  const at = (h) => new Date(now - h * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const ed = db.prepare("INSERT INTO editions (pack, created_at, mode, content) VALUES (?,?,?,?)");
  const item = db.prepare("INSERT INTO edition_items (edition_id, story_id, article_id) VALUES (?,?,?)");
  const ids = {};
  for (const [k, pack, h] of [["lonely", "study", 60 * 24], ["old", "all", 40 * 24], ["d5a", "all", 5 * 24 + 6], ["d5c", "core", 5 * 24 + 3], ["d5b", "all", 5 * 24 + 2], ["y1", "all", 30], ["now", "all", 1]]) {
    ids[k] = Number(ed.run(pack, at(h), "llm", "{}").lastInsertRowid);
    item.run(ids[k], "st", "a-" + k);
  }
  const call = db.prepare("INSERT INTO llm_calls (at, step, ok) VALUES (?,?,1)");
  call.run(at(1), "write"); call.run(at(31 * 24), "write");
  const det = db.prepare("INSERT INTO story_details (story_id, created_at, content) VALUES (?,?,?)");
  for (const s of ["s1", "s1", "s1", "s2"]) det.run(s, at(1), "{}");
  const r = prune(db, { now });
  const left = db.prepare("SELECT id FROM editions ORDER BY id").all().map((x) => x.id);
  assert.deepEqual(left, [ids.now, ids.y1, ids.d5b, ids.d5c, ids.lonely].sort((a, b) => a - b), "同一天同一包只留最后一份；每个包最新的一份永远留");
  assert.equal(r.editions, 2);
  assert.equal(r.edition_items, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_items").get().n, 5);
  assert.equal(r.llm_calls, 1);
  assert.equal(r.story_details, 1);
  assert.deepEqual(db.prepare("SELECT story_id, COUNT(*) n FROM story_details GROUP BY 1 ORDER BY 1").all().map((x) => x.n), [2, 1]);
  assert.deepEqual(prune(db, { now }).editions, 0, "再清一次没有可删的");
  db.close();
});
