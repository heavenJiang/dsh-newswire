/* 细节：故事线详情带每篇原文；材料多的报道要点放宽；详细报道的材料、提示词、逐句核对与存档。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { storyDetail, bodiesFor, richSpec, writePrompt, parseCopy, normalizeLayout, writeFingerprint } from "../../host/edition.mjs";
import { builtinProfiles } from "../../host/profiles.mjs";
import { detailMaterials, detailPrompt, verifyDetail, writeDetail, saveDetail, latestDetail } from "../../host/detail.mjs";

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-detail-")), "n.sqlite"));
  db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, copy, created_at, updated_at) VALUES ('st-1','all','霍尔木兹海峡油轮起火','politics','[]',80,'active',?, '2026-11-10 08:00:00','2026-11-10 12:00:00')")
    .run(JSON.stringify({ lead: "伊朗称霍尔木兹海峡多艘油轮起火。", by: "llm" }));
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, content, source_id, published_at, first_seen_at) VALUES (?,?,?,?,?,?,?,?)");
  const link = db.prepare("INSERT INTO story_items (article_id, story_id, joined_at) VALUES (?, 'st-1', '2026-11-10 12:00:00')");
  const add = (id, t, title, summary, content) => { art.run(id, "https://x/" + id, title, summary, content || null, "cls_telegraph", t, t); link.run(id); };
  add("a1", "2026-11-10 08:00:00", "伊朗称霍尔木兹海峡多艘油轮起火", "伊朗官方媒体称，霍尔木兹海峡有3艘油轮起火，原因不明。");
  add("a2", "2026-11-10 08:05:00", "伊朗称霍尔木兹海峡多艘油轮起火", "伊朗官方媒体称，霍尔木兹海峡有3艘油轮起火，原因不明。伊朗海军已派出救援船只。");
  add("a3", "2026-11-10 10:00:00", "布伦特原油日内涨超4%", "受霍尔木兹海峡油轮起火消息影响，布伦特原油日内涨超4%，报每桶86.5美元。");
  add("a4", "2026-11-10 11:00:00", "美国国务院回应油轮起火", "美国国务院发言人称正在密切关注局势，呼吁各方保持克制。");
  return db;
}

test("故事线详情：每篇报道带上原文（正文优先，和标题一样的不带）", () => {
  const db = tmpDb();
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, published_at, first_seen_at) VALUES ('a5','https://x/a5','只有标题','只有标题','cls_telegraph','2026-11-10 11:30:00','2026-11-10 11:30:00')").run();
  db.prepare("INSERT INTO story_items (article_id, story_id, joined_at) VALUES ('a5','st-1','2026-11-10 12:00:00')").run();
  const d = storyDetail(db, "st-1");
  assert.match(d.items.find((x) => x.id === "a2").text, /救援船只/);
  assert.equal(d.items.find((x) => x.id === "a5").text, undefined);
  db.close();
});

test("材料多的报道：要点放宽、多读几篇；一两篇报道或材料太短的照旧", () => {
  const layout = normalizeLayout(null);
  const wire = builtinProfiles().get("wire");
  const long = (i) => ({ id: "m" + i, grp: "g" + i, title: "标题" + i, summary: "这是一段足够长的报道内容，".repeat(20), published_at: "2026-11-10 0" + i + ":00:00" });
  const r = richSpec([1, 2, 3, 4].map(long), new Map(), layout.story, wire);
  assert.deepEqual(r, { materials: 10, points: 6, point_chars: 60 });
  assert.equal(richSpec([1, 2, 3].map(long), new Map(), layout.story, wire), null, "篇数不够");
  assert.equal(richSpec([1, 2, 3, 4].map((i) => ({ id: "s" + i, grp: "g", title: "短讯" + i, summary: "一句话。" })), new Map(), layout.story, wire), null, "合起来太短");
  assert.equal(richSpec([1, 2, 3, 4].map(long), new Map(), Object.assign({}, layout.story, { rich_items: 0 }), wire), null, "rich_items 为 0 关闭");

  const b = { story: { title: "T", section: "politics", labels: [] }, profile: wire, rich: r, mats: [long(1)], bodies: new Map(), fresh: [], prevLead: "" };
  assert.match(writePrompt([b], layout), /（这篇材料多：要点最多6条，每条不超过60字，把经过、关键数字、各方动作写全，不要重复导语）/);
  assert.doesNotMatch(writePrompt([Object.assign({}, b, { rich: null })], layout), /材料多/);
  const w = { lead: "导语", points: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ text: "要点" + i, refs: ["M1"] })) };
  assert.equal(parseCopy(w, wire.blocks, layout.story, () => [], r).points.length, 6);
  assert.equal(parseCopy(w, wire.blocks, layout.story, () => []).points.length, 3);
  assert.notEqual(writeFingerprint(b, layout), writeFingerprint(Object.assign({}, b, { rich: null }), layout), "放宽与否算两份稿");
});

test("详细报道的材料：按时间排，几乎一样的只留长的，篇数超了留最早和最近的", () => {
  const db = tmpDb();
  const m = detailMaterials(db, "st-1", bodiesFor);
  assert.deepEqual(m.map((x) => x.id), ["a2", "a3", "a4"]);
  assert.equal(m[0].source, "cls_telegraph");
  const few = detailMaterials(db, "st-1", bodiesFor, { items: 2 });
  assert.deepEqual(few.map((x) => x.id), ["a2", "a4"]);
  const p = detailPrompt({ title: "霍尔木兹海峡油轮起火", lead: "L" }, m, "客观。");
  assert.match(p, /写作要求：客观。每句话只能依据下面的材料/);
  assert.match(p, /\[2\] cls_telegraph｜2026-11-10 10:00｜布伦特原油日内涨超4%｜受霍尔木兹/);
  db.close();
});

test("详细报道核对：段落按句删、短句整条删，出处改到含数字的材料；存档与「写完后又有新报道」", async () => {
  const db = tmpDb();
  const mats = detailMaterials(db, "st-1", bodiesFor);
  const j = {
    overview: { text: "伊朗官方媒体称霍尔木兹海峡有3艘油轮起火。布伦特原油随后涨超4%。另有消息称损失达12亿美元。", refs: [1] },
    timeline: [{ time: "11月10日 08:05", text: "伊朗海军派出救援船只。", refs: [1] }, { time: "11月10日 10:00", text: "布伦特原油报每桶86.5美元。", refs: [1] }, { time: "", text: "油价报每桶99美元。", refs: [2] }],
    numbers: [{ text: "布伦特原油日内涨超4%。", refs: [3] }],
    views: [{ who: "美国国务院", says: "正在密切关注局势，呼吁各方保持克制。", refs: [3] }, { who: "OPEC", says: "将增产。", refs: [1] }],
    background: { text: "", refs: [] },
    open: [{ text: "起火原因不明。", refs: [1] }],
  };
  const d = verifyDetail(j, mats, { title: "霍尔木兹海峡油轮起火" });
  assert.equal(d.overview.text, "伊朗官方媒体称霍尔木兹海峡有3艘油轮起火。布伦特原油随后涨超4%。", "编的 12 亿那句删掉，其余保留");
  assert.deepEqual(d.timeline.map((x) => x.text), ["伊朗海军派出救援船只。", "布伦特原油报每桶86.5美元。"]);
  assert.deepEqual(d.timeline[1].refs, ["a3"], "出处改到含 86.5 的材料");
  assert.deepEqual(d.numbers[0].refs, ["a3"]);
  assert.deepEqual(d.views.map((x) => x.who), ["美国国务院"], "材料里没有的 OPEC 删掉");
  assert.equal(d.background, null);
  assert.equal(d.check.dropped, 3);

  const model = { complete: async () => JSON.stringify(j), label: () => "m" };
  const w = await writeDetail(model, { title: "霍尔木兹海峡油轮起火" }, mats, {});
  const saved = saveDetail(db, "st-1", w, { model: "m" });
  assert.equal(saved.items, 4);
  db.prepare("INSERT INTO articles (id, url, title, source_id) VALUES ('a9','https://x/a9','新报道','cls_telegraph')").run();
  db.prepare("INSERT INTO story_items (article_id, story_id) VALUES ('a9','st-1')").run();
  const latest = latestDetail(db, "st-1");
  assert.equal(latest.newer, 1);
  assert.equal(latest.overview.text, d.overview.text);
  await assert.rejects(writeDetail({ complete: async () => '{"overview":{"text":"损失12亿美元。"},"timeline":[]}' }, { title: "x" }, mats, {}), /nothing_verified/);
  await assert.rejects(writeDetail(model, { title: "x" }, [], {}), /no_materials/);
  db.close();
});
