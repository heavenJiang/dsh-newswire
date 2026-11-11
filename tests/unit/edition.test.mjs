/* 版面——版式、程序编排、模型编排（假模型）、失败退回、推送选择与消息。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { groupPrompt, planPrompt, writePrompt, taxonomyIndex, inFocus } from "../../host/edition.mjs";
import { autoAnalyzeTargets } from "../../host/analysis.mjs";
import { normalizeLayout, loadLayout, ruleEdition, llmEdition, saveEdition, latestEdition, notesFromEdition, editionPicks, recordEditionPushes, composeEditionMessage, gatherItems } from "../../host/edition.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8")).labels;
const NAMES = Object.fromEntries(TAX.flatMap((t) => [[t.id, t.name]].concat((t.children || []).map((c) => [c.id, c.name]))));
const LAYOUT = loadLayout(null, path.join(ROOT, "layout.json"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const SINCE = iso(12 * 3600000);

/** 三个规则事件：e1 两家（财联社、路透），e2 单源，e3 单源低分；外加一条噪声。 */
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-v10-"));
  const db = openDb(path.join(dir, "n.sqlite"));
  for (const [id, name, grp] of [["cls", "财联社电报", "cls"], ["reuters", "路透·World", "reuters"], ["moe", "教育部", "moe"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, grp);
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)");
  const ev = db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors, updated_run) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const mem = db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)");
  const t = iso(3600000);
  art.run("a1", "https://cls/1", "沙特首都金融区遭袭", "法新社援引目击者称利雅得金融区遭袭，阿美大楼受损", t, t, t, "cls", "core");
  art.run("a2", "https://reuters/2", "Saudi Aramco building damaged in Riyadh attack", "Missiles intercepted over Riyadh", t, t, t, "reuters", "core");
  art.run("a3", "https://moe/3", "教育部发布留学预警", "提醒留学人员注意安全", t, t, t, "moe", "core");
  art.run("a4", "https://cls/4", "某公司发布公告", "", t, t, t, "cls", "core");
  art.run("a5", "https://cls/5", "栏目导航", "", t, t, t, "cls", "core");
  ev.run("e1", "core", "沙特首都金融区遭袭", "a1", t, t, 2, 2, 80, "corroborated", JSON.stringify(["politics.conflict"]), JSON.stringify([{ source_id: "cls", name: "财联社电报" }, { source_id: "reuters", name: "路透·World" }]), JSON.stringify({ sources: 40, cross_region: 10, persistence: 5 }), "r1");
  ev.run("e2", "core", "教育部发布留学预警", "a3", t, t, 1, 1, 45, "single", JSON.stringify(["study.visa"]), JSON.stringify([{ source_id: "moe", name: "教育部" }]), "{}", "r1");
  ev.run("e3", "core", "某公司发布公告", "a4", t, t, 1, 1, 20, "single", JSON.stringify(["industry.corporate"]), JSON.stringify([{ source_id: "cls", name: "财联社电报" }]), "{}", "r1");
  mem.run("e1", "a1", "cls", "cls", "seed"); mem.run("e1", "a2", "reuters", "reuters", "entity");
  mem.run("e2", "a3", "moe", "moe", "seed"); mem.run("e3", "a4", "cls", "cls", "seed");
  return db;
}

