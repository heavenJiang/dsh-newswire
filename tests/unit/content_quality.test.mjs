/* 内容质量——广告与付费引流过滤、合集拆条、完整度、深读、模型判噪与拆合集、读者判定、内容健康度。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { upsertArticle } from "../../engine/store/db.mjs";
import { compileNoise, matchNoise, completeness, splitDigest, digestItemTitle, assess, reassess, markKind, isDigestTitle } from "../../engine/pipeline/quality.mjs";
import { upgradeTaxonomy } from "../../engine/config.mjs";
import { createModel } from "../../host/model.mjs";
import { loadLayout, gatherItems, bodiesFor, materialText, llmEdition } from "../../host/edition.mjs";
import { modelSplitDigests, makeDeepRead } from "../../host/deepread.mjs";
import { contentHealth, filteredItems } from "../../host/health.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAXDOC = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8"));
const NOISE = compileNoise(TAXDOC.noise);
const LAYOUT = Object.assign(loadLayout(null, path.join(CFG, "layout.json")), { min_importance: 0 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

const MORNING = "【财联社11月9日早间新闻精选】 1、国务院总理李强11月6日主持召开国务院常务会议。会议指出，完善资本市场稳市机制。 2、北京时间11月6日晚，何立峰与贝森特举行视频通话，双方同意继续发挥中美经贸磋商机制作用。 3、商务部新闻发言人就美制裁中国企业答记者问。 4、国家外汇管理局数据显示，截至10月末我国外汇储备规模为34052亿美元。";

test("噪声规则：财联社付费栏目与隐名荐股被标为 promo；标题里出现「广告」二字的正常新闻不误伤", () => {
  const hit = (title, summary, source_id) => matchNoise(NOISE, { title, summary, source_id: source_id || "cls_telegraph" });
  assert.equal(hit("【风口研报·公司】A股稀缺“红利+成长”标的，这家设备租赁公司以99%中小微客户筑牢基本盘", "①这家公司…分析师看好").id, "cls_paid_columns");
  assert.equal(hit("【九点特供】苹果研究团队披露机器人“大脑”进展", "分析师强call该环节").id, "cls_paid_columns");
  assert.equal(hit("【电报解读】光伏单月装机同比连续转正", "这家公司与头部组件企业合作").id, "cls_paid_columns");
  assert.equal(hit("\"AI+广告\"平台AppLovin四天暴涨70%", "AppLovin 股价大涨", "reuters"), null, "正常新闻不因「广告」二字被过滤");
  assert.equal(hit("某券商开户福利", "扫码领取 立即抢购", "x").id, "marketing_cta");
  assert.equal(hit("沙特首都遇袭", "利雅得金融区遇袭"), null);
});

test("taxonomy 升级到 v3：并入 noise 规则，从 mute 里拿掉会误伤的「广告」「推广」，保留用户自己加的", () => {
  const old = { version: 2, labels: [], mute: ["广告", "推广", "抽奖", "我的词"], noise: [{ id: "mine", name: "我的规则", title: "^【自定义】" }] };
  const up = upgradeTaxonomy(old, TAXDOC);
  assert.equal(up.changed, true);
  assert.deepEqual(up.doc.mute.filter((w) => w === "广告" || w === "推广"), []);
  assert.ok(up.doc.mute.includes("我的词"));
  assert.ok(up.doc.noise.some((r) => r.id === "mine") && up.doc.noise.some((r) => r.id === "cls_paid_columns"));
});

test("完整度：只有标题 / 截断（省略号或卡在抓取截断长度）/ 完整", () => {
  assert.equal(completeness({ title: "甲", summary: "", content: "" }), "title_only");
  assert.equal(completeness({ title: "甲", summary: "甲", content: "" }), "title_only");
  assert.equal(completeness({ title: "甲", summary: "前面的话……", content: "" }), "truncated");
  assert.equal(completeness({ title: "甲", summary: "字".repeat(300), content: "" }), "truncated");
  assert.equal(completeness({ title: "甲", summary: "字".repeat(300), content: "字".repeat(2000) }), "full");
  assert.equal(completeness({ title: "甲", summary: "一段完整的摘要。", content: "" }), "full");
});

test("合集拆条：按 1、2、3 连续编号拆，标题取第一句；不像合集的标题不拆", () => {
  const a = { title: "财联社11月9日早间新闻精选", summary: MORNING.slice(0, 120), content: MORNING };
  const parts = splitDigest(a);
  assert.equal(parts.length, 4);
  assert.equal(digestItemTitle(parts[0].text), "国务院总理李强11月6日主持召开国务院常务会议");
  assert.match(parts[3].text, /34052亿美元/);
  assert.deepEqual(splitDigest({ title: "某公司公告", content: MORNING }), []);
  assert.ok(isDigestTitle("11月8日周日《新闻联播》要闻17条"));
  assert.ok(isDigestTitle("周末要闻汇总：国常会作出部署"));
  assert.ok(!isDigestTitle("【财联社早知道】物理AI平台发布"), "付费栏目「早知道】」不当作合集");
});

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v18-")), "n.sqlite"));
  for (const [id, name] of [["cls_telegraph", "财联社电报"], ["ap", "美联社"], ["xh", "新华社"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  return db;
}
function rec(id, title, o) {
  const x = Object.assign({ summary: "", content: "", source_id: "cls_telegraph", pack: "core" }, o || {});
  return Object.assign({ completeness: completeness(Object.assign({ title }, x)), id, url: "https://x/" + id, canonical_url: "https://x/" + id, title, title_norm: title, published_at: iso(3600000), time_confidence: "feed", category: "", region: "", lang: "zh", paywalled: false, metrics: {}, content_hash: id, text_len: (x.content || x.summary).length, training_ready: false, parser_version: "t", signals: { rank: 0, hot: [], raw: {} } }, x);
}
function put(db, r) {
  upsertArticle(db, r, { nowIso: iso(3600000), channel: "t" });
  db.prepare("INSERT OR IGNORE INTO observations (run_id, source_id, article_id, rank, page, seen_at) VALUES ('r1', ?, ?, 0, 0, ?)").run(r.source_id, r.id, iso(3600000));
}

test("入库定性：合集拆出子条目入库、本身标 digest；广告标 promo；版面材料只取新闻，正文优先于摘要", () => {
  const db = tmpDb();
  const parent = rec("dg", "财联社11月9日早间新闻精选", { summary: MORNING.slice(0, 120), content: MORNING });
  const kids = assess(parent, NOISE);
  put(db, parent);
  for (const k of kids) put(db, k);
  const ad = rec("ad", "【风口研报·公司】这家公司有望受益", { summary: "①这家公司有望受益。" });
  assess(ad, NOISE);
  put(db, ad);
  const thin = rec("th", "美联社：某地发生地震", { source_id: "ap" });
  assess(thin, NOISE);
  put(db, thin);
  const kinds = Object.fromEntries(db.prepare("SELECT id, kind, completeness FROM articles").all().map((r) => [r.id, r.kind + "/" + r.completeness]));
  assert.equal(kinds.dg, "digest/full");
  assert.equal(kinds.ad, "promo/full");
  assert.equal(kinds.th, "news/title_only");
  assert.equal(kids.length, 4);
  assert.ok(kids.every((k) => kinds[k.id] === "digest_item/full"));
  const items = gatherItems(db, { pack: "core", since: iso(12 * 3600000), limit: 100 });
  assert.ok(!items.some((x) => x.id === "dg" || x.id === "ad"), "合集原稿与广告不进版面");
  assert.equal(items.filter((x) => x.parent_id === "dg").length, 4);
  // 正文：列表里带的全文比摘要长时交给模型的是正文
  db.prepare("UPDATE articles SET summary = '短摘要', content = ? WHERE id = 'th'").run("正文".repeat(100));
  const b = bodiesFor(db, ["th"]);
  assert.ok(b.get("th").length === 200);
  assert.match(materialText({ id: "th", title: "T", summary: "短摘要" }, b), /^T｜正文正文/);
  // 再次入库时规则不覆盖读者的判断
  markKind(db, ["ad"], "news", "reader", "读者恢复");
  put(db, Object.assign(rec("ad", "【风口研报·公司】这家公司有望受益"), { kind: "promo", kind_by: "rule" }));
  assert.equal(db.prepare("SELECT kind FROM articles WHERE id = 'ad'").get().kind, "news");
  db.close();
});

test("重新定性（reprocess）：改了规则后已入库的条目重判，合集补拆", () => {
  const db = tmpDb();
  put(db, rec("dg", "财联社11月9日早间新闻精选", { content: MORNING }));
  put(db, rec("ad", "【九点特供】机器人大脑进展", { summary: "分析师强call" }));
  const r = reassess(db, { sinceIso: iso(24 * 3600000), noise: NOISE, upsert: upsertArticle });
  assert.deepEqual(r, { promo: 1, digest: 1, items: 4 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM articles WHERE parent_id = 'dg'").get().n, 4);
  assert.deepEqual(reassess(db, { sinceIso: iso(24 * 3600000), noise: NOISE, upsert: upsertArticle }), { promo: 1, digest: 1, items: 0 }, "不重复拆");
  db.close();
});

function fakeLlm(reply) {
  const calls = [];
  const llm = { stream(o) { const p = o.messages[0].content[0].text; calls.push(p); const r = reply(p); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) }), calls };
}

test("模型读合集：规则拆不开的交给模型拆；拆出的内容要在原文里找得到，编造的丢掉", async () => {
  const db = tmpDb();
  const body = "周末发生哪些大事？要闻汇总如下： 宏观要闻 国务院常务会议部署稳市机制 国务院总理李强11月6日主持召开国务院常务会议，会议指出完善资本市场稳市机制。 何立峰与贝森特通话 北京时间11月6日晚，何立峰与贝森特举行视频通话。 外汇储备 截至10月末我国外汇储备规模为34052亿美元。 公司要闻 华新建材拟约16.42亿美元收购巴西水泥企业。" + "。".repeat(700);
  put(db, rec("wk", "周末要闻汇总：国常会就资本市场作出部署", { content: body }));
  const { m } = fakeLlm(() => JSON.stringify({ items: [
    { title: "国常会部署资本市场稳市机制", text: "国务院总理李强11月6日主持召开国务院常务会议，会议指出完善资本市场稳市机制。" },
    { title: "何立峰与贝森特视频通话", text: "北京时间11月6日晚，何立峰与贝森特举行视频通话。" },
    { title: "外汇储备34052亿美元", text: "截至10月末我国外汇储备规模为34052亿美元。" },
    { title: "华新建材收购巴西水泥企业", text: "华新建材拟约16.42亿美元收购巴西水泥企业。" },
    { title: "编造：央行降准", text: "央行宣布降准0.5个百分点，释放资金8000亿元。" },
  ] }));
  const r = await modelSplitDigests(db, m, { since: iso(12 * 3600000) });
  assert.deepEqual(r, { tried: 1, items: 4 });
  const rows = db.prepare("SELECT title, kind, kind_by FROM articles WHERE parent_id = 'wk' ORDER BY url").all().map((x) => ({ ...x }));
  assert.equal(rows.length, 4);
  assert.ok(!rows.some((x) => /降准/.test(x.title)), "原文里没有的数字被核对掉");
  assert.equal(db.prepare("SELECT kind FROM articles WHERE id = 'wk'").get().kind, "digest");
  assert.deepEqual(await modelSplitDigests(db, m, { since: iso(12 * 3600000) }), { tried: 0, items: 0 }, "拆过的不再拆");
  db.close();
});

test("模型编排：模型判为非新闻的标 promo 并离开版面；多家印证的不听模型的；读者标过的广告作为示例给模型；要写的报道先深读", async () => {
  const db = tmpDb();
  put(db, rec("n1", "沙特首都遇袭", { summary: "利雅得金融区遇袭" }));
  put(db, rec("n2", "美联社：某地发生地震", { source_id: "ap" }));
  put(db, rec("p1", "限时福利：开户送好礼", { summary: "名额有限" }));
  put(db, rec("old", "旧的读者标记广告", { summary: "x" }));
  markKind(db, ["old"], "promo", "reader", "读者标记");
  const { m, calls } = fakeLlm((p) => {
    if (p.includes("归为一篇报道")) {
      const n = (t) => Number(new RegExp("\\[(\\d+)\\] [^｜]*｜[^｜]*｜" + t).exec(p)[1]);
      return JSON.stringify({ stories: [{ items: [n("沙特首都遇袭")], title: "沙特遇袭", section: "politics", labels: [], importance: 80 }, { items: [n("美联社：某地发生地震")], title: "某地地震", section: "society", labels: [], importance: 60 }], noise: [n("限时福利")] });
    }
    if (p.includes("headline：一句话总括")) return JSON.stringify({ merge: [], headline: "总括", front: [1], watch: [] });
    if (p.includes("按版式为以下每篇报道写稿")) { const k = (p.match(/【报道\d+】/g) || []).length; return JSON.stringify({ stories: Array.from({ length: k }, (_, i) => ({ ref: i + 1, lead: "导语。", lead_refs: ["M1"], points: [], views: [], impact: "" })) }); }
    return "{}";
  });
  const asked = [];
  const deepRead = async (items) => { for (const it of items) { asked.push(it.id); db.prepare("UPDATE articles SET content = ?, completeness = 'full' WHERE id = ?").run("地震正文".repeat(30), it.id); } return { tried: items.length, ok: items.length }; };
  const ed = await llmEdition(db, m, { pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAXDOC.labels, maxItems: 100, maxStories: 10, budgetMs: 60000, deepRead });
  assert.equal(db.prepare("SELECT kind || '/' || kind_by k FROM articles WHERE id = 'p1'").get().k, "promo/llm");
  assert.ok(!Object.values(ed.stories).some((s) => (s.article_ids || []).includes("p1")));
  assert.match(calls.find((p) => p.includes("归为一篇报道")), /读者标记过的非新闻示例[\s\S]*旧的读者标记广告/);
  assert.ok(asked.includes("n2"), "只有标题的材料先深读");
  assert.ok(!asked.includes("n1"), "有摘要的不深读");
  assert.match(calls.find((p) => p.includes("按版式为以下每篇报道写稿")), /地震正文地震正文/, "深读到的正文交给了模型");
  assert.equal(ed.stats.deep.ok, 1);
  db.close();
});

test("深读：跳过近一天抓过的、长期抓不到正文的源；有篇数预算", async () => {
  const db = tmpDb();
  const now = iso(0);
  for (let i = 0; i < 3; i++) { put(db, rec("h" + i, "坏源" + i, { source_id: "xh" })); db.prepare("INSERT INTO article_bodies (article_id, ok, fetched_at) VALUES (?, 0, ?)").run("h" + i, now); }
  put(db, rec("a1", "甲", { source_id: "ap" }));
  const dr = makeDeepRead(db, { budget: 0 });
  const r = await dr([{ id: "h9", url: "https://x/h9", source_id: "xh" }, { id: "a1", url: "https://x/a1", source_id: "ap" }]);
  assert.deepEqual([r.wanted, r.tried, r.skipped], [2, 0, 2], "坏源跳过、预算为 0 时不抓");
  db.close();
});

test("内容健康度：只有标题的比例突然升高记 degraded；被过滤的条目可列出", () => {
  const db = tmpDb();
  const before = iso(3 * 24 * 3600000);
  for (let i = 0; i < 12; i++) { put(db, rec("o" + i, "旧闻" + i, { source_id: "ap", summary: "完整摘要" + i })); db.prepare("UPDATE articles SET first_seen_at = ?, completeness = 'full' WHERE id = ?").run(before, "o" + i); }
  for (let i = 0; i < 10; i++) { put(db, rec("t" + i, "新闻" + i, { source_id: "ap" })); db.prepare("UPDATE articles SET first_seen_at = ?, completeness = 'title_only' WHERE id = ?").run(iso(3600000), "t" + i); }
  put(db, rec("ad", "【九点特供】某某", { summary: "x" }));
  db.prepare("UPDATE articles SET kind = 'promo', kind_note = '财联社付费栏目引流', first_seen_at = ? WHERE id = 'ad'").run(iso(3600000));
  const h = contentHealth(db);
  const ap = h.sources.find((x) => x.source_id === "ap");
  assert.equal(ap.status, "degraded");
  assert.equal(ap.title_only_before, 0);
  assert.deepEqual(h.degraded, ["美联社"]);
  assert.equal(h.totals.promo, 1);
  assert.deepEqual(filteredItems(db, { hours: 72 }).map((x) => x.id), ["ad"]);
  db.close();
});
