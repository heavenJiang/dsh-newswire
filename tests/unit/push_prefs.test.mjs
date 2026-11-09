/* 推送体验——节奏、门槛档位、每轮与每天上限、按反馈调版块门槛。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { normalizePush, loadPush, savePush, rulesFor, sectionPenalties, applyDailyCap, recentPushes, bjMidnightUtc } from "../../host/push.mjs";
import { editionPicks } from "../../host/edition.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const tmpDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v23-")), "n.sqlite"));

test("偏好：坏值退回默认、范围夹住；存取往返", () => {
  assert.deepEqual(normalizePush({ cadence: "hourly", level: "max", per_round: 99, daily_max: 0 }), { version: 1, cadence: "every2h", level: "normal", per_round: 15, daily_max: 24 });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-p-")), "push.json");
  assert.equal(loadPush(f).cadence, "every2h", "没有文件用默认");
  savePush(f, { cadence: "thrice", level: "fewer" });
  assert.deepEqual([loadPush(f).cadence, loadPush(f).level], ["thrice", "fewer"]);
});

test("门槛档位：少而精提高门槛、多一些降低；每轮上限不超过偏好", () => {
  const r = { min_corroborated: 50, min_single: 36, max: 8 };
  assert.deepEqual(rulesFor(r, normalizePush({ level: "fewer", per_round: 3 })), { min_corroborated: 62, min_single: 48, max: 3 });
  assert.equal(rulesFor(r, normalizePush({ level: "more" })).min_single, 28);
});

test("反馈：同一版块「没用」比「有用」多 3 次以上门槛 +10，多 6 次 +20；editionPicks 据此跳过", () => {
  const db = tmpDb();
  const fb = (kind, sec, n) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (?,?,?,?)").run(iso(0), kind, "s" + kind + sec + i, sec); };
  fb("push_down", "markets", 4); fb("push_up", "markets", 1);
  fb("push_down", "industry", 6);
  fb("push_down", "politics", 2);
  assert.deepEqual(sectionPenalties(db), { markets: 10, industry: 20 });
  const ed = { stories: {
    a: { id: "a", title: "市场新闻", section: "markets", importance: 55, source_count: 2, credibility: "corroborated", first_seen_at: iso(600000), article_ids: [], event_ids: [] },
    b: { id: "b", title: "时政新闻", section: "politics", importance: 55, source_count: 2, credibility: "corroborated", first_seen_at: iso(600000), article_ids: [], event_ids: [] },
  } };
  const picks = editionPicks(db, ed, { min_corroborated: 50, min_single: 36, max: 8 }, { nowIso: iso(0), lookbackHours: 6, penalties: sectionPenalties(db) });
  assert.deepEqual(picks.map((x) => x.id), ["b"]);
  db.close();
});

test("每天上限：今天推过的算进去，超出的留在面板；关注的优先", () => {
  const db = tmpDb();
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO pushes (run_id, article_id, pushed_at, score, reason) VALUES ('r', ?, ?, 50, 'new')").run("x" + i, iso(60000));
  db.prepare("INSERT INTO pushes (run_id, article_id, pushed_at, score, reason) VALUES ('r', 'old', ?, 50, 'new')").run(new Date(Date.parse(bjMidnightUtc().replace(" ", "T") + "Z") - 3600000).toISOString().replace("T", " ").slice(0, 19));
  const picks = [{ id: "p1" }, { id: "p2" }, { id: "p3", followed: ["英伟达"] }];
  const r = applyDailyCap(db, picks, normalizePush({ daily_max: 4 }));
  assert.equal(r.today, 3, "昨天的不算");
  assert.deepEqual(r.send.map((x) => x.id), ["p3"]);
  assert.equal(r.held, 2);
  db.close();
});

test("推送记录带上读者的最近一次反馈", () => {
  const db = tmpDb();
  db.prepare("INSERT INTO stories (story_id, title, section, status) VALUES ('st1', '沙特遇袭', 'politics', 'active')").run();
  db.prepare("INSERT INTO pushes (run_id, article_id, story_id, pushed_at, score, reason) VALUES ('r', 'a1', 'st1', ?, 60, 'new')").run(iso(0));
  db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (?, 'push_up', 'st1', 'politics')").run(iso(0));
  const r = recentPushes(db, 10);
  assert.deepEqual([r[0].title, r[0].section, r[0].vote], ["沙特遇袭", "politics", "push_up"]);
  db.close();
});
