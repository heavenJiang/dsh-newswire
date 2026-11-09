/* 关注与屏蔽。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { normalizeFollows, updateFollows, matchList, applyFollows, loadFollows } from "../../host/follows.mjs";
import { loadLayout, ruleEdition, saveEdition, editionPicks, recordEditionPushes, composeEditionMessage, storyIdFor } from "../../host/edition.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const LAYOUT = loadLayout(null, path.join(ROOT, "layout.json"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

test("关注清单：去重、关注与屏蔽互斥、坏项丢弃、坏文件退回空", () => {
  let f = normalizeFollows({ follow: [{ kind: "keyword", value: "英伟达|NVIDIA" }, { kind: "keyword", value: "英伟达|nvidia" }, { kind: "bad", value: "x" }, { kind: "topic", value: "" }] });
  assert.equal(f.follow.length, 1);
  f = updateFollows(f, "mute", "keyword", "英伟达|NVIDIA");
  assert.equal(f.follow.length, 0, "屏蔽后不再关注");
  assert.equal(f.mute.length, 1);
  f = updateFollows(f, "unmute", "keyword", "英伟达|NVIDIA");
  assert.equal(f.mute.length, 0);
  assert.throws(() => updateFollows(f, "follow", "nope", "x"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-f-"));
  fs.writeFileSync(path.join(dir, "f.json"), "{坏");
  assert.deepEqual(loadFollows(path.join(dir, "f.json")), { version: 1, follow: [], mute: [] });
});

test("匹配：关键词别名不分大小写、主题前缀、来源、故事线", () => {
  const story = { id: "st-1", title: "芯片出口新规", section: "tech", labels: ["tech.chips"], outlets: [{ source_id: "reuters" }] };
  const items = [{ title: "Nvidia shares fall", summary: "", source_id: "reuters" }];
  const L = [{ kind: "keyword", value: "英伟达|NVIDIA" }, { kind: "topic", value: "tech" }, { kind: "topic", value: "te" }, { kind: "source", value: "reuters" }, { kind: "story", value: "st-1" }, { kind: "keyword", value: "苹果" }];
  assert.deepEqual(matchList(L, story, items).map((x) => x.value), ["英伟达|NVIDIA", "tech", "reuters", "st-1"]);
});

test("屏蔽优先；只由被屏蔽来源报道的故事线不出现；关注项标出显示名", () => {
  const mk = (id, title, src) => ({ id, title, section: "politics", labels: [], _g: { items: [{ title, source_id: src }] } });
  const f = normalizeFollows({ follow: [{ kind: "keyword", value: "沙特", name: "中东" }, { kind: "keyword", value: "伊朗" }], mute: [{ kind: "keyword", value: "伊朗" }, { kind: "source", value: "spam" }] });
  const out = applyFollows([mk("a", "沙特遇袭", "cls"), mk("b", "伊朗油轮", "cls"), mk("c", "广告", "spam")], f);
  assert.deepEqual(out.map((s) => s.id), ["a"]);
  assert.deepEqual(out[0].followed, ["中东"]);
});

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v13-")), "n.sqlite"));
  for (const [id, name] of [["cls", "财联社电报"], ["moe", "教育部"], ["ap", "美联社"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  return db;
}
function add(db, id, title, src, ev, imp, labels) {
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "https://x/" + id, title, title, t, t, t, src, "core");
  db.prepare("INSERT OR IGNORE INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets, factors) VALUES (?,?,?,?,?,?,1,1,?,?,?,?,?)").run(ev, "core", title, id, t, t, imp, "single", JSON.stringify(labels || ["politics.conflict"]), JSON.stringify([{ source_id: src }]), "{}");
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(ev, id, src, src, "seed");
}
const opts = (follows) => ({ pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, follows });

test("版面：「我的关注」放在各版块之前、不受门槛限制、不重复；屏蔽的不上版但照样登记", () => {
  const db = tmpDb();
  add(db, "a1", "沙特首都遇袭", "cls", "e1", 80);
  add(db, "a2", "英伟达发布新芯片", "ap", "e2", 26, ["tech.chips"]);
  add(db, "a3", "伊朗油轮触雷", "cls", "e3", 70);
  const f = normalizeFollows({ follow: [{ kind: "keyword", value: "英伟达|NVIDIA" }, { kind: "keyword", value: "沙特" }], mute: [{ kind: "keyword", value: "伊朗" }] });
  const ed = ruleEdition(db, opts(f));
  assert.equal(ed.sections[0].id, "following");
  assert.deepEqual(ed.sections[0].stories, [storyIdFor("a1"), storyIdFor("a2")]);
  assert.ok(!ed.sections.slice(1).some((x) => x.stories.includes(storyIdFor("a1"))), "不在其它版块重复");
  assert.ok(!ed.stories[storyIdFor("a3")], "屏蔽的不上版");
  saveEdition(db, ed, {});
  assert.equal(db.prepare("SELECT story_id FROM story_items WHERE article_id = 'a3'").get().story_id, storyIdFor("a3"), "屏蔽的照样登记");
  db.close();
});

test("推送：关注的门槛低（min_follow）并标 ★；关注的故事线有新报道再推（↻）；require_labels 不拦关注项", () => {
  const db = tmpDb();
  add(db, "a2", "英伟达发布新芯片", "ap", "e2", 26, ["tech.chips"]);
  add(db, "a1", "沙特首都遇袭", "cls", "e1", 80);
  const f = normalizeFollows({ follow: [{ kind: "keyword", value: "英伟达|NVIDIA" }] });
  const rules = { min_corroborated: 50, min_single: 36, max: 8, upgrade_jump: 20, min_follow: 20, require_labels: ["politics"] };
  const nowIso = iso(0);
  const ed = ruleEdition(db, opts(f));
  saveEdition(db, ed, {});
  const picks = editionPicks(db, ed, rules, { nowIso, lookbackHours: 6 });
  assert.deepEqual(picks.map((p) => p.title), ["沙特首都遇袭", "英伟达发布新芯片"]);
  recordEditionPushes(db, picks, "r1", nowIso, "core");
  const msg = composeEditionMessage({ hhmm: "09:00", md: "11-09", stats: "源", warnings: [], title: "要闻" }, picks, ed, {});
  assert.match(msg, /\n2\. 英伟达发布新芯片 ★\n美联社 · /);
  assert.ok(!msg.includes("\n英伟达发布新芯片\n"), "导语与标题相同时不重复");
  // 关注的故事线来了新报道
  const t = iso(600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES ('a4','https://x/a4','英伟达芯片续报','',?,?,?,'cls','core')").run(t, t, t);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES ('e2','a4','cls','cls','title')").run();
  const ed2 = ruleEdition(db, opts(f));
  const again = editionPicks(db, ed2, rules, { nowIso: iso(0), lookbackHours: 6 });
  assert.deepEqual(again.map((p) => [p.title, p.reason]), [["英伟达发布新芯片", "followup"]]);
  assert.match(composeEditionMessage({ hhmm: "11:00", md: "11-09", stats: "源", warnings: [], title: "要闻" }, again, ed2, {}), /\n1\. 【进展】英伟达发布新芯片 ★\n/);
  db.close();
});