/** 假模型：按提示词判断是归并、统筹还是写稿。 */
function fakeModel(o) {
  const calls = [];
  const reply = (prompt) => {
    if (prompt.includes("归为一篇报道")) {
      if (o.groupFail) return "不是 JSON";
      const n = (title) => { const m = prompt.match(new RegExp("\\[(\\d+)\\] [^\\n]*" + title)); return m ? Number(m[1]) : null; };
      return JSON.stringify({ stories: [
        { items: [n("沙特首都金融区遭袭"), n("Saudi Aramco")], title: "沙特利雅得金融区遇袭", section: "politics", labels: ["politics.conflict"], importance: 85 },
        { items: [n("教育部发布留学预警")], title: "教育部发布留学安全预警", section: "study", labels: ["study.visa"], importance: 55 },
        { items: [n("某公司发布公告")], title: "某公司公告", section: "industry", labels: ["bogus.label"], importance: 22 },
      ] });
    }
    if (prompt.includes("headline：一句话总括")) return o.planFail ? "乱写" : JSON.stringify({ merge: [], headline: "沙特遇袭牵动地区局势", front: [1, 2], watch: [{ text: "沙特官方后续通报", refs: [1] }] });
    if (prompt.includes("按版式为以下每篇报道写稿")) {
      if (o.writeFail) return "乱写";
      if (o.dropOnce && !o.dropped) { o.dropped = true; return { error: "Connection error." }; }
      const refs = (prompt.match(/【报道\d+】/g) || []).length;
      const debate = prompt.includes("debate 社区观点") ? { debate: [{ text: "有评论认为提醒很及时", refs: ["M1"] }, { text: "有人说涉及 9999 人", refs: ["M1"] }] } : {};
      return JSON.stringify({ stories: Array.from({ length: refs }, (_, i) => Object.assign({ ref: i + 1, lead: "模型导语" + (i + 1) + "：利雅得金融区周六遇袭。", points: ["要点甲", "要点乙"], views: [{ who: "路透", says: "导弹被拦截" }], impact: "牵动油价" }, debate)) });
    }
    return "{}";
  };
  const llm = { stream(opts) { const text = opts.messages[0].content[0].text; calls.push(text.slice(0, 30)); const r = reply(text); return (async function* () {
    if (r && typeof r === "object") { yield { type: "finish", reason: { kind: "error", failure: { message: r.error } } }; return; }
    yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  const m = createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) });
  return { m, calls };
}

const base = (extra) => Object.assign({ pack: "all", since: SINCE, hours: 12, layout: LAYOUT, names: NAMES, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});

test("版式：坏值夹紧、缺项补默认、坏文件退回种子", () => {
  const l = normalizeLayout({ front: { count: 99 }, sections: [{ id: "tech", max: 0 }, { bad: 1 }], story: { lead_chars: 5 } });
  assert.equal(l.front.count, 8);
  assert.deepEqual(l.sections, [{ id: "tech", max: 1 }]);
  assert.equal(l.story.lead_chars, 30);
  assert.equal(l.story.points, 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-layout-"));
  fs.writeFileSync(path.join(dir, "layout.json"), "{坏");
  assert.equal(loadLayout(path.join(dir, "layout.json"), path.join(ROOT, "layout.json")).sections.length, 7);
});

test("程序编排：报道=规则事件，按版块分栏，导语/要点/影响由程序拼，单源进待核实", () => {
  const db = tmpDb();
  const ed = ruleEdition(db, base());
  assert.equal(ed.mode, "rules");
  const s1 = Object.values(ed.stories).find((s) => s.lead_event_id === "e1");
  assert.equal(s1.section, "politics");
  assert.equal(s1.source_count, 2);
  assert.match(s1.lead, /利雅得金融区遭袭/);
  assert.ok(s1.points.some((x) => x.text.includes("Saudi Aramco") && x.refs[0] === "a2"), "要点取其它媒体的标题，出处是那篇");
  assert.equal(s1.impact, "", "程序说不出影响，不写");
  assert.deepEqual(ed.sections.map((x) => x.id), ["politics", "study"], "低于门槛的不上版");
  assert.equal(ed.front[0], s1.id);
  assert.ok(ed.verify.some((v) => /教育部/.test(v.text)), "单源过门槛进待核实");
  assert.ok(ed.watch.length >= 1, "持续发酵进值得关注");
  db.close();
});

test("模型编排：归并跨语言报道、版块与标签校验、统筹头版、按版式写稿，写稿记到事件解读", async () => {
  const db = tmpDb();
  const { m, calls } = fakeModel({});
  const ed = await llmEdition(db, m, base());
  assert.equal(ed.mode, "llm");
  assert.equal(ed.model, "fake/m");
  assert.equal(ed.headline, "沙特遇袭牵动地区局势");
  const s1 = ed.stories[ed.front[0]];
  assert.equal(s1.title, "沙特利雅得金融区遇袭");
  assert.deepEqual(s1.article_ids.sort(), ["a1", "a2"]);
  assert.equal(s1.credibility, "corroborated");
  assert.equal(s1.by, "llm");
  assert.match(s1.lead, /^模型导语/);
  assert.deepEqual(s1.views.map((v) => ({ who: v.who, says: v.says })), [{ who: "路透", says: "导弹被拦截" }]);
  const s3 = Object.values(ed.stories).find((s) => s.title === "某公司公告");
  assert.deepEqual(s3.labels, ["industry.corporate"], "不认识的标签换回规则标签");
  assert.ok(!Object.values(ed.stories).some((s) => s.article_ids.includes("a5")), "噪声条目不收");
  assert.deepEqual(ed.watch, [{ text: "沙特官方后续通报", stories: [s1.id] }]);
  assert.equal(calls.length, 3, "归并 1 次、统筹 1 次、写稿 1 次");
  assert.equal(s1.profile, "wire", "每篇报道记下用的读法");
  const saved = saveEdition(db, ed, { runId: "r1" });
  assert.equal(db.prepare("SELECT profile FROM stories WHERE story_id = ?").get(s1.id).profile, "wire", "故事线记下读法");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_items WHERE edition_id = ?").get(saved.id).n, 4);
  assert.equal(latestEdition(db, "all").content.headline, "沙特遇袭牵动地区局势");
  assert.equal(notesFromEdition(db, ed), 2);
  assert.match(JSON.parse(db.prepare("SELECT llm_notes FROM events WHERE event_id='e1'").get().llm_notes).summary, /^模型导语/);
  db.close();
});

test("模型编排失败退回：归并失败按规则事件归并；统筹失败按重要度选头版；写稿失败用程序拼的稿", async () => {
  const db = tmpDb();
  const ed = await llmEdition(db, fakeModel({ groupFail: true, planFail: true, writeFail: true }).m, base());
  assert.equal(ed.mode, "llm");
  assert.ok(ed.stats.failed >= 3);
  assert.deepEqual(ed.stats.fallbacks, ["group:4", "plan", "write:3"], "每个退回规则的步骤都记下");
  const s1 = ed.stories[ed.front[0]];
  assert.equal(s1.lead_event_id, "e1");
  assert.equal(s1.by, "rules");
  assert.match(s1.lead, /利雅得/);
  assert.ok(ed.headline.length > 0, "总括退回头版标题");
  db.close();
});

test("材料：时段外的不读；pack 过滤", () => {
  const db = tmpDb();
  assert.equal(gatherItems(db, { since: SINCE }).length, 5);
  assert.equal(gatherItems(db, { since: iso(-3600000) }).length, 0);
  assert.equal(gatherItems(db, { since: SINCE, pack: "study_abroad" }).length, 0);
  db.close();
});

test("推送：版面里的新报道过门槛就推，记推送后不重复；消息带总括、导语与依据", async () => {
  const db = tmpDb();
  const ed = await llmEdition(db, fakeModel({}).m, base());
  const nowIso = iso(0);
  const rules = { min_corroborated: 50, min_single: 36, max: 8, upgrade_jump: 20 };
  const picks = editionPicks(db, ed, rules, { nowIso, lookbackHours: 6 });
  assert.deepEqual(picks.map((x) => x.title), ["沙特利雅得金融区遇袭", "教育部发布留学安全预警"]);
  recordEditionPushes(db, picks, "r1", nowIso, "core");
  assert.equal(editionPicks(db, ed, rules, { nowIso, lookbackHours: 6 }).length, 0, "推过的不再推");
  const onlyStudy = editionPicks(tmpDb(), ed, Object.assign({}, rules, { require_labels: ["study"] }), { nowIso, lookbackHours: 6 });
  assert.deepEqual(onlyStudy.map((x) => x.section), ["study"]);
  const parts = { hhmm: "09:00", md: "11-08", stats: "源 3/3，新增 5 条，衔接 ✓", warnings: ["⚠ 某源 有缺口未补全（未补回）"], title: "要闻", overnight: false };
  const msg = composeEditionMessage(parts, picks, ed, NAMES).split("\n");
  assert.equal(msg[0], "📰 **要闻** · 11月8日 09:00");
  assert.equal(msg[1], "新报道 2 件");
  assert.equal(msg[2], "> 沙特遇袭牵动地区局势");
  assert.equal(msg[3], "", "分组之间空一行");
  assert.match(msg[4], /^\*\*(🔴 重点|💻|📈|🌐|📌)/, "按重点、领域分组");
  const first = msg.indexOf("**1. 沙特利雅得金融区遇袭**");
  assert.ok(first > 0, "标题加粗带序号");
  assert.match(msg[first + 1], /^模型导语/);
  assert.ok(msg.slice(first).some((l) => /\]\(https?:\/\/[^)]+\)/.test(l) && /\d\d:\d\d/.test(l)), "来源名带链接");
  assert.ok(!msg.some((l) => /【已印证|源 3\/3|衔接/.test(l)), "不再有内部术语");
  assert.ok(msg.includes("⚠ 有 1 处数据源异常，详见新闻面板「运行」"));
  assert.match(msg[msg.length - 1], /^由 fake\/m 阅读 5 条新闻后编写，可能有误，以原文为准/);
  assert.equal(composeEditionMessage(parts, [], ed, NAMES).split("\n")[0], "09:00 要闻：暂无新的重点");
  db.close();
});

