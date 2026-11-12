/* 读者反馈的几处问题：将来的发布时间、刚加的源不在列表里、追踪对象没有动静、最新快讯。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { toRecord } from "../../engine/pipeline/normalize.mjs";
import { sourceScores } from "../../host/sources.mjs";
import { addTracker, mentions, quietReason, trackerDetail } from "../../host/tracking.mjs";
import { latestWire } from "../../host/edition.mjs";

const tmp = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-rf-")), "n.sqlite"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

test("发布时间不可能在将来：「将于11月13日上市」里的日期不当发布时间，按抓取时间算；库里已有的由迁移改正", () => {
  const now = Date.parse("2026-11-09T04:56:24Z");
  const r = toRecord({ link: "https://36kr.com/newsflashes/1", title: "2027款岚图知音将于11月13日上市", published_raw: "11月13日" }, { id: "36kr", defaults: {} }, { nowMs: now });
  assert.equal(r.published_at, null);
  assert.equal(r.time_confidence, "fetched");
  const ok = toRecord({ link: "https://36kr.com/newsflashes/2", title: "某公司发布财报", published_at: "2026-11-09T04:30:00Z" }, { id: "36kr", defaults: {} }, { nowMs: now });
  assert.equal(ok.time_confidence, "feed", "正常的发布时间不动");
  const db = tmp();
  db.prepare("INSERT INTO articles (id, url, title, source_id, published_at, first_seen_at, time_confidence) VALUES ('x','https://x','t','s','2026-11-12 16:00:00','2026-11-09 04:56:24','page_text')").run();
  db.prepare("UPDATE articles SET published_at = first_seen_at, time_confidence = 'fetched' WHERE published_at > datetime(first_seen_at, '+1 hour')").run();
  assert.equal(db.prepare("SELECT published_at FROM articles WHERE id = 'x'").get().published_at, "2026-11-09 04:56:24");
  db.close();
});

test("源的取舍：刚加的源（配置里有、还没抓过）马上列出来，排最前，标「刚加上」", () => {
  const db = tmp();
  db.prepare("INSERT INTO sources (id, name, grp, enabled) VALUES ('cls','财联社','cls',1)").run();
  db.prepare("INSERT INTO fetch_attempts (run_id, source_id, ok, attempted_at) VALUES ('r0','cls',1,'2026-10-01 00:00:00')").run();
  const list = sourceScores(db, { days: 7, config: [{ id: "cls", name: "财联社" }, { id: "newsite", name: "新源", trial: true }] });
  assert.deepEqual(list.map((x) => [x.id, x.state, x.verdict]), [["newsite", "trial", "new"], ["cls", "on", "insufficient"]]);
  assert.deepEqual(sourceScores(db, { days: 7 }).map((x) => x.id), ["cls"], "不给配置时照旧按库");
  db.close();
});

test("追踪：没进故事线的单篇报道也列出来（主线不列）；两天没动静时说明最后一次在哪个源、那个源开没开", () => {
  const db = tmp();
  db.prepare("INSERT INTO sources (id, name, grp, enabled) VALUES ('guba','股吧','guba',0), ('cls','财联社','cls',1)").run();
  const art = db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, published_at) VALUES (?,?,?,?,?,?)");
  art.run("a1", "https://x/1", "华谊兄弟重整消息落地", "guba", iso(3 * 86400000), iso(3 * 86400000));
  art.run("a2", "https://x/2", "华谊兄弟三季报", "guba", iso(4 * 86400000), iso(4 * 86400000));
  const id = addTracker(db, { name: "华谊兄弟", kind: "company", entities: {} });
  const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(id);
  assert.deepEqual(mentions(db, t).map((x) => x.id), ["a1", "a2"], "按时间倒排");
  const q = quietReason(db, t);
  assert.equal(q.days_quiet, 3);
  assert.deepEqual([q.last.source, q.last.source_id, q.last.source_on], ["股吧", "guba", false]);
  assert.deepEqual(q.sources_on, ["财联社"]);
  art.run("a3", "https://x/3", "华谊兄弟发布公告", "cls", iso(3600000), iso(3600000));
  assert.equal(quietReason(db, t), null, "两天内有提到：不算没动静");
  assert.equal(trackerDetail(db, id).mentions.length, 3);
  const th = addTracker(db, { name: "华谊兄弟风波", kind: "theme", entities: {}, stories: [] });
  assert.deepEqual(mentions(db, db.prepare("SELECT * FROM trackers WHERE id = ?").get(th)), [], "主线不列单篇");
  db.close();
});

test("最新快讯：按时间倒排，同一件事只列一次，分数低的单家报道不列，一个源最多 3 条，版面之后抓到的标「新」，标题去掉列表残留", () => {
  const db = tmp();
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('a','甲','a'), ('b','乙','b')").run();
  const art = db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, published_at, kind) VALUES (?,?,?,?,?,?,?)");
  const ev = db.prepare("INSERT INTO events (event_id, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility) VALUES (?,?,?,?,?,1,?,?,'single')");
  const mem = db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,'seed')");
  const add = (id, src, minAgo, imp, evId, kind, n) => { art.run(id, "https://x/" + id, (id === "a1" ? "2026.11.11 - 9分钟前 " : "") + "标题" + id, src, iso(minAgo * 60000), iso(minAgo * 60000), kind || "news"); if (evId) { if (!db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(evId)) ev.run(evId, "t", id, iso(minAgo * 60000), iso(minAgo * 60000), n || 1, imp); mem.run(evId, id, src, src); } };
  add("a1", "a", 5, 50, "e1");
  add("a2", "a", 10, 50, "e1"); // 同一件事
  add("a3", "a", 15, 10, "e3"); // 分数低、单家
  add("a4", "a", 20, 40, "e4");
  add("a5", "a", 25, 40, "e5");
  add("a6", "a", 30, 40, "e6"); // 甲的第 4 条
  add("b1", "b", 35, null, null);
  add("p1", "b", 1, null, null, "promo");
  const out = latestWire(db, { hours: 6, limit: 10, editionAt: iso(12 * 60000) });
  assert.deepEqual(out.map((x) => x.id), ["a1", "a4", "a5", "b1"]);
  assert.equal(out[0].title, "标题a1", "去掉「2026.11.11 - 9分钟前」");
  assert.deepEqual(out.map((x) => x.fresh), [true, false, false, false]);
  db.close();
});
