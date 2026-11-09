/* 源的取舍——贡献评估与建议、试用状态。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { upsertSource } from "../../engine/store/db.mjs";
import { sourceScores, setSourceState, sourceState } from "../../host/sources.mjs";
import { loadLayout, ruleEdition, storyIdFor } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const LAYOUT = Object.assign(loadLayout(null, path.join(CFG, "layout.json")), { min_importance: 0 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v20-")), "n.sqlite"));
  for (const id of ["core", "echo", "noisy", "lonely", "flaky", "tiny"]) upsertSource(db, { id, name: id, type: "rss", url: "https://" + id, trial: id === "echo" }, iso(0));
  return db;
}
let k = 0;
function ev(db, members, importance) {
  const eid = "e" + (++k);
  members.forEach(([src, aid], i) => {
    db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, completeness, kind, pack) VALUES (?,?,?,?,?,?,?,?,?,?,'core')").run(aid, "https://x/" + aid, "标题" + aid, "摘要" + aid, src, iso(3600000 - i * 1000), iso(3600000), iso(3600000 - i * 1000), "full", "news");
    db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(eid, aid, src, src, "seed");
  });
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(eid, "core", "标题" + members[0][1], members[0][1], iso(3600000), iso(3600000), members.length, new Set(members.map((m) => m[0])).size, importance, members.length > 1 ? "corroborated" : "single", JSON.stringify(["politics.conflict"]), JSON.stringify(members.map((m) => ({ source_id: m[0] }))));
  return eid;
}

test("源的贡献：首报多的为核心、常给别家印证的为印证、几乎全是低价值的建议关或试用、抓取常失败的为不稳、数据少的先试用", () => {
  const db = tmpDb();
  for (let i = 0; i < 6; i++) ev(db, [["core", "c" + i], ["echo", "x" + i]], 60);
  for (let i = 0; i < 8; i++) ev(db, [["noisy", "n" + i]], 10);
  ev(db, [["noisy", "n9"], ["core", "c9"]], 50);
  for (let i = 0; i < 6; i++) ev(db, [["lonely", "l" + i]], 5);
  for (let i = 0; i < 6; i++) ev(db, [["flaky", "f" + i]], 30);
  for (let r = 0; r < 4; r++) db.prepare("INSERT INTO fetch_attempts (run_id, source_id, ok, attempted_at) VALUES (?, 'flaky', ?, ?)").run("r" + r, r === 0 ? 1 : 0, iso(60000));
  ev(db, [["tiny", "t1"]], 30);
  const by = Object.fromEntries(sourceScores(db, { days: 7 }).map((x) => [x.id, x]));
  assert.equal(by.core.verdict, "core");
  assert.equal(by.core.first, 6);
  assert.equal(by.echo.verdict, "support");
  assert.equal(by.echo.state, "trial");
  assert.equal(by.echo.suggest, "on", "印证多的试用源建议转正");
  assert.deepEqual([by.noisy.verdict, by.noisy.suggest], ["low", "trial"], "低价值但偶尔能印证：试用");
  assert.deepEqual([by.lonely.verdict, by.lonely.suggest], ["low", "off"], "从不与别家重合：关");
  assert.deepEqual([by.flaky.verdict, by.flaky.fetch_ok], ["unstable", 25]);
  assert.equal(by.tiny.verdict, "insufficient");
  db.close();
});

test("三态开关写配置：关掉清试用；开启清软删除；试用打标记", () => {
  const doc = { sources: [{ id: "a", enabled: false, removed_at: "2026-11-08 16:00:00" }, { id: "b", enabled: true, trial: true }] };
  setSourceState(doc, "a", "trial");
  assert.deepEqual(doc.sources[0], { id: "a", enabled: true, trial: true });
  assert.equal(sourceState(doc.sources[0]), "trial");
  setSourceState(doc, "b", "off");
  assert.deepEqual(doc.sources[1], { id: "b", enabled: false });
  setSourceState(doc, "b", "on");
  assert.equal(sourceState(doc.sources[1]), "on");
  assert.equal(setSourceState(doc, "zz", "on"), null);
  assert.equal(setSourceState(doc, "a", "bogus"), null);
});

test("试用源只能印证：只有试用源报道的事不上版；与正常源同报的照常上版", () => {
  const db = tmpDb();
  ev(db, [["echo", "only1"]], 70);
  ev(db, [["core", "both1"], ["echo", "both2"]], 70);
  const ed = ruleEdition(db, { pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {} });
  assert.ok(!ed.stories[storyIdFor("only1")], "只有试用源的不上版");
  assert.ok(ed.stories[storyIdFor("both1")], "有正常源同报的上版");
  db.close();
});
