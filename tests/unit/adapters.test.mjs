/* 适配器快照回归：站点改版时这里先失败。快照在 tests/fixtures/<id>.html.gz（2026-11-08 抓取，已去样式/脚本）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter, adapterIds } from "../../engine/adapters/index.mjs";
import { normalizeSignals } from "../../engine/pipeline/signals.mjs";
import { numericId, evaluate } from "../../engine/cursor.mjs";

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

test("注册表包含 6 个适配器且都声明了 browse 等待选择器", () => {
  assert.deepEqual(adapterIds().sort(), ["apnews", "hackernews", "jiemian", "techflow", "telegram", "thepaper"]);
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

test("Telegram 单条快讯：加粗首行为标题，「信源」为原始出处，频道推广链接去掉", () => {
  const items = getAdapter("telegram").parse(load("telegram_single"), { max: 100 });
  assert.equal(items.length, 20);
  common(items, "t.me/OneMillion_AI/");
  assert.equal(items[0].link, "https://t.me/OneMillion_AI/5845", "新的在前");
  const it = items.find((x) => x.link.endsWith("/5844"));
  assert.equal(it.title, "OpenAI第三季度营收首次达100亿美元，环比增长近50%");
  assert.equal(it.published_at, "2026-11-11T00:03:05+00:00");
  assert.match(it.signals_raw.origin_url, /^https:\/\/www\.bloomberg\.com\//);
  assert.equal(normalizeSignals(it, 0).views, 71);
  assert.equal(normalizeSignals(it, 0).likes, 1);
  for (const x of items) assert.doesNotMatch(x.content, /动察 Beating (频道|交流群)|信源/, x.link);
  // 回复别的消息时，引用块不能混进正文
  const reply = items.find((x) => x.link.endsWith("/5839"));
  assert.match(reply.title, /^Anthropic IPO方案更新/);
});

test("Telegram 分帖汇总：[k/n] 拼回后按栏目与编号拆条，跨帖续行归上一条，置顶提示跳过", () => {
  const items = getAdapter("telegram").parse(load("telegram"), { max: 1000 });
  assert.ok(items.length >= 150, "条数 " + items.length);
  common(items, "t.me/CryptoMarketAggregator/");
  assert.ok(items.every((x) => /\?i=\d+(\.\d+)?$/.test(x.link)), "每条都带 ?i=");
  assert.ok(!items.some((x) => /pinned|信息汇总】/.test(x.title)), "置顶提示与汇总抬头不应成条");
  const cpi = items.find((x) => x.link === "https://t.me/CryptoMarketAggregator/3430?i=1");
  assert.equal(cpi.title, "美国CPI超预期，美联储加息预期升温");
  assert.equal(cpi.signals.section, "重要新闻");
  assert.ok(cpi.signals_raw.sources.some((s) => s.name === "深潮" && /techflowpost\.com/.test(s.url)));
  // [3/3] 开头的（出处）属于 [2/3] 末尾那条「上市公司财报」
  const fin = items.find((x) => x.link === "https://t.me/CryptoMarketAggregator/3432?i=12");
  assert.match(fin.title, /^上市公司财报：Tron Inc\./);
  assert.match(fin.content, /The Block/);
  assert.equal(items.find((x) => x.link === "https://t.me/CryptoMarketAggregator/3433?i=1").signals.section, "项目动态");
  // 一段串几件事 → 拆开；逐行列出的 - 条目 → 拆开
  assert.equal(items.find((x) => x.link.endsWith("3433?i=3.2")).title, "Stripe完成收购OpenRouter");
  assert.equal(items.find((x) => x.link.endsWith("3429?i=3.1")).title, "灰度推出Zcash Invest，首批向生态拨款40万美元");
});

test("Telegram 翻页：消息 id 从条目链接里取，按 id 判断衔接", () => {
  const pattern = "t\\.me/[A-Za-z0-9_]+/(\\d+)";
  assert.equal(numericId("https://t.me/CryptoMarketAggregator/3433?i=3.2", pattern), 3433);
  const src = { id: "tg", continuity: "stream", paging: { mode: "before", id_pattern: pattern } };
  const rec = (id) => ({ id: "k" + id, url: "https://t.me/x/" + id, published_at: null, time_confidence: "fetched" });
  const prev = { last_ok_at: "2026-11-10 00:00:00", head_keys: ["old"], max_id: 100 };
  assert.equal(evaluate(prev, [rec(101), rec(105)], src).status, "connected");
  assert.equal(evaluate(prev, [rec(120), rec(125)], src).status, "gap");
});

test("max 限制生效", () => {
  for (const id of adapterIds()) assert.ok(getAdapter(id).parse(load(id), { max: 3 }).length <= 3, id);
});

test("Hacker News：首页帖子按分数门槛收，链接是原文，时间是 UTC；讨论页取顶层评论", async () => {
  const hn = getAdapter("hackernews");
  const all = hn.parse(load("hackernews"), { max: 30, src: { min_points: 0 } });
  assert.equal(all.length, 30);
  const items = hn.parse(load("hackernews"), { max: 30, src: { min_points: 100 } });
  assert.ok(items.length > 5 && items.length < 30, "门槛之下的不收：" + items.length);
  assert.ok(items.every((x) => x.signals.likes >= 100));
  common(items, "");
  const first = items[0];
  assert.match(first.link, /^https:\/\/www\.vulncheck\.com\//);
  assert.match(first.published_at, /^2026-11-10T22:17:56Z$/);
  assert.equal(first.summary, "", "分数、评论数是热度信号，不写进摘要");
  assert.deepEqual([first.signals.likes, first.signals.comments, first.signals_raw.site], [319, 144, "vulncheck.com"]);
  assert.equal(first.signals_raw.discussion, "https://news.ycombinator.com/item?id=50447074");
  const pages = { "https://news.ycombinator.com/item?id=50447074": readFileSync(path.join(FIX, "hackernews_item.html.gz")) };
  const fetchHtml = async (u) => (pages[u] ? gunzipSync(pages[u]).toString("utf8") : null);
  const few = await hn.enrich(items.map((x) => Object.assign({}, x)), { fetchHtml, src: { comment_items: 2 } });
  assert.equal(few.tried, 2, "只读分数最高的几条");
  const r = await hn.enrich(items, { fetchHtml, src: { comment_items: 30 } });
  assert.equal(r.tried, items.length);
  assert.equal(r.ok, 1);
  assert.match(first.comments, /^· （15 条回复）I received 9 reports of Fil-C issues/);
  assert.ok(first.comments.split("\n").length >= 5 && first.comments.split("\n").every((l) => l.length <= 420));
  assert.equal(first.content, "", "外链帖不拿讨论页当正文");
});
