/* 一手信息：AI 与新技术新闻找原文（聚合站页面上的出处）、原文进写稿材料、不按家数设门槛、不进待核实、推送与面板先列原文。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { originLink, pageUrlFor, isFirstHand, originCandidates, findOrigins, siteOf, originText } from "../../engine/pipeline/origin.mjs";
import { originOf, storyFacts, materialText, assemble, normalizeLayout, editionPicks, composeEditionMessage } from "../../host/edition.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const tmpDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-origin-")), "n.sqlite"));

test("出处链接：认「打开原文」「信源」「在 X 查看原推」；分享按钮、备案、本站链接、长文字链接不算；一手站点优先", () => {
  const html = `<a href="https://aihot.news/topics/openai">OpenAI</a>
    <a href="https://beian.miit.gov.cn/">原文</a>
    <a href="https://twitter.com/intent/tweet?url=x">分享到 X</a>
    <a href="https://www.ithome.com/1/0/1.htm">来源：IT之家</a>
    <a href="https://openai.com/index/new-model" class="btn">打开原文 <svg></svg></a>
    <a href="https://openai.com/index/new-model">OpenAI：官网动态</a>
    <a href="https://example.com/x">这是一段很长很长的正文里的链接文字，不是出处按钮，也不该被当成原文链接来用</a>`;
  assert.equal(originLink(html, "https://aihot.news/items/abc"), "https://openai.com/index/new-model");
  assert.equal(originLink('<div class="tgme_widget_message_text"><a href="https://x.com/MTSlive/status/1" target="_blank">信源</a></div>', "https://t.me/OneMillion_AI/5872"), "https://x.com/MTSlive/status/1");
  assert.equal(originLink('<a href="https://x.com/DrJimFan/status/2">在 X 查看原推</a>', "https://aihot.news/items/z"), "https://x.com/DrJimFan/status/2");
  assert.equal(originLink('<a href="https://www.chaincatcher.com/a/1">原文</a><a href="https://www.forbes.com/x"></a>', "https://www.chaincatcher.com/article/9"), "", "本站链接、没有文字的链接都不是出处");
  assert.equal(originLink('<a href="https://the-decoder.com/a">打开原文</a>', "https://aihot.news/items/q"), "https://the-decoder.com/a", "不在一手站点上的出处也记下");
});

test("一手站点与条目页地址", () => {
  assert.ok(isFirstHand("https://openai.com/index/x"));
  assert.ok(isFirstHand("https://arxiv.org/abs/2511.01234"));
  assert.ok(isFirstHand("https://www.anthropic.com/news/x"));
  assert.ok(isFirstHand("https://developer.nvidia.com/blog/x"), "子域名也算");
  assert.ok(!isFirstHand("https://www.ithome.com/1/0/1.htm"));
  assert.ok(!isFirstHand("https://notopenai.com/x"), "只认整段域名");
  assert.ok(isFirstHand("https://www.databricks.com/blog/genie-one", "Databricks 升级 Genie One 为企业 AI"), "站点名就是标题里的公司");
  assert.ok(isFirstHand("https://hy.tencent.ai/research/hy4", "腾讯 Tencent 混元 Hy4 上线"));
  assert.ok(!isFirstHand("https://www.databricks.com/blog/x", "谷歌发布新模型"), "标题里没这家公司");
  assert.ok(!isFirstHand("https://techcrunch.com/2026/x", "TechCrunch：Databricks 升级 Genie"), "媒体名出现在标题里不算");
  // X 账号要和标题里的公司或人对得上；评论者、搬运号不算一手（例子取自实际版面）
  assert.ok(!isFirstHand("https://x.com/rohanpaul_ai/status/1", "外交部回应美国收紧对华AI芯片限制"));
  assert.ok(!isFirstHand("https://x.com/bot/status/1", "Grok Bot 1.0发布主打团队协作"), "账号太短不算");
  assert.ok(isFirstHand("https://x.com/Google/status/1", "谷歌推出多人AI工具Tabletop"), "中文名对得上");
  assert.ok(isFirstHand("https://x.com/TencentHunyuan/status/1", "腾讯混元官方宣布 Hy4 已上线"));
  assert.ok(isFirstHand("https://x.com/DrJimFan/status/1", "Jim Fan 发布一段实机视频"), "人名两个词连写");
  assert.ok(!isFirstHand("https://www.latent.space/p/x", "[AINews] Latent Space 发布 AI 要闻"), "通讯平台不算");
  assert.equal(siteOf("https://x.com/GoogleDeepMind/status/2120484246401777737"), "X @GoogleDeepMind");
  assert.equal(siteOf("https://www.deepmind.google/blog/a"), "deepmind.google");
  assert.equal(originText("https://x.com/a/status/1", 'Tencent Hy on X: "Hy4 on OpenRouter" / Conversation / Hy4 on OpenRouter / *    So bad model'), "Hy4 on OpenRouter", "X 只留原帖，不要回复");
  assert.equal(originText("https://openai.com/x", "全文 / Conversation"), "全文 / Conversation");
  assert.equal(pageUrlFor("https://t.me/OneMillion_AI/5872"), "https://t.me/OneMillion_AI/5872?embed=1");
  assert.equal(pageUrlFor("https://aihot.news/items/a"), "https://aihot.news/items/a");
});

test("找原文：只找本轮的重点领域、非一手源、没找过的；找到存链接与原文，页面上没有出处记空串，打不开下次再试", async () => {
  const db = tmpDb();
  db.prepare("INSERT INTO runs (run_id, mode, started_at) VALUES ('r1', 'cycle', ?)").run(iso(0));
  const add = (id, url, label, origin) => {
    db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, last_seen_at, origin_url) VALUES (?,?,?,?,?,?,?)").run(id, url, "标题" + id, "agg", iso(0), iso(0), origin === undefined ? null : origin);
    db.prepare("INSERT INTO observations (run_id, article_id, source_id, seen_at) VALUES ('r1', ?, 'agg', ?)").run(id, iso(0));
    if (label) db.prepare("INSERT INTO article_labels (article_id, label, confidence, origin) VALUES (?, ?, 1, 'rule')").run(id, label);
  };
  add("a1", "https://aihot.news/items/1", "tech.frontier");
  add("a2", "https://aihot.news/items/2", "industry.ai_semis");
  add("a3", "https://aihot.news/items/3", "tech.frontier");
  add("a4", "https://t.me/c/4", "tech.frontier");
  add("m1", "https://cls.cn/1", "macro.monetary");
  add("o1", "https://openai.com/index/x", "tech.frontier");
  add("d1", "https://aihot.news/items/9", "tech.frontier", "");
  const list = originCandidates(db, { runId: "r1", labels: ["tech", "industry.ai_semis"], budget: 10 });
  assert.deepEqual(list.map((x) => x.id).sort(), ["a1", "a2", "a3", "a4"], "非重点领域、本身在一手站点、找过的都不找");
  const pages = {
    "https://aihot.news/items/1": '<a href="https://openai.com/index/m">打开原文</a>',
    "https://aihot.news/items/2": '<a href="https://www.ithome.com/x">打开原文</a>',
    "https://aihot.news/items/3": "<p>没有出处</p>",
  };
  const r = await findOrigins(db, list, {
    fetchPage: async (u) => (pages[u] ? { ok: true, text: pages[u] } : { ok: false }),
    fetchBody: async (u) => (u.includes("openai.com") ? { ok: true, text: "OpenAI today released model M with 1M context." } : { ok: false }),
  });
  assert.deepEqual([r.tried, r.found, r.first_hand, r.read], [4, 2, 1, 1]);
  const row = (id) => db.prepare("SELECT origin_url, origin_site, origin_text FROM articles WHERE id = ?").get(id);
  assert.deepEqual({ ...row("a1") }, { origin_url: "https://openai.com/index/m", origin_site: "openai.com", origin_text: "OpenAI today released model M with 1M context." });
  assert.deepEqual({ ...row("a2") }, { origin_url: "https://www.ithome.com/x", origin_site: "ithome.com", origin_text: null }, "原文读不到也记链接");
  assert.equal(row("a3").origin_url, "", "找过、没有出处");
  assert.equal(row("a4").origin_url, null, "页面打不开：下一轮再试");
  db.close();
});

test("报道的原文：一手站点优先；官方源本身就是一手；原文进写稿材料", () => {
  const items = [
    { id: "1", source_id: "agg", url: "https://aihot.news/items/1", origin_url: "https://the-decoder.com/a", origin_site: "the-decoder.com", title: "谷歌发布模型" },
    { id: "2", source_id: "tg", url: "https://t.me/c/2", origin_url: "https://x.com/Google/status/1", origin_site: "X @Google", title: "谷歌发布模型" },
  ];
  assert.deepEqual(originOf(items), { url: "https://x.com/Google/status/1", site: "X @Google", first_hand: true });
  assert.deepEqual(originOf([{ id: "3", url: "https://openai.com/index/y", title: "t" }]), { url: "https://openai.com/index/y", site: "openai.com", first_hand: true });
  assert.equal(originOf([{ id: "4", url: "https://cls.cn/1", title: "t" }]), null);
  assert.equal(storyFacts(items).origin.site, "X @Google");
  const t = materialText({ title: "谷歌发布模型", summary: "转述", origin_site: "blog.google", origin_text: "Today we are launching Gemini Decision 1." }, new Map(), { body_chars: 900, summary_chars: 240 });
  assert.match(t, /转述｜【原文（blog\.google）】Today we are launching Gemini Decision 1\./);
});

test("组版：AI 与新技术的单家报道不进待核实；推送不按家数设门槛，原文排在来源最前面", () => {
  const layout = normalizeLayout({});
  const st = (id, section, labels, n, imp, extra) => Object.assign({ id, title: "报道" + id, section, labels, importance: imp, source_count: n, credibility: n > 1 ? "corroborated" : "single", outlets: [{ source_id: "agg", name: "数字生命卡兹克" }], first_seen_at: iso(600000), article_ids: [], event_ids: [] }, extra || {});
  const stories = [
    st("ai", "tech", ["tech.frontier"], 1, 70, { origin: { url: "https://openai.com/index/m", site: "openai.com", first_hand: true } }),
    st("mac", "macro", ["macro.monetary"], 1, 60),
    st("chip", "industry", ["industry.ai_semis"], 2, 40),
    st("pol", "politics", ["politics.diplomacy"], 2, 40),
  ];
  const parts = assemble(stories, layout, {}, {});
  assert.deepEqual(parts.verify.map((v) => v.stories[0]), ["mac"], "只有非重点领域的单家报道待核实");
  assert.ok(stories[0].focal && stories[2].focal && !stories[1].focal);
  const db = tmpDb();
  const ed = { mode: "llm", model: "m", items_read: 4, stories: Object.fromEntries(stories.map((s) => [s.id, s])) };
  const picks = editionPicks(db, ed, { min_corroborated: 50, min_single: 36, max: 8 }, { nowIso: iso(0), lookbackHours: 6 });
  assert.deepEqual(picks.map((p) => p.id).sort(), ["ai", "chip", "mac"], "两家报道、40 分的芯片新闻按低的那档门槛推；同分的时政不推");
  const ai = picks.find((p) => p.id === "ai");
  assert.deepEqual(ai.links[0], { name: "原文（openai.com）", url: "https://openai.com/index/m", origin: true });
  const msg = composeEditionMessage({ hhmm: "09:00", md: "11-12", warnings: [], title: "要闻", format: "brief" }, [ai], ed, {});
  assert.match(msg, /\[原文（openai\.com）\]\(https:\/\/openai\.com\/index\/m\)/, "短消息只列一个来源时列原文");
  db.close();
});

test("找到原文后旧稿不沿用、不延后：旧稿按转述写的，要按原文重写", async () => {
  const { copyFresh, deferRewrite, originCount } = await import("../../host/edition.mjs");
  const row = { copy: { by: "llm", lead: "旧导语", items: 3, origins: 0 } };
  const items = [{ id: "1" }, { id: "2", origin_text: "OpenAI released M." }, { id: "3" }];
  assert.equal(originCount(items), 1);
  assert.ok(copyFresh(row, 3, 0), "没有新原文：照旧沿用");
  assert.ok(!copyFresh(row, 3, 1), "多了一篇原文：重写");
  assert.ok(copyFresh({ copy: Object.assign({}, row.copy, { origins: 1 }) }, 3, 1), "按原文写过的：沿用");
  const S = { rewrite_min: 2, rewrite_ratio: 0.25 };
  assert.ok(deferRewrite(row, { _total: 4, importance: 40, _g: { items: [{ id: "1" }] } }, S), "新增一篇、没有原文：先不重写");
  assert.ok(!deferRewrite(row, { _total: 4, importance: 40, _g: { items } }, S), "新增的带原文：不延后");
});
