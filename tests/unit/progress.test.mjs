/* 一轮的流程与进度：抓取 → 编版面 → 推送，每步的状态、计数、用时、预计剩余；引擎进度文件；一轮的接续与收尾。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgress, applyEngineProgress, STEPS } from "../../host/progress.mjs";

const store = () => { const m = new Map(); return { load: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), save: (k, v) => m.set(k, JSON.stringify(v)), m }; };

test("一轮从抓取到推送：开始下一步时前一步自动收尾、没走到的标跳过；收尾后存成「上一轮」", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const kv = store();
  const pg = createProgress(kv);
  assert.deepEqual(pg.view(), { active: null, last: null });
  pg.begin("cycle", { runId: "cycle-1", pack: "core", model: true });
  pg.start("prep");
  t.mock.timers.tick(2000);
  applyEngineProgress(pg, { stage: "sources", sources: { total: 7, done: 3, failed: 1, current: "财联社", list: [{ id: "cls", name: "财联社", status: "running" }] } });
  let v = pg.view().active;
  assert.equal(v.current, "sources");
  assert.equal(v.steps.find((s) => s.id === "prep").status, "done");
  const src = v.steps.find((s) => s.id === "sources");
  assert.deepEqual([src.done, src.total, src.detail], [3, 7, "正在抓：财联社"]);
  t.mock.timers.tick(60000);
  applyEngineProgress(pg, { stage: "bodies", detail: "触及 5 件事" });
  v = pg.view().active;
  assert.deepEqual(["sources", "clean", "events"].map((id) => v.steps.find((s) => s.id === id).status), ["done", "skipped", "skipped"], "引擎跳过的步骤标跳过");
  // 编版面接着同一轮
  assert.equal(pg.attach("manual", { runId: "cycle-1", model: true }).id, "cycle-1");
  pg.start("group", { done: 0, total: 3 });
  t.mock.timers.tick(90000);
  pg.update("group", { done: 2 });
  assert.equal(pg.view().active.steps.find((s) => s.id === "group").done, 2);
  pg.done("group", { detail: "归成 20 条" });
  pg.skip("plan", "沿用");
  pg.start("write", { total: 4, done: 0 });
  t.mock.timers.tick(200000);
  pg.start("push");
  pg.done("push", { detail: "已发到手机" });
  pg.finish("done");
  const view = pg.view();
  assert.equal(view.active, null);
  assert.equal(view.last.outcome, "done");
  assert.equal(view.last.pct, 100);
  assert.equal(view.last.steps.find((s) => s.id === "write").status, "done");
  assert.equal(view.last.steps.find((s) => s.id === "save").status, "skipped");
  assert.ok(kv.m.has("flow_last") && kv.m.has("flow_stats"), "存进 kv");
  // 重启：从 kv 读回上一轮
  assert.equal(createProgress(kv).view().last.id, "cycle-1");
  t.mock.timers.reset();
});

test("预计剩余按每步历史耗时的中位数；模型和程序编排分开算；没有历史时为 0", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  const kv = store();
  const pg = createProgress(kv);
  for (let r = 0; r < 3; r++) {
    pg.begin("refresh", { model: true });
    pg.start("group"); t.mock.timers.tick(60000);
    pg.start("write"); t.mock.timers.tick(240000);
    pg.finish("done");
  }
  pg.begin("refresh", { model: true });
  assert.equal(pg.view().active.eta_ms, 300000, "归并 1 分钟 + 写稿 4 分钟");
  pg.start("group"); t.mock.timers.tick(30000);
  const v = pg.view().active;
  assert.equal(v.eta_ms, 30000 + 240000, "归并还剩一半 + 写稿");
  assert.ok(v.pct > 5 && v.pct < 20, String(v.pct));
  pg.finish("done");
  pg.begin("refresh", { model: false });
  assert.equal(pg.view().active.eta_ms, 0, "程序编排没有历史");
  pg.start("translate"); pg.start("group", { done: 1, total: 4 });
  const v2 = pg.view().active;
  assert.ok(v2.pct > 10 && v2.pct < 40, "没有历史按步数算，不是 99%：" + v2.pct);
  t.mock.timers.reset();
});

test("新一轮开始时没收尾的旧一轮标「被取代」；45 分钟没动静的标「中断」；失败的步骤和整轮都标失败", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 9_000_000 });
  const pg = createProgress(store());
  pg.begin("manual", { runId: "a" });
  pg.start("sources");
  pg.begin("cycle", { runId: "b" });
  assert.equal(pg.view().last.outcome, "replaced");
  assert.equal(pg.view().active.id, "b");
  t.mock.timers.tick(46 * 60000);
  assert.equal(pg.view().active, null);
  assert.equal(pg.view().last.outcome, "stalled");
  pg.begin("manual", { runId: "c" });
  pg.start("sources");
  pg.fail("sources", "抓取失败（timeout）");
  pg.finish("failed", "抓取失败：timeout");
  const last = pg.view().last;
  assert.equal(last.outcome, "failed");
  assert.equal(last.steps.find((s) => s.id === "sources").status, "failed");
  assert.equal(last.steps.find((s) => s.id === "push").status, "skipped");
  assert.equal(STEPS.length, 12);
  t.mock.timers.reset();
});

test("只编版面的（重新编排）没有抓取和推送；推送一段可以接到已有的一轮后面", () => {
  const pg = createProgress(null);
  pg.begin("refresh");
  assert.deepEqual([...new Set(pg.view().active.steps.map((s) => s.phase))], ["edition"]);
  pg.attach("deliver", {});
  assert.deepEqual([...new Set(pg.view().active.steps.map((s) => s.phase))], ["edition", "push"]);
  pg.finish("done");
  pg.begin("deliver", { runId: "p1" });
  assert.deepEqual(pg.view().active.steps.map((s) => s.id), ["push"]);
});
