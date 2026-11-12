/* 直接推送与插件时钟：桥接插件的 phonePush 服务有就直接发、暂停定时任务按 cron 自己跑；服务没了就交还定时任务。两边互不依赖。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { ruleEdition, saveEdition, loadLayout } from "../../host/edition.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(PKG, "engine", "config");

/** 挂一个插件实例：可选地给 phonePush；返回路由调用、定时任务记录与「拔掉」服务的函数。 */
async function mount(o) { return mountAt(null, null, o); }
async function mountAt(dir0, tasks0, o0) {
  const o = o0 || {};
  const dir = dir0 || fs.mkdtempSync(path.join(os.tmpdir(), "nw-direct-"));
  const tasks = tasks0 || new Map();
  const calls = [];
  const schedule = {
    async list() { return { items: Array.from(tasks.values()) }; },
    async create(req) { const t = { id: "schedule-" + (tasks.size + 1), kind: "cron", title: req.title, prompt: req.prompt, expression: req.timing.cron.expression, timeZone: req.timing.cron.time_zone, status: "active", scheduledAt: "2026-11-11T01:00:00.000Z" }; tasks.set(t.id, t); return t; },
    async edit(req) { calls.push(["edit", req.id, req.patch]); const t = tasks.get(req.id); if (!t) return { code: "schedule_not_found" }; if (req.patch && req.patch.active !== undefined) t.status = req.patch.active ? "active" : "paused"; return t; },
    async run(req) { calls.push(["run", req.id]); return tasks.get(req.id) || { code: "schedule_not_found" }; },
  };
  const sent = [];
  const phone = { available: () => o.unavailable !== true, async send(text, opt) { sent.push({ text, source: opt && opt.source }); return { delivered: 1 }; } };
  let unplug = null;
  const routes = [];
  const tools = [];
  const disposers = [];
  const ctx = {
    inject(deps, fn) {
      if (deps[0] === "schedule") fn({ schedule, effect: () => {} });
      if (deps[0] === "phonePush" && o.phone) fn({ phonePush: phone, effect: (f) => { unplug = f(); } });
    },
    effect(fn) { disposers.push(fn()); },
    tools: { register: (def) => { tools.push(def); return () => {}; } },
    connection: { fetch: { register: (def) => { routes.push(def); return () => {}; } } },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
    logger: { info() {}, warn() {} },
    subprocess: { spawn: () => { throw new Error("no subprocess in this test"); } },
  };
  const mod = await import(path.join(PKG, "index.js") + "?t=" + Math.random());
  mod.apply(ctx, { dataDir: dir });
  const call = async (p, body) => {
    const r = routes.find((x) => x.path === p);
    const res = await r.fetch(new Request("http://x" + p, body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    return res.json();
  };
  const tool = (name) => tools.find((t) => t.name === name);
  // 一份版面（没有报道也行：推送按钮会说「都推过了」，照样是一条消息）
  if (dir0) return { dir, tasks, calls, sent, call, tool, unplug: () => unplug && unplug(), dispose: () => disposers.forEach((d) => typeof d === "function" && d()) };
  await call("/api/newswire/push");
  const db = openDb(path.join(dir, "news.sqlite"));
  const layout = loadLayout(null, path.join(ROOT, "layout.json"));
  saveEdition(db, ruleEdition(db, { pack: "all", since: "2026-11-10 00:00:00", hours: 12, layout, names: {}, taxonomy: [] }), { runId: "r0" });
  db.close();
  return { dir, tasks, calls, sent, call, tool, unplug: () => unplug && unplug(), dispose: () => disposers.forEach((d) => typeof d === "function" && d()) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("没有桥接插件：照旧经定时任务（触发任务让模型转发），不暂停任务", async () => {
  const m = await mount({ phone: false });
  await m.tool("newswire_schedule_setup").execute({});
  const v = await m.call("/api/newswire/push");
  assert.equal(v.direct.service, false);
  assert.equal(v.direct.on, false);
  assert.equal([...m.tasks.values()][0].status, "active");
  const r = await m.call("/api/newswire/push/now", {});
  assert.equal(r.ok, true);
  await wait(50);
  assert.ok(m.calls.some((c) => c[0] === "run"), "触发定时任务");
  m.dispose();
});

test("有桥接插件：暂停定时任务、按 cron 自己跑；推送直接发到手机，不触发任务；服务没了就交还", async () => {
  const m = await mount({ phone: true });
  await m.tool("newswire_schedule_setup").execute({});
  const v = await m.call("/api/newswire/push");
  assert.equal(v.direct.on, true);
  assert.equal(v.direct.clock, true, "时钟接管了任务");
  assert.ok(v.direct.next, "算出了下一次");
  assert.equal([...m.tasks.values()][0].status, "paused", "宿主任务暂停，不再让模型转发");
  const r = await m.call("/api/newswire/push/now", {});
  assert.equal(r.ok, true);
  await wait(50);
  assert.equal(m.sent.length, 1, "直接发了一条");
  assert.equal(m.sent[0].source, "dsh-newswire");
  assert.ok(!m.calls.some((c) => c[0] === "run"), "没有触发定时任务");
  // 改回「经定时任务」：马上交还
  await m.call("/api/newswire/push", { delivery: "task" });
  const v2 = await m.call("/api/newswire/push");
  assert.equal(v2.direct.on, false);
  assert.equal([...m.tasks.values()][0].status, "active", "任务恢复");
  await m.call("/api/newswire/push", { delivery: "auto" });
  assert.equal((await m.call("/api/newswire/push")).direct.clock, true, "改回直接发又接管");
  // 桥接插件卸载：服务没了，马上交还
  m.unplug();
  const v3 = await m.call("/api/newswire/push");
  assert.equal(v3.direct.service, false);
  assert.equal([...m.tasks.values()][0].status, "active");
  m.dispose();
});

test("用户在直接推送期间暂停任务：时钟不再跑它，也不会被自动恢复", async () => {
  const m = await mount({ phone: true });
  await m.tool("newswire_schedule_setup").execute({});
  await m.call("/api/newswire/push");
  await m.tool("newswire_schedule_setup").execute({ action: "pause" });
  const v = await m.call("/api/newswire/push");
  assert.equal(v.direct.clock, false);
  assert.equal([...m.tasks.values()][0].status, "paused");
  m.unplug();
  await m.call("/api/newswire/push");
  assert.equal([...m.tasks.values()][0].status, "paused", "交还时不恢复用户自己暂停的");
  m.dispose();
});

test("刚启动、桥接插件还没加载：先不交还上次接管的任务（等 3 分钟），免得重启时来回切换", async () => {
  const m = await mount({ phone: true });
  await m.tool("newswire_schedule_setup").execute({});
  await m.call("/api/newswire/push");
  assert.equal([...m.tasks.values()][0].status, "paused");
  m.dispose();
  // 同一个数据目录重新挂载，这次还没有 phonePush
  const again = await mountAt(m.dir, m.tasks);
  await again.call("/api/newswire/push");
  assert.equal([...m.tasks.values()][0].status, "paused", "启动 3 分钟内不交还");
  again.dispose();
});

test("推送链路自检：没装桥接插件、装了但没填聊天、直接推送生效，三种情况各说清原因和修法", async () => {
  const a = await mount({ phone: false });
  await a.tool("newswire_schedule_setup").execute({});
  const ha = (await a.call("/api/newswire/push")).health;
  assert.equal(ha.route, "task");
  assert.equal(ha.ok, false);
  assert.match(ha.summary, /经定时任务/);
  assert.match(ha.steps.find((x) => x.id === "bridge").fix, /掌上指挥台/);
  a.dispose();

  const b = await mount({ phone: true, unavailable: true });
  await b.tool("newswire_schedule_setup").execute({});
  const hb = (await b.call("/api/newswire/push")).health;
  assert.equal(hb.route, "task");
  assert.equal(hb.steps.find((x) => x.id === "bridge").ok, true);
  const chats = hb.steps.find((x) => x.id === "chats");
  assert.equal(chats.ok, false);
  assert.match(chats.fix, /定时任务推送聊天/);
  assert.equal([...b.tasks.values()][0].status, "active", "发不出去就不接管");
  const tb = await b.tool("newswire_push_prefs").execute({});
  assert.equal(tb.health.route, "task");
  b.dispose();

  const c = await mount({ phone: true });
  await c.tool("newswire_schedule_setup").execute({});
  const hc = (await c.call("/api/newswire/push")).health;
  assert.equal(hc.route, "direct");
  assert.equal(hc.ok, true);
  assert.ok(hc.steps.every((x) => x.ok || x.id === "recent"), JSON.stringify(hc.steps));
  await c.call("/api/newswire/push/now", {});
  await wait(80);
  const last = (await c.call("/api/newswire/push")).health.steps.find((x) => x.id === "last");
  assert.ok(last && last.ok, "记下最近一次直接发送");
  c.dispose();
});

test("手机上回复序号：能直接发时插件自己发（不让模型转述）；不能时把消息交回；有用没用、追踪记下来", async () => {
  const seed = (dir) => {
    const db = openDb(path.join(dir, "news.sqlite"));
    db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, copy, created_at, updated_at) VALUES ('s1','all','霍尔木兹海峡油轮起火','politics','[]',80,'active',?, datetime('now'), datetime('now'))").run(JSON.stringify({ lead: "伊朗称多艘油轮起火。", points: [{ text: "3 艘油轮起火" }], by: "llm" }));
    db.prepare("INSERT INTO pushes (run_id, story_id, pack, score, reason, pushed_at, n) VALUES ('r1','s1','core',80,'new',datetime('now'),5)").run();
    db.close();
  };
  const a = await mount({ phone: true });
  seed(a.dir);
  a.sent.length = 0;
  const r = await a.call("/api/newswire/reply", { text: "5" });
  assert.equal(r.sent, true);
  assert.equal(r.message, "");
  assert.equal(r.action, "expand");
  assert.match(a.sent[0].text, /^\*\*5\. 霍尔木兹海峡油轮起火\*\*\n伊朗称多艘油轮起火。\n\n· 3 艘油轮起火/);
  const viaTool = await a.tool("newswire_reply").execute({ text: "5 没用" });
  assert.equal(viaTool.sent, true);
  assert.match(a.sent.at(-1).text, /已记下：「霍尔木兹海峡油轮起火」没用/);
  await a.call("/api/newswire/reply", { text: "5 追踪" });
  assert.match(a.sent.at(-1).text, /已关注/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(a.dir, "follows.json"), "utf8")).follow.some((f) => f.kind === "story" && f.value === "s1"));
  const d = await a.call("/api/newswire/reply", { text: "5 详" });
  assert.equal(d.error, "no_model", "没有模型时说明白，不假装在写");
  const miss = await a.call("/api/newswire/reply", { text: "42" });
  assert.equal(miss.error, "no_such_number");
  const db = openDb(path.join(a.dir, "news.sqlite"));
  assert.deepEqual(db.prepare("SELECT kind FROM feedback WHERE story_id = 's1' ORDER BY id").all().map((x) => x.kind), ["push_open", "push_down", "push_follow", "push_detail"]);
  db.close();
  a.dispose();

  const b = await mount({ phone: false });
  seed(b.dir);
  const rb = await b.call("/api/newswire/reply", { text: "5" });
  assert.equal(rb.sent, false);
  assert.match(rb.message, /^\*\*5\. 霍尔木兹海峡油轮起火/, "发不了就把消息交回去由模型原样回复");
  const bad = await b.call("/api/newswire/reply", { text: "今天有什么新闻" });
  assert.equal(bad.error, "not_a_reply");
  b.dispose();
});

test("补跑：重启后发现 75 分钟内错过了一个整点、之后没跑过一轮，就补跑一次；跑过的不补", async (t) => {
  // 时间表：十分钟前那一分钟（每小时一次）——现在不是整点，但刚错过一个
  const past = new Date(Date.now() - 10 * 60000);
  const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", minute: "2-digit" }).format(past));
  const cron = minute + " * * * *";
  t.mock.timers.enable({ apis: ["setInterval"] });
  const a = await mount({ phone: true });
  await a.tool("newswire_schedule_setup").execute({ cron });
  await a.call("/api/newswire/push");
  a.sent.length = 0;
  t.mock.timers.tick(30000);
  await wait(300);
  assert.equal(a.sent.length, 1, "补跑了一轮（测试里没有抓取子进程，发出来的是「本轮失败」）");
  assert.match(a.sent[0].text, /本轮失败/);
  t.mock.timers.tick(30000);
  await wait(200);
  assert.equal(a.sent.length, 1, "同一个整点只补一次");
  a.dispose();

  // 那个整点之后已经跑过一轮：不补
  const b = await mount({ phone: true });
  await b.tool("newswire_schedule_setup").execute({ cron });
  await b.call("/api/newswire/push");
  const db = openDb(path.join(b.dir, "news.sqlite"));
  db.prepare("INSERT INTO runs (run_id, started_at, mode) VALUES ('cycle-x', datetime('now', '-5 minutes'), 'cycle')").run();
  db.close();
  b.sent.length = 0;
  t.mock.timers.tick(30000);
  await wait(300);
  assert.equal(b.sent.length, 0);
  b.dispose();
  t.mock.timers.reset();
});