test("旧闻：发布时间早于时段一天以上的不读（新源首轮的列表旧条目）", () => {
  const db = tmpDb();
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run("old", "https://x/old", "十月的旧闻", "", "2026-10-14 13:00:00", t, t, "cls", "core");
  assert.ok(!gatherItems(db, { since: SINCE }).some((x) => x.id === "old"));
  db.close();
});

test("程序导语截到整句，不在半句话处加省略号", async () => {
  const { clipSentence } = await import("../../host/edition.mjs");
  const body = "外交部发言人郭嘉昆主持例行记者会。法新社记者提问，路透社报道，60万块美国英伟达高级芯片正在香港，即将被送往中国大陆。请问外交部对此有何评论？郭嘉昆表示，中方在美国输华芯片问题上的立场是一贯的。";
  assert.equal(clipSentence(body, 80), "外交部发言人郭嘉昆主持例行记者会。法新社记者提问，路透社报道，60万块美国英伟达高级芯片正在香港，即将被送往中国大陆。请问外交部对此有何评论？");
  assert.equal(clipSentence("短句。", 80), "短句。");
  assert.ok(clipSentence("一".repeat(200), 80).endsWith("…"));
});

/** 再加一条只有一家报道、规则分低的 AI 新闻（a6，条目标签 tech.frontier）。 */
function tmpDbAi() {
  const db = tmpDb();
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run("a6", "https://cls/6", "某实验室发布新一代推理模型", "性能大幅提升", t, t, t, "cls", "core");
  db.prepare("INSERT INTO article_labels (article_id, label, confidence, origin) VALUES (?,?,?,?)").run("a6", "tech.frontier", 1, "rule");
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors, updated_run) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("e6", "core", "某实验室发布新一代推理模型", "a6", t, t, 1, 1, 10, "single", JSON.stringify(["tech.frontier"]), JSON.stringify([{ source_id: "cls", name: "财联社电报" }]), "{}", "r1");
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run("e6", "a6", "cls", "cls", "seed");
  return db;
}

