/**
 * 质量评测：用固定答案的评测集给各环节打分，改动前后对比。
 *
 *   node scripts/eval.mjs                     程序规则：广告与行情判定、合集拆条、搜索关键词、规则聚类（不需要模型）
 *   node scripts/eval.mjs --llm <OpenAI 兼容地址> [--llm-model 名字]   另评模型归并（成对精确率 / 召回率 / F1）
 *   node scripts/eval.mjs --update-baseline   把本次规则得分写成基线（之后低于基线就失败）
 *
 * 评测集在 tests/eval/cases.json（标题为自拟）。基线在 tests/eval/baseline.json。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => (a.startsWith("--") ? [a.slice(2), xs[i + 1] && !xs[i + 1].startsWith("--") ? xs[i + 1] : true] : null)).filter(Boolean));
const imp = (p) => import(path.join(ROOT, p));
const { compileNoise, matchNoise, splitDigest } = await imp("engine/pipeline/quality.mjs");
const { compileTaxonomy } = await imp("engine/taxonomy.mjs");
const { clusterArticles } = await imp("engine/pipeline/events.mjs");
const { openDb } = await imp("engine/store/schema.mjs");
const { searchTerms } = await imp("host/ask.mjs");
const { groupPrompt, taxonomyIndex, pickCandidates } = await imp("host/edition.mjs");
const { parseJsonLoose } = await imp("host/model.mjs");

const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/eval/cases.json"), "utf8"));
const taxDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "engine/config/taxonomy.json"), "utf8"));
const noise = compileNoise(taxDoc.noise);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);

/** 成对评估：同组的每一对。 */
function pairScore(pred, gold) {
  const ids = Object.keys(gold);
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const g = gold[ids[i]] != null && gold[ids[i]] === gold[ids[j]];
    const p = pred[ids[i]] != null && pred[ids[i]] === pred[ids[j]];
    if (g && p) tp++; else if (p) fp++; else if (g) fn++;
  }
  const P = tp + fp ? tp / (tp + fp) : 1, R = tp + fn ? tp / (tp + fn) : 1;
  return { precision: Math.round(P * 1000) / 10, recall: Math.round(R * 1000) / 10, f1: Math.round((P + R ? (2 * P * R) / (P + R) : 0) * 1000) / 10, pairs: tp + fn };
}

const report = {};
// 1. 入库定性
{
  let ok = 0; const miss = [];
  for (const [title, src, want] of cases.kinds) { const h = matchNoise(noise, { title, summary: "", source_id: src }); const got = h ? h.kind : "news"; if (got === want) ok++; else miss.push(title + "：期望 " + want + "，得到 " + got); }
  report.kinds = { accuracy: pct(ok, cases.kinds.length), n: cases.kinds.length, miss };
}
// 2. 合集拆条
{
  let ok = 0; const miss = [];
  for (const [title, body, want] of cases.digests) { const got = splitDigest({ title, content: body }).length; if (got === want) ok++; else miss.push(title + "：期望 " + want + " 条，得到 " + got); }
  report.digests = { accuracy: pct(ok, cases.digests.length), n: cases.digests.length, miss };
}
// 3. 搜索关键词
{
  let ok = 0; const miss = [];
  for (const [q, want] of cases.terms) { const got = searchTerms(q, taxDoc.entities); if (want.every((w) => got.includes(w)) && got.length <= want.length + 2) ok++; else miss.push(q + "：得到 " + JSON.stringify(got)); }
  report.terms = { accuracy: pct(ok, cases.terms.length), n: cases.terms.length, miss };
}
// 4. 规则聚类（不用模型）：宁可不合并，精确率要高
const gold = Object.fromEntries(cases.groups.map(([t, , g], i) => ["a" + i, g == null ? null : g]));
{
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-eval-")), "e.sqlite"));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const rows = cases.groups.map(([title, lang], i) => {
    const src = (lang === "en" ? "en" : "zh") + (i % 5);
    db.prepare("INSERT OR IGNORE INTO sources (id, name, grp) VALUES (?,?,?)").run(src, src, src);
    db.prepare("INSERT INTO articles (id, url, title, source_id, first_seen_at, last_seen_at, published_at, time_confidence) VALUES (?,?,?,?,?,?,?,'feed')").run("a" + i, "https://x/" + i, title, src, now, now, now);
    return { id: "a" + i, title, source_id: src, published_at: now, time_confidence: "feed", first_seen_at: now };
  });
  clusterArticles(db, rows, { runId: "eval", nowIso: now, tax: compileTaxonomy(taxDoc), sources: new Map(rows.map((r) => [r.source_id, {}])) });
  const pred = Object.fromEntries(db.prepare("SELECT article_id, event_id FROM event_members").all().map((r) => [r.article_id, r.event_id]));
  report.cluster_rules = pairScore(pred, gold);
  db.close();
}
// 5. 模型归并（可选）
if (args.llm) {
  const items = cases.groups.map(([title], i) => ({ n: i + 1, id: "a" + i, title, summary: "", source_name: "源" + (i % 7), published_at: new Date().toISOString().replace("T", " ").slice(0, 19), labels: [] }));
  const tax = taxonomyIndex(taxDoc.labels);
  const t0 = Date.now();
  const r = await fetch(String(args.llm).replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: args["llm-model"] || "default", max_tokens: 2000 + 500 * items.length, messages: [{ role: "user", content: groupPrompt(items, tax, []) }] }) });
  const j = parseJsonLoose(((await r.json()).choices || [{}])[0].message.content || "");
  const pred = {};
  (j && j.stories || []).forEach((s, k) => (s.items || []).forEach((n) => { const it = items[Number(n) - 1]; if (it) pred[it.id] = "g" + k; }));
  report.cluster_model = Object.assign(pairScore(pred, gold), { ms: Date.now() - t0, unassigned: items.filter((it) => !pred[it.id]).length });
}

