import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { eventRows, itemRows } from "../../engine/query.mjs";

// 首页列表源（没有发布时间）的旧文章每轮还挂在对方首页上：last_seen_at 每轮刷新，但它不是新闻
function art(db, id, published, first, last) {
  db.prepare("INSERT INTO articles (id, url, title, source_id, published_at, first_seen_at, last_seen_at, kind) VALUES (?,?,?,?,?,?,?, 'news')")
    .run(id, "https://x.test/" + id, "t" + id, "s", published, first, last);
}

test("24 hours means reports published (or first fetched) in the last 24 hours, not old ones seen again on a homepage", () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-win-")), "n.sqlite"));
  const since = "2026-11-16 08:00:00";
  art(db, "old", null, "2026-11-11 03:00:00", "2026-11-17 04:00:00"); // 11-11 的旧文，今天还在首页上
  art(db, "new", null, "2026-11-17 04:00:00", "2026-11-17 04:00:00");
  art(db, "pub", "2026-11-16 09:00:00", "2026-11-16 09:05:00", "2026-11-16 09:05:00");
  assert.deepEqual(itemRows(db, { since, limit: 50 }).map((r) => r.id).sort(), ["new", "pub"]);
  assert.equal(itemRows(db, { since, limit: 50 }).find((r) => r.id === "new").time, "2026-11-17 04:00:00");

  const ev = db.prepare("INSERT INTO events (event_id, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance) VALUES (?,?,?,?,?,?,1,50)");
  const mem = db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method, joined_at) VALUES (?,?, 's', ?, 'seed', ?)");
  // 只有旧文、被首页刷新了 last_seen_at 的事件：不算 24 小时内
  ev.run("e-stale", "stale", "old", "2026-11-11 03:00:00", "2026-11-17 04:00:00", 1);
  mem.run("e-stale", "old", "old", "2026-11-11 03:00:00");
  // 11-11 开始、今天有新报道的事件：算，时间写最新那篇
  ev.run("e-dev", "developing", "old", "2026-11-11 03:00:00", "2026-11-17 04:00:00", 2);
  db.prepare("INSERT INTO articles (id, url, title, source_id, published_at, first_seen_at, last_seen_at, kind) VALUES ('old2','https://x.test/old2','t','s',NULL,'2026-11-11 03:00:00','2026-11-17 04:00:00','news')").run();
  mem.run("e-dev", "old2", "old2", "2026-11-11 03:00:00");
  mem.run("e-dev", "new", "new", "2026-11-17 04:00:00");
  const rows = eventRows(db, { since, limit: 10 });
  assert.deepEqual(rows.map((r) => r.event_id), ["e-dev"]);
  assert.equal(rows[0].latest_at, "2026-11-17 04:00:00");
  assert.equal(rows[0].first_seen_at, "2026-11-11 03:00:00");
});