test("重点领域（AI 与新技术）：默认开启，可关闭；一级 id 含其下二级", () => {
  assert.deepEqual(LAYOUT.focus.labels, ["tech", "industry.ai_semis"]);
  assert.deepEqual(normalizeLayout({}).focus.labels, ["tech", "industry.ai_semis"], "旧版式文件没有 focus 也默认开启");
  assert.deepEqual(normalizeLayout({ focus: { labels: [] } }).focus.labels, []);
  assert.ok(inFocus(LAYOUT.focus, ["tech.frontier"]));
  assert.ok(inFocus(LAYOUT.focus, ["industry.ai_semis"]));
  assert.ok(!inFocus(LAYOUT.focus, ["industry.consumer", "politics"]));
  assert.ok(!inFocus(normalizeLayout({ focus: { labels: [] } }).focus, ["tech"]));
});

test("重点领域：挑材料时加分排前，免得被条数上限截掉", () => {
  const db = tmpDbAi();
  const all = gatherItems(db, { since: SINCE, focus: LAYOUT.focus });
  const ai = all.find((x) => x.id === "a6");
  assert.ok(ai.focus);
  assert.ok(all.indexOf(ai) < all.findIndex((x) => x.id === "a4"), "规则 10 分的 AI 新闻加分后排在 20 分的公告前");
  assert.ok(gatherItems(db, { since: SINCE, limit: 4, focus: LAYOUT.focus }).some((x) => x.id === "a6"));
  assert.ok(!gatherItems(db, { since: SINCE, limit: 4 }).some((x) => x.id === "a6"), "不开重点领域时会被截掉");
  db.close();
});

