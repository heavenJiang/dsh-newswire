/* 适配器快照回归：站点改版时这里先失败。快照在 tests/fixtures/<id>.html.gz（2026-11-08 抓取，已去样式/脚本）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter, adapterIds } from "../../engine/adapters/index.mjs";
import { normalizeSignals } from "../../engine/pipeline/signals.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (id) => gunzipSync(readFileSync(path.join(FIX, id + ".html.gz"))).toString("utf8");

/** 源头不给时间的卡片允许存在（入库记为 time_confidence=fetched），但应是少数。 */
function common(items, host) {
  let timed = 0;
  for (const it of items) {
    assert.ok(it.title && it.title.length >= 6, "title: " + it.title);
    assert.match(it.link, new RegExp("^https://" + host.replace(/\./g, "\\.")), "link: " + it.link);
    if (it.published_at) { assert.ok(!Number.isNaN(Date.parse(it.published_at)), "published_at: " + it.published_at); timed++; }
  }
  assert.ok(timed >= items.length * 0.95, "带时间的条目 " + timed + "/" + items.length);
  assert.equal(new Set(items.map((x) => x.link)).size, items.length, "链接不应重复");
}

test("注册表包含 4 个适配器且都声明了 browse 等待选择器", () => {
  assert.deepEqual(adapterIds().sort(), ["apnews", "jiemian", "techflow", "thepaper"]);
  for (const id of adapterIds()) assert.ok(getAdapter(id).waitFor, id + " 缺 waitFor");
});

test("深潮：RSC 数据里的阅读/分享/收藏与推送标记", () => {
  const items = getAdapter("techflow").parse(load("techflow"), { max: 60 });
  assert.ok(items.length >= 8, "条数 " + items.length);
  common(items, "www.techflowpost.com/");
  assert.ok(items.every((x) => typeof x.signals.views === "number"), "每条都应有 view_count");
  assert.ok(items.some((x) => x.signals.hot.includes("推送")), "应识别 is_push");
  assert.equal(items[0].link, "https://www.techflowpost.com/newsletter/143567");
});

test("界面：快讯列表、秒级时间戳、a-item-red → 加红", () => {
  const items = getAdapter("jiemian").parse(load("jiemian"), { max: 60 });
  assert.equal(items.length, 20);
  common(items, "www.jiemian.com/article/");
  assert.equal(items[0].published_at, "2026-11-08T11:27:38.000Z");
  const red = items.filter((x) => x.signals.hot.includes("加红"));
  assert.ok(red.length >= 1 && red.length < items.length, "加红应是少数条目");
});

test("澎湃：__NEXT_DATA__ 推荐位、点赞与互动数、区块", () => {
  const items = getAdapter("thepaper").parse(load("thepaper"), { max: 60 });
  assert.ok(items.length >= 12, "条数 " + items.length);
  for (const it of items) assert.match(it.link, /^https?:\/\//);
  const sig = normalizeSignals(items[0], 0);
  assert.equal(sig.likes, 646);
  assert.equal(sig.comments, 12);
  assert.equal(sig.section, "头图");
  assert.ok(items.some((x) => x.signals.section === "要闻"));
});

test("美联社：卡片去重、Most Read 排名、Most commented 评论数", () => {
  const items = getAdapter("apnews").parse(load("apnews"), { max: 200 });
  assert.ok(items.length >= 60, "条数 " + items.length);
  common(items, "apnews.com/article/");
  const mr = items.filter((x) => x.signals.hot.some((h) => h.startsWith("Most Read")));
  assert.equal(mr.length, 4);
  const mc = items.find((x) => x.signals_raw.most_commented_rank === 1);
  assert.ok(mc, "评论榜第一应在条目里");
  assert.equal(normalizeSignals(mc, 0).comments, 683);
  assert.equal(items[0].signals.section, "list");
});

test("max 限制生效", () => {
  for (const id of adapterIds()) assert.ok(getAdapter(id).parse(load(id), { max: 3 }).length <= 3, id);
});
