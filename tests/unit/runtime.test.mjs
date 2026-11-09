/* 模型运行时——账本、预算、速度自适应（并发探测）、提示词固定部分在前。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { recordCall, usageToday, makeGate, depthParams } from "../../host/runtime.mjs";
import { loadLayout, llmEdition, groupPrompt, taxonomyIndex } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAXL = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8")).labels;
const LAYOUT = Object.assign(loadLayout(null, path.join(CFG, "layout.json")), { min_importance: 10 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const tmpDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v30-")), "n.sqlite"));

test("调用记账：有 usage 用 usage（含缓存命中），没有就按字数估；失败也记；预算闸门", async () => {
  const calls = [];
  let withUsage = true;
  const llm = { stream() { return (async function* () { yield { type: "text-delta", text: "{\"ok\":1}" }; if (withUsage) yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400 } }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  let blocked = null;
  const m = createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }), onCall: (r) => calls.push(r), gate: () => blocked });
  await m.complete("你好", { step: "write" });
  withUsage = false;
  await m.complete("一段十六个字的提示词用来估算", { step: "group" });
  assert.deepEqual([calls[0].step, calls[0].in, calls[0].out, calls[0].cache, calls[0].est], ["write", 100, 20, 400, false]);
  assert.equal(calls[1].est, true);
  assert.ok(calls[1].in > 0);
  assert.equal(m.profile().calls, 2);
  assert.equal(m.profile().cache_rate, Math.round(100 * 400 / (100 + 400 + calls[1].in)));
  blocked = "token_budget";
  await assert.rejects(m.complete("x", {}), /token_budget/);
  const db = tmpDb();
  for (const r of calls) recordCall(db, r);
  const u = usageToday(db);
  assert.equal(u.calls, 2);
  assert.equal(u.tokens_cache, 400);
  assert.equal(u.cache_rate, Math.round(100 * 400 / (u.tokens_in + 400)));
  const f = path.join(path.dirname(db.location ? db.location() : os.tmpdir()), "x");
  void f;
  const gate = makeGate(() => db, () => ({ daily_tokens: 100 }));
  assert.equal(gate(), "token_budget");
  assert.equal(makeGate(() => db, () => ({}))(), null, "不设上限不拦");
});

test("模型投入档位：节省 < 均衡 < 深度；未知档位按均衡", () => {
  assert.ok(depthParams({ depth: "lean" }).maxStories < depthParams({}).maxStories);
  assert.ok(depthParams({ depth: "deep" }).autoAnalyze > depthParams({ depth: "balanced" }).autoAnalyze);
  assert.equal(depthParams({ depth: "zzz" }).maxItems, 150);
});

test("提示词：固定部分（任务、分类表、输出格式）在前，材料在后——相同前缀能命中缓存", () => {
  const tax = taxonomyIndex(TAXL);
  const a = groupPrompt([{ n: 1, title: "甲", source_name: "s" }], tax, [], []);
  const b = groupPrompt([{ n: 1, title: "乙乙乙", source_name: "t" }, { n: 2, title: "丙", source_name: "u" }], tax, [], []);
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  assert.ok(k > a.length * 0.8, "两次调用的公共前缀占大部分");
  assert.ok(a.indexOf("新抓到的新闻") > a.indexOf("只输出一个 JSON 对象"));
});

function editionDb(n) {
  const db = tmpDb();
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  for (let i = 0; i < n; i++) {
    const t = iso(3600000 + i * 1000);
    db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES (?,?,?,?,?,?,?,?,'core','full')").run("a" + i, "https://x/a" + i, "新闻" + i + "号", "摘要" + i, "cls", t, t, t);
  }
  return db;
}
function slowModel(parallelOk) {
  let busy = Promise.resolve();
  const reply = (p) => {
    if (p.includes("归为一篇报道")) { const ns = [...p.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1])); return JSON.stringify({ stories: ns.map((n) => ({ items: [n], title: "新闻" + n, section: "politics", labels: [], importance: 60 })) }); }
    if (p.includes("headline：一句话总括")) return JSON.stringify({ merge: [], headline: "总括", front: [1], watch: [] });
    if (p.includes("按版式为以下每篇报道写稿")) { const k = (p.match(/【报道\d+】/g) || []).length; return JSON.stringify({ stories: Array.from({ length: k }, (_, i) => ({ ref: i + 1, lead: "导语。", lead_refs: ["M1"], points: [], views: [], impact: "" })) }); }
    return "{}";
  };
  const llm = { stream(o) {
    const p = o.messages[0].content[0].text;
    return (async function* () {
      const isWrite = p.includes("按版式为以下每篇报道写稿");
      if (isWrite) {
        // parallelOk：服务端能并行（各自 60ms）；否则排队（串行执行）
        if (parallelOk) await new Promise((r) => setTimeout(r, 60));
        else { const prev = busy; let done; busy = new Promise((r) => (done = r)); await prev; await new Promise((r) => setTimeout(r, 60)); done(); }
      }
      yield { type: "text-delta", text: reply(p) }; yield { type: "finish", reason: { kind: "stop" } };
    })();
  } };
  return createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) });
}

test("并发探测：服务端真并行时之后用 3，排队时用 1；结果交给 onProbe 记住", async () => {
  for (const [ok, want] of [[true, 3], [false, 1]]) {
    const db = editionDb(12);
    let probed = null;
    const ed = await llmEdition(db, slowModel(ok), { pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAXL, maxItems: 100, maxStories: 12, budgetMs: 60000, probe: true, onProbe: (r) => (probed = r) });
    assert.equal(probed.concurrency, want, "parallel=" + ok + " efficiency=" + probed.efficiency);
    assert.equal(ed.stats.written, Object.values(ed.stories).filter((s) => s.by === "llm").length);
    db.close();
  }
});