test("重点领域：提示词要求按技术影响力评分、标 ★、头版留位、影响写技术变化", () => {
  const tax = taxonomyIndex(TAX);
  const g = groupPrompt([{ n: 1, title: "新模型发布", source_name: "s", focus: true }, { n: 2, title: "油价上涨", source_name: "t" }], tax, [], [], LAYOUT.focus);
  assert.match(g, /\[1\] ★s/);
  assert.match(g, /\[2\] t/);
  assert.match(g, /按技术影响力评/);
  assert.doesNotMatch(groupPrompt([{ n: 1, title: "x", source_name: "s", focus: true }], tax, [], []), /★|技术影响力/, "不给重点领域时提示词不变");
  const p = planPrompt([{ section: "tech", labels: [], importance: 50, source_count: 1, title: "新模型" }, { section: "politics", labels: [], importance: 80, source_count: 3, title: "会谈" }], LAYOUT);
  assert.match(p, /\[1\] ★tech/);
  assert.match(p, /头版至少放 1 篇/);
  const w = writePrompt([{ story: { title: "新模型", section: "tech", labels: [] }, mats: [{ source_name: "s", title: "t", summary: "x" }], bodies: new Map(), fresh: [] }], LAYOUT);
  assert.match(w, /【报道1】（AI 与新技术）新模型/);
  assert.match(w, /竞争格局/);
});

test("重点领域：头版至少一篇 AI 报道（换掉最后一篇，头条不动）", () => {
  const db = tmpDbAi();
  db.prepare("UPDATE events SET importance = 50 WHERE event_id = 'e6'").run();
  db.prepare("UPDATE events SET importance = 60 WHERE event_id = 'e2'").run();
  const lay = Object.assign({}, LAYOUT, { front: { count: 2 }, sections: LAYOUT.sections.map((s) => Object.assign({}, s, { max: 1 })) });
  const ed = ruleEdition(db, base({ layout: lay }));
  const ai = Object.values(ed.stories).find((s) => s.lead_event_id === "e6");
  assert.equal(ed.front.length, 2);
  assert.equal(ed.stories[ed.front[0]].lead_event_id, "e1", "头条不动");
  assert.equal(ed.front[1], ai.id);
  const off = ruleEdition(db, base({ layout: Object.assign({}, lay, { focus: { name: "", labels: [], boost: 0 } }) }));
  assert.ok(!off.front.includes(Object.values(off.stories).find((s) => s.lead_event_id === "e6").id), "关闭后按重要度");
  db.close();
});

test("重点领域：影响分析优先 AI 报道，门槛低 10 分", () => {
  const ed = { front: ["a", "b"], sections: [], stories: { a: { importance: 75, section: "politics" }, b: { importance: 62, section: "tech" } } };
  const db = { prepare: () => ({ get: () => null }) };
  const isFocus = (s) => inFocus(LAYOUT.focus, [s.section]);
  assert.deepEqual(autoAnalyzeTargets(db, ed, { max: 2, isFocus }), ["b", "a"]);
  assert.deepEqual(autoAnalyzeTargets(db, ed, { max: 2 }), ["a"]);
});

test("断点续写：同一份材料已经写过的稿直接复用，不再让模型重写", async () => {
  const db = tmpDb();
  const first = fakeModel({});
  const a = await llmEdition(db, first.m, base());
  assert.ok(first.calls.some((c) => c.includes("请按版式")), "第一次要写稿");
  // 模拟中断：没存版面就重来一遍
  const again = fakeModel({});
  const b = await llmEdition(db, again.m, base());
  assert.ok(!again.calls.some((c) => c.includes("请按版式")), "第二次不再调用写稿");
  assert.equal(b.stats.cached, a.stats.written);
  const s1 = b.stories[b.front[0]];
  assert.match(s1.lead, /^模型导语/);
  assert.equal(s1.by, "llm");
  db.close();
});

