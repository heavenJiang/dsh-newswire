/* 故事线——跨版面延续、增量归并、沿用稿件与统筹、合并、规则模式沿用、按故事线去重推送。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { loadLayout, ruleEdition, llmEdition, saveEdition, latestEdition, editionPicks, recordEditionPushes, assignments, storyIdFor } from "../../host/edition.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8")).labels;
const LAYOUT = loadLayout(null, path.join(ROOT, "layout.json"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const SINCE = iso(12 * 3600000);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v11-")), "n.sqlite"));
  for (const [id, name] of [["cls", "财联社电报"], ["reuters", "路透·World"], ["moe", "教育部"], ["ap", "美联社"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  return db;
}
function addArticle(db, id, title, source, ev, imp) {
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "https://x/" + id, title, title + "的摘要", t, t, t, source, "core");
  if (ev) {
    db.prepare("INSERT OR IGNORE INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors) VALUES (?,?,?,?,?,?,1,1,?,?,?,?,?)").run(ev, "core", title, id, t, t, imp || 40, "single", JSON.stringify(["politics.conflict"]), "[]", "{}");
    db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(ev, id, source, source, "seed");
  }
}

/** 假模型：归并时按标题关键词——含「沙特」的归一篇（有已有报道「沙特」就归入它），其余各成一篇。 */
function fakeModel() {
  const log = { group: 0, plan: 0, write: 0, prompts: [] };
  const reply = (p) => {
    if (p.includes("归为一篇报道")) {
      log.group++; log.prompts.push(p);
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜([^｜\n]*)/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
      const known = [...p.matchAll(/^\[S(\d+)\] [^｜]*｜(.*)$/gm)].map((m) => ({ s: "S" + m[1], title: m[2] }));
      const saudiKnown = known.find((k) => k.title.includes("沙特"));
      const saudi = lines.filter((l) => l.title.includes("沙特"));
      const others = lines.filter((l) => !l.title.includes("沙特"));
      const stories = [];
      if (saudi.length) stories.push(saudiKnown ? { items: saudi.map((l) => l.n), story: saudiKnown.s, importance: 90 } : { items: saudi.map((l) => l.n), title: "沙特利雅得遇袭", section: "politics", labels: ["politics.conflict"], importance: 85 });
      for (const l of others) stories.push({ items: [l.n], title: "报道·" + l.title.slice(0, 10), section: "politics", labels: ["politics.conflict"], importance: 50 });
      return JSON.stringify({ stories });
    }
    if (p.includes("headline：一句话总括")) { log.plan++; return JSON.stringify({ merge: log.mergeNext || [], headline: "总括" + log.plan, front: [1], watch: [] }); }
    if (p.includes("按版式为以下每篇报道写稿")) { log.write++; const n = (p.match(/【报道\d+】/g) || []).length; return JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ ref: i + 1, lead: "第" + log.write + "次写的导语" + (i + 1) + "，说明何事。", points: [], views: [], impact: "" })) }); }
    return "{}";
  };
  const llm = { stream(o) { const r = reply(o.messages[0].content[0].text); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) }), log };
}

const opts = (extra) => Object.assign({ pack: "core", since: SINCE, hours: 12, layout: Object.assign({}, LAYOUT, { min_importance: 10 }), names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});
async function edition(db, m) {
  const prev = latestEdition(db, "core");
  const ed = await llmEdition(db, m, opts({ prev: prev && prev.mode === "llm" ? prev.content : null }));
  const saved = saveEdition(db, ed, {});
  return Object.assign(ed, { id: saved.id });
}

test("故事线：第一份版面登记故事线；没有新新闻时零调用（沿用归并、统筹、稿件）", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a2", "Saudi 沙特 Aramco building damaged", "reuters", "e2", 60);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  const { m, log } = fakeModel();
  const ed1 = await edition(db, m);
  const sid = storyIdFor("a1");
  assert.ok(ed1.stories[sid], "故事线 id 由首条新闻决定");
  assert.equal(ed1.stories[sid].is_new, true);
  assert.deepEqual([...assignments(db, ["a1", "a2"]).values()], [sid, sid]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stories").get().n, 2);
  const before = { ...log };
  const ed2 = await edition(db, m);
  assert.equal(log.group, before.group, "没有新新闻不归并");
  assert.equal(log.plan, before.plan, "沿用统筹");
  assert.equal(log.write, before.write, "沿用稿件");
  assert.equal(ed2.stats.calls, 0);
  assert.equal(ed2.headline, ed1.headline);
  assert.equal(ed2.stories[sid].reused, true);
  assert.equal(ed2.stories[sid].is_new, false);
  assert.equal(ed2.stories[sid].updated, false);
  db.close();
});

