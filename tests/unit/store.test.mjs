/* 迁移（含从早期库升级）、入库合并规则、观测、全文检索、查询层。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, MIGRATIONS, SCHEMA_VERSION } from "../../engine/store/schema.mjs";
import { upsertArticle, insertObservation, touchSignals, upsertSource, startRun, logAttempt } from "../../engine/store/db.mjs";
import { toRecord } from "../../engine/pipeline/normalize.mjs";
import { itemRows, signalTrail, sourceHealth } from "../../engine/query.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "newswire-test-"));
const SRC = { id: "cls", name: "财联社", category: "财经", region: "CN", lang: "zh", pack: "core", type: "cls_api", url: "https://www.cls.cn/telegraph" };

test("早期库（user_version=0）升级到最新：旧数据保留并补齐新列", () => {
  const dir = tmp();
  const f = path.join(dir, "news.sqlite");
  const old = new DatabaseSync(f);
  for (const sql of MIGRATIONS[0]) old.exec(sql);
  old.prepare("INSERT INTO articles (id, url, title, summary, published_at, metrics, source_id, last_seen_at) VALUES (?,?,?,?,?,?,?,?)").run("x1", "https://a/1", "央行宣布下调存款准备金率", "", "", JSON.stringify({ time_from: "fetched" }), "cls", "2026-11-08 08:00:00");
  old.close();
  const db = openDb(f);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const r = db.prepare("SELECT published_at, time_confidence, pack, title_norm FROM articles WHERE id='x1'").get();
  assert.equal(r.published_at, null);
  assert.equal(r.time_confidence, "fetched");
  assert.equal(r.pack, "core");
  assert.equal(r.title_norm, "央行宣布下调存款准备金率");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM articles_fts WHERE articles_fts MATCH ?").get('"准备金"').n, 1);
  db.close();
  // 再开一次不应重复迁移
  const again = openDb(f);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test("同一条新闻多轮出现：文章合并、时间升级、每轮一条观测、热度轨迹", () => {
  const dir = tmp();
  const db = openDb(path.join(dir, "news.sqlite"));
  upsertSource(db, SRC, "2026-11-08 08:00:00");
  // 第一轮：没有发布时间
  const r1 = toRecord({ title: "央行开展逆回购操作一千亿元", link: "https://www.cls.cn/detail/9", summary: "短", metrics: { reading: 1000, level: "B" } }, SRC, { index: 4, nowMs: Date.parse("2026-11-08T08:00:00Z") });
  startRun(db, "r1", "2026-11-08 08:00:00", "fetch");
  upsertArticle(db, r1, { nowIso: "2026-11-08 08:00:00", channel: "browse" });
  insertObservation(db, r1, { runId: "r1", nowIso: "2026-11-08 08:00:00", channel: "browse" });
  insertObservation(db, r1, { runId: "r1", nowIso: "2026-11-08 08:00:00", channel: "browse" }); // 同轮重复：忽略
  touchSignals(db, "cls", ["views", "level"], "2026-11-08 08:00:00");
  // 第二轮：拿到了源头时间、摘要更长、阅读数涨了
  const r2 = toRecord({ title: "央行开展逆回购操作一千亿元", link: "https://www.cls.cn/detail/9", summary: "央行今日开展1000亿元7天期逆回购操作，中标利率持平。", published_at: "2026-11-08T07:58:00Z", metrics: { reading: 5200, level: "B" } }, SRC, { index: 1, nowMs: Date.parse("2026-11-08T10:00:00Z") });
  assert.equal(r1.id, r2.id);
  startRun(db, "r2", "2026-11-08 10:00:00", "fetch");
  upsertArticle(db, r2, { nowIso: "2026-11-08 10:00:00", channel: "browse" });
  insertObservation(db, r2, { runId: "r2", nowIso: "2026-11-08 10:00:00", channel: "browse" });
  touchSignals(db, "cls", ["views", "level"], "2026-11-08 10:00:00");
  logAttempt(db, { run_id: "r2", source_id: "cls", channel: "browse", url: SRC.url, ok: true, items: 1, latency_ms: 900, attempted_at: "2026-11-08 10:00:01" });

  const a = db.prepare("SELECT * FROM articles").all();
  assert.equal(a.length, 1);
  assert.equal(a[0].time_confidence, "feed");
  assert.equal(a[0].published_at, "2026-11-08 07:58:00");
  assert.equal(a[0].first_seen_at, "2026-11-08 08:00:00");
  assert.equal(a[0].last_seen_at, "2026-11-08 10:00:00");
  assert.match(a[0].summary, /中标利率/);

  const trail = signalTrail(db, r1.id);
  assert.deepEqual(trail.map((x) => [x.run_id, x.views, x.rank]), [["r1", 1000, 4], ["r2", 5200, 1]]);

  const rows = itemRows(db, { since: "2026-11-01 00:00:00", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signals.views, 5200, "条目带最近一次观测的信号");
  assert.equal(rows[0].signals.level, "B");
  assert.equal(itemRows(db, { since: "2026-11-01 00:00:00", query: "逆回购操作" }).length, 1, "≥3 字走全文检索");
  assert.equal(itemRows(db, { since: "2026-11-01 00:00:00", query: "央行" }).length, 1, "2 字退回 LIKE");
  assert.equal(itemRows(db, { since: "2026-11-01 00:00:00", query: "降准" }).length, 0);
  assert.equal(itemRows(db, { since: "2026-11-01 00:00:00", hotOnly: true }).length, 1, "有 level 算热门");

  const h = sourceHealth(db);
  assert.deepEqual(h.cls.signals.sort(), ["level", "views"]);
  assert.equal(h.cls.last_ok_channel, "browse");
  assert.equal(db.prepare("SELECT seen_count FROM signal_availability WHERE source_id='cls' AND signal='views'").get().seen_count, 2);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