test("模型服务断连：等一会儿重试一次，不直接退回程序稿", async () => {
  const db = tmpDb();
  const fm = fakeModel({ dropOnce: true });
  const ed = await llmEdition(db, fm.m, base({ retryWaitMs: 10 }));
  assert.deepEqual(ed.stats.fallbacks, []);
  assert.ok(ed.stats.errors.some((e) => /Connection error.*重试/.test(e)));
  assert.match(ed.stories[ed.front[0]].lead, /^模型导语/);
  db.close();
});

test("读法：源声明的读法传到报道（程序编排与模型编排都认）", async () => {
  const db = tmpDb();
  db.prepare("UPDATE sources SET profile = 'tech-frontier' WHERE id = 'moe'").run();
  const ed = ruleEdition(db, base());
  assert.equal(Object.values(ed.stories).find((s) => s.lead_event_id === "e2").profile, "tech-frontier", "这篇只有教育部一家，用它声明的读法");
  assert.equal(Object.values(ed.stories).find((s) => s.lead_event_id === "e1").profile, "wire");
  const { m } = fakeModel({});
  const ed2 = await llmEdition(db, m, base());
  assert.equal(Object.values(ed2.stories).find((s) => s.title === "教育部发布留学安全预警").profile, "tech-frontier");
  db.close();
});

test("读法：社区讨论的报道按它的块写稿——社区观点逐条核对、不写影响，标「社区」；稿件沿用时块也在", async () => {
  const db = tmpDb();
  db.prepare("UPDATE sources SET profile = 'community' WHERE id = 'moe'").run();
  db.prepare("UPDATE articles SET comments = '评论：提醒很及时' WHERE id = 'a3'").run();
  const { m, calls } = fakeModel({});
  const ed = await llmEdition(db, m, base());
  const s = Object.values(ed.stories).find((x) => x.title === "教育部发布留学安全预警");
  assert.equal(s.profile, "community");
  assert.equal(s.badge, "社区");
  assert.equal(s.impact, "", "社区读法没有影响块");
  assert.deepEqual(s.views, []);
  assert.deepEqual(s.extra.map((b) => [b.id, b.name, b.items.map((x) => x.text)]), [["debate", "社区观点", ["有评论认为提醒很及时"]]], "编出来的数字整条丢掉");
  const other = Object.values(ed.stories).find((x) => x.title === "沙特利雅得金融区遇袭");
  assert.equal(other.extra, undefined, "新闻读法没有自定义块");
  assert.equal(calls.filter((c) => c.startsWith("请按版式")).length, 2, "不同读法分两批写");
  saveEdition(db, ed, { runId: "r1" });
  const copy = JSON.parse(db.prepare("SELECT copy FROM stories WHERE story_id = ?").get(s.id).copy);
  assert.equal(copy.extra[0].id, "debate");
  const { m: m2 } = fakeModel({});
  const ed2 = await llmEdition(db, m2, base());
  const s2 = ed2.stories[s.id];
  assert.equal(s2.reused, true);
  assert.equal(s2.extra[0].items[0].text, "有评论认为提醒很及时");
  db.close();
});

test("读法：源声明了读法的新闻不做规则分诊，交给模型按读法评分", async () => {
  const db = tmpDb();
  const run = async () => { const { m } = fakeModel({}); return (await llmEdition(db, m, base({ triageBelow: 50 }))).stats.triaged; };
  const before = await run();
  const db2 = tmpDb();
  db2.prepare("UPDATE sources SET profile = 'tech-deep' WHERE id = 'moe'").run();
  const { m } = fakeModel({});
  const after = (await llmEdition(db2, m, base({ triageBelow: 50 }))).stats.triaged;
  assert.equal(after, before - 1, "教育部那条（单源、45 分）声明了读法，不再被分诊");
  db.close(); db2.close();
});
