import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { apply } from "../../index.js";
import { openDb } from "../../engine/store/schema.mjs";
import { draftMarketImpact, marketMaterials, marketReviewMaterials, publicMarketImpact, readMarketImpact, reviewMarketImpact, writeMarketImpact } from "../../host/market_impact.mjs";

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

  const checked = { ...finding, based_on: [1], links: [{ ...finding.links[0], supported: true }] };
  const reviewer = modelFor({ items: [
    { ...checked, ticker: "FAKE", finding: "采购增长99%" }, checked, checked,
    { ...checked, ticker: "NONE", refs: [999] },
  ], changes: ["补入并网约束"] });
  const report = await reviewMarketImpact(reviewer, draft, supporting, 5000, null, "复核供货身份");
  assert.match(reviewer.prompts[0], /复核供货身份/);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].identified, true);
  assert.equal(report.items[0].links[0].supported, false, "材料没有明确股票代码及双方关系，即使审查模型判定支持也降级");
  assert.deepEqual(report.changes, ["补入并网约束"]);
  const state = publicMarketImpact({ phase: "ready", report, materials: supporting, draft });
  assert.deepEqual(state.sources.map((x) => x.ref), [1, 46]);
  assert.ok(!("text" in state.sources[0]) && !("draft" in state));
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

test("看板接口提供已审核的研判，重审失败保留已发布结论", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nw-market-"));
  writeFileSync(join(dir, "model.json"), JSON.stringify({ mode: "llm", provider: "fixture", model: "reviewer" }));
  const db = openDb(join(dir, "news.sqlite"));
  db.prepare("INSERT INTO articles (id, title, first_seen_at, published_at) VALUES ('n','示例云 TEST 上调采购','2026-11-23 10:02:00','2026-11-23 10:01:00')").run();
  const content = { stories: { s: { is_new: true, article_ids: ["n"] } }, since: "2026-11-23 09:00:00", market_round: "fixture" };
  db.prepare("INSERT INTO editions (pack, created_at, mode, content, ok) VALUES ('all','2026-11-23 10:05:00','llm',?,1)").run(JSON.stringify(content));
  db.close();

  const candidate = { ...finding, refs: [1], links: [] };
  const answers = [{ items: [candidate] }, { items: [{ ...candidate, based_on: [1] }], changes: [] }, { invalid: true }];
  const prompts = [];
  const routes = new Map();
  const disposers = [];
  apply({
    inject(deps, fn) {
      if (deps[0] === "llm") fn({ effect() {}, llm: { async *stream(opts) {
        prompts.push(opts.messages[0].content[0].text);
        yield { type: "text-delta", text: JSON.stringify(answers.shift()) };
        yield { type: "finish", reason: { kind: "stop" } };
      } } });
    },
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
      if (res.market && !res.market.running) return res.market;
      await delay(10);
    }
    assert.fail("后台股票研判未结束");
  };

  assert.equal((await call("/api/newswire/market-impact", { edition_id: 1 })).status, 202);
  const first = await waitForReport();
  assert.equal(first.report.items[0].ticker, "TEST");
  assert.equal(first.sources.length, 1);
  const retry = await call("/api/newswire/market-impact", { edition_id: 1, feedback: "核对并网日期" });
  assert.equal(retry.status, 202);
  assert.deepEqual((await retry.json()).market.report, first.report);
  const after = await waitForReport();
  assert.equal(after.reviewError, true);
  assert.equal(after.reviewed, first.reviewed);
  assert.deepEqual(after.report, first.report);
  assert.match(prompts[2], /核对并网日期/);
});
