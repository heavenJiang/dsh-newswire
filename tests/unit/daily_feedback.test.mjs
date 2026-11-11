/* 日报、读者报错、质量面板、训练导出。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { buildDaily, saveDaily, latestDaily, dailyDates, composeDailyMessage, todayBj, gatherDay } from "../../host/daily.mjs";
import { loadLayout, ruleEdition, llmEdition, saveEdition, latestEdition, storyIdFor, assignments, qualityRows, scrubStory } from "../../host/edition.mjs";
import { exportDataset } from "../../engine/export.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8")).labels;
const LAYOUT = Object.assign(loadLayout(null, path.join(ROOT, "layout.json")), { min_importance: 10 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v15-")), "n.sqlite"));
  for (const [id, name] of [["cls", "财联社电报"], ["ap", "美联社"], ["moe", "教育部"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  return db;
}
function add(db, id, title, summary, src, ev, imp, msAgo) {
  // 默认「10 分钟前」；北京时间刚过零点的那几分钟里要落在今天，不然「今天的日报」里没有它
  const sinceMidnight = (Date.now() + 8 * 3600000) % 86400000;
  const t = iso(msAgo ?? Math.max(1000, Math.min(600000, sinceMidnight - 1000)));
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "https://x/" + id, title, summary, t, t, t, src, "core");
  db.prepare("INSERT OR IGNORE INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors) VALUES (?,?,?,?,?,?,1,1,?,'single',?,?,'{}')").run(ev, "core", title, id, t, t, imp || 60, JSON.stringify(["politics.conflict"]), JSON.stringify([{ source_id: src }]));
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(ev, id, src, src, "seed");
}
const opts = (extra) => Object.assign({ pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});
function llm(handler) {
  const log = [];
  const l = { stream(o) { const p = o.messages[0].content[0].text; log.push(p); const r = handler(p); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => l, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) }), log };
}

function seeded() {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "利雅得金融区遇袭，阿美大楼受损", "cls", "e1", 80);
  add(db, "a2", "教育部发布留学预警", "提醒注意安全", "moe", "e2", 50);
  add(db, "a3", "沙特称摧毁发射装置", "沙特称已摧毁12处发射装置", "ap", "e1", 80);
  saveEdition(db, ruleEdition(db, opts()), {});
  return db;
}

test("日报：程序版——当天有动静的故事线、脉络、数字与消息", async () => {
  const db = seeded();
  const date = todayBj();
  const day = gatherDay(db, { date });
  assert.equal(day.stats.items, 3);
  assert.equal(day.stats.storylines, 2);
  const d = await buildDaily(db, { date, pack: "all", names: {} });
  assert.equal(d.mode, "rules");
  assert.equal(d.stories[0].id, storyIdFor("a1"));
  assert.equal(d.stories[0].items_today, 2);
  const saved = saveDaily(db, d);
  assert.equal(latestDaily(db, "all", date).id, saved.id);
  assert.deepEqual(dailyDates(db, "all").map((x) => x.date), [date]);
  const msg = composeDailyMessage(d, { politics: "时政与地缘" }).split("\n");
  assert.match(msg[0], /^🌙 今日回顾 · \d{1,2}月\d{1,2}日 周.$/);
  const i1 = msg.findIndex((l) => l.startsWith("1."));
  assert.equal(msg[i1], "1. 沙特首都遇袭");
  assert.match(msg[i1 + 2], /^时政与地缘 · 当天 2 篇/);
  assert.match(msg.at(-1), /^今天共收录新闻 3 条，归为 2 件事/);
  db.close();
});

test("日报：模型版——脉络与明日关注经核对，编造的退回程序写的", async () => {
  const db = seeded();
  const { m, log } = llm(() => JSON.stringify({ headline: "沙特遇袭牵动地区局势", arcs: [{ ref: 1, text: "利雅得金融区遇袭后，沙特称已摧毁12处发射装置" }, { ref: 2, text: "教育部预警称已有300人受影响" }], tomorrow: [{ text: "沙特后续行动", refs: [1] }] }));
  const d = await buildDaily(db, { date: todayBj(), names: {}, model: m });
  assert.equal(d.mode, "llm");
  assert.match(log[0], /今日2篇/);
  assert.equal(d.headline, "沙特遇袭牵动地区局势");
  assert.equal(d.stories[0].arc_by, "llm");
  assert.equal(d.stories[1].arc_by, "rules", "300人 找不到，退回程序写的");
  assert.deepEqual(d.tomorrow, [{ text: "沙特后续行动", stories: [storyIdFor("a1")] }]);
  assert.deepEqual(d.stats.check, { checked: 2, passed: 1, dropped: 1 });
  assert.match(composeDailyMessage(d, {}), /由 fake\/m 编写/);
  db.close();
});

test("读者报错：错句立即撤下；重写时告诉模型；重写后报错标为已处理", async () => {
  const db = seeded();
  const sid = storyIdFor("a1");
  const writer = llm((p) => {
    if (p.includes("归为一篇报道")) return JSON.stringify({ stories: [] });
    if (p.includes("headline：一句话总括")) return JSON.stringify({ merge: [], headline: "总括", front: [1], watch: [] });
    if (p.includes("按版式为以下每篇报道写稿")) { const n = (p.match(/【报道\d+】/g) || []).length; return JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ ref: i + 1, lead: "利雅得金融区遇袭，阿美大楼受损。", lead_refs: ["M1"], points: [{ text: "沙特称已摧毁12处发射装置", refs: ["M2"] }], views: [], impact: "" })) }); }
    return "{}";
  });
  // 先编一份模型版面，让故事线有模型稿
  saveEdition(db, await llmEdition(db, writer.m, opts()), {});
  db.prepare("INSERT INTO feedback (at, kind, story_id, text, note) VALUES (?, 'error', ?, '沙特称已摧毁12处发射装置', '应为两处')").run(iso(0), sid);
  // 规则模式：沿用模型稿，但撤下错句
  const ed = ruleEdition(db, opts());
  assert.ok(!ed.stories[sid].points.some((p) => p.text.includes("12处")));
  assert.equal(ed.stories[sid].reported, 1);
  // 模型模式：重写这一篇，提示词带上读者指正；重写后标已处理
  const before = writer.log.length;
  const ed2 = await llmEdition(db, writer.m, opts({ prev: latestEdition(db, "core").content }));
  const prompt = writer.log.slice(before).find((p) => p.includes("按版式"));
  assert.match(prompt, /读者指出这些说法有误，不要再写：『沙特称已摧毁12处发射装置』（应为两处）/);
  saveEdition(db, ed2, {});
  assert.ok(db.prepare("SELECT resolved_at FROM feedback").get().resolved_at);
  db.close();
});

test("读者报错：放错故事线的报道不再归回去（规则模式与自动接上都认）", async () => {
  const db = seeded();
  const sid = storyIdFor("a1");
  db.prepare("INSERT INTO feedback (at, kind, story_id, article_id) VALUES (?, 'misplaced', ?, 'a3')").run(iso(0), sid);
  db.prepare("DELETE FROM story_items WHERE article_id = 'a3'").run();
  const ed = ruleEdition(db, opts());
  assert.deepEqual(ed.stories[sid].article_ids, ["a1"]);
  saveEdition(db, ed, {});
  assert.equal(assignments(db, ["a3"]).get("a3"), undefined, "规则模式不归回");
  const { m } = llm((p) => (p.includes("归为一篇报道") ? JSON.stringify({ stories: [{ items: [Number((p.match(/^\[(\d+)\] [^\n]*摧毁/m) || [])[1])], title: "沙特打击胡塞", section: "politics", labels: [], importance: 60 }] }) : p.includes("headline") ? JSON.stringify({ merge: [], headline: "x", front: [1], watch: [] }) : JSON.stringify({ stories: [] })));
  const ed2 = await llmEdition(db, m, opts());
  assert.equal(ed2.stats.auto_attached, 0, "规则事件同属也不自动接上");
  saveEdition(db, ed2, {});
  assert.notEqual(assignments(db, ["a3"]).get("a3"), sid);
  db.close();
});

test("scrubStory：导语被指出有误时标待核", () => {
  const s = scrubStory({ lead: "错的导语", points: [{ text: "对的" }], views: [{ who: "甲", says: "错的话" }] }, [{ text: "错的导语" }, { text: "甲：错的话" }]);
  assert.deepEqual(s.lead_missing, ["读者指出有误"]);
  assert.deepEqual(s.views, []);
  assert.equal(s.points.length, 1);
});

test("质量面板与训练导出：版面统计、报错数；导出故事线、版面标签、日报、报错", async () => {
  const db = seeded();
  const ed = await buildDaily(db, { date: todayBj(), names: {} });
  saveDaily(db, ed);
  const id = latestEdition(db, "core").id;
  db.prepare("INSERT INTO feedback (at, kind, story_id, edition_id, text) VALUES (?, 'error', ?, ?, 'x')").run(iso(0), storyIdFor("a1"), id);
  const q = qualityRows(db, 5);
  assert.equal(q[0].mode, "rules");
  assert.equal(q[0].reported, 1);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nw-exp-"));
  const r = exportDataset(db, { from: todayBj(), kind: "stories", outDir: out, cfg: { sources: [] }, tax: null });
  const read = (f) => fs.readFileSync(path.join(r.dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const st = read("stories.jsonl");
  assert.equal(st.length, 2);
  assert.equal(st.find((x) => x.story_id === storyIdFor("a1")).feedback.length, 1);
  const eds = read("editions.jsonl");
  assert.ok(eds[0].items.some((x) => x.article_id === "a3" && x.story_id === storyIdFor("a1")));
  assert.equal(read("digests.jsonl")[0].date, todayBj());
  db.close();
});

test("推送带源头热度：阅读最高的一篇的阅读数、评论与级别", async () => {
  const { editionPicks, composeEditionMessage } = await import("../../host/edition.mjs");
  const db = seeded();
  db.prepare("INSERT INTO observations (article_id, run_id, seen_at, views, comments, level) VALUES ('a3', 'r1', ?, 41867, 3, 'B')").run(iso(0));
  const ed = ruleEdition(db, opts());
  const picks = editionPicks(db, ed, { min_corroborated: 50, min_single: 36, max: 8, upgrade_jump: 20 }, { nowIso: iso(0), lookbackHours: 6 });
  const s = picks.find((p) => p.id === storyIdFor("a1"));
  assert.deepEqual(s.heat, { views: 41867, comments: 3, level: "B" });
  const msg = composeEditionMessage({ hhmm: "09:00", md: "11-09", stats: "源", warnings: [], title: "要闻" }, [s], ed, {});
  assert.match(msg, / · 阅读 4\.2万\n/);
  db.close();
});
