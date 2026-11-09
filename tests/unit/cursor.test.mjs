import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, nextCursor, isStream, sinceHoursFor, numericId } from "../../engine/cursor.mjs";
import { missingIds } from "../../engine/pipeline/paging.mjs";

const rec = (id, t, conf, extra) => Object.assign({ id, url: "https://x.example/n/" + id, published_at: t, time_confidence: conf || "feed", page: 0, signals: { rank: 0 } }, extra);
const STREAM = { id: "s", type: "rss" };

test("流式/快照判定：显式 continuity 优先，rss/API 默认流式，列表页默认快照", () => {
  assert.equal(isStream({ type: "rss" }), true);
  assert.equal(isStream({ type: "json_api" }), true);
  assert.equal(isStream({ type: "html_index" }), false);
  assert.equal(isStream({ type: "html_index", continuity: "stream" }), true);
  assert.equal(isStream({ type: "rss", continuity: "snapshot" }), false);
});

test("首轮 first；快照源 snapshot", () => {
  assert.equal(evaluate(null, [rec("a", "2026-11-08 10:00:00")], STREAM).status, "first");
  assert.equal(evaluate({ last_ok_at: "x", head_keys: [] }, [], { type: "html_index" }).status, "snapshot");
});

test("键重叠优先于时间：fetched 时间不能证明衔接", () => {
  const prev = { last_ok_at: "2026-11-08 08:00:00", head_keys: ["k1", "k2"], head_time: "2026-11-08 07:50:00" };
  const a = evaluate(prev, [rec("k9", null, "fetched"), rec("k2", null, "fetched")], STREAM);
  assert.equal(a.status, "connected");
  assert.equal(a.overlap, 1);
  const b = evaluate(prev, [rec("k9", "2026-11-08 07:40:00")], STREAM);
  assert.equal(b.status, "connected_time");
  const c = evaluate(prev, [rec("k9", "2026-11-08 07:40:00", "fetched")], STREAM);
  assert.equal(c.status, "gap", "抓取时间近似不算证据");
  const d = evaluate(prev, [rec("k9", "2026-11-08 09:30:00"), rec("k8", "2026-11-08 09:00:00")], STREAM);
  assert.equal(d.status, "gap");
  assert.equal(d.gap_from, "2026-11-08 07:50:00");
  assert.equal(d.gap_to, "2026-11-08 09:00:00");
});

test("id_walk：最小 id 接上上轮 max_id 即衔接", () => {
  const src = { id: "tf", type: "html_index", continuity: "stream", paging: { mode: "id_walk", id_pattern: "/n/(\\d+)" } };
  const prev = { last_ok_at: "x", head_keys: [], max_id: 100, head_time: null };
  assert.equal(evaluate(prev, [rec("101", "2026-11-08 09:00:00", "feed", { url: "https://x.example/n/101" })], src).status, "connected");
  assert.equal(evaluate(prev, [rec("105", "2026-11-08 09:00:00", "feed", { url: "https://x.example/n/105" })], src).status, "gap");
  assert.deepEqual(missingIds(100, [105, 107, 106]), [104, 103, 102, 101]);
  assert.deepEqual(missingIds(null, [5]), []);
  assert.equal(numericId("https://x.example/n/123?a=1", "/n/(\\d+)"), 123);
});

test("游标推进：首页优先取键、head_time 单调不回退、max_id 取最大", () => {
  const src = { id: "tf", paging: { mode: "id_walk", id_pattern: "/n/(\\d+)" } };
  const recs = [
    rec("b", "2026-11-08 09:00:00", "feed", { page: 2, url: "https://x.example/n/90" }),
    rec("a", "2026-11-08 10:00:00", "feed", { page: 0, url: "https://x.example/n/99" }),
  ];
  const c = nextCursor({ head_time: "2026-11-08 11:00:00", max_id: 95 }, recs, src, "r1", "2026-11-08 12:00:00");
  assert.deepEqual(c.head_keys, ["a", "b"]);
  assert.equal(c.head_time, "2026-11-08 11:00:00");
  assert.equal(c.tail_time, "2026-11-08 09:00:00");
  assert.equal(c.max_id, 99);
});

test("回看时长：从上次成功往前多留 15 分钟，夹在 1–48 小时", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(sinceHoursFor({ last_ok_at: "2026-11-08 10:00:00" }, now, 24), 2.25);
  assert.equal(sinceHoursFor({ last_ok_at: "2026-11-08 11:59:00" }, now, 24), 1);
  assert.equal(sinceHoursFor({ last_ok_at: "2026-11-01 00:00:00" }, now, 24), 48);
  assert.equal(sinceHoursFor(null, now, 24), 24);
});
