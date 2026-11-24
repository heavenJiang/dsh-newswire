import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply } from "../../index.js";
import { openDb } from "../../engine/store/schema.mjs";
import { auditMarketImpact, draftMarketImpact, marketChanges, marketMaterials, marketPushMessage, marketReviewMaterials, publicMarketImpact, publishMarketImpact, readMarketImpact, writeMarketImpact } from "../../host/market_impact.mjs";

const article = (ref, title, text = "") => ({ ref, title, text, source: "测试来源", url: "https://example.test/" + ref });
const finding = {
  market: "美股", company: "示例云", ticker: "TEST", direction: "双向", business: "自建机房",
  finding: "采购提前，兑现仍取决于并网", mechanism: "并网前设备交付不会提高可用容量", countercase: "租用已通电机房可缓解约束",
  watch: "对照下一期并网披露和租赁合同", horizon: "未来两个季度", refs: [1, 46],
  links: [{ company: "示例电气", ticker: "600123.SH", relation: "直接供货", why: "供电系统进入项目", refs: [46] }],
};
const modelFor = (...responses) => {
  const prompts = [];
  return { prompts, complete: async (prompt) => { prompts.push(prompt); assert.ok(responses.length); return JSON.stringify(responses.shift()); } };
};

test("整轮分批取材，汇总跨批依据，独立审查过滤无出处的数字和重复标的", async () => {
  const materials = Array.from({ length: 46 }, (_, i) => article(i + 1, "材料" + (i + 1)));
  materials[0] = article(1, "示例云 TEST 上调采购", "示例云调整设备采购计划");
  materials[1] = article(2, "示例云披露另一份租赁合同");
  materials[45] = article(46, "机房并网延期", "示例电气供电系统进入项目");
  const analyst = modelFor({ items: [{ ...finding, refs: [1, 999] }], signals: [] }, { items: [], signals: [{ text: "并网延后", refs: [46] }] }, { items: [finding] });
  const draft = await draftMarketImpact(analyst, materials, 5000);
  assert.equal(analyst.prompts.length, 3);
  assert.match(analyst.prompts[2], /机房并网延期/);
  const supporting = marketReviewMaterials(draft, materials);
  assert.deepEqual(supporting.map((x) => x.ref), [1, 2, 46]);

  const unsupported = { ...finding, id: 2, ticker: "FAKE", finding: "采购增长99%", mechanism: "" };
  const report = publishMarketImpact([unsupported, ...draft, ...draft], supporting);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].identified, true);
  assert.equal(report.items[0].links[0].supported, false);
  const state = publicMarketImpact({ phase: "ready", report, materials: supporting, draft });
  assert.deepEqual(state.sources.map((x) => x.ref), [1, 46]);
  assert.ok(!("text" in state.sources[0]) && !("draft" in state));
  assert.match(marketPushMessage(report, "12:00"), /示例云 TEST/);
  const reviewer = modelFor({ items: [{ id: 1, verdict: "需修正", note: "项目重新安排并网", refs: [1] }] });
  const result = await auditMarketImpact(reviewer, report.items, [article(1, "项目重新安排并网")], 5000, "复核供货身份", supporting);
  assert.match(reviewer.prompts[0], /复核供货身份/);
  assert.equal(result[0].verdict, "需修正");
  assert.equal(report.items[0].direction, "双向");

});

test("头版英伟达被批次遗漏后重新送审，缺少结论的重点可见", async () => {
  const priority = { ...article(1, "英伟达 NVDA CEO 变动"), priority: "英伟达 CEO 变动" };
  const other = { ...article(2, "其他重点"), priority: "其他重点" };
  const llm = modelFor({ items: [{ ...finding, company: "英伟达", ticker: "NVDA", refs: [1], finding: "采购增加99%", mechanism: "", links: [] }] }, { items: [{ ...finding, company: "英伟达", ticker: "NVDA", refs: [1], links: [] }] });
  const report = publishMarketImpact(await draftMarketImpact(llm, [priority, other], 5000), [priority, other]);
  assert.match(llm.prompts[1], /英伟达 NVDA CEO 变动/);
  assert.deepEqual(report.items.map((x) => x.ticker), ["NVDA"]);
  assert.deepEqual(report.coverage, [{ title: "其他重点", ref: 2, reason: null }]);
});

