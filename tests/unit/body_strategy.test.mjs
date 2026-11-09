/* 按源学正文策略、新条目补正文、快讯完整度。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { bodyProfiles, fillCandidates, fillBodies, bodyCandidates } from "../../engine/pipeline/bodies.mjs";
import { completeness } from "../../engine/pipeline/quality.mjs";
import { contentHealth } from "../../host/health.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v19-")), "n.sqlite"));
  for (const id of ["cheap", "slow", "dead", "rich", "fresh", "pay"]) db.prepare("INSERT INTO sources (id, name, grp, paywall) VALUES (?,?,?,?)").run(id, id, id, id === "pay" ? 1 : 0);
  return db;
}
function art(db, id, src, o) {
  const x = Object.assign({ completeness: "title_only", summary: "", run: "r1", url: "https://" + src + ".example/" + id }, o || {});
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, completeness, kind, paywalled) VALUES (?,?,?,?,?,?,?,?,?,0)").run(id, x.url, "标题" + id, x.summary, src, iso(3600000), iso(3600000), x.completeness, x.kind || "news");
  db.prepare("INSERT INTO observations (run_id, source_id, article_id, rank, page, seen_at) VALUES (?,?,?,0,0,?)").run(x.run, src, id, iso(3600000));
}
const body = (db, id, ok, ms, channel) => db.prepare("INSERT INTO article_bodies (article_id, ok, ms, channel, fetched_at, content) VALUES (?,?,?,?,?,?)").run(id, ok ? 1 : 0, ms, channel || "http", iso(60000), ok ? "正文" : null);
const SRC = (ids) => new Map(ids.map((id) => [id, id === "pay" ? { paywall: true } : {}]));

test("按源学正文策略：列表自带 / 便宜逐条补 / 慢只补重点 / 抓不到 / 试抓 / 付费墙", () => {
  const db = tmpDb();
  for (let i = 0; i < 3; i++) { art(db, "c" + i, "cheap", { run: "old" }); body(db, "c" + i, true, 300); }
  for (let i = 0; i < 3; i++) { art(db, "s" + i, "slow", { run: "old" }); body(db, "s" + i, true, 12000, "agent_reach"); }
  for (let i = 0; i < 3; i++) { art(db, "d" + i, "dead", { run: "old" }); body(db, "d" + i, false, 2000); }
  for (let i = 0; i < 6; i++) art(db, "r" + i, "rich", { run: "old", completeness: "full", summary: "完整摘要" });
  const p = bodyProfiles(db, SRC(["cheap", "slow", "dead", "rich", "fresh", "pay"]));
  assert.deepEqual(Object.fromEntries([...p].map(([k, v]) => [k, v.mode])), { cheap: "fetch", slow: "slow", dead: "blocked", rich: "list", fresh: "probe", pay: "none" });
  assert.equal(p.get("cheap").median_ms, 300);
  db.close();
});

test("配置写着列表自带正文、实际只有标题的源，重点事件照样补正文（按学到的策略，不按配置）", () => {
  const db = tmpDb();
  for (let i = 0; i < 3; i++) { art(db, "c" + i, "cheap", { run: "old" }); body(db, "c" + i, true, 300); }
  art(db, "k1", "cheap");
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance) VALUES ('e1','core','t','k1',?,?,1,1,80)").run(iso(0), iso(0));
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('e1','k1','cheap','cheap','seed')").run();
  const sources = new Map([["cheap", { body: "list" }]]);
  assert.equal(bodyCandidates(db, { touched: ["e1"], budget: 5, sources }).length, 0, "只看配置时跳过");
  assert.deepEqual(bodyCandidates(db, { touched: ["e1"], budget: 5, sources, profiles: bodyProfiles(db, sources) }).map((x) => x.id), ["k1"]);
  db.close();
});

test("本轮新条目补正文：便宜的源全补、没记录的源试 2 篇、慢的与抓不到的不在这里补；广告与已完整的不补", () => {
  const db = tmpDb();
  for (let i = 0; i < 3; i++) { art(db, "c" + i, "cheap", { run: "old" }); body(db, "c" + i, true, 300); }
  for (let i = 0; i < 3; i++) { art(db, "s" + i, "slow", { run: "old" }); body(db, "s" + i, true, 12000, "agent_reach"); }
  for (let i = 0; i < 4; i++) art(db, "nc" + i, "cheap");
  art(db, "ad", "cheap", { kind: "promo" });
  art(db, "ok", "cheap", { completeness: "full", summary: "完整的正文。".repeat(60) });
  // 列表里看着完整、其实只有一句导语：抓得到原文的源也补
  art(db, "lead", "cheap", { completeness: "full", summary: "一句导语，全文要点开原文才有。" });
  for (let i = 0; i < 4; i++) art(db, "nf" + i, "fresh");
  art(db, "ns", "slow");
  const profiles = bodyProfiles(db, SRC(["cheap", "slow", "fresh"]));
  const got = fillCandidates(db, { runId: "r1", profiles, budget: 60 }).map((x) => x.id).sort();
  assert.deepEqual(got, ["lead", "nc0", "nc1", "nc2", "nc3", "nf0", "nf1"]);
  assert.equal(fillCandidates(db, { runId: "r1", profiles, budget: 3 }).length, 3, "有预算");
  db.close();
});

test("并发补正文：同一网站最多 2 个并发；成功回填正文与完整度，失败也记下（下次学策略用）", async () => {
  const db = tmpDb();
  for (let i = 0; i < 6; i++) art(db, "a" + i, "cheap");
  art(db, "b0", "fresh");
  const live = new Map();
  let peak = 0;
  const fetch = async (url) => {
    const h = new URL(url).host;
    live.set(h, (live.get(h) || 0) + 1); peak = Math.max(peak, live.get(h));
    await new Promise((r) => setTimeout(r, 20));
    live.set(h, live.get(h) - 1);
    return url.endsWith("a3") ? { ok: false, error: "http 404", channel: "http" } : { ok: true, text: "正文".repeat(150), extractor: "paragraphs", channel: "http" };
  };
  const list = db.prepare("SELECT id, url FROM articles").all();
  const r = await fillBodies(db, list, { runId: "r1", concurrency: 6, fetch });
  assert.deepEqual([r.tried, r.ok], [7, 6]);
  assert.ok(peak <= 2, "同一网站并发不超过 2，实际 " + peak);
  assert.equal(db.prepare("SELECT completeness FROM articles WHERE id = 'a0'").get().completeness, "full");
  assert.equal(db.prepare("SELECT completeness FROM articles WHERE id = 'a3'").get().completeness, "title_only");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM article_bodies WHERE ms IS NOT NULL").get().n, 7);
  db.close();
});

test("快讯：标题本身是完整的一句话就算完整", () => {
  assert.equal(completeness({ title: "日本10年期国债收益率上行5.5个基点至2.69%。", summary: "" }), "full");
  assert.equal(completeness({ title: "伊朗称油轮起火", summary: "" }), "title_only");
  // 感叹号收尾的多是标题党，不是快讯全文；列表把发布日期当成了摘要的，也不算内容
  assert.equal(completeness({ title: "突传利空！全球首富马斯克，或被调查！", summary: "" }), "title_only");
  assert.equal(completeness({ title: "王大泉主任率团赴美加韩访问交流", summary: "2025-02-24" }), "title_only");
  assert.equal(completeness({ title: "某某会议召开", summary: "2026年11月9日 10:31" }), "title_only");
});

test("健康度带上每个源的正文策略与建议代码", () => {
  const db = tmpDb();
  for (let i = 0; i < 6; i++) { art(db, "d" + i, "dead"); body(db, "d" + i, false, 2000); }
  const h = contentHealth(db);
  const d = h.sources.find((x) => x.source_id === "dead");
  assert.equal(d.body_mode, "blocked");
  assert.equal(d.advice, "blocked");
  db.close();
});

test("列表自带全文的源要抽查原文：一致就保持；原文明显更长（列表只是导语）就改为去原文补", () => {
  const db = tmpDb();
  for (let i = 0; i < 6; i++) art(db, "r" + i, "rich", { run: "old", completeness: "full", summary: "列表里的一段文字。".repeat(4) });
  art(db, "now", "rich", { completeness: "full", summary: "本轮最长的一条。".repeat(10) });
  art(db, "now2", "rich", { completeness: "full", summary: "短" });
  let p = bodyProfiles(db, SRC(["rich"]));
  assert.equal(p.get("rich").mode, "list");
  assert.deepEqual(fillCandidates(db, { runId: "r1", profiles: p }).map((x) => x.id), ["now"], "每轮抽查 1 篇，挑列表文字最长的");
  const check = (id, len, listLen) => db.prepare("INSERT INTO article_bodies (article_id, ok, ms, channel, fetched_at, content, text_len, list_len) VALUES (?,1,300,'http',?,?,?,?)").run(id, iso(60000), "x".repeat(len), len, listLen);
  // 电报：原文与列表一样长
  check("r0", 36, 36); check("r1", 40, 36); check("r2", 36, 36);
  p = bodyProfiles(db, SRC(["rich"]));
  assert.equal(p.get("rich").mode, "list");
  assert.equal(p.get("rich").checked, 3);
  assert.deepEqual(fillCandidates(db, { runId: "r1", profiles: p }), [], "抽满 3 篇不再抽");
  // 同花顺一类：列表是导语，原文长得多
  db.prepare("DELETE FROM article_bodies").run();
  check("r0", 1500, 36); check("r1", 900, 36);
  p = bodyProfiles(db, SRC(["rich"]));
  assert.equal(p.get("rich").mode, "fetch");
  assert.deepEqual(fillCandidates(db, { runId: "r1", profiles: p }).map((x) => x.id).sort(), ["now", "now2"]);
  db.close();
});
