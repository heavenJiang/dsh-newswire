/* 版面——版式、程序编排、模型编排（假模型）、失败退回、推送选择与消息。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
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
      const refs = (prompt.match(/【报道\d+】/g) || []).length;
      return JSON.stringify({ stories: Array.from({ length: refs }, (_, i) => ({ ref: i + 1, lead: "模型导语" + (i + 1) + "：利雅得金融区周六遇袭。", points: ["要点甲", "要点乙"], views: [{ who: "路透", says: "导弹被拦截" }], impact: "牵动油价" })) });
    }
    return "{}";
  };
  const llm = { stream(opts) { const text = opts.messages[0].content[0].text; calls.push(text.slice(0, 30)); const r = reply(text); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
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
  const saved = saveEdition(db, ed, { runId: "r1" });
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
  assert.equal(msg[0], "📰 要闻 · 11月8日 09:00");
  assert.equal(msg[1], "沙特遇袭牵动地区局势");
  assert.equal(msg[2], "", "条目之间空一行");
  assert.equal(msg[3], "1. 沙特利雅得金融区遇袭");
  assert.match(msg[4], /^模型导语/);
  assert.match(msg[5], /等 2 家 · \d\d:\d\d$/);
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