test("增量：新新闻归入已有故事线（模型看到已有报道），只重写这一篇；其余沿用", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const { m, log } = fakeModel();
  await edition(db, m);
  addArticle(db, "a4", "沙特称已摧毁胡塞导弹发射装置", "ap", "e4", 70);
  const writes = log.write;
  const ed = await edition(db, m);
  const sid = storyIdFor("a1");
  assert.match(log.prompts.at(-1), /已有报道（编号｜版块｜标题）：\n\[S\d+\] politics｜沙特利雅得遇袭/);
  assert.ok(!/教育部发布留学预警（/.test(log.prompts.at(-1).split("以下是新抓到的新闻")[1] || ""), "已归入的新闻不再交给模型");
  assert.equal(assignments(db, ["a4"]).get("a4"), sid);
  assert.equal(ed.stories[sid].updated, true);
  assert.equal(ed.stories[sid].importance, 90, "已有故事线可更新重要度");
  assert.equal(ed.stories[sid].source_count, 2);
  assert.match(ed.stories[sid].lead, new RegExp("第" + (writes + 1) + "次写"), "有新报道的重写");
  const other = Object.values(ed.stories).find((s) => s.id !== sid);
  assert.equal(other.reused, true, "没变的沿用");
  assert.equal(ed.stats.fresh_items, 1);
  db.close();
});

test("合并：统筹合并两条已有故事线时并入已有的一条，另一条退役、新闻搬过去", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const { m, log } = fakeModel();
  await edition(db, m);
  addArticle(db, "a5", "另一条新闻", "ap", "e5", 30);
  log.mergeNext = [[1, 2]];
  const ed = await edition(db, m);
  const retired = db.prepare("SELECT story_id, merged_into FROM stories WHERE status = 'merged'").all();
  assert.equal(retired.length, 1);
  const head = retired[0].merged_into;
  assert.ok(ed.stories[head]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_items WHERE story_id = ?").get(retired[0].story_id).n, 0);
  db.close();
});

test("规则模式沿用模型的故事线：标题和没变的稿照用；新事件新起故事线", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const { m } = fakeModel();
  await edition(db, m);
  addArticle(db, "a6", "新的规则事件", "ap", "e6", 50);
  const ed = ruleEdition(db, opts());
  saveEdition(db, ed, {});
  const s1 = ed.stories[storyIdFor("a1")];
  assert.equal(s1.title, "沙特利雅得遇袭");
  assert.equal(s1.by, "llm");
  assert.equal(s1.reused, true);
  const s6 = ed.stories[storyIdFor("a6")];
  assert.equal(s6.is_new, true);
  assert.equal(s6.by, "rules");
  assert.equal(assignments(db, ["a6"]).get("a6"), storyIdFor("a6"));
  assert.equal(db.prepare("SELECT title FROM stories WHERE story_id = ?").get(storyIdFor("a1")).title, "沙特利雅得遇袭", "规则模式不改模型起的标题");
  db.close();
});

test("推送按故事线去重：推过的故事线换了规则事件也不重推", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a2", "Saudi 沙特 Aramco building damaged", "reuters", "e2", 60);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const { m } = fakeModel();
  const ed = await edition(db, m);
  const rules = { min_corroborated: 50, min_single: 36, max: 8, upgrade_jump: 20 };
  const nowIso = iso(0);
  const picks = editionPicks(db, ed, rules, { nowIso, lookbackHours: 6 });
  assert.ok(picks.some((p) => p.id === storyIdFor("a1")));
  recordEditionPushes(db, picks, "r1", nowIso, "core");
  assert.deepEqual(db.prepare("SELECT story_id FROM pushes ORDER BY id").all().map((r) => r.story_id), picks.map((p) => p.id));
  const again = await edition(db, m);
  assert.equal(editionPicks(db, again, rules, { nowIso, lookbackHours: 6 }).length, 0);
  db.close();
});

test("模型失败时按规则临时归并的新故事线不登记；退回规则的统筹不沿用", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const bad = { stream() { return (async function* () { yield { type: "text-delta", text: "坏" }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  const m = createModel({ getLlm: () => bad, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) });
  const ed = await edition(db, m);
  assert.ok(ed.stats.fallbacks.includes("plan"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_items").get().n, 0, "临时归并不登记");
  const { m: good, log } = fakeModel();
  await edition(db, good);
  assert.equal(log.group, 1, "这些新闻重新交给模型");
  assert.equal(log.plan, 1, "不沿用退回规则的统筹");
  db.close();
});

test("同一规则事件的新报道直接接上故事线，不问模型", async () => {
  const db = tmpDb();
  addArticle(db, "a1", "沙特首都金融区遭袭", "cls", "e1", 80);
  addArticle(db, "a3", "教育部发布留学预警", "moe", "e3", 45);
  addArticle(db, "a9", "某公司发布公告", "cls", "e9", 20);
  const { m, log } = fakeModel();
  await edition(db, m);
  const t = iso(1800000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run("a7", "https://x/a7", "教育部预警续报", "", t, t, t, "ap", "core");
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('e3','a7','ap','ap','title')").run();
  const groups = log.group;
  const ed = await edition(db, m);
  assert.equal(log.group, groups, "不调用归并");
  assert.equal(ed.stats.auto_attached, 1);
  assert.equal(assignments(db, ["a7"]).get("a7"), storyIdFor("a3"));
  assert.equal(ed.stories[storyIdFor("a3")].updated, true);
  db.close();
});
