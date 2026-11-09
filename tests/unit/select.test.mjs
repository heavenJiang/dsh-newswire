import { test } from "node:test";
import assert from "node:assert/strict";
import { bigrams, similarity, nativeHeat, composeMessage } from "../../engine/pipeline/select.mjs";
import { parseExaText } from "../../engine/channels/exa.mjs";

const SOURCES = new Map([
  ["cls", { id: "cls", name: "财联社电报", group: "cls", weight: 0.85 }],
  ["jm", { id: "jm", name: "界面新闻·快讯", group: "jiemian", weight: 0.8 }],
  ["reuters", { id: "reuters", name: "路透·World", group: "reuters", weight: 0.95 }],
]);

test("标题相似：长前缀用包含度识别，不同新闻不相似", () => {
  const a = bigrams("沙特首都金融区遭袭，阿美石油公司大楼受损");
  const b = bigrams("法新社8日援引目击者消息说，沙特阿拉伯首都利雅得金融区遭到袭击，沙特阿美石油公司大楼受损");
  assert.ok(similarity(a, b) >= 0.5);
  assert.ok(similarity(a, bigrams("上交所：沪市上市公司总市值超65万亿元")) < 0.2);
});

test("源头热度：标记、级别、头条位；分位要求非零样本 ≥30", () => {
  const empty = new Map();
  assert.equal(nativeHeat({ hot: JSON.stringify(["加红"]), source_id: "jm" }, empty).heat, 40);
  assert.equal(nativeHeat({ level: "B", source_id: "cls", views: 999999 }, empty).heat, 40);
  assert.equal(nativeHeat({ level: "C", source_id: "cls" }, empty).heat, 0);
  assert.equal(nativeHeat({ hot: ["Most Read #2"], section: "list", rank: 0, source_id: "ap" }, empty).heat, 45);
  const dist = new Map([["cls", Array.from({ length: 100 }, (_, i) => (i + 1) * 100)]]);
  assert.ok(nativeHeat({ source_id: "cls", views: 9800 }, dist).why.includes("互动前5%"));
  assert.equal(nativeHeat({ source_id: "cls", views: 0 }, dist).heat, 0);
});

const ev = (o) => Object.assign({ lead: { source_id: "cls", url: "https://www.cls.cn/detail/1" }, obs: { views: 42000 }, heat: { heat: 40, why: ["级别B"] }, outlets: [], labels: [], dispute: null, reason: "new", first_seen_at: "2026-11-07 23:30:00" }, o);

test("消息：多源事件标可信度与各源，单源标源名，升级标 ↑，分歧单列", () => {
  const picks = [
    ev({ title: "央行宣布降准0.5个百分点", credibility: "confirmed", source_count: 3, labels: ["macro.monetary"], outlets: [{ source_id: "cls", name: "财联社电报" }, { source_id: "jm", name: "界面新闻·快讯" }, { source_id: "reuters", name: "路透·World" }] }),
    ev({ title: "某公司停牌", credibility: "single", source_count: 1, reason: "new", obs: {} }),
    ev({ title: "某地发生爆炸", credibility: "disputed", source_count: 2, reason: "upgraded", heat: { heat: 0, why: [] }, obs: {}, outlets: [{ source_id: "cls", grp: "cls" }, { source_id: "reuters", grp: "reuters" }], dispute: { kind: "人数", values: [{ outlet: "cls", value: 6 }, { outlet: "reuters", value: 8 }] } }),
  ];
  const msg = composeMessage({ now: new Date("2026-11-07T23:00:00Z"), tz: "Asia/Shanghai", overnight: true, results: [{ id: "cls", ok: true, fresh: 80, continuity: "connected" }], picks, sources: SOURCES, failing: [], names: { "macro.monetary": "货币政策" } });
  const L = msg.split("\n");
  assert.equal(L[0], "📰 隔夜要闻 · 11-08 07:00");
  assert.equal(L[2], "1.【权威确认·3源·级别B】央行宣布降准0.5个百分点 #货币政策");
  assert.equal(L[3], "   07:30 · 财联社电报/界面新闻/路透 · 阅读 4.2万 · https://www.cls.cn/detail/1");
  assert.equal(L[4], "2.【财联社电报·级别B】某公司停牌");
  assert.equal(L[6], "3.↑【存在分歧·2源】某地发生爆炸");
  assert.equal(L[8], "   分歧（人数）：财联社电报 6 / 路透 8");
});

test("消息：无重点一行简报，附缺口与连续失败提醒", () => {
  const results = [{ id: "cls", ok: true, fresh: 12, continuity: "connected" }, { id: "jm", ok: true, fresh: 3, continuity: "gap_open", backfilled: 0 }, { id: "reuters", ok: false, continuity: "failed" }];
  const msg = composeMessage({ now: new Date("2026-11-08T05:00:00Z"), tz: "Asia/Shanghai", overnight: false, results, picks: [], sources: SOURCES, failing: [{ source_id: "reuters", runs: 3, chain: "browse:unknown -> http:paywall" }] });
  assert.deepEqual(msg.split("\n"), ["13:00 无新重点（源 2/3，新增 15 条，衔接 ✓1 ⚠1）", "⚠ 界面新闻·快讯 有缺口未补全（未补回）", "⚠ 路透·World 连续 3 轮失败（http:paywall）"]);
});

test("Exa 文本结果解析", () => {
  const t = "Title: 快报|界面新闻\nURL: https://m.jiemian.com/lists/4.html?page=65\nPublished: 2026-11-07T00:00:00.000Z\nAuthor: N/A\nHighlights:\n快讯正文\n\nTitle: 某条新闻\nURL: https://www.jiemian.com/article/15307925.html\nPublished: 2026-11-08T00:00:00.000Z\nHighlights:\n摘要";
  const r = parseExaText(t);
  assert.equal(r.length, 2);
  assert.equal(r[1].url, "https://www.jiemian.com/article/15307925.html");
});
