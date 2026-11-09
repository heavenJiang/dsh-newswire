/* 编排提速——分诊、头版先写、边写边出。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { normalizeFollows } from "../../host/follows.mjs";
import { loadLayout, llmEdition, saveEdition, updateEditionContent, latestEdition } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8")).labels;
const LAYOUT = Object.assign(loadLayout(null, path.join(CFG, "layout.json")), { min_importance: 10 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v22-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  return db;
}
function add(db, id, title, imp) {
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES (?,?,?,?,?,?,?,?,'core','full')").run(id, "https://x/" + id, title, title + "的摘要", "cls", t, t, t);
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets) VALUES (?,?,?,?,?,?,1,1,?,'single',?,?)").run("e" + id, "core", title, id, t, t, imp, JSON.stringify(["politics.conflict"]), JSON.stringify([{ source_id: "cls" }]));
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run("e" + id, id, "cls", "cls", "seed");
}
function fake() {
  const log = { group: [], write: [] };
  const llm = { stream(o) {
    const p = o.messages[0].content[0].text;
    let r = "{}";
    if (p.includes("归为一篇报道")) {
      log.group.push(p);
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜([^｜\n]*)/gm)];
      r = JSON.stringify({ stories: lines.map((m) => ({ items: [Number(m[1])], title: m[2].slice(0, 20), section: "politics", labels: [], importance: m[2].includes("头条") ? 90 : 50 })) });
    } else if (p.includes("headline：一句话总括")) {
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜[^｜]*｜(.*)$/gm)];
      const top = lines.find((m) => m[2].includes("头条"));
      r = JSON.stringify({ merge: [], headline: "总括", front: top ? [Number(top[1])] : [], watch: [] });
    } else if (p.includes("按版式为以下每篇报道写稿")) {
      log.write.push(p);
      const n = (p.match(/【报道\d+】/g) || []).length;
      r = JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ ref: i + 1, lead: "导语。", lead_refs: ["M1"], points: [], views: [], impact: "" })) });
    }
    return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })();
  } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), log };
}
const opts = (extra) => Object.assign({ pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});

test("分诊：规则分低、只有一家报道的不交给模型；关注命中的照样交给模型", async () => {
  const db = tmpDb();
  add(db, "a1", "伊朗局势头条", 70);
  add(db, "a2", "某地小区停水通知", 5);
  add(db, "a3", "英伟达发布小更新", 8);
  const { m, log } = fake();
  const ed = await llmEdition(db, m, opts({ follows: normalizeFollows({ follow: [{ kind: "keyword", value: "英伟达" }] }) }));
  assert.equal(ed.stats.triaged, 1);
  assert.ok(!log.group[0].includes("小区停水"), "低分单源的不送模型");
  assert.ok(log.group[0].includes("英伟达"), "关注命中的照样送模型");
  db.close();
});

test("头版先写；归并统筹完先出一版（全是程序稿），每写完一批再更新", async () => {
  const db = tmpDb();
  for (let i = 0; i < 7; i++) add(db, "b" + i, "普通新闻" + i, 40 + i);
  add(db, "top", "今天的头条事件", 30);
  const { m, log } = fake();
  const snaps = [];
  const ed = await llmEdition(db, m, opts({ onProgress: (s) => snaps.push(s) }));
  assert.match(log.write[0], /【报道1】今天的头条/, "头版那篇最先写");
  assert.ok(snaps.length >= 2);
  assert.equal(snaps[0].stats.partial, true);
  assert.equal(snaps[0].stats.written, 0);
  assert.ok(Object.values(snaps[0].stories).every((s) => s.by !== "llm"), "第一版全是程序稿");
  assert.ok(snaps.at(-1).stats.written > 0);
  assert.ok(!ed.stats.partial, "正式版不带进度标记");
  // 进度版落库：同一行更新
  const first = saveEdition(db, snaps[0], {});
  updateEditionContent(db, first.id, snaps.at(-1));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM editions").get().n, 1);
  assert.equal(latestEdition(db, "core").content.stats.written, snaps.at(-1).stats.written);
  db.close();
});

test("按规则事件折叠：同一事件的几篇只给模型看一行，归并后整组展开到同一篇报道", async () => {
  const db = tmpDb();
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('ap','美联社','ap')").run();
  add(db, "c1", "沙特首都遇袭", 60);
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES ('c2','https://x/c2','利雅得遭导弹袭击','', 'ap', ?, ?, ?, 'core','full')").run(t, t, t);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('ec1','c2','ap','ap','title')").run();
  add(db, "c3", "某地发布暴雨预警", 40);
  const { m, log } = fake();
  const ed = await llmEdition(db, m, opts());
  assert.equal(ed.stats.units, 2);
  assert.match(log.group[0], /沙特首都遇袭｜沙特首都遇袭的摘要（同一事件另有 1 篇：美联社）/);
  assert.ok(!log.group[0].includes("利雅得遭导弹袭击"), "同事件的另一篇不单独送");
  const s = Object.values(ed.stories).find((x) => (x.article_ids || []).includes("c1"));
  assert.ok(s.article_ids.includes("c2"), "展开回同一篇报道");
  db.close();
});

test("程序稿：导语去掉【标题】与「某社某日电」套话；与导语说法差不多的标题不当要点；总括用头条标题", async () => {
  const { cleanLead, ruleEdition } = await import("../../host/edition.mjs");
  assert.equal(cleanLead("【国务院关税税则委员会关于调整措施的公告】财联社11月9日电，为落实共识，决定继续暂停加征关税。"), "为落实共识，决定继续暂停加征关税。");
  assert.equal(cleanLead("新华社北京11月8日电 国家主席习近平出席会议。"), "国家主席习近平出席会议。");
  const db = tmpDb();
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('ws','华尔街见闻','ws')").run();
  add(db, "r1", "国务院关税税则委员会：2个月内继续暂停实施24%的对美加征关税税率", 70);
  db.prepare("UPDATE articles SET summary = '财联社11月9日电，国务院关税税则委员会决定在2个月内继续暂停实施24%的对美加征关税税率，保留10%的税率。' WHERE id = 'r1'").run();
  const t = iso(3500000);
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES ('r2','https://x/r2','国务院关税税则委员会：在2个月内继续暂停实施24%的对美加征关税税率','', 'ws', ?, ?, ?, 'core','full')").run(t, t, t);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('er1','r2','ws','ws','title')").run();
  const ed = ruleEdition(db, opts());
  const s = Object.values(ed.stories)[0];
  assert.match(s.lead, /^国务院关税税则委员会决定/);
  assert.equal(s.points.length, 0, "另一家的标题只差几个字，不当要点");
  assert.equal(ed.headline, "国务院关税税则委员会：2个月内继续暂停实施24%的对美加征关税税率");
  db.close();
});
