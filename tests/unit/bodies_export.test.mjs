/* 正文抽取、正文候选、数据集导出（含覆盖情况）、原始快照保留。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extractBody, readerText, bodyCandidates, CHALLENGE } from "../../engine/pipeline/bodies.mjs";
import { exportDataset, DATASET_SCHEMA } from "../../engine/export.mjs";
import { applyRetention } from "../../engine/retention.mjs";
import { openDb } from "../../engine/store/schema.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const LONG = "央行今日开展1000亿元7天期逆回购操作，中标利率持平于1.4%，当日有800亿元逆回购到期，实现净投放200亿元。";

test("正文抽取：JSON-LD 优先，其次 Next.js 数据，再次段落；去掉导航与样板句", () => {
  const ld = '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","articleBody":"' + LONG.repeat(3) + '"}]}</script><p>无关段落无关段落无关段落无关段落无关段落</p>';
  assert.equal(extractBody(ld).extractor, "json-ld");
  const nd = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"detail":{"content":"<p>' + LONG.repeat(3) + '</p>"}}}}</script>';
  assert.equal(extractBody(nd).extractor, "next-data");
  const html = "<nav><p>首页 电报 话题 盯盘 VIP 下载 APP 首页 电报 话题</p></nav><article><p>" + LONG + LONG + "</p><p>" + LONG.slice(5) + "</p><p>本文版权所有，未经授权不得转载，责任编辑：某某</p></article>";
  const p = extractBody(html);
  assert.equal(p.extractor, "paragraphs");
  assert.ok(!/首页 电报/.test(p.text) && !/版权所有/.test(p.text));
  assert.equal(extractBody("<p>太短</p>"), null);
});

test("验证页不是正文", () => {
  assert.ok(CHALLENGE.test("Performing security verification This website uses a security service"));
  assert.equal(extractBody("<title>Just a moment...</title><p>Checking your browser before accessing the site, please wait a moment while we verify.</p>"), null);
});

test("阅读器 Markdown → 纯文本", () => {
  const md = "Title: x\n\nMarkdown Content:\n# 标题\n![img](https://x/a.png)\n" + LONG + "\n[首页](https://x)\n" + LONG.slice(3) + "\n";
  const t = readerText(md);
  assert.ok(t.startsWith("央行今日"));
  assert.ok(!/!\[|\]\(/.test(t));
});

function seed(db) {
  const now = "2026-11-08 05:00:00";
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, content, published_at, time_confidence, first_seen_at, last_seen_at, source_id, pack, paywalled, text_len, training_ready, parser_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  art.run("a1", "https://x/1", "央行开展逆回购", "s", LONG.repeat(4), "2026-11-08 04:50:00", "feed", now, now, "cls", "core", 0, LONG.length * 4, 1, "0.7.0/generic");
  art.run("a2", "https://y/2", "财新独家", "s", "", "2026-11-08 04:55:00", "feed", now, now, "caixin", "core", 1, 10, 0, "0.7.0/generic");
  art.run("a3", "https://z/3", "旧闻", "s", "", "2026-11-06 04:55:00", "feed", "2026-11-06 05:00:00", "2026-11-06 05:00:00", "cls", "core", 0, 10, 0, "0.7.0/generic");
  db.prepare("INSERT INTO runs (run_id, started_at, finished_at, mode, sources_total, sources_ok, sources_failed, items_new) VALUES ('r1', ?, ?, 'cycle', 3, 2, 1, 2)").run(now, now);
  db.prepare("INSERT INTO observations (run_id, source_id, article_id, rank, views, hot, seen_at) VALUES ('r1', 'cls', 'a1', 0, 4200, '[\"加红\"]', ?)").run(now);
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, regions, factors, created_run) VALUES ('ev1', 'core', '央行开展逆回购', 'a1', '2026-11-08 04:50:00', ?, 2, 2, 72, 'corroborated', '[\"macro.monetary\"]', '[\"CN\"]', '{}', 'r1')").run(now);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, similarity, method, joined_at, joined_run) VALUES ('ev1', 'a1', 'cls', 'cls', 1, 'seed', ?, 'r1'), ('ev1', 'a2', 'caixin', 'caixin', 0.8, 'title', ?, 'r1')").run(now, now);
  db.prepare("INSERT INTO continuity (run_id, source_id, status, note) VALUES ('r1', 'reuters', 'failed', 'browse:timeout -> http:paywall')").run();
  db.prepare("INSERT INTO coverage_gaps (source_id, run_id, gap_from, gap_to, status, method, recovered, updated_at) VALUES ('jiemian', 'r1', '2026-11-08 01:00:00', '2026-11-08 03:00:00', 'open', 'paging', 0, ?), ('techflow', 'r1', '2026-11-08 01:00:00', '2026-11-08 02:00:00', 'backfilled', 'paging', 9, ?)").run(now, now);
}

test("正文候选：重点事件成员，跳过付费墙源与 body=list / none 的源", () => {
  const dir = tmp("newswire-bodies-");
  const db = openDb(path.join(dir, "news.sqlite"));
  seed(db);
  db.prepare("UPDATE articles SET text_len = 10, content = '' WHERE id = 'a1'").run();
  const sources = new Map([["cls", { id: "cls", tier: "primary" }], ["caixin", { id: "caixin", paywall: true }]]);
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 5, sources }).map((c) => c.id), ["a1"]);
  sources.set("cls", { id: "cls", body: "list" });
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 5, sources }), []);
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 0, sources: new Map() }), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("导出：条目带观测轨迹与事件，正文按可训练性给出；清单列出未补全缺口与失败的源轮次", () => {
  const dir = tmp("newswire-export-");
  const db = openDb(path.join(dir, "news.sqlite"));
  seed(db);
  const cfg = { version: 5, sources: [{ id: "cls", name: "财联社电报", type: "cls_api", region: "CN", weight: 0.85, tier: "primary", group: "cls" }, { id: "caixin", name: "财新", type: "html_index", paywall: true }] };
  const r = exportDataset(db, { from: "2026-11-08", kind: "all", outDir: dir, cfg, tax: { rulesVersion: "t1" }, now: Date.parse("2026-11-08T10:00:00Z") });
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, "manifest.json"), "utf8"));
  assert.equal(m.schema, DATASET_SCHEMA);
  assert.deepEqual(m.range, { from_date: "2026-11-08", to_date: "2026-11-08", timezone: "Asia/Shanghai", from_utc: "2026-11-07 16:00:00", to_utc: "2026-11-08 16:00:00" });
  assert.deepEqual(m.files, { "articles.jsonl": 2, "events.jsonl": 1, "stories.jsonl": 0, "editions.jsonl": 0, "digests.jsonl": 0 }, "11-06 的旧闻不在范围内；all 也导出故事线、版面、日报");
  assert.deepEqual(m.coverage.open_gaps.map((g) => g.source_id), ["jiemian"], "已补回的缺口不列");
  assert.deepEqual(m.coverage.failed_source_runs.map((f) => f.source_id), ["reuters"]);
  assert.equal(m.versions.taxonomy_rules, "t1");
  const arts = fs.readFileSync(path.join(r.dir, "articles.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const a1 = arts.find((a) => a.id === "a1");
  const a2 = arts.find((a) => a.id === "a2");
  assert.ok(a1.content && a1.content_withheld === null);
  assert.equal(a1.event_id, "ev1");
  assert.deepEqual(a1.observations.map((o) => [o.views, o.hot]), [[4200, ["加红"]]]);
  assert.equal(a2.content, null);
  assert.equal(a2.content_withheld, "paywall");
  const ev = JSON.parse(fs.readFileSync(path.join(r.dir, "events.jsonl"), "utf8").trim());
  assert.equal(ev.members.length, 2);
  assert.deepEqual(ev.labels, ["macro.monetary"]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("原始快照：今天的不动，之前的压缩（内容不变），超过保留期的删除", () => {
  const raw = tmp("newswire-raw-");
  const mk = (rel, body) => { const p = path.join(raw, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  mk("20261108/09/cls.browse.json", "today");
  const old = mk("20261107/21/jiemian.browse.html", "<html>" + "x".repeat(5000) + "</html>");
  mk("20261107/21/done.html.gz", "already");
  mk("20260101/cls.xml", "ancient");
  const r = applyRetention({ rawDir: raw, today: "20261108", retentionDays: 180 });
  assert.equal(r.compressed, 1);
  assert.equal(r.removedDays, 1);
  assert.ok(r.savedBytes > 4000);
  assert.ok(fs.existsSync(path.join(raw, "20261108/09/cls.browse.json")));
  assert.ok(!fs.existsSync(old));
  assert.equal(gunzipSync(fs.readFileSync(old + ".gz")).toString(), "<html>" + "x".repeat(5000) + "</html>");
  assert.ok(!fs.existsSync(path.join(raw, "20260101")));
  assert.equal(applyRetention({ rawDir: raw, today: "20261108", retentionDays: 180 }).compressed, 0, "重复执行无事可做");
  fs.rmSync(raw, { recursive: true, force: true });
});
