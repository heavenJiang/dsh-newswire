/**
 * dsh-newswire 引擎 CLI（可脱离插件直跑）。
 *
 *   node engine/run.mjs [--mode fetch] [--config ...] [--db ...] [--out ...] [--raw ...]
 *        [--since-hours 24] [--sources a,b] [--categories x,y] [--packs core] [--max-items N]
 *        [--per-source 12] [--export jsonl,csv] [--run-id ...] [--tz Asia/Shanghai]
 *        [--browse-bin ...] [--browse-session news-ingest] [--agent-reach-bin ...] [--mcporter-bin ...]
 *
 *   node engine/run.mjs --mode cycle [同上参数] [--overnight] [--min-corroborated 50] [--min-single 36] [--max-push 8] [--dry-run] [--defer-push] [--backfill-budget 3]
 *        整轮：抓取（按断点衔接、缺口翻页/搜索补抓）→ 分类与事件聚类打分 → 汇总 → 按事件选重点 → stdout 末行 NEWSWIRE_JSON { message, ... }。
 *        message 是发到手机的成品文本；--dry-run 不记推送（不影响下次去重）。
 *
 *   node engine/run.mjs --mode reprocess [--stage labels|events] [--hours 72] [--config/--db/--taxonomy]
 *        分类规则或聚类逻辑改了之后重算时间窗内的标签（与事件）。
 *
 *   node engine/run.mjs --mode export --from 2026-11-01 [--to 2026-11-07] [--kind all|articles|events|stories] [--pack core] [--datasets <目录>]
 *        导出数据集（articles.jsonl / events.jsonl / manifest.json），stdout 末行 NEWSWIRE_JSON { dir, manifest 摘要 }。
 *
 *   fetch / cycle 另收 --body-budget 12（每轮为重点事件抓正文的篇数，0 关闭）、--raw-retention-days 180。
 *
 *   node engine/run.mjs --mode test-source (--source <id> | --source-file <json>) [--max-items 10]
 *        只抓不入库，stdout 末行输出 `NEWSWIRE_JSON {...}`：通道链结果、前 N 条解析结果与识别到的热度信号。
 *
 * 外部命令路径未给时自动探测（PATH 与常见安装位置），找不到则对应通道视为不可用并降级。
 */
import fs from "node:fs";
import path from "node:path";
import { openDb, upsertSource, startRun, finishRun } from "./store/db.mjs";
import { bingResults, searchUrl } from "./parsers/search.mjs";
import { configureBrowse, browseStatus, ensureSession, browseFetch } from "./channels/browse.mjs";
import { configureAgentReach } from "./channels/agent_reach.mjs";
import { fetchSource, DEFAULT_CHAIN } from "./pipeline/fetch.mjs";
import { toRecord } from "./pipeline/normalize.mjs";
import { presentSignals } from "./pipeline/signals.mjs";
import { writeDigest, exportFiles, stamp, zdt } from "./pipeline/digest.mjs";
import { processSource } from "./pipeline/ingest.mjs";
import { compileNoise, reassess, isDigestTitle } from "./pipeline/quality.mjs";
import { upsertArticle } from "./store/db.mjs";
import { selectEvents, recordPushes, composeMessage, messageParts, failingSources, DEFAULT_RULES } from "./pipeline/select.mjs";
import { processEvents, reprocess } from "./pipeline/events.mjs";
import { compileTaxonomy } from "./taxonomy.mjs";
import { bodyCandidates, fetchBodies, bodyProfiles, fillCandidates, fillBodies } from "./pipeline/bodies.mjs";
import { exportDataset } from "./export.mjs";
import { applyRetention } from "./retention.mjs";
import { coolingMap } from "./pipeline/cooling.mjs";
import { acquireLock, acquireLockWait } from "./lock.mjs";
import { findBin } from "./bins.mjs";
import { loadConfig, readJson, loadTaxonomyFile } from "./config.mjs";
import { isoUtc } from "./util/text.mjs";
import { scrub } from "./channels/classify.mjs";

function argo(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const k = t.slice(2);
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith("--")) a[k] = true; else { a[k] = nx; i++; }
  }
  return a;
}
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : "");

