/* 问新闻——关键词、搜索归拢、据材料作答（每句核对）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { searchTerms, searchNews, answerNews } from "../../host/ask.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const ENT = { _note: "x", nvidia: { aliases: ["英伟达", "Nvidia", "NVIDIA"] }, fed: { aliases: ["美联储", "Federal Reserve", "Fed"] }, china: { aliases: ["中国", "China"], weak: true } };

test("关键词：去掉虚词；命中实体时带上别名；太短的英文别名不用；泛实体不展开", () => {
  assert.deepEqual(searchTerms("伊朗局势最近怎么样？", ENT), ["伊朗"]);
  assert.deepEqual(searchTerms("英伟达有什么新消息", ENT), ["英伟达", "Nvidia"]);
  assert.ok(!searchTerms("美联储降息了吗", ENT).includes("Fed"));
  assert.ok(!searchTerms("中国经济", ENT).includes("China"));
});

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v24-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls'), ('bbc','BBC','bbc')").run();
  const add = (id, title, src, o) => {
    const x = Object.assign({ msAgo: 3600000, summary: "", kind: "news" }, o || {});
    db.prepare("INSERT INTO articles (id, url, title, title_zh, summary, source_id, first_seen_at, last_seen_at, published_at, kind) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "https://x/" + id, title, x.zh || null, x.summary, src, iso(x.msAgo), iso(x.msAgo), iso(x.msAgo), x.kind);
    if (x.story) { db.prepare("INSERT OR IGNORE INTO stories (story_id, title, section, status, copy) VALUES (?,?,?,?,?)").run(x.story, "英伟达调查黄仁勋", "industry", "active", JSON.stringify({ lead: "英伟达董事会启动调查。" })); db.prepare("INSERT INTO story_items (article_id, story_id) VALUES (?,?)").run(id, x.story); }
  };
  add("a1", "英伟达董事会就黄仁勋婚外情启动独立调查", "cls", { story: "st1", summary: "英伟达董事会8日宣布启动独立调查。" });
  add("a2", "Nvidia investigates CEO Jensen Huang", "bbc", { zh: "英伟达调查CEO黄仁勋", story: "st1" });
  add("a3", "英伟达股价夜盘下跌2%", "cls", { msAgo: 7200000 });
  add("a4", "【风口研报】英伟达产业链这家公司有望受益", "cls", { kind: "promo" });
  add("a5", "英伟达发布新显卡", "cls", { msAgo: 10 * 86400000 });
  return db;
}

test("搜索：标题、中文译名、摘要都能命中；广告与时段外的不算；按故事线归拢", () => {
  const db = tmpDb();
  const r = searchNews(db, { q: "英伟达最近怎么样", since: iso(72 * 3600000), entities: ENT });
  assert.equal(r.total, 3);
  assert.ok(!r.items.some((x) => x.id === "a4" || x.id === "a5"));
  assert.deepEqual(r.stories.map((s) => [s.id, s.n, s.lead]), [["st1", 2, "英伟达董事会启动调查。"]]);
  assert.equal(r.items.find((x) => x.id === "a2").title, "英伟达调查CEO黄仁勋", "外文报道显示中文译名");
  db.close();
});

test("作答：只据材料、每句标出处；核对不过的句子删掉", async () => {
  const db = tmpDb();
  const hits = searchNews(db, { q: "英伟达", since: iso(72 * 3600000), entities: ENT });
  const llm = { stream() { return (async function* () { yield { type: "text-delta", text: JSON.stringify({ answer: [
    { text: "英伟达董事会8日宣布就黄仁勋启动独立调查。", refs: [1, 2] },
    { text: "英伟达股价当晚下跌2%。", refs: [3] },
    { text: "英伟达市值蒸发5000亿美元。", refs: [3] },
  ], enough: true }) }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  const m = createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) });
  const a = await answerNews(m, "英伟达", hits, new Map(), {});
  assert.equal(a.answer.length, 2);
  assert.equal(a.dropped, 1, "5000亿是编的");
  assert.ok(a.answer.every((s) => s.refs.every((i) => a.materials[i])));
  db.close();
});
