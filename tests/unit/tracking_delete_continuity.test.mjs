/* 追踪可删除、摘掉挂错的故事线；有断点的源翻到上一轮为止。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { addTracker, removeTracker, unlinkStory, linkStories, trackerDetail, listTrackers } from "../../host/tracking.mjs";
import { renderJob } from "../../engine/channels/browse.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
function db0() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v33-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  for (const [sid, title] of [["s1", "英伟达发布新芯片"], ["s2", "英伟达广告牌上的猫"]]) {
    db.prepare("INSERT INTO stories (story_id, title, section, importance, status, created_at, updated_at) VALUES (?,?, 'industry', 50, 'active', ?, ?)").run(sid, title, iso(3600000), iso(3600000));
    db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, last_seen_at) VALUES (?,?,?, 'cls', ?, ?)").run("a" + sid, "https://x/" + sid, title, iso(3600000), iso(3600000));
    db.prepare("INSERT INTO story_items (article_id, story_id) VALUES (?,?)").run("a" + sid, sid);
  }
  return db;
}

test("摘掉挂错的故事线：之后自动挂也不再挂回来；删除追踪：对象、挂的故事线、综述一并删掉，并返回要撤的关注", () => {
  const db = db0();
  const id = addTracker(db, { name: "英伟达", kind: "company" });
  assert.equal(trackerDetail(db, id).timeline.length, 2);
  unlinkStory(db, id, "s2");
  linkStories(db, id, { days: 3 });
  assert.deepEqual(trackerDetail(db, id).timeline.map((x) => x.id), ["s1"], "摘掉的不再挂回");
  assert.equal(listTrackers(db)[0].stories, 1);
  db.prepare("INSERT INTO tracker_syntheses (tracker_id, at, content) VALUES (?, ?, '{}')").run(id, iso(0));
  const t = removeTracker(db, id);
  assert.deepEqual([t.name, t.stories], ["英伟达", ["s1"]]);
  for (const tb of ["trackers", "tracker_stories", "tracker_syntheses"]) assert.equal(db.prepare("SELECT COUNT(*) n FROM " + tb).get().n, 0, tb + " 删干净");
  assert.equal(removeTracker(db, id), null);
  db.close();
});

test("财联社有断点时翻到上一轮最新那条之前 5 分钟为止；没有断点按时间窗", () => {
  const withCursor = renderJob("cls_api", "https://www.cls.cn/telegraph", 300, { sinceHours: 4, pages: 60, until: "2026-11-09 04:06:49", token: "t" });
  assert.match(withCursor, /const CUT = 1794197209 \? 1794197209 - 300/);
  assert.match(withCursor, /while \(pages < 60\)/);
  const first = renderJob("cls_api", "https://www.cls.cn/telegraph", 60, { sinceHours: 4, pages: 7, token: "t" });
  assert.match(first, /const CUT = 0 \? 0 - 300 : Math\.floor\(Date\.now\(\) \/ 1000\) - 4 \* 3600/);
});
