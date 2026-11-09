/* 留学主题包——链接时间、时间可信度合并、分类体系升级、配置升级、包内标签过滤、消息标题、锁等待。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timeFromUrl, toRecord } from "../../engine/pipeline/normalize.mjs";
import { upgradeConfig, upgradeTaxonomy, CONFIG_VERSION } from "../../engine/config.mjs";
import { selectEvents, composeMessage } from "../../engine/pipeline/select.mjs";
import { compileTaxonomy, classify } from "../../engine/taxonomy.mjs";
import { acquireLock, acquireLockWait } from "../../engine/lock.mjs";
import { openDb } from "../../engine/store/schema.mjs";
import { upsertArticle } from "../../engine/store/db.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8"));

test("链接时间：完整时间戳可信，只有日期记为 url_date；没有就不猜", () => {
  assert.deepEqual(timeFromUrl("https://www.cscse.edu.cn/cscse/sy/tzgg/2026101415255489242/index.html"), { at: "2026-10-14 07:25:54", precise: true });
  assert.deepEqual(timeFromUrl("http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/moe_1485/202611/t20261107_1457469.html"), { at: "2026-11-06 16:00:00", precise: false });
  assert.deepEqual(timeFromUrl("https://www.news.cn/politics/20261029/a7d43ed1/c.html"), { at: "2026-10-28 16:00:00", precise: false });
  assert.deepEqual(timeFromUrl("https://www.chinanews.com.cn/gn/2026/11-08/10728268.shtml"), { at: "2026-11-07 16:00:00", precise: false });
  assert.equal(timeFromUrl("https://www.cls.cn/detail/2528241"), null);
  assert.equal(timeFromUrl("https://x.example/a/20261399/b"), null, "非法日期不认");
  const src = { id: "moe", category: "留学与签证" };
  assert.equal(toRecord({ title: "教育部发布出国留学预警提示", link: "http://www.moe.gov.cn/a/t20261107_1.html" }, src, { index: 0 }).time_confidence, "url_date");
  assert.equal(toRecord({ title: "国际教育项目综合服务平台全面上线", link: "https://www.cscse.edu.cn/cscse/sy/tzgg/2026070316263012331/index.html" }, src, { index: 0 }).time_confidence, "page_text");
});

test("时间可信度合并只升不降：fetched < url_date < page_text < feed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newswire-v08-"));
  const db = openDb(path.join(dir, "news.sqlite"));
  const base = { id: "a", url: "https://x/1", canonical_url: "https://x/1", title: "t", title_norm: "t", summary: "", content: "", source_id: "s", category: "", region: "", lang: "", pack: "core", paywalled: false, content_hash: "h", text_len: 0, training_ready: false, parser_version: "x", metrics: {} };
  const put = (published_at, time_confidence) => upsertArticle(db, Object.assign({}, base, { published_at, time_confidence }), { nowIso: "2026-11-08 10:00:00", channel: "http" });
  const get = () => db.prepare("SELECT published_at, time_confidence FROM articles WHERE id = 'a'").get();
  put(null, "fetched");
  put("2026-11-07 16:00:00", "url_date");
  assert.equal(get().time_confidence, "url_date");
  put("2026-11-08 02:31:00", "feed");
  assert.deepEqual(Object.assign({}, get()), { published_at: "2026-11-08 02:31:00", time_confidence: "feed" });
  put("2026-11-07 16:00:00", "url_date");
  assert.equal(get().time_confidence, "feed", "不会被降级");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("分类体系升级：补齐种子新增的节点与关键词，保留用户自己的", () => {
  const mine = JSON.parse(JSON.stringify(TAX));
  mine.version = 1;
  const visa = mine.labels.find((t) => t.id === "study").children.find((c) => c.id === "study.visa");
  visa.keywords = ["签证", "我自己加的词"];
  mine.labels.push({ id: "mine", name: "我的分类", children: [{ id: "mine.x", name: "X", keywords: ["x"] }] });
  delete mine.category_defaults["留学与签证"];
  const up = upgradeTaxonomy(mine, TAX);
  assert.equal(up.changed, true);
  const v = up.doc.labels.find((t) => t.id === "study").children.find((c) => c.id === "study.visa");
  assert.ok(v.keywords.includes("我自己加的词") && v.keywords.includes("student visa"));
  assert.ok(up.doc.labels.find((t) => t.id === "mine"), "用户的节点保留");
  assert.equal(up.doc.category_defaults["留学与签证"], "study");
  assert.equal(upgradeTaxonomy(up.doc, TAX).changed, false);
});

test("配置 v5 → v6：补上留学包的源、包设置与推送规则，用户的核心包设置不动", () => {
  const v5 = { version: 5, defaults: { channels: ["browse", "http"] }, categories: ["国际宏观"], packs: { core: { name: "我的核心包", enabled: true } }, push: { core: { min_corroborated: 60 } }, sources: SEED.sources.filter((s) => s.pack !== "study_abroad") };
  const up = upgradeConfig(v5, SEED);
  assert.equal(up.doc.version, CONFIG_VERSION);
  assert.equal(up.doc.packs.core.name, "我的核心包");
  assert.deepEqual(up.doc.packs.core.schedule, { cron: "0 7-21/2 * * *", time_zone: "Asia/Shanghai" }, "缺的字段由种子补上");
  assert.equal(up.doc.packs.study_abroad.schedule.cron, "30 8,20 * * *");
  assert.equal(up.doc.push.core.min_corroborated, 60);
  assert.deepEqual(up.doc.push.study_abroad.require_labels, ["study"]);
  for (const id of ["cscse_notice", "uk_ukvi", "ca_ircc", "pie_news"]) assert.ok(up.added.includes(id), id);
  assert.ok(up.doc.categories.includes("留学与签证"));
});

test("留学关键词：签证、学生担保、国际学生上限都打上 study 标签", () => {
  const tax = compileTaxonomy(TAX);
  const has = (title, prefix) => classify(tax, { title }).labels.some((l) => l.label.startsWith(prefix));
  assert.ok(has("Guidance: Register of licensed sponsors: students", "study."));
  assert.ok(has("Canada extends 150,000 international student arrivals target to 2029", "study."));
  assert.ok(has("关于对部分国外院校学历学位认证加强认证审查的公告", "study."));
  assert.ok(!has("Cuban Aliens and Florida Man Sentenced for Their Roles in an Alien Smuggling Conspiracy", "study."));
});

test("包内推送规则：require_labels 只放行对口事件；消息标题跟着包走", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newswire-v08-"));
  const db = openDb(path.join(dir, "news.sqlite"));
  const ev = db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets) VALUES (?, 'study_abroad', ?, ?, '2026-11-08 09:00:00', '2026-11-08 09:00:00', 1, 1, 23, 'single', ?, '[]')");
  ev.run("e1", "Student sponsor guidance updated", "a1", JSON.stringify(["study.visa"]));
  ev.run("e2", "Man sentenced for smuggling", "a2", JSON.stringify(["society.disaster"]));
  ev.run("e3", "教育部召开学习会", "a3", JSON.stringify([]));
  const rules = { min_corroborated: 40, min_single: 15, max: 8, upgrade_jump: 20, require_labels: ["study"] };
  const picks = selectEvents(db, { touched: ["e1", "e2", "e3"], nowIso: "2026-11-08 10:00:00", lookbackHours: 12, rules, dist: new Map() });
  assert.deepEqual(picks.map((p) => p.event_id), ["e1"]);
  const msg = composeMessage({ now: new Date("2026-11-08T00:30:00Z"), tz: "Asia/Shanghai", overnight: false, results: [{ id: "uk_ukvi", ok: true, fresh: 3, continuity: "connected" }], picks, sources: new Map([["uk_ukvi", { name: "GOV.UK·UK Visas and Immigration" }]]), failing: [], title: "留学资讯" });
  assert.match(msg, /^📰 留学资讯 · 11-08 08:30/);
  const none = composeMessage({ now: new Date("2026-11-08T12:30:00Z"), tz: "Asia/Shanghai", overnight: false, results: [], picks: [], sources: new Map(), failing: [], title: "留学资讯" });
  assert.equal(none, "20:30 留学资讯 无新重点（源 0/0，新增 0 条，衔接 ✓）");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("锁等待：前一轮释放后，等待中的一轮接着跑；超时则放弃", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newswire-lockwait-"));
  const first = acquireLock(dir, { run_id: "core" });
  assert.equal(first.ok, true);
  assert.equal((await acquireLockWait(dir, { run_id: "study" }, 60000, 300)).ok, false, "等 0.3 秒还没释放");
  setTimeout(() => first.release(), 300);
  const t0 = Date.now();
  const second = await acquireLockWait(dir, { run_id: "study" }, 60000, 10000);
  assert.equal(second.ok, true);
  assert.ok(Date.now() - t0 >= 250);
  second.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("首次抓到的旧条目（链接日期早于回看范围一天以上）不当新事件推", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newswire-v08-"));
  const db = openDb(path.join(dir, "news.sqlite"));
  db.prepare("INSERT INTO articles (id, url, title, published_at, time_confidence, first_seen_at, last_seen_at, source_id) VALUES ('old', 'u1', '旧闻', '2026-10-30 16:00:00', 'url_date', '2026-11-08 16:00:00', '2026-11-08 16:00:00', 'moe'), ('new', 'u2', '新闻', '2026-11-08 15:00:00', 'feed', '2026-11-08 16:00:00', '2026-11-08 16:00:00', 'ukvi')").run();
  const ev = db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets) VALUES (?, 'study_abroad', ?, ?, '2026-11-08 16:00:00', '2026-11-08 16:00:00', 1, 1, 23, 'single', '[\"study.admission\"]', '[]')");
  ev.run("e-old", "旧闻", "old");
  ev.run("e-new", "新闻", "new");
  const picks = selectEvents(db, { touched: ["e-old", "e-new"], nowIso: "2026-11-08 16:10:00", lookbackHours: 12, rules: { min_single: 15, require_labels: ["study"] }, dist: new Map() });
  assert.deepEqual(picks.map((p) => p.event_id), ["e-new"]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
