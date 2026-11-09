/* 集成烟测：假 ctx 挂载插件，验证工具注册/执行/render、面板路由，并实跑一次小样本抓取与试抓（需要联网；browse 不在时自动降级）。
 * 跑法：node tests/fake_ctx_smoke.mjs （数据写到系统临时目录下的新目录，不碰 ~/.dsh/newswire）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = await mkdtemp(path.join(os.tmpdir(), "newswire-smoke-"));

const tools = [];
const routes = [];
const sections = [];
let bad = 0;

function collect(stream, maxBytes) {
  const parts = [];
  let size = 0;
  stream.on("data", (b) => { if (size >= maxBytes) return; parts.push(b); size += b.length; });
  return { readFrom: () => ({ text: Buffer.concat(parts).toString("utf8") }) };
}

// 假的宿主定时任务服务：记录 create/edit 调用
const scheduleCalls = [];
let taskSeq = 0;
const fakeTasks = new Map();
const fakeSchedule = {
  async list() { return { items: Array.from(fakeTasks.values()) }; },
  async create(req) { scheduleCalls.push(["create", req]); const t = { id: "schedule-" + (++taskSeq), title: req.title, prompt: req.prompt, status: "active", scheduledAt: "2026-11-09T01:00:00.000Z", target: req.target }; fakeTasks.set(t.id, t); return t; },
  async edit(req) {
    scheduleCalls.push(["edit", req]);
    const t = fakeTasks.get(req.id);
    if (!t) return { id: req.id, code: "schedule_not_found" };
    if (req.action === "delete") { fakeTasks.delete(req.id); return { id: req.id, deleted: true }; }
    if (req.patch.active !== undefined) t.status = req.patch.active ? "active" : "paused";
    if (req.patch.prompt) t.prompt = req.patch.prompt;
    return t;
  },
};

// 假的宿主模型服务：简报提示回简报 JSON，其它回事件解读 JSON
const llmCalls = [];
const fakeLlm = {
  listProviders: () => [{ id: "fake", name: "Fake" }],
  listModels: async (pr) => (pr === "fake" ? [{ provider: "fake", id: "smoke", name: "Smoke" }, { provider: "fake", id: "other", name: "Other" }] : []),
  stream(opts) {
    const text = opts.messages[0].content[0].text;
    llmCalls.push(text.slice(0, 40));
    // 版面三步：归并（每条各成一篇）、统筹、写稿；其它（单事件解读）回解读
    let reply;
    if (text.includes("归为一篇报道")) {
      const ns = [...text.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
      reply = JSON.stringify({ stories: ns.map((n, i) => ({ items: [n], title: "烟测报道" + n, section: "politics", labels: ["politics.conflict"], importance: i < 2 ? 90 : 30 })) });
    } else if (text.includes("headline：一句话总括")) reply = JSON.stringify({ merge: [], headline: "烟测总括", front: [1, 2], watch: [{ text: "关注一", refs: [1] }] });
    else if (text.includes("按版式为以下每篇报道写稿")) reply = JSON.stringify({ stories: [1, 2, 3].map((r) => ({ ref: r, lead: "烟测导语" + r + "，说清何事。", points: ["要点"], views: [], impact: "" })) });
    else reply = JSON.stringify({ summary: "烟测摘要", why: "因为", watch: "看后续" });
    return (async function* () { yield { type: "text-delta", text: reply }; yield { type: "finish", reason: { kind: "stop" } }; })();
  },
};
const ctx = {
  inject(deps, fn) {
    if (deps[0] === "schedule") fn({ schedule: fakeSchedule, effect: () => {} });
    if (deps[0] === "llm") fn({ llm: fakeLlm, effect: () => {} });
    if (deps[0] === "agentDefaultModel") fn({ agentDefaultModel: { currentSelection: () => ({ provider: "fake", model: "smoke" }) }, effect: () => {} });
  },
  effect(fn) { const dispose = fn(); this._disposers.push(dispose); return dispose; },
  _disposers: [],
  tools: { register: (def) => { tools.push(def); return () => {}; } },
  // 与 DSH 的 HostConnectionService 一致：exact Fetch route 按 path 唯一，重复 path 直接抛。
  connection: { fetch: { register: (def) => { if (routes.some((r) => r.path === def.path)) throw new Error('connection: exact Fetch route ' + JSON.stringify(def.path) + ' is already registered'); routes.push(def); return () => {}; } } },
  systemPrompt: { section: (def) => { sections.push(def.name); return () => {}; }, getSectionOrder: () => 10 },
  logger: { info: (m) => console.log("[host:info]", m), warn: (m) => console.log("[host:warn]", m) },
  subprocess: {
    spawn: ({ argv, cwd, stdio, signal }) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = collect(child.stdout, stdio?.stdout?.maxBytes ?? 65536);
      const stderr = collect(child.stderr, stdio?.stderr?.maxBytes ?? 65536);
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, sig) => resolve({ exitCode, signal: sig }));
        if (signal) signal.addEventListener("abort", () => child.kill("SIGTERM"));
      });
      return { done, collected: { stdout, stderr }, terminate: () => child.kill("SIGTERM"), waitForExit: () => done };
    },
  },
};

const mod = await import(path.join(PKG, "index.js"));
mod.apply(ctx, { dataDir: DATA, windowHours: 12, tailChars: 700 });

console.log("routes:", routes.map((r) => r.methods.join("/") + " " + r.path).join(", "));
console.log("prompt sections:", sections.join(", "));
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
console.log("tools:", Object.keys(byName).join(", "));

// DSH 只接受这个 JSON Schema 子集；type 数组会被拒（core/tools/src/json-schema.ts）。
const SCHEMA_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
function auditSchema(node, path, out) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) { out.push(path + " 必须是 schema 对象"); return; }
  for (const key of Object.keys(node)) if (!SCHEMA_KEYWORDS.has(key)) out.push(path + "." + key + " 不在 DSH 支持的子集里");
  if (Array.isArray(node.type)) out.push(path + ".type 不能是数组（" + JSON.stringify(node.type) + "），可空字段写 oneOf");
  if (node.type === "object" && node.properties) for (const [k, v] of Object.entries(node.properties)) auditSchema(v, path + ".properties." + k, out);
  if (node.type === "array" && node.items) auditSchema(node.items, path + ".items", out);
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((v, i) => auditSchema(v, path + ".oneOf[" + i + "]", out));
}
for (const tool of tools) {
  const out = [];
  auditSchema(tool.parameters, "parameters", out);
  if (tool.output && tool.output.schema) auditSchema(tool.output.schema, "output", out);
  if (out.length) { bad++; console.log("SCHEMA " + tool.name + ": " + out.join(" | ")); }
}
console.log(out_summary());
function out_summary() { return "schema 子集检查完成，工具 " + tools.length + " 个"; }
for (const n of ["newswire_export", "newswire_events", "newswire_event", "newswire_reprocess", "newswire_cycle", "newswire_schedule_setup", "newswire_run", "newswire_snapshot", "newswire_items", "newswire_sources", "newswire_source_toggle", "newswire_source_upsert", "newswire_source_remove", "newswire_source_test", "newswire_failures", "newswire_edition", "newswire_follow", "newswire_story", "newswire_daily", "newswire_push_prefs", "newswire_track", "newswire_analyze"]) {
  if (!byName[n]) { console.log("MISSING TOOL", n); bad++; }
}

async function callTool(name, args) {
  const t = byName[name];
  if (!t) return null;
  try {
    const value = await t.execute(args ?? {});
    const text = (t.output?.render ? t.output.render(args ?? {}, value) : []).map((x) => x.text).join("\n");
    console.log("tool " + name + " ok, render " + text.length + " chars");
    return value;
  } catch (e) { bad++; console.log("tool " + name + " THREW: " + e.message); return null; }
}

function callRoute(pathname, method, bodyArg) {
  const def = routes.find((r) => r.path === pathname && r.methods.indexOf(method) >= 0);
  if (!def) { bad++; console.log("route missing: " + method + " " + pathname); return Promise.resolve(null); }
  return def.fetch({ url: pathname, method, json: async () => bodyArg }).then(async (res) => {
    const text = await res.text();
    let value = null;
    try { value = JSON.parse(text === "" ? "null" : text); } catch { value = { raw: text.slice(0, 60) }; }
    console.log("route " + method + " " + pathname + " -> " + res.status + " keys=" + Object.keys(value ?? {}).slice(0, 7).join(","));
    return { status: res.status, value, text };
  });
}

await callTool("newswire_snapshot");
await callTool("newswire_sources", { limit: 4 });
const run = await callTool("newswire_run", { sources: "bbc_world,cls_telegraph,jiemian", window_hours: 6, max_items: 8, per_source: 3, export: "jsonl" });
if (!run || run.ok !== true) { bad++; console.log("newswire_run 未成功:", run && run.stage); }
await callTool("newswire_items", { category: "国际宏观", limit: 3, hours: 12 });
const hot = await callTool("newswire_items", { hot_only: true, limit: 5, hours: 12 });
console.log("  热门条目:", hot ? hot.count : "?");
const tested = await callTool("newswire_source_test", { id: "jiemian", max_items: 3 });
if (!tested || tested.ok !== true || !(tested.items || []).length) { bad++; console.log("试抓 jiemian 失败", tested && (tested.error || JSON.stringify(tested.attempts))); }
const badTest = await callTool("newswire_source_test", { source: { id: "Bad Id", name: "x", category: "c", type: "nope", url: "ftp://x" } });
if (!badTest || !(badTest.problems || []).length) { bad++; console.log("非法试抓没被拒"); }
const up = await callTool("newswire_source_upsert", { source: { id: "smoke_feed", name: "Smoke Feed", category: "国际宏观", type: "rss", url: "https://feeds.bbci.co.uk/news/business/rss.xml", region: "UK", weight: 0.5 } });
if (!up || up.ok !== true || up.created !== true) bad++;
const up2 = await callTool("newswire_source_upsert", { source: { id: "smoke_feed", weight: 2 } });
if (!up2 || up2.ok !== false) { bad++; console.log("非法 weight 没被拒"); }
const rmv = await callTool("newswire_source_remove", { id: "smoke_feed" });
if (!rmv || rmv.ok !== true) bad++;
const listed = await callTool("newswire_sources", { include_removed: true });
const gone = listed && listed.sources.find((x) => x.id === "smoke_feed");
if (!gone || !gone.removed_at || gone.enabled !== false) { bad++; console.log("软删除没生效"); }
const visible = await callTool("newswire_sources", {});
if (!visible || visible.sources.some((x) => x.id === "smoke_feed")) { bad++; console.log("软删除的源不该默认列出"); }
await callTool("newswire_source_remove", { id: "smoke_feed", purge: true });

// 整轮：第一轮建立断点，第二轮应衔接；消息是成品文本
const c1 = await callTool("newswire_cycle", { sources: "bbc_world,jiemian,wallstreetcn", dry_run: true });
const c2 = await callTool("newswire_cycle", { sources: "bbc_world,jiemian,wallstreetcn", dry_run: true });
console.log("  cycle#1:", c1 && c1.message && c1.message.split("\n")[0]);
console.log("  cycle#2:", c2 && c2.message && c2.message.split("\n")[0]);
if (!c1 || typeof c1.message !== "string" || !c1.run_id) { bad++; console.log("cycle 没返回 message", c1); }
const linked = c2 && (c2.continuity || []).filter((x) => x.status === "connected" || x.status === "connected_time");
if (!linked || linked.length < 2) { bad++; console.log("第二轮应衔接上", c2 && c2.continuity); }
// 版面：LLM 模式下整轮后由模型编排；推送消息来自版面
console.log("  model:", JSON.stringify(c1 && c1.model), "edition:", JSON.stringify(c1 && c1.edition), "llm calls:", llmCalls.length);
if (!c1 || !c1.edition || c1.edition.mode !== "llm" || c1.edition.headline !== "烟测总括") { bad++; console.log("整轮没有生成模型版面", c1 && c1.edition); }
if (c1 && (c1.picks || []).length && !/由 fake\/smoke 阅读 \d+ 条新闻后编写/.test(c1.message)) { bad++; console.log("推送消息不是版面消息", c1.message); }
const edt = await callTool("newswire_edition", {});
if (!edt || edt.ok !== true || !edt.edition || !edt.edition.content.sections.length) { bad++; console.log("newswire_edition 异常", edt && edt.error); }
const mdl = await callRoute("/api/newswire/model", "GET");
if (!mdl || mdl.status !== 200 || mdl.value.model.mode !== "llm" || !(mdl.value.providers[0] || {}).models || mdl.value.providers[0].models.length !== 2) { bad++; console.log("模型列表异常", mdl && mdl.value); }
const pin = await callRoute("/api/newswire/model", "POST", { provider: "fake", model: "other" });
if (!pin || pin.status !== 200 || pin.value.model.label !== "fake/other") { bad++; console.log("选择模型异常", pin && pin.value); }
const badPin = await callRoute("/api/newswire/model", "POST", { provider: "fake", model: "nope" });
if (!badPin || badPin.status !== 400) { bad++; console.log("不存在的模型应被拒"); }
const eco = await callRoute("/api/newswire/model", "POST", { mode: "economy", provider: "", model: "" });
if (!eco || eco.value.model.mode !== "economy" || eco.value.model.ready !== false) { bad++; console.log("切到节省 token 异常", eco && eco.value); }
const callsBefore = llmCalls.length;
const ecoEd = await callRoute("/api/newswire/edition", "POST", { refresh: true });
if (!ecoEd || ecoEd.status !== 200 || ecoEd.value.edition.mode !== "rules" || llmCalls.length !== callsBefore) { bad++; console.log("节省 token 模式不应调用模型", ecoEd && ecoEd.value && ecoEd.value.edition && ecoEd.value.edition.mode); }
// 关注：用工具关注版面里的一条故事线，节省 token 模式重编后「我的关注」排第一
const firstStory = Object.keys(ecoEd.value.edition.content.stories)[0];
const fl = await callTool("newswire_follow", { action: "follow", kind: "story", value: firstStory, name: "烟测关注" });
if (!fl || fl.follow.length !== 1) { bad++; console.log("关注失败", fl); }
const badFl = await callRoute("/api/newswire/follows", "POST", { action: "follow", kind: "nope", value: "x" });
if (!badFl || badFl.status !== 400) bad++;
const folEd = await callRoute("/api/newswire/edition", "POST", { refresh: true });
if (!folEd || (folEd.value.edition.content.sections[0] || {}).id !== "following") { bad++; console.log("关注栏没有排第一", folEd && folEd.value.edition.content.sections.map((x) => x.id)); }
await callTool("newswire_follow", { action: "unfollow", kind: "story", value: firstStory });
// 自上次查看：第一次没有上次时间；第二次有
const seen1 = await callRoute("/api/newswire/edition", "POST", { mark_seen: true });
const seen2 = await callRoute("/api/newswire/edition", "POST", { mark_seen: true });
if (!seen1 || !seen1.value.since || seen1.value.since.at !== null || !seen2.value.since.at) { bad++; console.log("查看记录异常", seen1 && seen1.value.since, seen2 && seen2.value.since); }
const sd = await callRoute("/api/newswire/story", "POST", { id: firstStory });
if (!sd || sd.status !== 200 || !sd.value.items.length) { bad++; console.log("故事线详情异常", sd && sd.status); }
const sdt = await callTool("newswire_story", { id: firstStory });
if (!sdt || !sdt.found) { bad++; console.log("newswire_story 异常"); }
// 日报、历史、报错、质量
const dly = await callTool("newswire_daily", {});
if (!dly || !dly.ok || !/^🌙 今日回顾/.test(dly.message)) { bad++; console.log("日报异常", dly && dly.message); }
const dlr = await callRoute("/api/newswire/daily", "POST", {});
if (!dlr || !dlr.value.daily || !dlr.value.dates.length) { bad++; console.log("日报接口异常"); }
const hist = await callRoute("/api/newswire/editions", "POST", {});
if (!hist || hist.value.editions.length < 2) { bad++; console.log("历史版面异常"); }
const old = await callRoute("/api/newswire/edition", "POST", { id: hist.value.editions.at(-1).id });
if (!old || !old.value.edition.content.stats.preview) { bad++; console.log("冷启动应先存一份预览版面", old && old.value.edition.content.stats); }
if (!old || old.value.edition.id !== hist.value.editions.at(-1).id) { bad++; console.log("取历史版面异常"); }
const fbBad = await callRoute("/api/newswire/feedback", "POST", { kind: "error", story_id: firstStory });
if (!fbBad || fbBad.status !== 400) bad++;
const fbOk = await callRoute("/api/newswire/feedback", "POST", { kind: "error", story_id: firstStory, text: "烟测错句" });
if (!fbOk || fbOk.status !== 200) bad++;
const ql = await callRoute("/api/newswire/quality", "GET");
if (!ql || !ql.value.editions.length || !ql.value.feedback.length) { bad++; console.log("质量面板异常", ql && ql.value.feedback); }
if (!ql.value.content || !Array.isArray(ql.value.filtered)) { bad++; console.log("内容完整度缺失"); }
// 源的取舍：评估、三态开关（试用写进配置并同步到库）
const sc = await callRoute("/api/newswire/sources/scores", "GET");
if (!sc || !sc.value.sources.length || !sc.value.sources[0].verdict) { bad++; console.log("源评估异常", sc && sc.value); }
const stt = await callRoute("/api/newswire/sources/state", "POST", { id: "jiemian", state: "trial" });
if (!stt || stt.status !== 200 || stt.value.trial !== true) { bad++; console.log("试用状态没生效", stt && stt.value); }
const stBad = await callRoute("/api/newswire/sources/state", "POST", { id: "jiemian", state: "maybe" });
if (!stBad || stBad.status !== 400) bad++;
await callRoute("/api/newswire/sources/state", "POST", { id: "jiemian", state: "on" });
// 影响分析：缺 story_id 被拒；LLM 模式下用假模型分析一条故事线
const anBad = await callRoute("/api/newswire/analyze", "POST", {});
if (!anBad || anBad.status !== 400) bad++;
// 追踪：添加、列表、详情、坏动作被拒
const tAdd = await callRoute("/api/newswire/track", "POST", { action: "add", name: "伊朗", kind: "theme", aliases: ["伊朗", "Iran"] });
if (!tAdd || tAdd.status !== 200 || !tAdd.value.id) { bad++; console.log("追踪添加异常", tAdd && tAdd.value); }
const tList = await callRoute("/api/newswire/track", "GET");
if (!tList || !tList.value.trackers.some((x) => x.name === "伊朗")) { bad++; console.log("追踪列表异常", tList && tList.value); }
const tItem = await callRoute("/api/newswire/track/item", "POST", { id: tAdd.value.id });
if (!tItem || tItem.status !== 200 || !Array.isArray(tItem.value.timeline)) { bad++; console.log("追踪详情异常"); }
const tBad = await callRoute("/api/newswire/track", "POST", { action: "nope" });
if (!tBad || tBad.status !== 400) bad++;
const tTool = await callTool("newswire_track", { action: "list" });
if (!tTool || !tTool.ok) { bad++; console.log("追踪工具异常", tTool); }
// 问新闻：搜索；空问题被拒
const sk = await callRoute("/api/newswire/ask", "POST", { q: "伊朗" });
if (!sk || sk.status !== 200 || !Array.isArray(sk.value.items) || !sk.value.terms.includes("伊朗")) { bad++; console.log("搜索异常", sk && sk.value); }
const skBad = await callRoute("/api/newswire/ask", "POST", { q: "" });
if (!skBad || skBad.status !== 400) bad++;
// 推送设置：改节奏会同步改已有定时任务的时间
const pv = await callRoute("/api/newswire/push", "GET");
if (!pv || !pv.value.prefs || !pv.value.cadences.thrice) { bad++; console.log("推送设置异常", pv && pv.value); }
const pp = await callTool("newswire_push_prefs", { cadence: "thrice", level: "fewer" });
if (!pp || pp.prefs.cadence !== "thrice" || pp.prefs.level !== "fewer") { bad++; console.log("推送偏好没存上", pp); }
await callRoute("/api/newswire/push", "POST", { prefs: { cadence: "every2h", level: "normal" } });
await callRoute("/api/newswire/model", "POST", { mode: "llm" });
const brr = await callRoute("/api/newswire/edition", "POST", { refresh: true });
if (!brr || brr.status !== 202) { bad++; console.log("LLM 模式重新编排应在后台进行", brr && brr.status); }
for (let i = 0; i < 60; i++) { const st = await callRoute("/api/newswire/edition", "POST", {}); if (st && st.value.model && !st.value.model.busy) break; await new Promise((r) => setTimeout(r, 500)); }
const after = await callRoute("/api/newswire/edition", "POST", {});
if (!after || after.value.edition.mode !== "llm") { bad++; console.log("后台编排没有完成"); }

// 事件：本轮聚出的事件可查，详情含成员；重算标签与事件
const evs = await callTool("newswire_events", { hours: 24, limit: 5 });
if (!evs || !evs.count) { bad++; console.log("没有聚出事件"); }
else {
  const one = await callTool("newswire_event", { id: evs.events[0].event_id });
  if (!one || !one.found || !one.event.members.length) { bad++; console.log("事件详情缺成员"); }
}
const rp = await callTool("newswire_reprocess", { stage: "events", hours: 24 });
if (!rp || rp.ok !== true || !rp.articles) { bad++; console.log("重算失败", rp); }

// 导出当天数据集：清单在、条目与事件都有
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
const exp = await callTool("newswire_export", { from: today });
if (!exp || exp.ok !== true || !(exp.files && exp.files["articles.jsonl"] > 0)) { bad++; console.log("导出失败", exp); }
const expBad = await callTool("newswire_export", { from: "11/08" });
if (!expBad || expBad.ok !== false) { bad++; console.log("非法日期没被拒"); }

// 定时任务：创建 → 状态 → 暂停 → 恢复 → 再次 create（更新）→ 删除
const s1 = await callTool("newswire_schedule_setup", {});
if (!s1 || s1.ok !== true || scheduleCalls[0][1].timing.cron.expression !== "0 7-21/2 * * *" || scheduleCalls[0][1].timing.cron.time_zone !== "Asia/Shanghai" || scheduleCalls[0][1].target.kind !== "new_once" || !/newswire_cycle/.test(scheduleCalls[0][1].prompt)) { bad++; console.log("定时任务创建参数不对", JSON.stringify(scheduleCalls[0])); }
const s2 = await callTool("newswire_schedule_setup", { action: "status" });
if (!s2 || !s2.task) bad++;
const s3 = await callTool("newswire_schedule_setup", { action: "pause" });
if (!s3 || s3.task.status !== "paused") bad++;
const s4 = await callTool("newswire_schedule_setup", { action: "resume" });
if (!s4 || s4.task.status !== "active") bad++;
const s5 = await callTool("newswire_schedule_setup", { cron: "0 8-20/2 * * 1-5" });
if (!s5 || s5.ok !== true || scheduleCalls.at(-1)[0] !== "edit") { bad++; console.log("已存在时应更新而不是重复创建"); }
const sd1 = await callTool("newswire_schedule_setup", { kind: "daily" });
const dailyCall = scheduleCalls.at(-1);
if (!sd1 || sd1.ok !== true || dailyCall[0] !== "create" || dailyCall[1].timing.cron.expression !== "30 21 * * *" || !/newswire_daily/.test(dailyCall[1].prompt) || !/今日回顾/.test(dailyCall[1].title)) { bad++; console.log("日报定时任务参数不对", JSON.stringify(dailyCall)); }
await callTool("newswire_schedule_setup", { kind: "daily", action: "remove" });
// 推送节奏改为「早中晚三次」：已有的定时任务时间跟着改；改为「只看日报」：暂停每轮要闻、建好日报
await callTool("newswire_push_prefs", { cadence: "thrice" });
const cadCall = scheduleCalls.at(-1);
if (!cadCall || cadCall[0] !== "edit" || cadCall[1].patch.timing.cron.expression !== "0 8,12,18 * * *") { bad++; console.log("改节奏没有同步到定时任务", JSON.stringify(cadCall)); }
await callTool("newswire_push_prefs", { cadence: "daily_only" });
const dOnly = scheduleCalls.slice(-2);
if (!(dOnly[0][0] === "edit" && dOnly[0][1].patch.active === false && dOnly[1][0] === "create" && /今日回顾/.test(dOnly[1][1].title))) { bad++; console.log("只看日报没生效", JSON.stringify(dOnly)); }
await callTool("newswire_schedule_setup", { kind: "daily", action: "remove" });
await callTool("newswire_push_prefs", { cadence: "every2h" });
const s6 = await callTool("newswire_schedule_setup", { action: "remove" });
if (!s6 || s6.ok !== true || fakeTasks.size !== 0) bad++;
// 留学包：独立任务，默认 08:30 / 20:30，标题按包名；不存在的包被拒
const st1 = await callTool("newswire_schedule_setup", { pack: "study_abroad" });
const stCall = scheduleCalls.at(-1);
if (!st1 || st1.ok !== true || stCall[1].timing.cron.expression !== "30 8,20 * * *" || stCall[1].title !== "留学资讯 · dsh-newswire" || !/pack=\\?"study_abroad/.test(stCall[1].prompt)) { bad++; console.log("留学包定时任务参数不对", JSON.stringify(stCall)); }
const st2 = await callTool("newswire_schedule_setup", { pack: "nope" });
if (!st2 || st2.ok !== false) { bad++; console.log("不存在的包没被拒"); }
await callTool("newswire_schedule_setup", { pack: "study_abroad", action: "remove" });
await callTool("newswire_failures", { limit: 4 });
await callTool("newswire_source_toggle", { id: "reuters", enabled: false });
await callTool("newswire_source_toggle", { id: "reuters", enabled: true });

const sum = await callRoute("/api/newswire/summary", "GET");
if (!sum || sum.status !== 200 || !(sum.value.categories || []).length) { bad++; console.log("summary 路由异常"); }
const digRes = await routes.find((r) => r.path === "/api/newswire/digest").fetch({ url: "/api/newswire/digest", method: "GET" });
const digText = await digRes.text();
if (digRes.status !== 200 || digText.length < 40) { bad++; console.log("digest 路由异常"); } else console.log("route GET /api/newswire/digest -> 200, " + digText.length + " chars markdown");
const src = await callRoute("/api/newswire/sources", "GET");
if (!src || !(src.value.sources || []).length) bad++;
const itm = await callRoute("/api/newswire/items", "POST", { hours: 12, limit: 5 });
if (!itm || itm.status !== 200 || !(itm.value.items || []).length) bad++;
const page2 = await callRoute("/api/newswire/items", "POST", { hours: 12, limit: 5, before: itm.value.next_before });
if (!page2 || page2.status !== 200) bad++;
const trail = await callRoute("/api/newswire/trail", "POST", { id: itm.value.items[0].id });
if (!trail || trail.status !== 200 || !(trail.value.trail || []).length) { bad++; console.log("热度轨迹为空"); }
const rtest = await callRoute("/api/newswire/sources/test", "POST", { source: { id: "x", name: "x", category: "c", type: "rss", url: "not-a-url" } });
if (!rtest || rtest.status !== 400) { bad++; console.log("试抓路由没校验"); }
const att = await callRoute("/api/newswire/attempts", "POST", { runs: 3 });
if (!att || att.status !== 200 || !(att.value.attempts || []).length) bad++;
if (!att || !Array.isArray(att.value.continuity) || !att.value.continuity.length) { bad++; console.log("attempts 路由缺衔接状态"); }
const doc = src.value;
const flipped = doc.sources.map((s) => (s.id === "reuters" ? Object.assign({}, s, { enabled: false }) : s));
const save1 = await callRoute("/api/newswire/sources", "POST", { sources: flipped });
if (!save1 || save1.status !== 200 || save1.value.ok !== true) bad++;
const check = await callRoute("/api/newswire/sources", "GET");
const off = (check.value.sources || []).find((s) => s.id === "reuters");
if (!off || off.enabled !== false) { bad++; console.log("停用没有写回"); }
const restore = await callRoute("/api/newswire/sources", "POST", { sources: doc.sources });
if (!restore || restore.status !== 200) bad++;
const rej = await callRoute("/api/newswire/sources", "POST", { sources: [{ id: "X Bad", name: "x", category: "国际宏观", type: "nope", url: "ftp://x" }] });
if (!rej || rej.status !== 400 || !(rej.value.problems || []).length) { bad++; console.log("非法数据源没被拒"); } else console.log("非法数据源被拒:", rej.value.problems.slice(0, 3).join(" / "));
if (!(src.value.adapters || []).includes("jiemian")) { bad++; console.log("sources 路由缺 adapters"); }
const evr = await callRoute("/api/newswire/events", "POST", { hours: 24, limit: 5 });
if (!evr || evr.status !== 200 || !(evr.value.events || []).length) { bad++; console.log("events 路由异常"); }
const evd = await callRoute("/api/newswire/event", "POST", { id: evr.value.events[0].event_id });
if (!evd || evd.status !== 200 || !(evd.value.members || []).length) bad++;
const ana = await callRoute("/api/newswire/event/analyze", "POST", { id: evr.value.events[0].event_id });
if (!ana || ana.status !== 200 || !ana.value.event || !ana.value.event.notes || ana.value.event.notes.summary !== "烟测摘要") { bad++; console.log("单事件解读异常", ana && ana.value); }
const upd = await callRoute("/api/newswire/update-check", "POST", { source: "link:/somewhere" });
if (!upd || upd.status !== 200 || upd.value.source.kind !== "local" || upd.value.newer !== false) { bad++; console.log("更新检查异常", upd && upd.value); }
const sm = await callRoute("/api/newswire/summary", "GET");
if (!sm || !sm.value.model || sm.value.model.available !== true) { bad++; console.log("summary 缺模型状态"); }
const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
const tl = await callRoute("/api/newswire/timeline", "POST", { date: day });
if (!tl || tl.status !== 200 || !(tl.value.runs || []).length || !(tl.value.entries || []).length) { bad++; console.log("时间线为空", tl && tl.value); }
else if (tl.value.ms > 1000) { bad++; console.log("时间线超过 1 秒：" + tl.value.ms + "ms"); }
const tlr = await callRoute("/api/newswire/timeline/run", "POST", { run_id: tl.value.runs[0].run_id, kind: "items" });
if (!tlr || tlr.status !== 200) bad++;
const tlbad = await callRoute("/api/newswire/timeline", "POST", { date: "11/08" });
if (!tlbad || tlbad.status !== 400) bad++;
const sch = await callRoute("/api/newswire/schedule", "GET");
if (!sch || sch.status !== 200 || sch.value.available !== true) bad++;
const txr = await callRoute("/api/newswire/taxonomy", "GET");
if (!txr || txr.status !== 200 || !(txr.value.labels || []).some((l) => l.id === "study")) { bad++; console.log("taxonomy 路由异常"); }
const lbl = await callRoute("/api/newswire/items", "POST", { hours: 24, label: "politics", limit: 5 });
if (!lbl || lbl.status !== 200) bad++;
const ran = await callRoute("/api/newswire/run", "POST", { sources: "bbc_world", window_hours: 6, max_items: 4, export: "none" });
if (!ran || ran.status !== 200 || ran.value.ok !== true) bad++;

for (const d of ctx._disposers) if (typeof d === "function") d();
console.log("\nSMOKE " + (bad === 0 ? "PASS" : "FAIL(" + bad + ")") + "  dataDir=" + DATA);
process.exitCode = bad === 0 ? 0 : 1;