// 6. 模型归并、分两批（可选）：同一件事的报道交错分到两批，看第二批能不能归进第一批建的报道（按批检索候选）
if (args.llm) {
  const all = cases.groups.map(([title], i) => ({ n: i + 1, id: "a" + i, title, summary: "", source_name: "源" + (i % 7), published_at: new Date().toISOString().replace("T", " ").slice(0, 19), labels: [] }));
  const tax = taxonomyIndex(taxDoc.labels);
  const ask = async (batch, cands) => {
    const r = await fetch(String(args.llm).replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: args["llm-model"] || "default", max_tokens: 2000 + 500 * batch.length, messages: [{ role: "user", content: groupPrompt(batch, tax, cands, []) }] }) });
    return parseJsonLoose(((await r.json()).choices || [{}])[0].message.content || "") || { stories: [] };
  };
  const t0 = Date.now();
  const b1 = all.filter((_, i) => i % 2 === 0), b2 = all.filter((_, i) => i % 2 === 1);
  const groups = [];
  const pred = {};
  (await ask(b1, [])).stories.forEach((s) => { const its = (s.items || []).map((n) => all[Number(n) - 1]).filter(Boolean); if (!its.length) return; const g = { id: "g" + groups.length, title: s.title || its[0].title, importance: Number(s.importance) || 50, entities: s.entities || [] }; groups.push(g); its.forEach((it) => (pred[it.id] = g.id)); });
  const cands = args.old ? [] : pickCandidates(groups, b2, 30);
  (await ask(b2, cands)).stories.forEach((s) => {
    const its = (s.items || []).map((n) => all[Number(n) - 1]).filter(Boolean);
    const m = /^S(\d+)$/i.exec(String(s.story || "").trim());
    const gid = m && cands[Number(m[1]) - 1] ? cands[Number(m[1]) - 1].id : "n" + Math.random();
    its.forEach((it) => (pred[it.id] = gid));
  });
  report.cluster_model_batched = Object.assign(pairScore(pred, gold), { ms: Date.now() - t0 });
}

console.log(JSON.stringify(report, null, 2));
const basePath = path.join(ROOT, "tests/eval/baseline.json");
const keys = ["kinds.accuracy", "digests.accuracy", "terms.accuracy", "cluster_rules.precision", "cluster_rules.recall"];
const get = (o, k) => k.split(".").reduce((x, y) => (x || {})[y], o);
if (args["update-baseline"]) { fs.writeFileSync(basePath, JSON.stringify(Object.fromEntries(keys.map((k) => [k, get(report, k)])), null, 2) + "\n"); console.log("基线已更新"); process.exit(0); }
if (fs.existsSync(basePath)) {
  const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const worse = keys.filter((k) => get(report, k) < base[k]);
  if (worse.length) { console.log("低于基线：" + worse.map((k) => k + " " + get(report, k) + " < " + base[k]).join("；")); process.exit(1); }
  console.log("不低于基线");
}