test("正式抓取轮次覆盖未上版报道与合集拆条，排除已知旧闻和推广；研判记录按轮次读取", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('s','甲','s')").run();
  db.prepare("INSERT INTO runs (run_id, started_at) VALUES ('run','2026-11-23 10:00:00')").run();
  const ins = db.prepare("INSERT INTO articles (id, source_id, title, first_seen_at, published_at, kind, parent_id) VALUES (?, 's', ?, ?, ?, ?, ?)");
  for (const [id, seen, published, kind, parent] of [
    ["n","10:02:00","10:01:00","news",null], ["old","10:02:00","01:00:00","news",null],
    ["p","10:02:00","10:01:00","promo",null], ["digest","10:03:00","10:02:00","digest",null],
    ["child","10:04:00","10:02:00","digest_item","digest"], ["unknown","10:02:00","10:01:00","news",null],
  ]) ins.run(id, id, "2026-11-23 " + seen, "2026-11-23 " + published, kind, parent);
  const obs = db.prepare("INSERT INTO observations (run_id, source_id, article_id) VALUES ('run','s',?)");
  for (const id of ["n","old","p","digest"]) obs.run(id);
  const ed = { id: 1, pack: "core", run_id: "run", created_at: "2026-11-23 10:05:00", content: { since: "2026-11-23 03:00:00", market_round: "run", stories: {} } };
  assert.deepEqual(marketMaterials(db, ed).map((x) => x.title), ["child","n"]);
  writeMarketImpact(db, ed, { phase: "ready" });
  assert.deepEqual(readMarketImpact(db, { ...ed, id: 2, run_id: null }), { phase: "ready" });
  assert.equal(readMarketImpact(db, { ...ed, pack: "study" }), null);
  db.close();
});

test("低分政策与治理消息按业务触发规则送审", () => {
  const db = openDb(":memory:");
  const insert = db.prepare("INSERT INTO articles (id, title, first_seen_at, published_at, kind) VALUES (?, ?, '2026-11-23 10:02:00','2026-11-23 10:01:00','news')");
  insert.run("p", "新规限制先进芯片出口");
  insert.run("g", "公司首席执行官将出席听证会");
  insert.run("r", "日常社区分享");
  const ed = { id: 1, pack: "core", created_at: "2026-11-23 10:05:00", content: { since: "2026-11-23 09:00:00", stories: {
    a: { title: "新规限制先进芯片出口", importance: 45, article_ids: ["p"] },
    b: { title: "公司首席执行官将出席听证会", importance: 55, updated: true, article_ids: ["g"] },
    c: { title: "日常社区分享", importance: 50, is_new: true, article_ids: ["r"] },
  } } };
  const byTitle = Object.fromEntries(marketMaterials(db, ed).map((m) => [m.title, m.priorityReason]));
  assert.deepEqual(byTitle, { "新规限制先进芯片出口": "policy", "公司首席执行官将出席听证会": "governance", "日常社区分享": null });
  db.close();
});