const A = argo(process.argv.slice(2));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const SEED = path.join(ROOT, "config/sources.json");
const CFG_PATH = path.resolve(str(A.config) || SEED);
const DB = path.resolve(str(A.db) || path.join(ROOT, "data/news.sqlite"));
const OUT = path.resolve(str(A.out) || path.join(ROOT, "out"));
const RAW = path.resolve(str(A.raw) || path.join(ROOT, "raw"));
const TZ = str(A.tz) || "Asia/Shanghai";
const MODE = str(A.mode) || "fetch";

configureBrowse({ bin: findBin("browse", str(A["browse-bin"])) || "", session: str(A["browse-session"]) || "news-ingest" });
configureAgentReach({ bin: findBin("agent-reach", str(A["agent-reach-bin"])) || "", mcporter: findBin("mcporter", str(A["mcporter-bin"])) || "" });

const cfg = loadConfig(CFG_PATH, SEED);
const TAX_SEED = path.join(ROOT, "config/taxonomy.json");
const TAX_PATH = path.resolve(str(A.taxonomy) || (fs.existsSync(path.join(path.dirname(CFG_PATH), "taxonomy.json")) ? path.join(path.dirname(CFG_PATH), "taxonomy.json") : TAX_SEED));
/** 分类体系：数据目录那份按种子版本自动合并升级后编译。 */
const loadTaxonomy = () => compileTaxonomy(TAX_PATH === TAX_SEED ? readJson(TAX_SEED) : loadTaxonomyFile(TAX_PATH, TAX_SEED));
/** 本轮属于哪个主题包：只指定了一个包时就是它，否则 all。 */
const PACK = str(A.packs) && !A.packs.includes(",") ? A.packs : "all";
const allSources = () => new Map((cfg.sources || []).map((s) => [s.id, Object.assign({}, DEF, s)]));
const DEF = cfg.defaults || {};
const now = new Date();
const windowHours = Number(A["since-hours"] || A.window || 24);
const hardMax = Number(A["max-items"] || 0);

// 模型读页面得到的条目（「不限」档）：插件先读好，按源 id 存成 <dir>/<id>.json，这里照常走入库流程
const PREFETCHED = (() => {
  const dir = str(A.prefetched);
  const out = {};
  if (!dir) return out;
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) { try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) {} } } catch (e) {}
  return out;
})();

function envFor(browse, writeRaw, onAttempt) {
  return {
    browse, windowHours, maxOverride: hardMax, retries: DEF.retries_per_channel || 1, backoffMs: DEF.backoff_ms || 800,
    timeoutMs: DEF.timeout_ms || 30000, defaultChain: DEF.channels || DEFAULT_CHAIN, writeRaw, onAttempt, prefetched: PREFETCHED,
  };
}

async function preflight(sources) {
  const needsBrowse = sources.some((s) => (s.channels || DEF.channels || DEFAULT_CHAIN).includes("browse"));
  if (!needsBrowse) return { ok: false, reason: "not_needed" };
  const pre = await browseStatus();
  if (pre.ok) await ensureSession();
  return pre;
}

// ------------------------------------------------------------------ 页面全文快照（模型读页面用）
if (MODE === "read") {
  const url = str(A.url);
  if (!url) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "url_required" })); process.exit(2); }
  const pre = await preflight([Object.assign({}, DEF, { id: "read", url, channels: ["browse"] })]);
  if (!pre.ok) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "browse_unavailable", reason: pre.reason || null })); process.exit(2); }
  const res = await browseFetch("read", url, 1, { timeoutMs: 90000, waitFor: str(A["wait-for"]) || "" });
  const d = (res && res.data) || {};
  const v = (res && res.value) || {};
  // 输出可能很大：等写完再退出，否则管道里会被截断
  await new Promise((r) => process.stdout.write("NEWSWIRE_JSON " + JSON.stringify({ ok: Boolean(res.ok && d.text), url, page_url: v.page_url || null, title: v.doc_title || null, text: d.text || "", links: d.links || [], times: d.times || [], truncated: Boolean(d.truncated), scroll: d.scroll || null, error: res.ok ? null : res.error }) + "\n", r));
  process.exit(res.ok ? 0 : 2);
}

