import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { editionDiff, editionList, editionById, fillEditionReportTimes } from "../../host/edition.mjs";

function put(db, runId, at, mode, stories) {
  const content = { stories: Object.fromEntries(Object.entries(stories).map(([id, a]) => [id, { id, article_ids: a }])), headline: "h" + at };
  return Number(db.prepare("INSERT INTO editions (pack, run_id, created_at, mode, content, ok, headline) VALUES ('all', ?, ?, ?, ?, 1, ?)").run(runId, at, mode, JSON.stringify(content), "h" + at).lastInsertRowid);
}

test("diff compares with the last edition before this fetch round; previews and re-layouts of a round count as one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-diff-"));
  const db = openDb(path.join(dir, "n.sqlite"));
  const first = put(db, "r1", "2026-11-10 00:00:00", "rules", { a: ["1"] });
  const insertStory = db.prepare("INSERT INTO stories (story_id, pack, title, section, created_at, updated_at, created_edition) VALUES (?, 'all', ?, 'tech', datetime('now'), datetime('now'), ?)");
  insertStory.run("returning", "旧报道重新上版", first);
  insertStory.run("returningDev", "旧报道有进展", first);
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('s', 's', 's')").run();
  db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, published_at) VALUES ('6','https://x/6','续报','s','2026-11-10 03:01:00','2026-11-10 02:55:00')").run();
  const base = put(db, "r1", "2026-11-10 00:10:00", "llm", { a: ["1"], b: ["2"], gone: ["9"] });
  put(db, null, "2026-11-10 00:20:00", "llm", { a: ["1"], b: ["2"], gone: ["9"] }); // 改关注后的重排
  const pv = put(db, "r2", "2026-11-10 03:00:00", "rules", { a: ["1"], b: ["2", "3"], c: ["4"], returning: ["5"], returningDev: ["6"] });
  const fin = put(db, "r2", "2026-11-10 03:10:00", "llm", { a: ["1"], b: ["2", "3"], c: ["4"], returning: ["5"], returningDev: ["6"] });
  const re = put(db, null, "2026-11-10 03:20:00", "llm", { a: ["1"], b: ["2", "3"], c: ["4"], returning: ["5"], returningDev: ["6"] });
  db.prepare("INSERT INTO story_items (article_id, story_id, joined_at, joined_edition) VALUES ('6','returningDev',datetime('now'),?)").run(pv);
  for (const id of [pv, fin, re]) {
    const d = editionDiff(db, editionById(db, id));
    assert.equal(d.base_id, base + 1, "base is the last edition before round r2");
    assert.deepEqual(d.stories, { a: "same", b: "dev", c: "new", returning: "same", returningDev: "dev" });
    assert.deepEqual(d.counts, { new: 1, dev: 2, same: 2, gone: 1 });
  }
  assert.equal(editionDiff(db, editionById(db, 1)), null);
  // 往期列表每轮一份，取这一轮最新的
  assert.deepEqual(editionList(db, "all", 10).map((x) => x.id), [re, base + 1]);
  const archived = editionById(db, fin);
  fillEditionReportTimes(db, archived);
  assert.equal(archived.content.stories.returningDev.latest_published_at, "2026-11-10 02:55:00");
  assert.equal(archived.content.stories.returning.latest_published_at, null);
  db.close();
});