test("看板接口提供已审核的研判，重审失败保留已发布结论", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nw-market-"));
  writeFileSync(join(dir, "model.json"), JSON.stringify({ mode: "llm", provider: "fixture", model: "reviewer" }));
  const db = openDb(join(dir, "news.sqlite"));
  db.prepare("INSERT INTO articles (id, title, first_seen_at, published_at) VALUES ('n','示例云 TEST 上调采购','2026-11-23 10:02:00','2026-11-23 10:01:00')").run();
  const content = { stories: { s: { is_new: true, article_ids: ["n"] } }, since: "2026-11-23 09:00:00", market_round: "fixture" };
  db.prepare("INSERT INTO editions (pack, created_at, mode, content, ok) VALUES ('all','2026-11-23 10:05:00','llm',?,1)").run(JSON.stringify(content));
  db.close();

  const candidate = { ...finding, refs: [1], links: [] };
  const answers = [{ items: [candidate] }, { invalid: true }];
  const pushes = [];
  const prompts = [];
  const routes = new Map();
  const disposers = [];
  const fetches = [];
  apply({
    inject(deps, fn) {
      if (deps[0] === "phonePush") fn({ effect() {}, phonePush: { available: () => true, send: async (text) => { pushes.push(text); return { delivered: 1 }; } } });
      if (deps[0] === "llm") fn({ effect() {}, llm: { async *stream(opts) {
        prompts.push(opts.messages[0].content[0].text);
        yield { type: "text-delta", text: JSON.stringify(answers.shift()) };
        yield { type: "finish", reason: { kind: "stop" } };
      } } });
    },
    subprocess: { spawn({ argv }) {
      const run = argv[argv.indexOf("--run-id") + 1];
      const only = argv.includes("--sources") ? argv[argv.indexOf("--sources") + 1] : null;
      fetches.push(only);
      const store = openDb(join(dir, "news.sqlite"));
      store.prepare("INSERT INTO runs(run_id, started_at) VALUES (?,datetime('now'))").run(run);
      store.prepare("INSERT INTO fetch_attempts(run_id,source_id,ok) VALUES (?, 'offline', ?)").run(run, only ? 1 : 0);
      store.close();
      return { done: Promise.resolve({ exitCode: only ? 0 : 2 }) };
    } },
    effect(fn) { disposers.push(fn()); },
    tools: { register: () => () => {} },
    connection: { fetch: { register: (def) => { routes.set(def.path, def); return () => {}; } } },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
    logger: { info() {}, warn() {} },
  }, { dataDir: dir });
  t.after(() => { for (const dispose of disposers) dispose?.(); rmSync(dir, { recursive: true, force: true }); });
  const call = (path, body) => routes.get(path).fetch(new Request("http://fixture" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const waitForReport = async () => {
    for (let i = 0; i < 100; i++) {
      const res = await (await call("/api/newswire/edition", { id: 1 })).json();
      if (res.market && !res.market.running && !res.market.auditing && res.market.delivery === "sent") return res.market;
      await delay(10);
    }
    assert.fail("后台股票研判未结束");
  };

  assert.equal((await call("/api/newswire/market-impact", { edition_id: 1 })).status, 202);
  const first = await waitForReport();
  assert.equal(first.report.items[0].ticker, "TEST");
  assert.equal(first.sources.length, 1);
  assert.equal(prompts.length, 1, "初稿推出时不等待模型审查");
  assert.match(pushes[0], /股票影响研判/);
  const retry = await call("/api/newswire/market-impact", { edition_id: 1, action: "audit", feedback: "核对并网日期" });
  assert.equal(retry.status, 202);
  assert.deepEqual((await retry.json()).market.report, first.report);
  const after = await waitForReport();
  assert.equal(after.reviewError, true);
  assert.equal(after.audit, null);
  assert.deepEqual(after.report, first.report);
  assert.match(prompts[1], /核对并网日期/);
  assert.equal(pushes.length, 1);
  for (const [action, phase] of [["fetch", "failed"], ["retry_sources", "checked"]]) {
    assert.equal((await call("/api/newswire/market-impact", { action })).status, 202);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await (await call("/api/newswire/edition", { research: true })).json()).researchFetch;
      if (job.phase === phase) break;
      await delay(10);
    }
    assert.equal(job.phase, phase);
    assert.deepEqual(job.failed, action === "fetch" ? ["offline"] : []);
    if (action === "retry_sources") assert.equal(job.count, 0);
  }
  assert.deepEqual(fetches, [null, "offline"]);
  assert.equal(prompts.length, 2);
  assert.equal(pushes.length, 1);
});

test("研判超时拆分重试，归并超时不丢已完成的分析", async () => {
  const mats = Array.from({ length: 25 }, (_, i) => article(i + 1, "材料" + (i + 1), "正文".repeat(500)));
  const seen = [], incomplete = [];
  let scans = 0;
  const model = { complete: async (prompt, opt) => {
    seen.push(opt.step);
    assert.ok(opt.maxTokens < 10000);
    assert.ok(prompt.length < 19000);
    if (opt.step === "market_merge" || (opt.step === "market_scan" && ++scans === 1)) throw new Error("timeout");
    return JSON.stringify({ items: prompt.includes('"ref":1,') ? [{ ...finding, refs: [1], links: [] }] : [] });
  } };
  const checkpoints = {};
  let count = 0;
  const draft = await draftMarketImpact(model, mats, 240000, {
    checkpoints, onScan: (n) => { count = n; },
    onIncomplete: (stage, n) => incomplete.push([stage, n]),
  });
  assert.equal(count, mats.length);
  assert.equal(seen.filter((s) => s === "market_scan").length, 4);
  assert.deepEqual(incomplete, [["market_merge", 0]]);
  assert.equal(publishMarketImpact(draft, mats).items[0].company, "示例云");
  const resumed = modelFor({ items: [] });
  await draftMarketImpact(resumed, mats, 240000, { checkpoints: JSON.parse(JSON.stringify(checkpoints)) });
  assert.equal(resumed.prompts.length, 1);
  assert.match(resumed.prompts[0], /跨批组合/);
});

test("跨轮比较按来源识别新增依据，编号变化和公司缺席不会生成推送", () => {
  const old = { report: { items: [{ ...finding, refs: [1] }] }, materials: [article(1, "原报道")] };
  const materials = [{ ...old.materials[0], ref: 2 }, article(3, "新公告")];
  const report = { items: [{ ...finding, refs: [2] }] };
  assert.deepEqual(marketChanges(report, materials, old), []);
  assert.equal(marketPushMessage(report, "12:00", []), "");
  report.items[0].refs.push(3);
  const change = marketChanges(report, materials, old)[0];
  assert.equal(change.kind, "evidence");
  assert.deepEqual(change.evidence.map((x) => x.title), ["新公告"]);
  report.items[0].direction = "利空";
  assert.equal(marketChanges(report, materials, old)[0].kind, "direction");
  assert.deepEqual(marketChanges({ items: [] }, [], old), []);
});
