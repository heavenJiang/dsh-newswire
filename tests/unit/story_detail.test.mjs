/* 故事线进展、详情、自上次查看、即时重新组版。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { normalizeFollows } from "../../host/follows.mjs";
import { loadLayout, llmEdition, ruleEdition, saveEdition, latestEdition, storyIdFor, storyDetail, sinceSeen, reassemble, composeEditionMessage, recordEditionPushes, editionPicks } from "../../host/edition.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8")).labels;
const LAYOUT = Object.assign(loadLayout(null, path.join(ROOT, "layout.json")), { min_importance: 10 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v14-")), "n.sqlite"));
  for (const [id, name] of [["cls", "财联社电报"], ["ap", "美联社"], ["moe", "教育部"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  return db;
}
function add(db, id, title, summary, src, ev, msAgo) {
  const t = iso(msAgo || 3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "https://x/" + id, title, summary, t, t, t, src, "core");
  db.prepare("INSERT OR IGNORE INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors) VALUES (?,?,?,?,?,?,1,1,60,'single',?,?,'{}')").run(ev, "core", title, id, t, t, JSON.stringify(["politics.conflict"]), JSON.stringify([{ source_id: src }]));
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(ev, id, src, src, "seed");
}
function fakeModel(updateText) {
  const log = { writes: [] };
  const reply = (p) => {
    if (p.includes("归为一篇报道")) {
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜([^｜\n]*)/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
      const known = [...p.matchAll(/^\[S(\d+)\] [^｜]*｜(.*)$/gm)].map((m) => ({ s: "S" + m[1], title: m[2] }));
      const k = known.find((x) => x.title.includes("沙特"));
      const saudi = lines.filter((l) => l.title.includes("沙特"));
      const rest = lines.filter((l) => !l.title.includes("沙特"));
      return JSON.stringify({ stories: (saudi.length ? [k ? { items: saudi.map((l) => l.n), story: k.s } : { items: saudi.map((l) => l.n), title: "沙特遇袭", section: "politics", labels: ["politics.conflict"], importance: 80 }] : []).concat(rest.map((l) => ({ items: [l.n], title: l.title, section: "politics", labels: [], importance: 40 }))) });
    }
    if (p.includes("headline：一句话总括")) return JSON.stringify({ merge: [], headline: "总括", front: [1], watch: [] });
    if (p.includes("按版式为以下每篇报道写稿")) {
      log.writes.push(p);
      const n = (p.match(/【报道\d+】/g) || []).length;
      return JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ ref: i + 1, lead: "利雅得遇袭，阿美大楼受损。", lead_refs: ["M1"], points: [], views: [], impact: "", update: updateText })) });
    }
    return "{}";
  };
  const llm = { stream(o) { const r = reply(o.messages[0].content[0].text); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) }), log };
}
const opts = (extra) => Object.assign({ pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});
async function edition(db, m, extra) {
  const prev = latestEdition(db, "core");
  const ed = await llmEdition(db, m, opts(Object.assign({ prev: prev && prev.mode === "llm" ? prev.content : null }, extra)));
  const saved = saveEdition(db, ed, {});
  return Object.assign(ed, { id: saved.id });
}

test("进展：有新报道的故事线，模型看到上次导语与新材料，写一句进展（经核对）并存档；推送写「进展」", async () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "利雅得金融区遇袭，阿美大楼受损", "cls", "e1", 7200000);
  add(db, "a3", "教育部发布留学预警", "提醒注意安全", "moe", "e3");
  add(db, "a9", "某公司公告", "公告", "cls", "e9");
  const { m, log } = fakeModel("沙特称已摧毁12处发射装置");
  const ed1 = await edition(db, m);
  const sid = storyIdFor("a1");
  recordEditionPushes(db, [Object.assign({ reason: "new" }, ed1.stories[sid])], "r1", iso(0), "core");
  add(db, "a4", "沙特称摧毁胡塞发射装置", "沙特称已摧毁12处发射装置", "ap", "e4", 600000);
  const ed2 = await edition(db, m);
  const prompt = log.writes.at(-1);
  assert.match(prompt, /上次导语：利雅得遇袭，阿美大楼受损。\n本次新增材料：M1/);
  assert.match(prompt, /\[M1\] 美联社｜/, "新材料排在前面");
  const s = ed2.stories[sid];
  assert.equal(s.update_text, "沙特称已摧毁12处发射装置");
  assert.equal(s.update_by, "llm");
  const ups = db.prepare("SELECT text, items, by FROM story_updates WHERE story_id = ?").all(sid).map((r) => ({ ...r }));
  assert.deepEqual(ups, [{ text: "沙特称已摧毁12处发射装置", items: 1, by: "llm" }]);
  const msg = composeEditionMessage({ hhmm: "11:00", md: "11-09", stats: "源", warnings: [], title: "要闻" }, [Object.assign({}, s, { reason: "jumped" })], ed2, {});
  assert.match(msg, /\n进展：沙特称已摧毁12处发射装置\n/);
  db.close();
});

test("进展核对不过就退回程序写的「新增 n 篇」", async () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "利雅得金融区遇袭", "cls", "e1", 7200000);
  add(db, "a3", "教育部发布留学预警", "提醒注意安全", "moe", "e3");
  add(db, "a9", "某公司公告", "公告", "cls", "e9");
  const { m } = fakeModel("沙特称已摧毁99处发射装置");
  await edition(db, m);
  add(db, "a4", "沙特称摧毁胡塞发射装置", "沙特称已摧毁12处发射装置", "ap", "e4", 600000);
  const ed = await edition(db, m);
  const s = ed.stories[storyIdFor("a1")];
  assert.equal(s.update_by, "rules");
  assert.equal(s.update_text, "新增 1 篇：沙特称摧毁胡塞发射装置（美联社）");
  db.close();
});

test("规则模式也记进展；故事线详情含报道、进展、推送；被并入的跟到并入者", () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "利雅得金融区遇袭", "cls", "e1", 7200000);
  saveEdition(db, ruleEdition(db, opts()), {});
  const t = iso(600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES ('a5','https://x/a5','沙特遇袭续报','',?,?,?,'ap','core')").run(t, t, t);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('e1','a5','ap','ap','title')").run();
  const ed = ruleEdition(db, opts());
  saveEdition(db, ed, {});
  const sid = storyIdFor("a1");
  assert.equal(ed.stories[sid].update_text, "新增 1 篇：沙特遇袭续报（美联社）");
  db.prepare("INSERT INTO stories (story_id, title, status, merged_into) VALUES ('st-old', '旧', 'merged', ?)").run(sid);
  const d = storyDetail(db, "st-old");
  assert.equal(d.id, sid);
  assert.deepEqual(d.items.map((x) => x.id), ["a1", "a5"]);
  assert.equal(d.updates.length, 1);
  assert.deepEqual(d.merged.map((x) => x.story_id), ["st-old"]);
  assert.equal(storyDetail(db, "st-none"), null);
  db.close();
});

test("自上次查看以来：新起的故事线与新增篇数", () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "x", "cls", "e1", 7200000);
  saveEdition(db, ruleEdition(db, opts()), {});
  const seen = "2000-01-01 00:00:00";
  const sid = storyIdFor("a1");
  assert.deepEqual(sinceSeen(db, [sid], seen), { [sid]: { added: 1, new: true } });
  assert.deepEqual(sinceSeen(db, [sid], "2999-01-01 00:00:00"), {});
  assert.deepEqual(sinceSeen(db, [sid], null), {});
  db.close();
});

test("即时重新组版：改关注后按上一份版面重排，不调用模型", () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "利雅得金融区遇袭", "cls", "e1");
  add(db, "a3", "教育部发布留学预警", "提醒注意安全", "moe", "e3");
  const ed = ruleEdition(db, opts());
  const re = reassemble(ed, { follows: normalizeFollows({ follow: [{ kind: "keyword", value: "留学" }], mute: [{ kind: "keyword", value: "沙特" }] }), layout: LAYOUT, names: {} });
  assert.equal(re.sections[0].id, "following");
  assert.deepEqual(re.sections[0].stories, [storyIdFor("a3")]);
  assert.ok(!re.stories[storyIdFor("a1")], "屏蔽的去掉");
  assert.equal(re.stats.reassembled, true);
  saveEdition(db, re, {});
  assert.equal(latestEdition(db, "core").content.sections[0].id, "following");
  db.close();
});