// ------------------------------------------------------------------ 网页搜索（影响分析与背景补充用；browse 打开 Bing 结果页，不用收费搜索接口）
if (MODE === "search") {
  const q = str(A.query);
  if (!q) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "query_required" })); process.exit(2); }
  const url = searchUrl(q);
  const pre = await preflight([Object.assign({}, DEF, { id: "search", url, channels: ["browse"] })]);
  if (!pre.ok) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "browse_unavailable", reason: pre.reason || null })); process.exit(2); }
  const res = await browseFetch("html", url, 1, { timeoutMs: 45000, waitFor: "li.b_algo", raw: true });
  const html = res.ok && res.data && typeof res.data.html === "string" ? res.data.html : "";
  const results = html ? bingResults(html, Number(A.max) || 6) : [];
  await new Promise((r) => process.stdout.write("NEWSWIRE_JSON " + JSON.stringify({ ok: results.length > 0, query: q, results, error: res.ok ? (results.length ? null : "no_results") : res.error }) + "\n", r));
  process.exit(results.length ? 0 : 2);
}

// ------------------------------------------------------------------ 页面结构概要（给模型学解析规则用）
if (MODE === "outline") {
  const url = str(A.url);
  if (!url) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "url_required" })); process.exit(2); }
  const pre = await preflight([Object.assign({}, DEF, { id: "outline", url, channels: ["browse"] })]);
  if (!pre.ok) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "browse_unavailable", reason: pre.reason || null })); process.exit(2); }
  const res = await browseFetch("outline", url, 1, { timeoutMs: 90000 });
  const d = (res && res.data) || {};
  const v = (res && res.value) || {};
  // 输出可能很大：等写完再退出，否则管道里会被截断
  await new Promise((r) => process.stdout.write("NEWSWIRE_JSON " + JSON.stringify({ ok: Boolean(res.ok && d.outline), url, page_url: v.page_url || null, title: v.doc_title || null, outline: d.outline || "", truncated: Boolean(d.truncated), error: res.ok ? null : res.error }) + "\n", r));
  process.exit(res.ok ? 0 : 2);
}

// ------------------------------------------------------------------ 试抓
if (MODE === "test-source") {
  let src = null;
  try {
    if (str(A["source-file"])) src = readJson(path.resolve(A["source-file"]));
    else if (str(A.source)) src = (cfg.sources || []).find((s) => s.id === A.source) || null;
  } catch (e) {
    console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "bad_source_file: " + e.message }));
    process.exit(2);
  }
  if (!src) {
    console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "source_not_found" }));
    process.exit(2);
  }
  const merged = Object.assign({}, DEF, src);
  const pre = await preflight([merged]);
  const res = await fetchSource(merged, envFor(pre, () => "", null));
  const shown = Math.min(hardMax || 10, 30);
  const records = [];
  const skipped = {};
  res.items.forEach((it, i) => {
    const r = toRecord(it, merged, { index: i, nowMs: Date.now(), minTextLen: DEF.min_text_len, parser: res.parsed_by });
    if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; return; }
    records.push(r);
  });
  const sigCount = {};
  for (const r of records) for (const n of presentSignals(r.signals)) sigCount[n] = (sigCount[n] || 0) + 1;
  const timeCount = records.reduce((m, r) => (m[r.time_confidence] = (m[r.time_confidence] || 0) + 1, m), {});
  const out = {
    ok: Boolean(res.won), source_id: merged.id, channel: res.won, parsed_by: res.parsed_by,
    browse: { ok: pre.ok, reason: pre.reason || null },
    attempts: res.attempts.map((a) => ({ channel: a.channel, ok: a.ok, backend: a.backend || null, http_status: a.http_status ?? null, items: a.items ?? null, latency_ms: a.latency_ms ?? null, error_kind: a.error_kind || null, error: a.error ? scrub(a.error).slice(0, 300) : null, hint: a.hint || null, note: a.note || null })),
    parsed: res.items.length, kept: records.length, skipped,
    signals: sigCount, time_confidence: timeCount,
    items: records.slice(0, shown).map((r) => ({ title: r.title, url: r.url, published_at: r.published_at, time_confidence: r.time_confidence, summary: r.summary.slice(0, 160), signals: { views: r.signals.views, comments: r.signals.comments, likes: r.signals.likes, shares: r.signals.shares, favorites: r.signals.favorites, hot: r.signals.hot, level: r.signals.level, rank: r.signals.rank, section: r.signals.section } })),
  };
  console.log("NEWSWIRE_JSON " + JSON.stringify(out));
  process.exit(out.ok ? 0 : 2);
}

