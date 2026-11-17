import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { latestAllId, latestEdition } from "../../host/edition.mjs";

function put(db, pack, at, since, headline) {
  const content = { pack, since, headline, stories: {}, front: [], sections: [] };
  return Number(db.prepare("INSERT INTO editions (pack, run_id, created_at, mode, content, ok, headline) VALUES (?, NULL, ?, 'llm', ?, 1, ?)").run(pack, at, JSON.stringify(content), headline).lastInsertRowid);
}

test("全部内容 shows the fresher of the all and core editions, not an old all edition re-saved by reflows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-all-"));
  const db = openDb(path.join(dir, "n.sqlite"));
  put(db, "all", "2026-11-13 12:06:37", "2026-11-12 14:11:10", "old all");
  const core = put(db, "core", "2026-11-17 04:02:29", "2026-11-16 16:00:40", "fresh core");
  // 改关注后的重排：把旧的 all 版面另存成新的一行（id 更新、内容还是 11-12 的）
  put(db, "all", "2026-11-17 04:30:00", "2026-11-12 14:11:10", "old all");
  assert.equal(latestAllId(db), core);
  assert.equal(latestEdition(db, "all").headline, "fresh core");
  assert.equal(latestEdition(null, "all"), null);
  // 读者手动重排出一份更新的 all：它更新，就看它
  const all2 = put(db, "all", "2026-11-17 05:00:00", "2026-11-16 17:00:00", "new all");
  assert.equal(latestAllId(db), all2);
  // 指定包照旧
  assert.equal(latestEdition(db, "core").id, core);
});
