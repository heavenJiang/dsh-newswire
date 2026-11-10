import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { editionDiff, editionList, editionById } from "../../host/edition.mjs";

function put(db, runId, at, mode, stories) {
  const content = { stories: Object.fromEntries(Object.entries(stories).map(([id, a]) => [id, { id, article_ids: a }])), headline: "h" + at };
  return Number(db.prepare("INSERT INTO editions (pack, run_id, created_at, mode, content, ok, headline) VALUES ('all', ?, ?, ?, ?, 1, ?)").run(runId, at, mode, JSON.stringify(content), "h" + at).lastInsertRowid);
}

test("diff compares with the last edition before this fetch round; previews and re-layouts of a round count as one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-diff-"));
  const db = openDb(path.join(dir, "n.sqlite"));
  put(db, "r1", "2026-11-10 00:00:00", "rules", { a: ["1"] });
  const base = put(db, "r1", "2026-11-10 00:10:00", "llm", { a: ["1"], b: ["2"], gone: ["9"] });
  put(db, null, "2026-11-10 00:20:00", "llm", { a: ["1"], b: ["2"], gone: ["9"] }); // 改关注后的重排
  const pv = put(db, "r2", "2026-11-10 03:00:00", "rules", { a: ["1"], b: ["2", "3"], c: ["4"] });
  const fin = put(db, "r2", "2026-11-10 03:10:00", "llm", { a: ["1"], b: ["2", "3"], c: ["4"] });
  const re = put(db, null, "2026-11-10 03:20:00", "llm", { a: ["1"], b: ["2", "3"], c: ["4"] });
  for (const id of [pv, fin, re]) {
    const d = editionDiff(db, editionById(db, id));
    assert.equal(d.base_id, base + 1, "base is the last edition before round r2");
    assert.deepEqual(d.stories, { a: "same", b: "dev", c: "new" });
    assert.deepEqual(d.counts, { new: 1, dev: 1, same: 1, gone: 1 });
  }
  assert.equal(editionDiff(db, editionById(db, 1)), null);
  // 往期列表每轮一份，取这一轮最新的
  assert.deepEqual(editionList(db, "all", 10).map((x) => x.id), [re, base + 1]);
  db.close();
});