// ------------------------------------------------------------------ 重算标签 / 事件
if (MODE === "reprocess") {
  const db = openDb(DB);
  const lock = acquireLock(path.dirname(DB), { mode: MODE }, 45 * 60000);
  if (!lock.ok) { console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "run_in_progress", holder: lock.holder })); process.exit(3); }
  try {
    const hoursBack = Math.min(24 * 90, Math.max(1, Number(A.hours || 72)));
    const tax = loadTaxonomy();
    const sinceIso = isoUtc(Date.now() - hoursBack * 3600000);
    // 训练可用性按当前源配置重算（例如快讯源改为 body=list 后，60 字以上即可用）
    const minLen = DEF.min_text_len || 200;
    const upd = db.prepare("UPDATE articles SET training_ready = CASE WHEN paywalled = 0 AND COALESCE(text_len, 0) >= ? THEN 1 ELSE 0 END WHERE source_id = ? AND last_seen_at >= ?");
    for (const s of allSources().values()) upd.run(s.body === "list" ? 60 : minLen, s.id, sinceIso);
    // 内容定性按当前 noise 规则重算（广告 / 合集拆条 / 完整度）
    const qa = reassess(db, { sinceIso, noise: compileNoise(tax.doc.noise), upsert: upsertArticle });
    console.log("[quality] 广告与引流 " + qa.promo + "，合集 " + qa.digest + "（补拆 " + qa.items + " 条）");
    const r = reprocess(db, { sinceIso, stage: str(A.stage) || "events", tax, sources: allSources(), runId: "reprocess-" + stamp(now, TZ), nowIso: isoUtc(now) });
    console.log("NEWSWIRE_JSON " + JSON.stringify(Object.assign({ ok: true, hours: hoursBack, stage: str(A.stage) || "events", rules_version: tax.rulesVersion, quality: qa }, r)));
  } finally {
    lock.release();
  }
  process.exit(0);
}

// ------------------------------------------------------------------ 导出数据集
if (MODE === "export") {
  const db = openDb(DB);
  try {
    const from = str(A.from) || new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(now);
    const r = exportDataset(db, { from, to: str(A.to) || from, kind: str(A.kind) || "all", pack: str(A.packs) || str(A.pack) || null, outDir: path.resolve(str(A.datasets) || path.join(path.dirname(DB), "datasets")), cfg, tax: loadTaxonomy(), now });
    console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: true, dir: r.dir, files: r.manifest.files, range: r.manifest.range, runs: r.manifest.coverage.runs, open_gaps: r.manifest.coverage.open_gaps.length, failed_source_runs: r.manifest.coverage.failed_source_runs.length }));
  } catch (e) {
    console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: e.message }));
    process.exit(2);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ 抓一轮（fetch）/ 整轮（cycle：抓取 + 选择 + 推送消息）
const db = openDb(DB);
// 两个主题包的定时任务撞上时，后来的等前一轮结束（--lock-wait-ms，默认不等）
const lock = await acquireLockWait(path.dirname(DB), { mode: MODE, pack: PACK, run_id: str(A["run-id"]) || null }, Number(A["lock-stale-ms"] || 45 * 60000), Number(A["lock-wait-ms"] || 0));
if (!lock.ok) {
  const msg = "已有一轮在跑（" + ((lock.holder && (lock.holder.run_id || lock.holder.mode)) || "?") + "，开始于 " + ((lock.holder && lock.holder.started_at) || "?") + "）";
  console.log(msg);
  if (MODE === "cycle") console.log("NEWSWIRE_JSON " + JSON.stringify({ ok: false, error: "run_in_progress", holder: lock.holder, message: zdt(now, TZ, false).slice(11, 16) + " 本轮跳过：" + msg }));
  process.exit(3);
}
process.on("exit", () => lock.release());
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { lock.release(); process.exit(130); });

