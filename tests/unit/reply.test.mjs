/* 短推送与回复序号：消息里每条有当天唯一的序号；回复「3」展开、「3 详」详细报道、「3 有用 / 没用」反馈、「3 追踪」关注；感兴趣的行为算半票有用。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { composeEditionMessage, recordEditionPushes, orderPicks, storyDetail } from "../../host/edition.mjs";
import { parseReply, numberPicks, storyOfNumber, trackedIn, composeExpand, composeDetail } from "../../host/reply.mjs";
import { sectionPenalties, noteInterest, feedbackStats } from "../../host/push.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const st = (id, section, importance, extra) => Object.assign({ id, title: "标题" + id, section, importance, reason: "new", lead: "11月10日，" + id + "的导语第一句，写明时间和地点。第二句补充细节，用来确认短消息里只留一句。", points: [{ text: "要点一" }], impact: "影响一句。",
  outlets: [{ name: "财联社电报" }], links: [{ name: "财联社电报", url: "https://www.cls.cn/detail/1" }], url: "https://www.cls.cn/detail/1", first_seen_at: "2026-11-10 10:00:00", lead_article_id: "a-" + id, lead_event_id: "e-" + id, credibility: "single" }, extra || {});
const tmp = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-reply-")), "n.sqlite"));

test("解析回复：只有序号是展开；没用先于有用；后面跟一长句的不算", () => {
  assert.deepEqual(parseReply("3"), { n: 3, action: "expand", rest: "" });
  assert.equal(parseReply(" #12 详").action, "detail");
  assert.equal(parseReply("第5条 详细").n, 5);
  assert.equal(parseReply("7 没用").action, "down");
  assert.equal(parseReply("7有用").action, "up");
  assert.equal(parseReply("7 👍").action, "up");
  assert.equal(parseReply("9 追踪").action, "follow");
  assert.equal(parseReply("3 月份的数据怎么样，帮我查一下"), null);
  assert.equal(parseReply("3 天气"), null, "认不出的词不当成序号回复");
  assert.equal(parseReply("帮我看看新闻"), null);
  assert.equal(parseReply("0"), null);
});

test("当天序号：按消息里的顺序接着今天已推的往下编，记进推送；短消息每条只有标题、一句话和来源，结尾教怎么回复", () => {
  const db = tmp();
  const picks = [st("m", "markets", 40), st("p", "politics", 70), st("t", "tech", 45, { reason: "followup", update_text: "新增 2 篇：某公司回应。后面还有一句。" })];
  numberPicks(db, orderPicks(picks).flatMap((g) => g.items));
  assert.deepEqual(picks.map((x) => [x.id, x.n]), [["m", 3], ["p", 1], ["t", 2]], "重点第 1，其余按分组顺序");
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  recordEditionPushes(db, picks, "r1", now, "core");
  const again = [st("x", "society", 30)];
  numberPicks(db, again);
  assert.equal(again[0].n, 4, "同一天接着编");
  assert.equal(numberPicks(db, [st("y", "society", 30)], Date.now() + 2 * 86400000)[0].n, 1, "过了一天从 1 重新编");
  assert.equal(storyOfNumber(db, 2).story_id, "t");
  assert.equal(storyOfNumber(db, 9), null);

  const brief = composeEditionMessage({ hhmm: "18:08", md: "11-10", warnings: [], title: "要闻", format: "brief", tracked: [{ name: "英伟达", stories: ["t"] }] }, picks, { headline: "总括", mode: "llm", model: "m", items_read: 9 }, {}).split("\n");
  assert.equal(brief[3], "🔭 你追踪的有动静：英伟达");
  const p = brief.indexOf("**1. 标题p**");
  assert.equal(brief[p + 1], "p的导语第一句，写明时间和地点。", "短消息只留一句");
  assert.match(brief[p + 2], /^\[财联社电报\]/, "重点也不带要点和影响");
  assert.ok(!brief.some((l) => l.startsWith("· ") || l.startsWith("影响：")));
  const t = brief.indexOf("**2. 【进展】标题t** 🔭英伟达");
  assert.ok(t > 0, brief.join("|"));
  assert.equal(brief[t + 1], "进展：新增 2 篇：某公司回应。");
  assert.equal(brief.at(-2), "回复序号看要点（如「3」）；「3 详」写详细报道；「3 有用 / 没用」调整以后推什么。");
  const full = composeEditionMessage({ hhmm: "18:08", md: "11-10", warnings: [], title: "要闻" }, picks, { mode: "llm", model: "m", items_read: 9 }, {});
  assert.match(full, /\*\*1\. 标题p\*\*\np的导语第一句，写明时间和地点。第二句补充细节[^\n]*\n· 要点一\n影响：影响一句。/, "长消息照旧，重点带要点和影响");
  const short = brief.join("\n").length, long = full.length;
  assert.ok(short < long, short + " < " + long);
  db.close();
});

test("展开与详细报道的消息；追踪对象命中；感兴趣算半票有用", () => {
  const db = tmp();
  db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, copy, created_at, updated_at) VALUES ('s1','all','霍尔木兹海峡油轮起火','politics','[]',80,'active',?, '2026-11-10 08:00:00','2026-11-10 12:00:00')")
    .run(JSON.stringify({ lead: "伊朗称多艘油轮起火。", points: [{ text: "3 艘油轮起火" }, { text: "原油涨超 4%" }], views: [{ who: "美国国务院", says: "密切关注" }], impact: "油价承压。", by: "llm" }));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社电报','cls')").run();
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, published_at, first_seen_at) VALUES ('a1','https://x/a1','伊朗称油轮起火','伊朗官方媒体称 3 艘油轮起火。','cls','2026-11-10 08:00:00','2026-11-10 08:00:00')").run();
  db.prepare("INSERT INTO story_items (article_id, story_id, joined_at) VALUES ('a1','s1','2026-11-10 08:00:00')").run();
  db.prepare("INSERT INTO story_updates (story_id, at, text, items, by) VALUES ('s1','2026-11-10 10:00:00','新增 1 篇：原油大涨',1,'rules')").run();
  const msg = composeExpand(7, storyDetail(db, "s1"));
  assert.match(msg, /^\*\*7\. 霍尔木兹海峡油轮起火\*\*\n伊朗称多艘油轮起火。\n\n· 3 艘油轮起火\n· 原油涨超 4%\n\n\*\*各方说法\*\*\n· 美国国务院：密切关注\n\n影响：油价承压。\n\n\*\*进展\*\*\n· 18:00 新增 1 篇：原油大涨\n\n1 篇报道 · \[财联社电报\]\(https:\/\/x\/a1\)\n回复「7 详」/);
  const dm = composeDetail(7, "霍尔木兹海峡油轮起火", { model: "m", materials: [1, 2], overview: { text: "概述。" }, timeline: [{ time: "11月10日 08:00", text: "起火。" }], numbers: [{ text: "3 艘。" }], views: [{ who: "美方", says: "关注。" }], background: null, open: [], check: { dropped: 1 } });
  assert.match(dm, /^📰 \*\*7\. 霍尔木兹海峡油轮起火\*\* · 详细报道\n\n概述。\n\n\*\*经过\*\*\n· 11月10日 08:00 起火。\n\n\*\*关键数字\*\*\n· 3 艘。\n\n\*\*各方说法\*\*\n· 美方：关注。\n\n由 m 读 2 篇报道写成，逐句与原文核对（1 句核对不上已删去）/);

  db.prepare("INSERT INTO trackers (id, name, kind, status, aliases, created_at) VALUES ('t1','中东局势','theme','active','[]','2026-11-01 00:00:00')").run();
  db.prepare("INSERT INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES ('t1','s1','2026-11-10 08:00:00','auto')").run();
  assert.deepEqual(trackedIn(db, ["s1", "s2"]), [{ name: "中东局势", stories: ["s1"] }]);
  assert.deepEqual(trackedIn(db, []), []);

  // 6 次「没用」本来 +20；点开看过 4 次（各算半票有用）→ 净 4 次 → +10
  const fb = db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (datetime('now'), 'push_down', ?, 'politics')");
  for (let i = 0; i < 6; i++) fb.run("d" + i);
  assert.deepEqual(sectionPenalties(db), { politics: 20 });
  for (let i = 0; i < 4; i++) { db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'active',datetime('now'),datetime('now'))").run("o" + i, "all", "t", "politics", "[]", 50); assert.equal(noteInterest(db, "push_open", "o" + i), true); }
  assert.equal(noteInterest(db, "push_open", "o0"), false, "同一条同一种一天只记一次");
  assert.equal(noteInterest(db, "bogus", "o0"), false);
  assert.deepEqual(sectionPenalties(db), { politics: 10 });
  assert.deepEqual(feedbackStats(db), { up: 0, down: 6, interest: 4, pushed: 0 });
  db.close();
});

test("一条推送写多少有上限：隔夜上百条时，前 12 条一句话、再 18 条只列标题、其余只报个数；条数不多时照旧", async () => {
  const { tierPicks, restGroups, worthSaying } = await import("../../host/edition.mjs");
  const many = Array.from({ length: 56 }, (_, i) => st("s" + i, i % 3 === 0 ? "tech" : i % 3 === 1 ? "markets" : "politics", 20 + i, i === 3 ? { followed: [{ kind: "keyword" }] } : {}));
  const t = tierPicks(many);
  assert.deepEqual([t.detail.length, t.titles.length, t.rest.length], [12, 18, 26]);
  assert.equal(t.detail[0].id, "s55", "按重要度排");
  assert.ok(!t.detail.some((s) => s.id === "s3") && !t.titles.some((s) => s.id === "s3"), "关注的只加 10 分：重要度 23 的琐碎关注项挤不进前面");
  assert.equal(tierPicks([st("a", "tech", 50), st("b", "tech", 45, { followed: [{}] })]).detail[0].id, "b", "分数接近时关注的在前");
  assert.equal(tierPicks(many.slice(0, 16)).titles.length, 0, "只多出 4 条以内：全部写一句话");
  assert.deepEqual(restGroups(t.rest).map((g) => g.n).reduce((a, b) => a + b, 0), 26);

  const db = tmp();
  t.titles.forEach((s) => { s.title_only = true; });
  const shown = t.detail.concat(t.titles);
  numberPicks(db, orderPicks(t.detail).flatMap((g) => g.items).concat(t.titles));
  const msg = composeEditionMessage({ hhmm: "07:16", md: "11-12", warnings: [], title: "要闻", format: "brief", rest: restGroups(t.rest), totals: { all: 56, fresh: 56 } }, shown, { mode: "llm", model: "m", items_read: 9 }, {});
  const L = msg.split("\n");
  assert.equal(L[1], "新报道 56 件", "总数按全部算");
  assert.ok(L.includes("**还有这些**"));
  assert.ok(L.some((l) => /^13\. 标题s\d+$/.test(l)), "第二档一行一条、只有序号和标题");
  assert.ok(L.some((l) => /^另有 26 条没有列出（.*），在面板「今日」里看。$/.test(l)));
  assert.equal(L.filter((l) => /^\*\*\d+\. /.test(l)).length, 12);
  assert.ok(msg.length < 3200, "上百条也只有两三千字：" + msg.length);

  assert.equal(worthSaying("俄罗斯称其在黑海击中一艘货船。", "俄罗斯称在黑海击中一艘货船"), false, "只是把标题再说一遍");
  assert.equal(worthSaying("Nvidia's Asian Cloud Partners Have a Debt Problem X.PIN 长文分析", "英伟达主权AI战略带动数据中心热"), false, "没译过的外文摘要");
  assert.equal(worthSaying("俄罗斯称在黑海击中一艘货船，船上 12 名船员获救，乌方尚未回应。", "俄罗斯称在黑海击中一艘货船"), true);
  assert.equal(worthSaying("进展：新增 1 篇：承销商考虑上调估值", "Anthropic路演11月19日上市"), true);
  db.close();
});
