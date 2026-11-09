import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSignals, presentSignals } from "../../engine/pipeline/signals.mjs";
import { toCount, fromEpoch } from "../../engine/util/text.mjs";
import { mapJsonItem } from "../../engine/parsers/generic.mjs";

test("toCount：万/k/逗号；空与布尔为 null，0 保留", () => {
  assert.equal(toCount("1.2万"), 12000);
  assert.equal(toCount("3,456"), 3456);
  assert.equal(toCount("2.5k"), 2500);
  assert.equal(toCount(0), 0);
  assert.equal(toCount(""), null);
  assert.equal(toCount(true), null);
  assert.equal(toCount("abc"), null);
});

test("fromEpoch 同时接受秒与毫秒", () => {
  assert.equal(fromEpoch(1794137258), "2026-11-08 11:27:38");
  assert.equal(fromEpoch(1794137258000), "2026-11-08 11:27:38");
  assert.equal(fromEpoch(""), "");
});

test("财联社早期 metrics → 标准字段", () => {
  const s = normalizeSignals({ metrics: { level: "B", reading: 41867, share: 1, comments: 0, subjects: ["A股"] } }, 3);
  assert.equal(s.views, 41867);
  assert.equal(s.shares, 1);
  assert.equal(s.comments, 0);
  assert.equal(s.level, "B");
  assert.equal(s.rank, 3);
  assert.deepEqual(s.raw.subjects, ["A股"]);
  assert.deepEqual(presentSignals(s).sort(), ["comments", "level", "shares", "views"]);
});

test("没有信号时全是 null，presentSignals 为空", () => {
  const s = normalizeSignals({ title: "x" }, 0);
  assert.deepEqual(presentSignals(s), []);
  assert.equal(s.views, null);
  assert.deepEqual(s.hot, []);
});

test("json_api 的 signals 映射（华尔街见闻 score → level）", () => {
  const map = mapJsonItem({ title: "title", link: "uri", time: "display_time", summary: "content", signals: { level: "score", comments: "comment_count" } });
  const it = map({ title: "快讯", uri: "https://wallstreetcn.com/livenews/1", display_time: 1794123363, content: "<p>正文</p>", score: 2, comment_count: 5 });
  assert.equal(it.published_at, "2026-11-08T07:36:03.000Z");
  const s = normalizeSignals(it, 0);
  assert.equal(s.level, "2");
  assert.equal(s.comments, 5);
});