const runId = str(A["run-id"]) || (MODE === "cycle" ? "cycle-" : "run-") + stamp(now, TZ) + "-" + isoUtc(now).slice(11, 19).replace(/:/g, "") + "-" + Math.random().toString(36).slice(2, 6);
const nowIso = isoUtc(now);

for (const s of cfg.sources) upsertSource(db, Object.assign({}, DEF, s), nowIso);

let sel = cfg.sources.filter((s) => s.enabled !== false && !s.removed_at).map((s) => Object.assign({}, DEF, s));
const packs = cfg.packs || {};
sel = sel.filter((s) => !packs[s.pack || "core"] || packs[s.pack || "core"].enabled !== false);
if (str(A.sources)) { const ids = A.sources.split(","); sel = sel.filter((s) => ids.includes(s.id)); }
// 连续失败的源降频：平时跳过，隔几小时试一次（指名抓的不跳）
const cooled = [];
if (!str(A.sources) && A["no-cooling"] !== true) {
  const cm = coolingMap(db, sel.map((s) => s.id), { now: now.getTime() });
  sel = sel.filter((s) => { const c = cm.get(s.id); if (!c || c.probe_due) return true; cooled.push(Object.assign({ id: s.id }, c)); return false; });
}
if (str(A.categories)) { const cs = A.categories.split(","); sel = sel.filter((s) => cs.includes(s.category)); }
if (str(A.packs)) { const ps = A.packs.split(","); sel = sel.filter((s) => ps.includes(s.pack || "core")); }

