/* 模型解读（假模型）、简报、推送消息加摘要、更新检查。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { parseJsonLoose, createModel, analyzeEvents, makeBriefing, latestBriefing, enrichMessage, PROMPT_VERSION } from "../../host/model.mjs";
import { parseSource, compareVersions, UpdateChecker, installedPackage } from "../../host/update.mjs";

/** 假的宿主 llm：按调用顺序吐出给定文字，记录请求。 */
function fakeLlm(replies) {
  const calls = [];
  return {
    calls,
    stream(opts) {
      calls.push(opts);
      const reply = replies.length ? replies.shift() : "";
      return (async function* () {
        if (reply instanceof Error) { yield { type: "finish", reason: { kind: "error", failure: { message: reply.message } } }; return; }
        yield { type: "reasoning-delta", text: "想一想……" };
        for (const part of String(reply).match(/[\s\S]{1,20}/g) || []) yield { type: "text-delta", text: part };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}
const defaultModel = { currentSelection: () => ({ provider: "local", model: "m1" }) };

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-v09-"));
  const db = openDb(path.join(dir, "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name) VALUES (?, ?)").run("cls", "财联社电报");
  db.prepare("INSERT INTO sources (id, name) VALUES (?, ?)").run("reuters", "路透·World");
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id) VALUES (?,?,?,?,?,?,?,?)");
  const ev = db.prepare("INSERT INTO events (event_id, pack, title, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, updated_run) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const mem = db.prepare("INSERT INTO event_members (event_id, article_id, source_id, method) VALUES (?,?,?,?)");
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (let i = 1; i <= 3; i++) {
    art.run("a" + i, "https://x/" + i, "事件" + i + "的报道", "摘要" + i, now, now, now, i === 2 ? "reuters" : "cls");
    ev.run("e" + i, "core", "事件" + i, now, now, 1, 1, 90 - i * 10, "single", JSON.stringify(["macro.monetary"]), "r1");
    mem.run("e" + i, "a" + i, i === 2 ? "reuters" : "cls", "seed");
  }
  return db;
}

test("parseJsonLoose：去掉推理标签和代码围栏，取第一个完整对象", () => {
  assert.deepEqual(parseJsonLoose('<think>{"x":1}</think>好的：```json\n{"a":"b{c}","n":[1,2]}\n```'), { a: "b{c}", n: [1, 2] });
  assert.deepEqual(parseJsonLoose('前言 {"s":"引号\\"里"} 尾巴 {"t":2}'), { s: '引号"里' });
  assert.equal(parseJsonLoose("没有 JSON"), null);
  assert.equal(parseJsonLoose('{"坏的": }'), null);
});

test("createModel：留空用 dsh 默认模型；插件指定时用指定的；没有 llm 服务时不可用", async () => {
  const llm = fakeLlm(["你好"]);
  const m = createModel({ getLlm: () => llm, getDefault: () => defaultModel, timeoutMs: 5000 });
  assert.equal(m.available(), true);
  assert.equal(m.label(), "local/m1");
  assert.equal(await m.complete("问"), "你好", "只收正文，不收推理");
  assert.equal(llm.calls[0].provider, "local");
  assert.equal(llm.calls[0].temperature, 0.2);
  const pinned = createModel({ getLlm: () => llm, getDefault: () => defaultModel, provider: "p", model: "x" });
  assert.equal(pinned.label(), "p/x");
  assert.equal(createModel({ getLlm: () => undefined, getDefault: () => defaultModel }).available(), false);
  assert.equal(createModel({ getLlm: () => llm, getDefault: () => undefined }).available(), false);
  const bad = createModel({ getLlm: () => fakeLlm([new Error("boom")]), getDefault: () => defaultModel });
  await assert.rejects(bad.complete("问"), /boom/);
});

test("analyzeEvents：写入解读；坏 JSON 记失败；已有解读且家数没变就跳过", async () => {
  const db = tmpDb();
  // e1 一次成功；e2 第一次不是 JSON、重试成功；e3 两次都坏
  const llm = fakeLlm(['{"summary":"事件1发生了","why":"影响大","watch":"后续"}', "不是 JSON", '{"summary":"重试后"}', "坏", "也坏"]);
  const m = createModel({ getLlm: () => llm, getDefault: () => defaultModel });
  const r = await analyzeEvents(db, m, { eventIds: ["e1", "e2", "e3"], max: 6 });
  assert.equal(r.done, 2);
  assert.equal(r.failed, 1);
  assert.equal(JSON.parse(db.prepare("SELECT llm_notes FROM events WHERE event_id='e2'").get().llm_notes).summary, "重试后");
  assert.equal(db.prepare("SELECT llm_notes FROM events WHERE event_id='e3'").get().llm_notes, null);
  const n1 = JSON.parse(db.prepare("SELECT llm_notes FROM events WHERE event_id='e1'").get().llm_notes);
  assert.equal(n1.summary, "事件1发生了");
  assert.equal(n1.model, "local/m1");
  assert.equal(n1.v, PROMPT_VERSION);
  assert.match(llm.calls[0].messages[0].content[0].text, /事件1的报道｜财联社电报/);
  const again = await analyzeEvents(db, m, { eventIds: ["e1"], max: 6 });
  assert.equal(again.skipped, 1, "家数没变不重写");
  db.prepare("UPDATE events SET member_count = 2 WHERE event_id='e1'").run();
  llm.calls.length = 0;
  const llm2 = fakeLlm(['{"summary":"更新"}']);
  await analyzeEvents(db, createModel({ getLlm: () => llm2, getDefault: () => defaultModel }), { eventIds: ["e1"], max: 6 });
  assert.equal(JSON.parse(db.prepare("SELECT llm_notes FROM events WHERE event_id='e1'").get().llm_notes).summary, "更新");
  db.close();
});

test("makeBriefing：要点编号映射成事件 id，存档；失败也记录；latestBriefing 取最新成功的", async () => {
  const db = tmpDb();
  const reply = '{"headline":"今日要点","points":[{"text":"要点一","refs":[1,2]},{"text":"要点二","refs":[9]}],"watch":[{"text":"关注","refs":[3]}]}';
  const llm = fakeLlm([reply, "乱写", "还是乱写"]);
  const m = createModel({ getLlm: () => llm, getDefault: () => defaultModel });
  const since = "2000-01-01 00:00:00";
  const b = await makeBriefing(db, m, { pack: "core", since, hours: 12, runId: "r1", names: { "macro.monetary": "货币政策" } });
  assert.equal(b.ok, true);
  assert.deepEqual(b.content.points[0].event_ids, ["e1", "e2"]);
  assert.deepEqual(b.content.points[1].event_ids, [], "越界编号丢掉");
  assert.deepEqual(b.content.watch[0].event_ids, ["e3"]);
  const fail = await makeBriefing(db, m, { pack: "core", since, hours: 12 });
  assert.equal(fail.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM briefings").get().n, 2);
  const last = latestBriefing(db, "core");
  assert.equal(last.headline, "今日要点");
  assert.equal(latestBriefing(db, "study_abroad"), null);
  const few = await makeBriefing(db, m, { pack: "core", since: "2999-01-01 00:00:00" });
  assert.equal(few.error, "too_few_events");
  db.close();
});

test("enrichMessage：标题后加总括，每条后加一句摘要，结尾注明模型；没有选中事件时原样返回", () => {
  const msg = ["📰 要闻 · 11-08 09:00", "源 20/20，新增 30 条，衔接 ✓", "1.【已印证·3源】甲", "   09:00 · https://a", "2.【财联社】乙", "   09:01 · https://b", "依据：多源交叉验证与源头热度。"].join("\n");
  const notes = new Map([["e1", { summary: "甲的摘要" }]]);
  const out = enrichMessage(msg, [{ event_id: "e1" }, { event_id: "e2" }], notes, { headline: "总括" }, "local/m1").split("\n");
  assert.equal(out[2], "📝 总括");
  assert.equal(out[4], "   甲的摘要");
  assert.equal(out[6], "2.【财联社】乙", "没有解读的不加");
  assert.equal(out[out.length - 1], "（摘要由 local/m1 生成）");
  assert.equal(enrichMessage("09:00 无新重点", [], new Map(), null, "x"), "09:00 无新重点");
});

test("更新检查：安装来源解析与版本比较", () => {
  assert.deepEqual(parseSource("github:heavenJiang/dsh-newswire#abc", "dsh-newswire"), { kind: "github", owner: "heavenJiang", repo: "dsh-newswire", ref: "abc" });
  assert.deepEqual(parseSource("https://github.com/o/r.git", "x"), { kind: "github", owner: "o", repo: "r" });
  assert.equal(parseSource("^0.9.0", "dsh-newswire").kind, "npm");
  assert.equal(parseSource("link:../dsh-newswire", "x").kind, "local");
  assert.equal(parseSource("", "x").kind, "unknown");
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.9.0", "0.9.0-beta.1") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

test("更新检查：私有仓库匿名 404 时用凭据重试；读该提交 package.json 的版本", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const auth = init.headers.authorization || null;
    seen.push([url, auth]);
    if (!auth) return { ok: false, status: 404 };
    if (url.endsWith("/commits/HEAD")) return { ok: true, json: async () => ({ sha: "deadbeef", commit: { message: "v9.9.9\n\n详情", committer: { date: "2026-11-08T00:00:00Z" } } }) };
    if (url.includes("/contents/package.json?ref=deadbeef")) return { ok: true, text: async () => JSON.stringify({ version: "9.9.9" }) };
    return { ok: false, status: 500 };
  };
  const c = new UpdateChecker({ fetchImpl, token: async () => "tkn" });
  const r = await c.check("github:o/r", true);
  const pkg = await installedPackage();
  assert.equal(r.installed, pkg.version);
  assert.equal(r.newer, true);
  assert.equal(r.latest.spec, "github:o/r#deadbeef");
  assert.equal(r.latest.summary, "v9.9.9");
  assert.equal(seen.filter((x) => x[1] === "Bearer tkn").length, 2);
  const noToken = await new UpdateChecker({ fetchImpl, token: async () => null }).check("github:o/r", true);
  assert.match(noToken.error, /私有/);
  const local = await new UpdateChecker({ fetchImpl }).check("link:/x", true);
  assert.equal(local.newer, false);
  assert.equal(local.source.kind, "local");
});
