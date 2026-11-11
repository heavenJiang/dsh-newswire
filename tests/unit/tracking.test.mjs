/* 追踪——对象、自动挂故事线、建议、增量综述。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { aliasesFor, addTracker, linkStories, linkAll, listTrackers, trackerDetail, synthesize, needsSynthesis, suggestions, synthTargets } from "../../host/tracking.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const ENT = { nvidia: { aliases: ["英伟达", "Nvidia", "NVIDIA"] } };
function db0() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v32-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  return db;
}
function story(db, sid, title, o) {
  const x = Object.assign({ msAgo: 3600000, imp: 50, ents: [], lead: title + "。" }, o || {});
  db.prepare("INSERT INTO stories (story_id, title, section, importance, status, copy, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?, ?)").run(sid, title, "industry", x.imp, JSON.stringify({ lead: x.lead }), iso(x.msAgo), iso(x.msAgo));
  const aid = "a-" + sid;
  db.prepare("INSERT INTO articles (id, url, title, title_zh, source_id, first_seen_at, last_seen_at, published_at) VALUES (?,?,?,?, 'cls', ?, ?, ?)").run(aid, "https://x/" + aid, x.en || title, x.en ? title : null, iso(x.msAgo), iso(x.msAgo), iso(x.msAgo));
  db.prepare("INSERT INTO story_items (article_id, story_id) VALUES (?,?)").run(aid, sid);
  for (const e of x.ents) db.prepare("INSERT INTO story_entities (story_id, name, at) VALUES (?,?,?)").run(sid, e, iso(x.msAgo));
}

test("追踪对象：别名从实体表补齐；按关键主体、别名（含外文报道的中文译名）挂故事线；主线按版面里的主线挂", () => {
  const db = db0();
  assert.deepEqual(aliasesFor("英伟达", [], ENT), ["英伟达", "Nvidia"], "大小写不同算同一个");
  story(db, "s1", "英伟达发布新一代GPU", { ents: ["英伟达"] });
  story(db, "s2", "Nvidia opens probe into CEO", { en: "Nvidia opens probe into CEO" });
  story(db, "s3", "某地暴雨预警");
  story(db, "s4", "伊朗油轮起火");
  story(db, "s5", "美军成立特遣队");
  const id = addTracker(db, { name: "英伟达", kind: "company", ticker: "NVDA", entities: ENT });
  assert.deepEqual(db.prepare("SELECT story_id FROM tracker_stories WHERE tracker_id = ? ORDER BY story_id").all(id).map((r) => r.story_id), ["s1", "s2"]);
  const th = addTracker(db, { name: "伊朗战事", kind: "theme", stories: ["s4"] });
  const added = linkAll(db, [{ name: "伊朗战事", stories: ["s4", "s5"] }]);
  assert.deepEqual(added[th], ["s5"]);
  const list = listTrackers(db);
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === id).ticker, "NVDA");
  assert.equal(list.find((x) => x.id === id).spark.length, 30);
  db.close();
});

test("建议：近 7 天出现在 ≥3 条故事线且在升温的关键主体；版面里的主线；已追踪的不再建议", () => {
  const db = db0();
  for (let i = 0; i < 3; i++) story(db, "n" + i, "固态电池进展" + i, { ents: ["固态电池"], msAgo: 3600000 * (i + 1) });
  for (let i = 0; i < 4; i++) story(db, "o" + i, "旧闻" + i, { ents: ["某老话题"], msAgo: 86400000 * (4 + i), imp: 30 });
  story(db, "x1", "x", { ents: ["某老话题"], msAgo: 3600000, imp: 30 });
  const s = suggestions(db, { themes: [{ name: "中美关税", kind: "policy", stories: ["a", "b"] }] });
  assert.deepEqual(s.map((x) => x.name), ["固态电池", "中美关税"], "老话题在降温、重要度不高，不建议");
  for (let i = 0; i < 3; i++) story(db, "c" + i, "中国相关" + i, { ents: ["中国"], msAgo: 3600000 });
  assert.ok(!suggestions(db, { entities: { china: { aliases: ["中国", "China"], weak: true } } }).some((x) => x.name === "中国"), "太泛的实体不建议");
  addTracker(db, { name: "固态电池", kind: "technology" });
  assert.ok(!suggestions(db, {}).some((x) => x.name === "固态电池"));
  db.close();
});

function fake(reply) {
  const prompts = [];
  const llm = { stream(o) { prompts.push(o.messages[0].content[0].text); const r = reply(prompts.length); return (async function* () { yield { type: "text-delta", text: JSON.stringify(r) }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), prompts };
}

test("综述：首次给全部近况；之后增量——只给上次综述与新动态；编造数字的条目删掉；新动态够了才需要重写", async () => {
  const db = db0();
  story(db, "s1", "英伟达发布Rubin平台", { ents: ["英伟达"], msAgo: 5 * 86400000, lead: "英伟达发布Rubin平台，算力提升3倍。" });
  story(db, "s2", "英伟达与多家云厂商签约", { ents: ["英伟达"], msAgo: 3 * 86400000, lead: "英伟达与多家云厂商签署供货协议。" });
  const id = addTracker(db, { name: "英伟达", kind: "company", ticker: "NVDA", entities: ENT });
  assert.equal(needsSynthesis(db, id), 2, "还没有综述：要写，返回动态篇数");
  const { m, prompts } = fake((n) => n === 1
    ? { state: "英伟达持续推出新平台", trend: "新品节奏加快，算力提升3倍", milestones: [{ date: "11-04", text: "发布Rubin平台" }],
        implications: [{ area: "股价", target: "英伟达", ticker: "NVDA", direction: "利好", why: "新平台巩固领先", confidence: "中" }, { area: "行业", target: "云厂商", direction: "利好", why: "采购额将增长80%", confidence: "高" }],
        outlook: [{ name: "基准", likelihood: "高", what: "新品按期交付", signals: "云厂商追加订单" }], watch: ["下一代产品发布"], changed: "" }
    : { state: "英伟达新品与合作并进", trend: "合作扩大", milestones: [], implications: [], outlook: [], watch: [], changed: "新增与云厂商的合作" });
  const a = await synthesize(db, m, id, { model: "f/m" });
  assert.equal(a.implications.length, 1, "「增长80%」材料里没有，删掉");
  assert.equal(a.dropped, 1);
  assert.equal(a.changed, "首次综述");
  assert.match(prompts[0], /近来的动态/);
  assert.equal(needsSynthesis(db, id), 0);
  await new Promise((r) => setTimeout(r, 1100)); // 库里的时间精确到秒
  story(db, "s3", "英伟达CEO黄仁勋被调查", { ents: ["英伟达"], msAgo: 600000, imp: 75 });
  linkStories(db, id, { days: 1 });
  // 间隔：离上次不到 2 小时不写；不到间隔（默认 6 小时）只有重要度 ≥ 80 的才写；过了间隔照旧（≥2 篇或有 ≥70 的）
  const H = 3600000;
  assert.equal(needsSynthesis(db, id), 0, "刚写过");
  assert.equal(needsSynthesis(db, id, { now: Date.now() + 3 * H }), 0, "3 小时：重要度 75 还不够");
  assert.equal(needsSynthesis(db, id, { now: Date.now() + 3 * H, gapHours: 2 }), 1, "间隔调小就写");
  assert.equal(needsSynthesis(db, id, { now: Date.now() + 7 * H }), 1, "过了间隔：有重要度 ≥70 的新动态");
  assert.deepEqual(synthTargets(db, 2), []);
  assert.deepEqual(synthTargets(db, 2, { now: Date.now() + 7 * H }), [id]);
  const b = await synthesize(db, m, id, { model: "f/m" });
  assert.equal(b.incremental, true);
  assert.match(prompts[1], /上次综述（/);
  assert.match(prompts[1], /上次综述之后的新动态[\s\S]*英伟达CEO黄仁勋被调查/);
  assert.match(prompts[1], /更早的动态（只列标题）[\s\S]*Rubin/, "旧动态只给标题");
  assert.equal(b.changed, "新增与云厂商的合作");
  const d = trackerDetail(db, id);
  assert.equal(d.timeline.length, 3);
  assert.equal(d.synthesis.state, "英伟达新品与合作并进");
  db.close();
});

test("新动态按「有新报道加入」算，不按版面刷新的时间；主线只有一篇重叠时不整条挂过来", async () => {
  const db = db0();
  story(db, "s1", "英伟达发布Rubin平台", { ents: ["英伟达"], msAgo: 5 * 86400000 });
  const id = addTracker(db, { name: "英伟达", kind: "company", entities: ENT });
  db.prepare("INSERT INTO tracker_syntheses (tracker_id, at, content) VALUES (?, datetime('now', '-1 hour'), '{}')").run(id);
  // 版面把故事线刷了一遍（updated_at = 现在），但没有新报道
  db.prepare("UPDATE stories SET updated_at = datetime('now')").run();
  db.prepare("UPDATE tracker_stories SET linked_at = datetime('now', '-2 days')").run();
  assert.equal(listTrackers(db).find((x) => x.id === id).fresh, 0, "只是被版面刷新：不算新动态");
  assert.equal(needsSynthesis(db, id, { now: Date.now() + 9 * 3600000 }), 0);
  // 真有新报道加入
  db.prepare("INSERT INTO articles (id, url, title, source_id) VALUES ('n1','https://x/n1','英伟达新报道','cls')").run();
  db.prepare("INSERT INTO story_items (article_id, story_id, joined_at) VALUES ('n1','s1', datetime('now'))").run();
  assert.equal(listTrackers(db).find((x) => x.id === id).fresh, 1);

  // 主线：版面里的另一条主线只和它重叠一篇 → 不认；重叠过半（且 ≥2 篇）→ 认
  const th = addTracker(db, { name: "AI 算力", kind: "theme", entities: ENT });
  for (const k of ["a", "b", "c", "d"]) story(db, "t" + k, "无关报道" + k, { msAgo: 3600000 });
  db.prepare("INSERT INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?, 'ta', datetime('now'), 'manual')").run(th);
  assert.deepEqual(linkStories(db, th, { days: 1, themes: [{ name: "别的主线", stories: ["ta", "tb", "tc", "td"] }] }), [], "只重叠一篇：不挂");
  db.prepare("INSERT INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?, 'tb', datetime('now'), 'manual')").run(th);
  assert.deepEqual(linkStories(db, th, { days: 1, themes: [{ name: "别的主线", stories: ["ta", "tb", "tc", "td"] }] }).sort(), ["tc", "td"], "重叠一半：整条挂上");
  // 名字相近也算同一条主线；核心主体（一半以上已挂的故事线都有）带来新故事线
  story(db, "te", "又一篇", { msAgo: 3600000 });
  assert.deepEqual(linkStories(db, th, { days: 1, themes: [{ name: "AI 算力扩张", stories: ["te"] }] }), ["te"], "名字相近");
  const nv = addTracker(db, { name: "英伟达风波", kind: "theme", entities: {}, stories: [] });
  story(db, "n1", "黄仁勋被调查", { ents: ["英伟达", "黄仁勋"], msAgo: 3600000 });
  story(db, "n2", "英伟达股价大跌", { ents: ["英伟达"], msAgo: 3600000 });
  story(db, "n3", "英伟达回应质疑", { ents: ["英伟达"], msAgo: 1800000 });
  story(db, "n4", "苹果发布新机", { ents: ["苹果"], msAgo: 1800000 });
  const seed = db.prepare("INSERT OR IGNORE INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?,?, datetime('now'), 'theme')");
  seed.run(nv, "n1"); seed.run(nv, "n2");
  assert.deepEqual(linkStories(db, nv, { days: 1, themes: [] }).filter((x) => x !== "s1").sort(), ["n3"], "带核心主体「英伟达」的挂上，不相干的不挂");
  db.close();
});

test("一次性修复：摘掉按旧规则挂到主线上的故事线；建立时带的、按别名认的、读者摘掉的不动", async () => {
  const { repairThemeLinks } = await import("../../host/tracking.mjs");
  const db = db0();
  for (const k of ["a", "b", "c", "d"]) story(db, "r" + k, "报道" + k, { msAgo: 3600000 });
  const id = addTracker(db, { name: "某主线", kind: "theme", entities: ENT, stories: ["ra"] });
  const ins = db.prepare("INSERT OR REPLACE INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?,?, datetime('now', '+1 hour'), ?)");
  ins.run(id, "rb", "theme"); ins.run(id, "rc", "alias"); ins.run(id, "rd", "banned");
  assert.equal(repairThemeLinks(db), 1);
  assert.deepEqual(db.prepare("SELECT story_id, how FROM tracker_stories WHERE tracker_id = ? ORDER BY story_id").all(id).map((x) => x.story_id + ":" + x.how), ["ra:theme", "rc:alias", "rd:banned"]);
  assert.equal(repairThemeLinks(db), 0);
  db.close();
});

test("主线的检索关键词：从名字里拆，泛词和太常见的词不要；有了关键词，标题带它的新报道就挂得上", async () => {
  const { nameKeywords, keywordOk, ensureThemeKeywords } = await import("../../host/tracking.mjs");
  assert.deepEqual(nameKeywords("英伟达风波"), ["英伟达"]);
  assert.deepEqual(nameKeywords("AI与数据中心"), ["数据中心"], "两个字母的英文太短，不当关键词");
  assert.deepEqual(nameKeywords("中东局势、油价"), ["中东", "油价"]);
  const db = db0();
  assert.equal(keywordOk(db, "AI"), false, "泛词");
  assert.equal(keywordOk(db, "市"), false, "太短");
  assert.equal(keywordOk(db, "数据中心"), true);
  // 太常见：60 条故事线里 10 条标题都有它（超过 6%）
  for (let i = 0; i < 60; i++) story(db, "c" + i, (i < 10 ? "芯片" : "别的") + "新闻" + i, { msAgo: 3600000 });
  assert.equal(keywordOk(db, "芯片"), false);
  assert.equal(keywordOk(db, "数据中心"), true);

  const id = addTracker(db, { name: "AI与数据中心", kind: "theme", entities: ENT, stories: [] });
  assert.deepEqual(JSON.parse(db.prepare("SELECT aliases FROM trackers WHERE id = ?").get(id).aliases), ["数据中心"], "建立时就拆好");
  assert.deepEqual(ensureThemeKeywords(db, id), [], "已有关键词的不动");
  story(db, "dc1", "美参议员拟提数据中心征税草案", { msAgo: 600000 });
  story(db, "dc2", "苹果发布新机", { msAgo: 600000 });
  assert.deepEqual(linkStories(db, id, { days: 1, themes: [] }), ["dc1"]);
  // 老的主线没有关键词：每轮挂故事线前补上
  db.prepare("UPDATE trackers SET aliases = '[]' WHERE id = ?").run(id);
  story(db, "dc3", "某地数据中心用电创新高", { msAgo: 300000 });
  assert.deepEqual(linkAll(db, [])[id], ["dc3"]);
  db.close();
});