// 距上一整轮多久：决定本轮规模（隔夜 / 长间隔抓得更多）与推送回看范围
const lastCycle = db.prepare("SELECT started_at FROM runs WHERE mode = 'cycle' AND COALESCE(pack, 'all') = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(PACK);
const gapHours = lastCycle ? (now.getTime() - Date.parse(lastCycle.started_at.replace(" ", "T") + "Z")) / 3600000 : null;
const localHour = Number(zdt(now, TZ, false).slice(11, 13));
// 隔夜：早上 10 点前、且距上一轮（同一主题包）≥6 小时或首轮。白天长时间中断后的那轮不算隔夜，但规模照样按间隔放大
const overnight = A.overnight === true || (MODE === "cycle" && localHour < 10 && (gapHours == null || gapHours >= 6));
const scale = overnight ? 4 : gapHours == null ? 1 : Math.min(3, Math.max(1, Math.ceil(gapHours / 2)));

const pre = await preflight(sel);
console.log("[preflight] browse:", pre.ok ? "OK browser=" + pre.browser : "不可用 reason=" + pre.reason + (pre.detail ? " " + pre.detail : ""));
if (MODE === "cycle") console.log("[cycle] " + (PACK !== "all" ? "主题包 " + PACK + " " : "") + (overnight ? "隔夜模式 " : "") + "规模×" + scale + (gapHours != null ? " 距上一整轮 " + gapHours.toFixed(1) + "h" : " 首轮"));

for (const c of cooled) console.log("SKIP  " + c.id.padEnd(18) + " 连续 " + c.fails + " 轮失败（" + c.reason + "），降频中，下次尝试 " + c.next_probe + " UTC");
startRun(db, runId, nowIso, MODE, PACK);
const rawDir = path.join(RAW, stamp(now, TZ).slice(0, 8), stamp(now, TZ).slice(8, 10));
fs.mkdirSync(rawDir, { recursive: true });
const writeRaw = (name, text) => { const p = path.join(rawDir, name); fs.writeFileSync(p, text); return p; };

const results = [];
const totals = { raw: 0, fresh: 0, dup: 0 };
const backfillBudget = { left: Number(A["backfill-budget"] ?? 3) };
const noise = compileNoise(loadTaxonomy().doc.noise);
for (const src of sel) {
  const r = await processSource(src, { db, runId, now, nowIso, defaults: DEF, scale, backfillBudget, writeRaw, noise, fetchEnv: envFor(pre, writeRaw, null) });
  results.push(r);
  if (r.ok) { totals.raw += r.stored; totals.fresh += r.fresh; totals.dup += r.dup; }
  console.log((r.ok ? "OK  " : "FAIL") + "  " + r.id.padEnd(18) + " 通道=" + (r.channel || "-") + " 条数=" + r.items + " 入库=" + r.stored + " 衔接=" + r.continuity + (r.pages > 1 ? " 翻页=" + r.pages : "") + (r.backfilled ? " 补回=" + r.backfilled : "") + (r.signals && r.signals.length ? " 信号=" + r.signals.join("/") : "") + (r.ok ? "" : " | " + r.attempts.map((x) => x.channel + ":" + (x.error_kind || "err")).join(" -> ")));
}

const failed = results.filter((x) => !x.ok);
const gapsOpen = results.filter((x) => x.continuity === "gap_open" || x.continuity === "gap_partial").length;
finishRun(db, runId, { finished_at: isoUtc(new Date()), sources_total: results.length, sources_ok: results.length - failed.length, sources_failed: failed.length, items_raw: totals.raw, items_new: totals.fresh, items_dup: totals.dup, notes: "browse=" + (pre.ok ? "on" : "off:" + pre.reason) + (MODE === "cycle" ? " scale=" + scale + (overnight ? " overnight" : "") : "") + (gapsOpen ? " gaps=" + gapsOpen : "") });

// 合集（早间精选、周末要闻汇总……）的正文常被列表截断：先抓全文，再重新拆条
try {
  const dg = db.prepare(`SELECT DISTINCT a.id, a.url, a.title FROM observations ob JOIN articles a ON a.id = ob.article_id
    LEFT JOIN article_bodies b ON b.article_id = a.id WHERE ob.run_id = ? AND COALESCE(a.completeness, '') != 'full' AND b.article_id IS NULL AND COALESCE(a.kind, 'news') != 'promo'`).all(runId)
    .filter((a) => isDigestTitle(a.title)).slice(0, 4);
  if (dg.length) {
    const b = await fetchBodies(db, dg, { runId, minTextLen: DEF.min_text_len || 200, browse: pre.ok });
    const qa = reassess(db, { ids: dg.map((x) => x.id), noise, upsert: upsertArticle });
    console.log("[digest] 合集补全文 " + b.ok + "/" + b.tried + "，拆出 " + qa.items + " 条");
  }
} catch (e) {
  console.log("[digest] 失败：" + e.message);
}
// 分类 → 事件聚类 → 交叉验证打分（失败不影响抓取结果入库）
const tax = loadTaxonomy();
let ev = { touched: [], scored: [], merged: 0, fresh: 0 };
try {
  ev = processEvents(db, { runId, nowIso, tax, sources: allSources() });
  console.log("[events] 本轮条目 " + ev.labelled + "，新归入 " + ev.fresh + "（并入已有事件 " + ev.merged + "），触及事件 " + ev.touched.length);
} catch (e) {
  console.log("[events] 失败：" + e.message);
}
// 补正文：按源学到的策略——便宜的源新条目逐条补，没记录的源试 2 篇来学（每轮预算 --fill-budget，最长 90 秒）
const profiles = bodyProfiles(db, allSources());
const fillBudget = Number(A["fill-budget"] ?? 150);
if (fillBudget > 0) {
  try {
    const list = fillCandidates(db, { runId, profiles, budget: fillBudget });
    if (list.length) {
      const b = await fillBodies(db, list, { runId, minTextLen: DEF.min_text_len || 200, browse: pre.ok, concurrency: 4, maxMs: 90000 });
      console.log("[fill] 补正文 " + b.ok + "/" + b.tried + "（" + Math.round(b.ms / 1000) + "s）");
    }
  } catch (e) {
    console.log("[fill] 失败：" + e.message);
  }
}
// 正文两段式：本轮重点事件的成员（每轮预算 --body-budget；慢的源只在这里补）
const bodyBudget = Number(A["body-budget"] ?? 12);
if (bodyBudget > 0 && ev.touched.length) {
  try {
    const list = bodyCandidates(db, { touched: ev.touched, budget: bodyBudget, minImportance: 50, minTextLen: DEF.min_text_len || 200, sources: allSources(), profiles: bodyProfiles(db, allSources()) });
    if (list.length) {
      const b = await fetchBodies(db, list, { runId, minTextLen: DEF.min_text_len || 200, browse: pre.ok });
      console.log("[bodies] 抓正文 " + b.tried + " 篇，成功 " + b.ok);
    }
  } catch (e) {
    console.log("[bodies] 失败：" + e.message);
  }
}

const topEvents = ev.touched.length ? db.prepare("SELECT * FROM events WHERE event_id IN (" + ev.touched.map(() => "?").join(",") + ") ORDER BY importance DESC LIMIT 15").all(...ev.touched) : [];

const digest = writeDigest(db, { runId, now, results, browse: pre, windowHours, categories: cfg.categories, outDir: OUT, perSource: Number(A["per-source"] || 12), tz: TZ, totals, events: topEvents, names: tax.names });
if (str(A.export)) for (const p of exportFiles(digest.rows, { kinds: A.export.split(","), outDir: OUT, now, tz: TZ })) console.log("导出:", p);

try {
  const rt = applyRetention({ rawDir: RAW, today: stamp(now, TZ).slice(0, 8), retentionDays: Number(A["raw-retention-days"] || 180) });
  if (rt.compressed || rt.removedDays) console.log("[raw] 压缩 " + rt.compressed + " 个文件（省 " + Math.round(rt.savedBytes / 1048576) + "MB），删除 " + rt.removedDays + " 天");
} catch (e) {
  console.log("[raw] 保留策略执行失败：" + e.message);
}

console.log("");
console.log("汇总文件:", digest.path);
console.log("数据库:", DB, "｜ 运行:", runId, "｜ 成功", results.length - failed.length, "/", results.length, "｜ 新增条目", totals.fresh);

if (MODE === "cycle") {
  const sources = allSources();
  const lookback = overnight ? 12 : gapHours == null ? 6 : Math.min(14, Math.max(2, gapHours + 0.5));
  const packRules = (cfg.push && (cfg.push[PACK] || cfg.push.core)) || {};
  const rules = Object.assign({}, DEFAULT_RULES, packRules);
  if (A["min-corroborated"]) rules.min_corroborated = Number(A["min-corroborated"]);
  if (A["min-single"]) rules.min_single = Number(A["min-single"]);
  if (A["max-push"]) rules.max = Number(A["max-push"]);
  const picks = selectEvents(db, { touched: ev.touched, nowIso, lookbackHours: lookback, rules });
  const failing = failingSources(db, 3);
  const packInfo = (cfg.packs || {})[PACK] || {};
  const msgArgs = { now, tz: TZ, overnight, results, picks, sources, failing, names: tax.names, title: packInfo.title || null };
  const message = composeMessage(msgArgs);
  // --defer-push：由插件（版面模式）决定推什么并记推送
  if (A["dry-run"] !== true && A["defer-push"] !== true) recordPushes(db, picks, runId, nowIso);
  console.log("NEWSWIRE_JSON " + JSON.stringify({
    ok: results.length > 0 && failed.length < results.length, run_id: runId, overnight, scale, message,
    stats: { sources: results.length, ok: results.length - failed.length, fresh: totals.fresh, dup: totals.dup, gaps_open: gapsOpen, events_touched: ev.touched.length, merged: ev.merged, picked: picks.length },
    rules,
    parts: messageParts(msgArgs), pack: PACK, lookback_hours: lookback, defer_push: A["defer-push"] === true && A["dry-run"] !== true,
    picks: picks.map((p) => ({ event_id: p.event_id, lead_article_id: p.lead_article_id, pack: p.pack || "core", title: p.title, url: p.lead.url, importance: p.importance, credibility: p.credibility, reason: p.reason, source_count: p.source_count, outlets: p.outlets.map((x) => x.source_id), labels: p.labels })),
    continuity: results.map((r) => ({ id: r.id, status: r.continuity, pages: r.pages || 0, backfilled: r.backfilled || 0 })),
    digest_path: digest.path,
  }));
}
process.exitCode = results.length && failed.length === results.length ? 2 : 0;
