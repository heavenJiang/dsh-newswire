/**
 * dsh-newswire — 新闻抓取插件（Host 半边，plain ESM JS，零构建）。
 *
 * 职责（薄层）：Config、模型工具、面板路由、systemPrompt 段落。
 * 抓取与入库在 engine/（子进程跑 engine/run.mjs，崩了不拖垮宿主）；读查询统一走 engine/query.mjs。
 * 产物（sources.json / news.sqlite / raw / out）写到 config.dataDir，与包目录解耦。任何密钥都不进 Config。
 */

import { makeDeepRead, modelSplitDigests } from "./host/deepread.mjs";
import { contentHealth, filteredItems } from "./host/health.mjs";
import { sourceScores, setSourceState } from "./host/sources.mjs";
import { translateTitles } from "./host/translate.mjs";
import { DEPTHS, depthOf, depthParams, recordCall, usageToday, makeGate } from "./host/runtime.mjs";
import { searchNews, answerNews } from "./host/ask.mjs";
import { analysisMaterials, analyzeStory, saveAnalysis, latestAnalysis, analysisBrief, autoAnalyzeTargets } from "./host/analysis.mjs";
import { listTrackers, addTracker, removeTracker, unlinkStory, linkAll, trackerDetail, synthesize, suggestions as trackSuggestions, synthTargets } from "./host/tracking.mjs";
import { CADENCES, LEVELS, loadPush, savePush, normalizePush, sectionPenalties, rulesFor, applyDailyCap, recentPushes as pushHistory } from "./host/push.mjs";
import { markKind } from "./engine/pipeline/quality.mjs";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { openIfExists, sinceIso, latestRun, recentRuns, countsByCategory, keywords, failureRows, attemptRows, sourceHealth, itemRows, signalTrail, continuityRows, continuitySummary, recentGaps, recentPushes, eventRows, eventDetail, labelCounts, dayRange, timelineDay, timelineRun } from "./engine/query.mjs";
import { readLock } from "./engine/lock.mjs";
import { createModel, analyzeEvents } from "./host/model.mjs";
import { loadLayout, ruleEdition, llmEdition, saveEdition, latestEdition, notesFromEdition, editionPicks, recordEditionPushes, composeEditionMessage, storyDetail, sinceSeen, reassemble, scrubStory, qualityRows, editionById, editionList, tickerBoard, updateEditionContent, bodiesFor } from "./host/edition.mjs";
import { buildDaily, saveDaily, latestDaily, dailyDates, composeDailyMessage, todayBj } from "./host/daily.mjs";
import { recordPushes, DEFAULT_RULES } from "./engine/pipeline/select.mjs";
import { loadFollows, updateFollows, KINDS as FOLLOW_KINDS } from "./host/follows.mjs";
import { UpdateChecker, githubToken, installedPackage } from "./host/update.mjs";
import { findBin } from "./engine/bins.mjs";
import { loadConfig, loadTaxonomyFile, readJson } from "./engine/config.mjs";
import { adapterIds } from "./engine/adapters/index.mjs";
import { CHANNELS } from "./engine/constants.mjs";

export const name = "dsh-newswire";

export const inject = ["connection", "tools", "subprocess", "systemPrompt"];

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  engineDir: path.join(PACKAGE_DIR, "engine"),
  dataDir: path.join(os.homedir(), ".dsh", "newswire"),
  nodeBin: process.execPath,
  browseBin: "",
  browseSession: "news-ingest",
  agentReachBin: "",
  mcporterBin: "",
  windowHours: 24,
  timeoutMs: 600000,
  tailChars: 1500,
  rawRetentionDays: 180,
  bodyBudget: 12,
  modelMode: "llm",
  llmMaxItems: 150,
  llmStories: 16,
  llmBudgetMs: 1500000,
  modelTimeoutMs: 180000,
};

export const Config = z.object({
  engineDir: z.string().default(DEFAULTS.engineDir),
  dataDir: z.string().default(DEFAULTS.dataDir),
  nodeBin: z.string().default(DEFAULTS.nodeBin),
  browseBin: z.string().default(DEFAULTS.browseBin),
  browseSession: z.string().default(DEFAULTS.browseSession),
  agentReachBin: z.string().default(DEFAULTS.agentReachBin),
  mcporterBin: z.string().default(DEFAULTS.mcporterBin),
  windowHours: z.number().min(1).max(336).step(1).default(DEFAULTS.windowHours),
  timeoutMs: z.number().min(30000).max(1800000).step(1000).default(DEFAULTS.timeoutMs),
  tailChars: z.number().min(200).max(6000).step(100).default(DEFAULTS.tailChars),
  rawRetentionDays: z.number().min(1).max(3650).step(1).default(DEFAULTS.rawRetentionDays),
  bodyBudget: z.number().min(0).max(60).step(1).default(DEFAULTS.bodyBudget),
  modelMode: z.union([z.const("llm"), z.const("economy")]).default(DEFAULTS.modelMode),
  llmMaxItems: z.number().min(20).max(600).step(10).default(DEFAULTS.llmMaxItems),
  llmStories: z.number().min(3).max(40).step(1).default(DEFAULTS.llmStories),
  llmBudgetMs: z.number().min(60000).max(3600000).step(10000).default(DEFAULTS.llmBudgetMs),
  modelTimeoutMs: z.number().min(10000).max(600000).step(1000).default(DEFAULTS.modelTimeoutMs),
}).i18n({
  en: {
    engineDir: "Engine directory. Leave the default (the engine shipped in this package).",
    dataDir: "Data directory for sources.json, taxonomy.json, news.sqlite, raw snapshots, digests, and datasets.",
    nodeBin: "Node.js executable that runs the engine.",
    browseBin: "Path to the browse CLI (first channel). Leave empty to detect it automatically.",
    browseSession: "browse session name reserved for this plugin.",
    agentReachBin: "Path to the agent-reach CLI (second channel). Leave empty to detect it automatically.",
    mcporterBin: "Path to mcporter, used for agent-reach's web-reader and Exa backfill search. Leave empty to detect it automatically.",
    windowHours: "Default window in hours for digests and lists.",
    timeoutMs: "Timeout for one fetch round, in milliseconds.",
    tailChars: "Characters of the engine log returned to the model.",
    rawRetentionDays: "Days to keep raw page snapshots. Snapshots older than a day are gzipped; older than this are deleted.",
    bodyBudget: "Article bodies fetched per round for the top events (0 turns body fetching off).",
    modelMode: "Default mode until one is picked in the panel (Runs → Model): llm = a model reads each round's news and lays out the edition (grouping, sections, importance, copy); economy = no model calls, the program lays out the edition from the rules. The model itself is picked in the panel; the harness default model is used until then.",
    llmMaxItems: "LLM mode: news items the model reads per edition.",
    llmStories: "LLM mode: stories the model writes copy for per edition (front page and sections); the rest get program copy.",
    llmBudgetMs: "LLM mode: time budget for one edition, in milliseconds; steps past it fall back to rule results.",
    modelTimeoutMs: "Timeout for one model call, in milliseconds.",
  },
  zh: {
    engineDir: "抓取引擎目录。保持默认（本包自带的引擎）。",
    dataDir: "数据目录：sources.json、taxonomy.json、news.sqlite、原始快照、汇总和数据集都写在这里。",
    nodeBin: "运行引擎的 Node.js 可执行文件。",
    browseBin: "browse CLI 路径（第一通道）。留空自动探测。",
    browseSession: "本插件专用的 browse 会话名。",
    agentReachBin: "agent-reach CLI 路径（第二通道）。留空自动探测。",
    mcporterBin: "mcporter 路径（agent-reach 的 web-reader 与 Exa 补抓搜索用）。留空自动探测。",
    windowHours: "汇总与列表的默认时间窗（小时）。",
    timeoutMs: "一轮抓取的超时（毫秒）。",
    tailChars: "返回给模型的引擎日志字符数。",
    rawRetentionDays: "原始页面快照保留天数。超过一天的压缩为 gzip，超过此天数的删除。",
    bodyBudget: "每轮为重点事件抓取正文的篇数（0 关闭正文抓取）。",
    modelMode: "面板（运行 → 模型）里没选过时的默认模式：llm = 模型阅读每轮新闻并编排版面（归并、分版、重要度、写稿）；economy = 节省 token，不调用模型，由程序按规则编排。具体用哪个模型在面板里选，没选时用 harness 的默认模型。",
    llmMaxItems: "LLM 模式：每份版面交给模型阅读的新闻条数。",
    llmStories: "LLM 模式：每份版面由模型写稿的报道篇数（头版与各版块），其余用程序拼的稿。",
    llmBudgetMs: "LLM 模式：一份版面的时间预算（毫秒），超出后剩下的步骤用规则结果。",
    modelTimeoutMs: "单次模型调用的超时（毫秒）。",
  },
});

const COLLECT_BYTES = 1048576;
const GRACE_MS = 5000;
const EXCERPT_CHARS = 1400;
const TEST_TIMEOUT_MS = 180000;
/** 定时任务投递给会话的指令：Agent 只调一个工具并原样转述，控制 token。 */
const SCHEDULE_TITLE = "新闻要闻 · dsh-newswire";
const SCHEDULE_CRON = "0 7-21/2 * * *";
const SCHEDULE_TZ = "Asia/Shanghai";
/** 主题包的定时默认值：标题、cron、时区（来自 sources.json 的 packs.<包>.schedule，核心包沿用原标题）。 */
function packSchedule(p, pack) {
  let packs = {};
  try { packs = readJson(p.cfgFile).packs || {}; } catch { packs = {}; }
  const info = packs[pack] || {};
  const sch = info.schedule || {};
  return {
    title: pack === "core" ? SCHEDULE_TITLE : (info.name || pack) + " · dsh-newswire",
    cron: sch.cron || SCHEDULE_CRON,
    tz: sch.time_zone || SCHEDULE_TZ,
    packs,
  };
}

const DAILY_CRON = "30 21 * * *";
function dailyPrompt(pack) {
  return "调用工具 newswire_daily（参数 pack=\"" + pack + "\"），把返回结果里 message 字段的文本原样作为你的回复：不要改写、不要补充、不要调用其他工具。工具报错时只回复一行错误原因。";
}
function schedulePrompt(pack) {
  return "调用工具 newswire_cycle（参数 pack=\"" + pack + "\"），把返回结果里 message 字段的文本原样作为你的回复：不要改写、不要补充、不要调用其他工具。工具报错时只回复一行错误原因。";
}
const CRED_TEXT = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };
const CYCLE_WAIT_MS = 15 * 60000;
const DISCLAIMER = "来源与数据时间已在每条行内标注；标题/摘要来自列表页或 feed，未逐条核原文；热度信号为源头原值；财经内容非投资建议。";

// ------------------------------------------------------------------ 配置
function liveValue(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

function strSetting(raw, key) {
  const v = liveValue(raw[key]);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULTS[key];
}

function numSetting(raw, key, min, max) {
  const v = Number(liveValue(raw[key]));
  if (!Number.isFinite(v)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(v)));
}

function settingsFrom(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  return {
    engineDir: path.resolve(strSetting(raw, "engineDir")),
    dataDir: path.resolve(strSetting(raw, "dataDir").replace(/^~(?=\/)/, os.homedir())),
    nodeBin: strSetting(raw, "nodeBin"),
    browseBin: strSetting(raw, "browseBin"),
    browseSession: strSetting(raw, "browseSession"),
    agentReachBin: strSetting(raw, "agentReachBin"),
    mcporterBin: strSetting(raw, "mcporterBin"),
    windowHours: numSetting(raw, "windowHours", 1, 336),
    timeoutMs: numSetting(raw, "timeoutMs", 30000, 1800000),
    tailChars: numSetting(raw, "tailChars", 200, 6000),
    rawRetentionDays: numSetting(raw, "rawRetentionDays", 1, 3650),
    bodyBudget: numSetting(raw, "bodyBudget", 0, 60),
    modelMode: liveValue(raw.modelMode) === "economy" ? "economy" : "llm",
    llmMaxItems: numSetting(raw, "llmMaxItems", 20, 600),
    llmStories: numSetting(raw, "llmStories", 3, 40),
    llmBudgetMs: numSetting(raw, "llmBudgetMs", 60000, 1500000),
    modelTimeoutMs: numSetting(raw, "modelTimeoutMs", 10000, 600000),
  };
}

function pathsOf(cfg) {
  const engine = path.resolve(cfg.engineDir);
  const data = path.resolve(cfg.dataDir);
  return {
    engine,
    data,
    entry: path.join(engine, "run.mjs"),
    seed: path.join(engine, "config", "sources.json"),
    taxSeed: path.join(engine, "config", "taxonomy.json"),
    taxFile: path.join(data, "taxonomy.json"),
    layoutSeed: path.join(engine, "config", "layout.json"),
    layoutFile: path.join(data, "layout.json"),
    modelPrefs: path.join(data, "model.json"),
    follows: path.join(data, "follows.json"),
    pushPrefs: path.join(data, "push.json"),
    cfgFile: path.join(data, "sources.json"),
    db: path.join(data, "news.sqlite"),
    out: path.join(data, "out"),
    raw: path.join(data, "raw"),
    tmp: path.join(data, "tmp"),
    datasets: path.join(data, "datasets"),
  };
}

/** 建目录；首次复制种子配置；旧版配置自动升级（补新源与新字段，原文件留 .bak）。 */
async function ensureData(p) {
  await mkdir(p.out, { recursive: true });
  await mkdir(p.raw, { recursive: true });
  if (!existsSync(p.cfgFile)) {
    if (existsSync(p.seed)) await copyFile(p.seed, p.cfgFile);
    else throw new Error("缺少数据源配置：" + p.cfgFile + "（也没有种子 " + p.seed + "）");
  } else {
    loadConfig(p.cfgFile, p.seed);
  }
  if (!existsSync(p.taxFile) && existsSync(p.taxSeed)) await copyFile(p.taxSeed, p.taxFile);
  else if (existsSync(p.taxFile)) loadTaxonomyFile(p.taxFile, p.taxSeed);
  if (!existsSync(p.layoutFile) && existsSync(p.layoutSeed)) await copyFile(p.layoutSeed, p.layoutFile);
  return p;
}

async function readConfigSources(p) {
  const text = await readFile(p.cfgFile, "utf8");
  return { text, data: JSON.parse(text) };
}

async function writeFileAtomic(file, text) {
  const tmpFile = file + ".tmp";
  await writeFile(tmpFile, text);
  await rename(tmpFile, file);
}

async function writeConfigSources(p, data) {
  await writeFileAtomic(p.cfgFile, JSON.stringify(data, null, 2) + "\n");
}

function withDb(p, fn) {
  const db = openIfExists(p.db);
  try {
    return fn(db);
  } finally {
    if (db) db.close();
  }
}

// ------------------------------------------------------------------ 汇总快照
async function findDigest(outDir) {
  let names;
  try {
    names = await readdir(outDir);
  } catch {
    return null;
  }
  let best = null;
  for (const n of names.filter((x) => x.startsWith("digest-") && x.endsWith(".md"))) {
    const full = path.join(outDir, n);
    const info = await stat(full).catch(() => null);
    if (info && (!best || info.mtimeMs > best.mtimeMs)) best = { path: full, mtimeMs: info.mtimeMs };
  }
  if (!best) return null;
  best.text = await readFile(best.path, "utf8").catch(() => "");
  return best;
}

async function snapshotOf(cfg, p) {
  const since = sinceIso(cfg.windowHours);
  const digest = await findDigest(p.out);
  return withDb(p, (db) => {
    const run = latestRun(db);
    return {
      data_asof: new Date().toISOString(),
      window_hours: cfg.windowHours,
      latest_run: run ? { run_id: run.run_id, started_at: run.started_at, finished_at: run.finished_at ?? null, sources_ok: run.sources_ok ?? null, sources_failed: run.sources_failed ?? null, items_raw: run.items_raw ?? null, items_new: run.items_new ?? null, items_dup: run.items_dup ?? null, notes: run.notes ?? "" } : null,
      stale: run ? Date.now() - Date.parse((run.finished_at || run.started_at).replace(" ", "T") + "Z") > 26 * 3600 * 1000 : true,
      categories: countsByCategory(db, since),
      keywords: keywords(db, since, 14),
      failed: failureRows(db, run ? run.run_id : null, 12),
      continuity: continuitySummary(db, run ? run.run_id : null),
      top_events: eventRows(db, { since, minImportance: 40, limit: 10 }),
      digest_path: digest ? digest.path : null,
      digest_excerpt: digest ? String(digest.text).slice(0, EXCERPT_CHARS) : "",
      db_path: p.db,
      sources_config: p.cfgFile,
      disclaimer: DISCLAIMER,
    };
  });
}

// ------------------------------------------------------------------ 引擎子进程
function tailOf(parts, maxChars) {
  const text = parts.filter((x) => typeof x === "string" && x !== "").join("\n").replace(/\s+\n/g, (m) => m.trimEnd() + "\n");
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - maxChars);
}

function runIdFrom(text) {
  const m = /(?:run|web|tool)-[0-9]{12,14}-[0-9a-z-]{3,14}/.exec(String(text || ""));
  return m ? m[0] : null;
}

async function runEngine(ctx, cfg, p, flags, timeoutMs) {
  const limit = timeoutMs || cfg.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("超时 " + Math.round(limit / 1000) + "s")), limit);
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv: [cfg.nodeBin, "--disable-warning=ExperimentalWarning", p.entry, ...flags],
      cwd: p.engine,
      stdio: { stdin: "ignore", stdout: { maxBytes: COLLECT_BYTES }, stderr: { maxBytes: COLLECT_BYTES } },
      graceMs: GRACE_MS,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, stage: "spawn", tail: String(error && error.message ? error.message : error), run_id: null, stdout: "" };
  }
  try {
    const outcome = await handle.done;
    const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? "";
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? "";
    return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode ?? null, stage: outcome.exitCode === 0 ? "done" : "engine_exit_" + String(outcome.exitCode), tail: tailOf([stdout, stderr], cfg.tailChars), run_id: runIdFrom(stdout + "\n" + stderr), stdout };
  } catch (error) {
    const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? "";
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? "";
    return { ok: false, stage: controller.signal.aborted ? "timeout" : "spawn_error", tail: tailOf([String(error && error.message ? error.message : error), stdout, stderr], cfg.tailChars), run_id: runIdFrom(stdout + "\n" + stderr), stdout };
  } finally {
    clearTimeout(timer);
    try {
      handle.terminate();
      await handle.waitForExit();
    } catch {
      // 收尾幂等
    }
  }
}

function taxFlags(p) { return existsSync(p.taxFile) ? ["--taxonomy", p.taxFile] : []; }

function roundFlags(cfg) { return ["--body-budget", String(cfg.bodyBudget), "--raw-retention-days", String(cfg.rawRetentionDays)]; }

function binFlags(cfg, session) {
  const out = ["--browse-session", session || cfg.browseSession];
  if (cfg.browseBin) out.push("--browse-bin", cfg.browseBin);
  if (cfg.agentReachBin) out.push("--agent-reach-bin", cfg.agentReachBin);
  if (cfg.mcporterBin) out.push("--mcporter-bin", cfg.mcporterBin);
  return out;
}

function runFlags(p, cfg, args) {
  const out = ["--mode", "fetch", "--config", p.cfgFile, "--db", p.db, "--out", p.out, "--raw", p.raw, "--since-hours", String(args.window_hours ?? cfg.windowHours), ...taxFlags(p), ...roundFlags(cfg), ...binFlags(cfg)];
  if (args.sources) out.push("--sources", String(args.sources));
  if (args.categories) out.push("--categories", String(args.categories));
  if (args.packs) out.push("--packs", String(args.packs));
  if (args.max_items) out.push("--max-items", String(args.max_items));
  if (args.per_source) out.push("--per-source", String(args.per_source));
  if (args.run_id) out.push("--run-id", String(args.run_id));
  const exp = args.export === undefined ? "jsonl,csv" : String(args.export);
  if (exp && exp !== "none") out.push("--export", exp === "both" ? "jsonl,csv" : exp);
  return out;
}

function cycleFlags(p, cfg, args, runId) {
  const out = ["--mode", "cycle", "--config", p.cfgFile, "--db", p.db, "--out", p.out, "--raw", p.raw, "--since-hours", String(cfg.windowHours), "--run-id", runId, ...taxFlags(p), ...roundFlags(cfg), ...binFlags(cfg)];
  if (args.pack) out.push("--packs", String(args.pack));
  if (args.sources) out.push("--sources", String(args.sources));
  if (args.overnight === true) out.push("--overnight");
  if (args.dry_run === true) out.push("--dry-run");
  if (args.defer_push === true) out.push("--defer-push");
  out.push("--lock-wait-ms", String(CYCLE_WAIT_MS));
  if (args.min_corroborated) out.push("--min-corroborated", String(clampNum(args.min_corroborated, 0, 100, 50)));
  if (args.min_single) out.push("--min-single", String(clampNum(args.min_single, 0, 100, 36)));
  if (args.max_push) out.push("--max-push", String(clampNum(args.max_push, 1, 20, 8)));
  return out;
}

function engineJson(stdout) {
  const line = String(stdout || "").split("\n").reverse().find((l) => l.startsWith("NEWSWIRE_JSON "));
  if (!line) return null;
  try { return JSON.parse(line.slice("NEWSWIRE_JSON ".length)); } catch { return null; }
}

function hhmmShanghai() { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()); }

/** 试抓：只抓不入库，用独立 browse 会话，避免和正在跑的一轮抢同一个标签页。 */
async function testSource(ctx, cfg, p, args) {
  await mkdir(p.tmp, { recursive: true });
  const flags = ["--mode", "test-source", "--config", p.cfgFile, "--max-items", String(clampNum(args.max_items, 1, 30, 10)), ...binFlags(cfg, "newswire-test")];
  let tmpFile = null;
  if (args.source && typeof args.source === "object") {
    const problems = validateSources({ sources: [args.source] }, { allowSingle: true });
    if (problems.length) return { ok: false, error: "invalid_source", problems };
    tmpFile = path.join(p.tmp, "test-" + Date.now().toString(36) + ".json");
    await writeFile(tmpFile, JSON.stringify(normalizeSource(args.source)));
    flags.push("--source-file", tmpFile);
  } else if (typeof args.id === "string" && args.id) {
    flags.push("--source", args.id);
  } else {
    return { ok: false, error: "id_or_source_required" };
  }
  try {
    const res = await runEngine(ctx, cfg, p, flags, TEST_TIMEOUT_MS);
    return engineJson(res.stdout) || { ok: false, error: "engine_" + res.stage, tail: res.tail };
  } finally {
    if (tmpFile) await rm(tmpFile, { force: true });
  }
}

// ------------------------------------------------------------------ 数据源校验与写回
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function strOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

const TYPES = ["rss", "html_index", "cls_api", "json_api"];
const TIERS = ["primary", "secondary"];
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

function regexOk(pattern) {
  if (pattern === null || pattern === undefined || pattern === "") return true;
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

function validateOne(s, at, problems) {
  if (s === null || typeof s !== "object" || Array.isArray(s)) { problems.push(at + " 不是对象"); return; }
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) problems.push(at + " id 需为小写字母或数字开头的 2-40 位 [a-z0-9_-]");
  if (typeof s.name !== "string" || s.name.trim() === "" || s.name.length > 80) problems.push(at + " name 需为 1-80 字符");
  if (typeof s.category !== "string" || s.category.trim() === "" || s.category.length > 40) problems.push(at + " category 需为 1-40 字符");
  if (TYPES.indexOf(s.type) < 0) problems.push(at + " type 只能是 " + TYPES.join("/"));
  if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url.trim())) problems.push(at + " url 必须是 http(s) 地址");
  if (s.adapter !== undefined && s.adapter !== null && s.adapter !== "" && adapterIds().indexOf(s.adapter) < 0) problems.push(at + " adapter 只能是 " + adapterIds().join("/") + " 或留空");
  if (s.channels !== undefined && (!Array.isArray(s.channels) || s.channels.some((c) => CHANNELS.indexOf(c) < 0))) problems.push(at + " channels 只能是 " + CHANNELS.join("/") + " 的组合");
  if (s.max_items !== undefined && clampNum(s.max_items, 1, 300, 0) === 0) problems.push(at + " max_items 需为 1-300");
  if (s.timeout_ms !== undefined && clampNum(s.timeout_ms, 5000, 180000, 0) === 0) problems.push(at + " timeout_ms 需为 5000-180000");
  if (s.weight !== undefined && s.weight !== null && !(Number(s.weight) >= 0 && Number(s.weight) <= 1)) problems.push(at + " weight 需为 0-1");
  if (s.tier !== undefined && s.tier !== null && s.tier !== "" && TIERS.indexOf(s.tier) < 0) problems.push(at + " tier 只能是 primary/secondary");
  for (const k of ["group", "pack"]) if (s[k] !== undefined && s[k] !== null && s[k] !== "" && (typeof s[k] !== "string" || !ID_RE.test(s[k]))) problems.push(at + " " + k + " 需为 [a-z0-9_-] 标识");
  if (s.region !== undefined && s.region !== null && (typeof s.region !== "string" || s.region.length > 8)) problems.push(at + " region 需为不超过 8 字符的地区码（如 CN/US/UK/INTL）");
  if (!regexOk(s.url_include) || !regexOk(s.url_exclude)) problems.push(at + " url_include/url_exclude 不是合法正则");
  if (s.continuity !== undefined && s.continuity !== null && s.continuity !== "" && ["stream", "snapshot"].indexOf(s.continuity) < 0) problems.push(at + " continuity 只能是 stream（按时间滚动，判断衔接）或 snapshot（首页推荐，不判断）");
  if (s.paging !== undefined && s.paging !== null) {
    const pg = s.paging;
    if (typeof pg !== "object" || ["param", "cursor", "id_walk", "native"].indexOf(pg.mode) < 0) problems.push(at + " paging.mode 只能是 param/cursor/id_walk/native");
    else if (pg.mode === "id_walk" && (typeof pg.template !== "string" || pg.template.indexOf("{id}") < 0 || !regexOk(pg.id_pattern) || !pg.id_pattern)) problems.push(at + " paging id_walk 需要含 {id} 的 template 与合法的 id_pattern");
  }
  if (s.backfill !== undefined && typeof s.backfill !== "boolean") problems.push(at + " backfill 需为布尔");
  if (s.body !== undefined && s.body !== null && ["fetch", "list", "none"].indexOf(s.body) < 0) problems.push(at + " body 只能是 fetch / list / none");
  if (s.enabled !== undefined && typeof s.enabled !== "boolean") problems.push(at + " enabled 需为布尔");
}

function validateSources(body, opts) {
  const problems = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) return ["body 必须是对象 { sources: [...] }"];
  if (!Array.isArray(body.sources)) return ["sources 必须是数组"];
  if (body.sources.length === 0 && !(opts && opts.allowSingle)) return ["sources 不能为空（全部停用请改用 enabled:false）"];
  if (body.sources.length > 150) return ["sources 最多 150 个"];
  const seen = new Set();
  body.sources.forEach((s, i) => {
    const at = "第 " + (i + 1) + " 项" + (s && typeof s.id === "string" ? "（" + s.id + "）" : "");
    validateOne(s, at, problems);
    if (s && typeof s.id === "string") {
      if (seen.has(s.id)) problems.push(at + " id 重复：" + s.id);
      seen.add(s.id);
    }
  });
  return problems;
}

const STR_FIELDS = ["id", "name", "category", "region", "lang", "type", "adapter", "url", "note", "category_src", "url_include", "url_exclude", "tier", "group", "pack", "removed_at", "wait_for"];

/** 只保留认识的字段并规范化（防止面板把健康度之类的派生字段写回配置）。 */
function normalizeSource(s) {
  const out = {};
  for (const key of STR_FIELDS) {
    if (s[key] !== undefined && s[key] !== null && s[key] !== "") out[key] = typeof s[key] === "string" ? s[key].trim() : s[key];
  }
  if (Array.isArray(s.channels) && s.channels.length) out.channels = s.channels.slice();
  if (s.json !== undefined && s.json !== null && typeof s.json === "object") out.json = s.json;
  if (s.signals !== undefined && s.signals !== null && typeof s.signals === "object") out.signals = s.signals;
  if (s.paging !== undefined && s.paging !== null && typeof s.paging === "object") out.paging = s.paging;
  if (s.continuity === "stream" || s.continuity === "snapshot") out.continuity = s.continuity;
  if (s.backfill === false) out.backfill = false;
  if (s.body === "list" || s.body === "none") out.body = s.body;
  out.enabled = s.enabled !== false;
  if (s.max_items !== undefined) out.max_items = clampNum(s.max_items, 1, 300, 20);
  if (s.timeout_ms !== undefined) out.timeout_ms = clampNum(s.timeout_ms, 5000, 180000, 30000);
  if (s.pages !== undefined) out.pages = clampNum(s.pages, 1, 20, 3);
  if (s.weight !== undefined && s.weight !== null && s.weight !== "") out.weight = Math.round(Math.min(1, Math.max(0, Number(s.weight))) * 100) / 100;
  if (s.paywall === true) out.paywall = true;
  if (s.trial === true) out.trial = true;
  return out;
}

function withSources(doc, sources) {
  const categories = Array.isArray(doc.categories) ? doc.categories.slice() : [];
  for (const s of sources) if (typeof s.category === "string" && categories.indexOf(s.category) < 0) categories.push(s.category);
  return Object.assign({}, doc, { categories, sources });
}

async function sourcesDocOf(p, cfg) {
  const conf = await readConfigSources(p);
  const health = withDb(p, (db) => sourceHealth(db));
  return {
    config_path: p.cfgFile,
    window_hours: cfg.windowHours,
    data_dir: p.data,
    version: conf.data.version ?? 1,
    timezone: conf.data.timezone ?? "Asia/Shanghai",
    defaults: conf.data.defaults ?? {},
    packs: conf.data.packs ?? {},
    categories: conf.data.categories ?? [],
    types: TYPES,
    channel_choices: CHANNELS,
    adapters: adapterIds(),
    sources: (conf.data.sources ?? []).map((s) => Object.assign({}, s, { health: health[s.id] ?? null })),
  };
}

function nowIsoUtc() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

async function upsertSourceInConfig(p, input) {
  const conf = await readConfigSources(p);
  const list = conf.data.sources || [];
  const at = list.findIndex((s) => s.id === input.id);
  const merged = at >= 0 ? Object.assign({}, list[at], input) : input;
  if (merged.removed_at && input.enabled === true) delete merged.removed_at;
  const problems = validateSources({ sources: [merged] }, { allowSingle: true });
  if (problems.length) return { ok: false, problems };
  const clean = normalizeSource(merged);
  const next = list.slice();
  if (at >= 0) next[at] = clean; else next.push(clean);
  await writeConfigSources(p, withSources(conf.data, next));
  return { ok: true, created: at < 0, source: clean };
}

// ------------------------------------------------------------------ 渲染
function signalText(sig) {
  if (!sig) return "";
  const parts = [];
  if (sig.hot && sig.hot.length) parts.push("🔥" + sig.hot.join("/"));
  if (sig.level) parts.push("级别" + sig.level);
  if (sig.views != null) parts.push("阅读" + sig.views);
  if (sig.comments) parts.push("评论" + sig.comments);
  if (sig.likes) parts.push("赞" + sig.likes);
  return parts.length ? "〔" + parts.join(" ") + "〕" : "";
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), { status: status ?? 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function bodyOf(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

const SOURCE_PROPS = {
  id: { type: "string", description: "Unique id: lowercase [a-z0-9_-], 2–40 characters." },
  name: { type: "string", description: "Display name." },
  category: { type: "string", description: "Category, for example 国内财经与公告 / 国际宏观 / 市场与交易 / 科技与AI / 国内时政." },
  type: { type: "string", enum: TYPES, description: "rss | html_index | cls_api | json_api。" },
  adapter: { type: "string", description: "Optional site adapter id: " + adapterIds().join(" / ") + "。" },
  url: { type: "string", description: "List page, feed, or API URL." },
  channels: { type: "array", items: { type: "string", enum: CHANNELS }, description: "Channel chain; default browse → agent_reach → http." },
  region: { type: "string", description: "Region code: CN / US / UK / HK / INTL and so on." },
  lang: { type: "string", description: "zh / en。" },
  weight: { type: "number", description: "Credibility weight 0–1, used by cross-validation." },
  tier: { type: "string", enum: TIERS, description: "primary (first-hand, wire, official) or secondary (reposts, aggregators)." },
  group: { type: "string", description: "Media group; channels of one group share it and count as one outlet in cross-validation." },
  pack: { type: "string", description: "Topic pack; default core." },
  max_items: { type: "number", description: "Items to take on a source's first round (1–300). After that, a source with a continuity cursor fetches everything newer than the last round (up to 300 per round; Cailian pages back until it reaches the last round), so this is not a per-round limit." },
  enabled: { type: "boolean" },
  trial: { type: "boolean", description: "Trial: fetched and used to corroborate, but cannot put a story in the edition or a push on its own." },
  paywall: { type: "boolean", description: "Paywalled source: article bodies stay out of the training set." },
  note: { type: "string" },
  url_include: { type: "string", description: "Keep only links matching this regex." },
  url_exclude: { type: "string", description: "Drop links matching this regex." },
  continuity: { type: "string", enum: ["stream", "snapshot"], description: "stream = a time-ordered feed checked for continuity every run; snapshot = a curated front page, not checked. RSS and APIs default to stream, list pages to snapshot." },
  paging: { type: "object", description: "How to recover a gap: {mode:param,param,start,max_pages} | {mode:cursor,param,next,max_pages} | {mode:id_walk,template,id_pattern,max_steps} | {mode:native}." },
  body: { type: "string", enum: ["fetch", "list", "none"], description: "Article bodies: fetch = fetch the page for top events (default); list = the list text is already the full body (news flashes); none = never fetch." },
  backfill: { type: "boolean", description: "Fall back to an Exa search when a gap remains; default true." },
  wait_for: { type: "string", description: "CSS selector browse waits for before reading the page (slow pages; up to 15 seconds)." },
  json: { type: "object", description: "json_api field mapping: list/title/link/time/summary/signals{views,comments,likes,shares,level,…}." },
};

// ------------------------------------------------------------------ 插件入口
export function apply(ctx, config) {
  const cfg = settingsFrom(config);
  const p = pathsOf(cfg);
  const inflight = { current: null };
  const optional = {};
  // 模型偏好：面板里选的模式与模型存在数据目录的 model.json；没选过时用插件设置的模式和 harness 的默认模型
  let prefsCache = { mtime: -1, value: {} };
  function prefs() {
    try {
      const st = statSync(p.modelPrefs);
      if (st.mtimeMs !== prefsCache.mtime) prefsCache = { mtime: st.mtimeMs, value: JSON.parse(readFileSync(p.modelPrefs, "utf8")) || {} };
    } catch { prefsCache = { mtime: -1, value: {} }; }
    return prefsCache.value;
  }
  /** 改 model.json 里的几个字段（合并写回）。 */
  async function savePrefs(patch) {
    const next = Object.assign({}, prefs(), patch, { updated_at: new Date().toISOString() });
    await mkdir(path.dirname(p.modelPrefs), { recursive: true });
    await writeFileAtomic(p.modelPrefs, JSON.stringify(next, null, 2) + "\n");
  }
  const modeNow = () => (prefs().mode === "llm" || prefs().mode === "economy" ? prefs().mode : cfg.modelMode);
  // 宿主的模型服务与默认模型（可选）：LLM 模式下有它们才调用模型；没有就退回程序编排
  const model = createModel({
    getLlm: () => optional.llm,
    getDefault: () => optional.defaultModel,
    pinned: () => { const x = prefs(); return x.provider && x.model ? { provider: x.provider, model: x.model } : null; },
    timeoutMs: cfg.modelTimeoutMs,
    // 账本与预算
    onCall: (r) => { try { const db = openIfExists(p.db); if (db) { recordCall(db, r); db.close(); } } catch { /* 记账失败不影响调用 */ } },
    gate: makeGate(() => openIfExists(p.db), () => prefs()),
  });
  const llmReady = () => modeNow() === "llm" && model.available();
  const updates = new UpdateChecker({ token: () => githubToken(findBin("gh")) });
  const modelState = { busy: null, last: null };

  // 宿主的定时任务服务（可选）：有它才能用 newswire_schedule_setup
  if (typeof ctx.inject === "function") {
    ctx.inject(["llm"], (scope) => {
      optional.llm = scope.llm;
      scope.effect(() => () => { delete optional.llm; }, "dsh-newswire: llm service");
    });
    ctx.inject(["agentDefaultModel"], (scope) => {
      optional.defaultModel = scope.agentDefaultModel;
      scope.effect(() => () => { delete optional.defaultModel; }, "dsh-newswire: default model");
    });
    ctx.inject(["schedule"], (scope) => {
      optional.schedule = scope.schedule;
      scope.effect(() => () => { delete optional.schedule; }, "dsh-newswire: schedule service");
    });
  }

  /** 本进程或其它进程（命令行直跑）正在抓取时返回持有者描述。 */
  function busyWith() {
    if (inflight.current !== null) return inflight.current;
    const holder = readLock(p.data);
    return holder ? holder.run_id || holder.mode || "另一个进程" : null;
  }

  async function guardedRun(args, runId) {
    const busy = busyWith();
    if (busy) return { ok: false, stage: "run_in_progress", tail: "已有一轮在跑：" + busy, run_id: busy };
    inflight.current = runId;
    try {
      await ensureData(p);
      return await runEngine(ctx, cfg, p, runFlags(p, cfg, Object.assign({}, args, { run_id: runId })));
    } finally {
      inflight.current = null;
    }
  }

  const errText = (err) => String(err && err.message ? err.message : err).slice(0, 200);

  function defaultSelection() {
    try { const d = optional.defaultModel && optional.defaultModel.currentSelection(); return d && d.provider && d.model ? { provider: d.provider, model: d.model } : null; } catch { return null; }
  }

  function modelView() {
    const pr = prefs();
    return {
      mode: modeNow(), mode_from: pr.mode ? "panel" : "settings", service: Boolean(optional.llm), available: model.available(), ready: llmReady(), label: model.label(),
      pinned: pr.provider && pr.model ? { provider: pr.provider, model: pr.model } : null, default: defaultSelection(), busy: modelState.busy, last: modelState.last,
      depth: depthOf(pr), depths: Object.fromEntries(Object.entries(DEPTHS).map(([k, v]) => [k, v])), daily_tokens: Number(pr.daily_tokens) || 0,
      speed: Object.assign({ concurrency: pr.concurrency || null, probe: pr.probe || null }, model.profile()),
    };
  }

  let catalogCache = null;
  /** harness 里可用的模型：按提供方列出（5 分钟缓存）。 */
  async function modelCatalog(force) {
    const llm = optional.llm;
    if (!llm || typeof llm.listProviders !== "function") return [];
    if (!force && catalogCache && Date.now() - catalogCache.at < 300000) return catalogCache.value;
    const out = [];
    for (const pr of (await Promise.resolve(llm.listProviders())) || []) {
      let models = [];
      try { models = typeof llm.listModels === "function" ? (await llm.listModels(pr.id)) || [] : []; } catch { models = []; }
      out.push({ id: pr.id, name: pr.name || pr.id, models: models.map((m) => ({ id: m.id, name: m.name || m.id, description: m.description || "" })) });
    }
    catalogCache = { at: Date.now(), value: out };
    return out;
  }

  function taxonomyLabels() {
    try { return readJson(p.taxFile).labels || []; } catch { return []; }
  }

  /**
   * 编一份版面并存库。wantLlm 且模型可用时由模型编排，否则（或模型编排整体失败时）由程序编排。不抛错。
   * @param o { pack, runId, wantLlm, minHours }
   */
  async function makeEdition(o) {
    const db = openIfExists(p.db);
    if (!db) return null;
    const t0 = Date.now();
    const layout = loadLayout(p.layoutFile, p.layoutSeed);
    const hours = Math.max(layout.window_hours, Number(o.minHours) || 0);
    const pack = o.pack && !String(o.pack).includes(",") ? String(o.pack) : "all";
    const base = { pack, since: sinceIso(hours), hours, layout, names: taxonomyNames(), follows: loadFollows(p.follows) };
    let ed = null;
    let error = null;
    const useLlm = o.wantLlm && llmReady();
    let progressCleanup = () => {};
    try {
      if (useLlm) {
        modelState.busy = "edition:" + pack;
        try {
          // 上一份同包的模型版面：没有新新闻时沿用它的统筹
          const prevRow = latestEdition(db, pack);
          const prev = prevRow && prevRow.pack === pack && prevRow.mode === "llm" ? prevRow.content : null;
          // 冷启动不空板：版面超过 30 分钟没更新（或从未有过）时，先存一份程序编排的预览；预览不登记故事线，归并留给模型
          const stale = !prevRow || Date.now() - Date.parse(String(prevRow.created_at).replace(" ", "T") + "Z") > 30 * 60000;
          if (stale) {
            try {
              const pv = ruleEdition(db, base);
              delete pv._persist;
              pv.stats = Object.assign({}, pv.stats, { preview: true });
              saveEdition(db, pv, { runId: o.runId, error: null, ms: Date.now() - t0 });
            } catch { /* 预览失败不影响模型编排 */ }
          }
          // 外文标题译成中文；有新译的就按译名重新聚类近 24 小时（外文报道归入中文报道的同一件事）
          let tr = null;
          try {
            tr = await translateTitles(db, model, { since: base.since, max: depthParams(prefs()).translate, timeoutMs: cfg.modelTimeoutMs, deadline: Date.now() + 240000 });
            if (tr.ok) { const rr = await runEngine(ctx, cfg, p, ["--mode", "reprocess", "--config", p.cfgFile, "--db", p.db, ...taxFlags(p), "--stage", "events", "--hours", "24"], 300000); tr.reclustered = Boolean(rr && rr.ok); }
          } catch (err) { tr = { error: errText(err) }; }
          // 模型读合集：规则拆不开的（按小标题分段的要闻汇总）交给模型拆成单条
          let split = null;
          try { split = await modelSplitDigests(db, model, { since: base.since, timeoutMs: cfg.modelTimeoutMs }); } catch (err) { split = { error: errText(err) }; }
          // 边写边出：归并统筹完先出一版，之后每写完一批更新同一行；正式版存好后删掉这行
          let progressId = null;
          const onProgress = (snap) => {
            try {
              snap.tickers = tickerBoard(db, { since: base.since, pack });
              if (progressId == null) progressId = saveEdition(db, snap, { runId: o.runId, error: null, ms: Date.now() - t0 }).id;
              else updateEditionContent(db, progressId, snap);
            } catch { /* 进度版失败不影响正式版 */ }
          };
          progressCleanup = () => { if (progressId != null) try { db.prepare("DELETE FROM editions WHERE id = ?").run(progressId); } catch { /* 留着也是一份完整版面 */ } };
          ed = await llmEdition(db, model, Object.assign({}, base, { onProgress, taxonomy: taxonomyLabels(), maxItems: depthParams(prefs()).maxItems, maxStories: depthParams(prefs()).maxStories, budgetMs: cfg.llmBudgetMs, callTimeoutMs: cfg.modelTimeoutMs, prev, deepRead: makeDeepRead(db, { runId: o.runId || null }),
            // 并发由实测决定：还没测过就让第一次有两批稿时并行试一次，结果记进 model.json
            concurrency: Number(prefs().concurrency) || 1, probe: !prefs().concurrency, onProbe: (r) => { void savePrefs({ concurrency: r.concurrency, probe: Object.assign({ at: new Date().toISOString() }, r) }); } }));
          if (ed && ed.fallback) { error = ed.fallback; ed = null; }
          if (ed && split) ed.stats = Object.assign({}, ed.stats, { split });
          if (ed && tr) ed.stats = Object.assign({}, ed.stats, { translate: tr });
        } catch (err) { error = errText(err); ed = null; }
      }
      if (!ed) ed = ruleEdition(db, base);
      try { ed.tickers = tickerBoard(db, { since: base.since, pack }); } catch { ed.tickers = []; }
      const saved = saveEdition(db, ed, { runId: o.runId, error, ms: Date.now() - t0 });
      progressCleanup();
      autoAnalyze(ed);
      if (ed.mode === "llm") notesFromEdition(db, ed);
      const st = ed.stats || {};
      if (useLlm) modelState.last = { at: new Date().toISOString(), run_id: o.runId || null, pack, mode: ed.mode, model: model.label(), items_read: ed.items_read, fresh_items: st.fresh_items ?? null, reused: st.reused || 0, calls: st.calls || 0, failed: st.failed || 0, written: st.written || 0, retried: (st.errors || []).length, error: error || ((st.fallbacks || []).length ? "fallback " + st.fallbacks.join(", ") + ((st.errors || []).length ? "：" + st.errors[0] : "") : null), ms: Date.now() - t0 };
      const out = Object.assign({ id: saved.id, created_at: saved.created_at, error }, ed);
      delete out._items;
      return out;
    } catch (err) {
      if (useLlm) modelState.last = { at: new Date().toISOString(), run_id: o.runId || null, pack, error: errText(err), ms: Date.now() - t0 };
      return null;
    } finally {
      db.close();
      if (useLlm) modelState.busy = null;
    }
  }

  async function saveFollows(f) {
    await mkdir(path.dirname(p.follows), { recursive: true });
    await writeFileAtomic(p.follows, JSON.stringify(f, null, 2) + "\n");
    reflowEdition(f);
  }

  /** 改了关注或屏蔽：按最新一份版面立即重新组版（不调用模型），存成新的一份。 */
  /** 配置改了状态后同步到库里的 sources 表（版面按它判断试用源），不必等下一轮抓取。 */
  function syncSourceState(src) {
    try { withDb(p, (db) => { if (db) db.prepare("UPDATE sources SET enabled = ?, trial = ?, removed_at = ? WHERE id = ?").run(src.enabled === false ? 0 : 1, src.trial ? 1 : 0, src.removed_at || null, src.id); }); } catch { /* 下一轮抓取会同步 */ }
  }

  function reflowEdition(f) {
    try {
      withDb(p, (db) => {
        if (!db) return;
        const latest = latestEdition(db, "all");
        if (!latest || !latest.content) return;
        const content = reassemble(latest.content, { follows: f, layout: loadLayout(p.layoutFile, p.layoutSeed), names: taxonomyNames() });
        saveEdition(db, content, { runId: null });
      });
    } catch { /* 组版失败就等下一份版面 */ }
  }

  /** 编一份日报并存档。LLM 模式且模型可用时由模型写，否则程序写。 */
  async function makeDaily(o) {
    const db = openIfExists(p.db);
    if (!db) return null;
    const useLlm = modeNow() === "llm" && model.available();
    if (useLlm) modelState.busy = "daily";
    try {
      const d = await buildDaily(db, { pack: o.pack || "all", date: o.date || todayBj(), names: taxonomyNames(), follows: loadFollows(p.follows), model: useLlm ? model : null, timeoutMs: cfg.modelTimeoutMs * 2 });
      return saveDaily(db, d);
    } finally {
      db.close();
      if (useLlm) modelState.busy = null;
    }
  }

  /** 读者报错后：在最新一份版面上撤下错句，立即存成新的一份（不调用模型）。 */
  function reflowWithFeedback(storyId, errs) {
    try {
      withDb(p, (db) => {
        if (!db) return;
        const latest = latestEdition(db, "all");
        if (!latest || !latest.content || !latest.content.stories || !latest.content.stories[storyId]) return;
        const content = JSON.parse(JSON.stringify(latest.content));
        scrubStory(content.stories[storyId], errs);
        saveEdition(db, reassemble(content, { follows: loadFollows(p.follows), layout: loadLayout(p.layoutFile, p.layoutSeed), names: taxonomyNames() }), { runId: null });
      });
    } catch { /* 等下一份版面 */ }
  }

  /** 手动抓取后在后台编版面（不让面板干等）。 */
  /** 分析一条故事线的影响与走势（模型），存档并返回。 */
  async function runAnalysis(storyId, auto) {
    const db = openIfExists(p.db);
    if (!db) throw new Error("no_db");
    try {
      const row = db.prepare("SELECT story_id, title, copy FROM stories WHERE story_id = ?").get(storyId);
      if (!row) throw new Error("not_found");
      let copy = null; try { copy = JSON.parse(row.copy || "null"); } catch { copy = null; }
      const mats = analysisMaterials(db, storyId, bodiesFor);
      const a = await analyzeStory(model, { title: row.title, lead: copy && copy.lead }, mats, { timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) });
      return saveAnalysis(db, storyId, a, { model: model.label(), auto });
    } finally { db.close(); }
  }
  /** 追踪对象的关注项：公司 / 技术 / 人物按别名关注（报道进「我的关注」、推送门槛更低），主线按挂上的故事线关注。 */
  async function syncTrackerFollows(db, trackerId, storyIds) {
    const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(trackerId);
    if (!t) return;
    let f = loadFollows(p.follows);
    if (t.kind === "theme") for (const sid of storyIds || []) f = updateFollows(f, "follow", "story", sid, t.name);
    else f = updateFollows(f, "follow", "keyword", JSON.parse(t.aliases || "[]").join("|") || t.name, t.name);
    await saveFollows(f);
  }

  /** 删掉追踪对象时撤掉它加的关注（别名关键词 / 主线的故事线）。 */
  async function dropTrackerFollows(t) {
    if (!t) return;
    let f = loadFollows(p.follows);
    if (t.kind === "theme") for (const sid of t.stories || []) f = updateFollows(f, "unfollow", "story", sid);
    else f = updateFollows(f, "unfollow", "keyword", (t.aliases || []).join("|") || t.name);
    await saveFollows(f);
  }

  /** 版面出来后的后台工作（不挡推送）：头版里重要的报道分析影响；追踪对象挂上新的故事线，新动态够多的重写综述。 */
  function autoAnalyze(ed) {
    // 挂故事线不调用模型，两种模式都做
    let linked = {};
    try { linked = withDb(p, (db) => (db ? linkAll(db, ed.themes || []) : {})) || {}; } catch { linked = {}; }
    for (const [tid, sids] of Object.entries(linked)) withDb(p, (db) => { if (db) { const t = db.prepare("SELECT kind FROM trackers WHERE id = ?").get(tid); if (t && t.kind === "theme") void syncTrackerFollows(db, tid, sids); } });
    if (!(modeNow() === "llm" && llmReady())) return;
    const dp = depthParams(prefs());
    setTimeout(async () => {
      let ids = [];
      try { ids = dp.autoAnalyze ? withDb(p, (db) => (db ? autoAnalyzeTargets(db, ed, { max: dp.autoAnalyze }) : [])) : []; } catch { ids = []; }
      for (const id of ids) {
        if (modelState.busy) break;
        modelState.busy = "analyze:" + id;
        try { await runAnalysis(id, true); } catch { /* 下一份版面再试 */ } finally { modelState.busy = null; }
      }
      let ts = [];
      try { ts = withDb(p, (db) => (db ? synthTargets(db, dp.track || 0) : [])); } catch { ts = []; }
      for (const id of ts) {
        if (modelState.busy) break;
        modelState.busy = "track:" + id;
        try { await runSynthesis(id); } catch { /* 下一份版面再试 */ } finally { modelState.busy = null; }
      }
    }, 0);
  }

  async function runSynthesis(id) {
    const db = openIfExists(p.db);
    if (!db) throw new Error("no_db");
    try { return await synthesize(db, model, id, { model: model.label(), timeoutMs: Math.max(cfg.modelTimeoutMs, 300000) }); } finally { db.close(); }
  }

  function backgroundEdition(runId, pack) {
    if (modelState.busy) return;
    void makeEdition({ pack, runId, wantLlm: modeNow() === "llm" });
  }

  function taxonomyNames() {
    const names = {};
    try {
      for (const t of readJson(p.taxFile).labels || []) { names[t.id] = t.name; for (const c of t.children || []) names[c.id] = c.name; }
    } catch { /* 没有分类文件时用标签 id */ }
    return names;
  }

  async function runCycle(args) {
    // 两个主题包的定时任务可能撞上：等前一轮结束（最多 15 分钟）再跑，而不是跳过这一轮
    const deadline = Date.now() + CYCLE_WAIT_MS;
    while (inflight.current !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5000));
    const busy = inflight.current;
    if (busy) return { ok: false, error: "run_in_progress", message: hhmmShanghai() + " 本轮跳过：上一轮（" + busy + "）超过 15 分钟仍未结束" };
    const runId = newRunId("cycle");
    inflight.current = runId;
    try {
      await ensureData(p);
      // 两种模式都按版面推送（版面认得关注与屏蔽）：引擎只算规则候选、不记推送；版面编不出来时退回规则候选
      const wantLlm = modeNow() === "llm" && model.available();
      const res = await runEngine(ctx, cfg, p, cycleFlags(p, cfg, Object.assign({}, args, { defer_push: !(args && args.dry_run === true) }), runId), cfg.timeoutMs + CYCLE_WAIT_MS);
      const out = engineJson(res.stdout);
      if (out && out.run_id) {
        // 手动抓取后的后台编排可能还在跑：最多等 5 分钟
        const until = Date.now() + 300000;
        while (modelState.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
        const ed = await makeEdition({ pack: out.pack || (args && args.pack) || "all", runId: out.run_id, wantLlm, minHours: out.lookback_hours });
        out.edition = ed ? { id: ed.id, mode: ed.mode, model: ed.model, headline: ed.headline, stories: Object.keys(ed.stories || {}).length, items_read: ed.items_read, error: ed.error } : null;
        {
          const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
          const db = openIfExists(p.db);
          try {
            if (ed && out.parts) {
              // 推送偏好：门槛档位、每轮上限、按读者反馈调各版块门槛、每天上限
              const pp = loadPush(p.pushPrefs);
              const all = editionPicks(db, ed, rulesFor(Object.assign({}, DEFAULT_RULES, out.rules || {}), pp), { nowIso, lookbackHours: out.lookback_hours || 6, penalties: sectionPenalties(db) });
              const cap = applyDailyCap(db, all, pp);
              const picks = cap.send;
              if (out.defer_push) recordEditionPushes(db, picks, out.run_id, nowIso, out.pack);
              out.message = composeEditionMessage(out.parts, picks, ed, taxonomyNames()) + (cap.held ? "\n（今天已推 " + (cap.today + picks.length) + " 条，到了每天上限；另有 " + cap.held + " 条留在面板里）" : "");
              out.held = cap.held;
              out.picks = picks.map((x) => ({ story: x.id, event_id: x.lead_event_id, title: x.title, url: x.url, importance: x.importance, credibility: x.credibility, reason: x.reason, source_count: x.source_count, section: x.section, followed: x.followed || null }));
            } else if (out.defer_push) {
              // 版面编不出来：按规则候选推送
              recordPushes(db, out.picks || [], out.run_id, nowIso);
              if ((out.picks || []).length && wantLlm) out.message += "\n（版面编排失败，本轮按规则推送）";
            }
          } finally {
            if (db) db.close();
          }
        }
        out.model = modelState.last;
        delete out.parts;
      }
      if (out) return out;
      return { ok: false, run_id: runId, error: res.stage, message: hhmmShanghai() + " 本轮失败（" + res.stage + "），详情见面板「抓取日志」", tail: res.tail };
    } finally {
      inflight.current = null;
    }
  }

  function newRunId(prefix) { return prefix + "-" + new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6); }

  ctx.effect(() => {
    const disposers = [];
    const routePaths = new Set();
    // DSH 的 exact Fetch route 以 path 为唯一键；撞 path 会在插件 start 里抛，这里先抛并点名插件自己。
    const route = (def) => {
      if (routePaths.has(def.path)) throw new Error("dsh-newswire: Fetch route " + def.path + " registered twice; declare all methods in one route");
      routePaths.add(def.path);
      disposers.push(ctx.connection.fetch.register(Object.assign({ requestBody: "buffered" }, def)));
    };
    const tool = (def) => disposers.push(ctx.tools.register(def));

    // ---------------------------------------------------------------- 路由
    route({
      path: "/api/newswire/health",
      methods: ["GET", "HEAD"],
      fetch: async () => {
        try {
          await ensureData(p);
          return jsonResponse(await snapshotOf(cfg, p), 200);
        } catch (error) {
          return jsonResponse({ error: "newswire_health_missing", detail: String(error && error.message ? error.message : error) }, 503);
        }
      },
    });

    route({
      path: "/api/newswire/summary",
      methods: ["GET", "HEAD"],
      fetch: async () => {
        try {
          await ensureData(p);
          const snap = await snapshotOf(cfg, p);
          snap.model = modelView();
          const ed = withDb(p, (db) => latestEdition(db, "all"));
          snap.edition = ed ? { id: ed.id, pack: ed.pack, mode: ed.mode, model: ed.model, created_at: ed.created_at, headline: ed.headline } : null;
          try { snap.content_degraded = withDb(p, (db) => (db ? contentHealth(db).degraded : [])); } catch { snap.content_degraded = []; }
          return jsonResponse(snap, 200);
        } catch (error) {
          return jsonResponse({ error: "summary_missing", detail: String(error && error.message ? error.message : error) }, 503);
        }
      },
    });

    route({
      path: "/api/newswire/digest",
      methods: ["GET", "HEAD"],
      fetch: async () => {
        const digest = await findDigest(p.out);
        if (!digest) return jsonResponse({ error: "digest_missing" }, 503);
        return new Response(digest.text, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
      },
    });

    // 同一个 path 的多个 method 必须写在同一条注册里：DSH 的 exact Fetch route 以 path 为唯一键。
    route({
      path: "/api/newswire/sources",
      methods: ["GET", "HEAD", "POST"],
      fetch: async (request) => {
        if (request.method === "POST") {
          let body;
          try {
            body = await request.json();
          } catch {
            return jsonResponse({ error: "bad_json" }, 400);
          }
          const problems = validateSources(body);
          if (problems.length) return jsonResponse({ error: "invalid_sources", problems }, 400);
          await ensureData(p);
          const conf = await readConfigSources(p);
          const merged = withSources(conf.data, body.sources.map(normalizeSource));
          await writeConfigSources(p, merged);
          return jsonResponse({ ok: true, count: merged.sources.length, config_path: p.cfgFile, categories: merged.categories }, 200);
        }
        try {
          await ensureData(p);
          return jsonResponse(await sourcesDocOf(p, cfg), 200);
        } catch (error) {
          return jsonResponse({ error: "sources_missing", detail: String(error && error.message ? error.message : error) }, 503);
        }
      },
    });

    route({
      path: "/api/newswire/sources/test",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const res = await testSource(ctx, cfg, p, body);
        return jsonResponse(res, res.problems ? 400 : 200);
      },
    });

    route({
      path: "/api/newswire/items",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const hours = clampNum(body.hours, 1, 24 * 90, cfg.windowHours);
        const since = sinceIso(hours);
        const items = withDb(p, (db) => itemRows(db, { since, category: strOrNull(body.category), source: strOrNull(body.source), pack: strOrNull(body.pack), label: strOrNull(body.label), query: strOrNull(body.query), hotOnly: body.hot_only === true, allKinds: body.all_kinds === true, before: strOrNull(body.before), limit: Math.min(Number(body.limit) || 60, 400) }));
        return jsonResponse({ count: items.length, since_iso: since, items, next_before: items.length ? items[items.length - 1].time : null }, 200);
      },
    });

    route({
      path: "/api/newswire/events",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const hours = clampNum(body.hours, 1, 24 * 90, 24);
        const since = sinceIso(hours);
        const events = withDb(p, (db) => eventRows(db, { since, pack: strOrNull(body.pack), minImportance: body.min_importance, credibility: strOrNull(body.credibility), label: strOrNull(body.label), region: strOrNull(body.region), query: strOrNull(body.query), multiOnly: body.multi_only === true, order: strOrNull(body.order), before: strOrNull(body.before), limit: Math.min(Number(body.limit) || 40, 300) }));
        return jsonResponse({ count: events.length, since_iso: since, events, next_before: events.length ? events[events.length - 1].last_seen_at : null }, 200);
      },
    });

    route({
      path: "/api/newswire/event",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const id = strOrNull(body.id);
        if (!id) return jsonResponse({ error: "id_required" }, 400);
        const ev = withDb(p, (db) => eventDetail(db, id));
        return ev ? jsonResponse(ev, 200) : jsonResponse({ error: "not_found" }, 404);
      },
    });

    route({
      path: "/api/newswire/taxonomy",
      methods: ["GET", "HEAD"],
      fetch: async () => {
        await ensureData(p);
        const doc = JSON.parse(await readFile(p.taxFile, "utf8"));
        const counts = withDb(p, (db) => labelCounts(db, sinceIso(24 * 7)));
        return jsonResponse({ path: p.taxFile, rules_version: doc.rules_version, labels: doc.labels.map((t) => ({ id: t.id, name: t.name, children: (t.children || []).map((c) => ({ id: c.id, name: c.name })) })), regions: Object.keys(doc.regions || {}), counts_7d: counts }, 200);
      },
    });

    route({
      path: "/api/newswire/timeline",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const date = strOrNull(body.date) || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
        const range = dayRange(date, 8);
        if (!range) return jsonResponse({ error: "bad_date", hint: "date 形如 2026-11-08" }, 400);
        const t0 = Date.now();
        const out = withDb(p, (db) => {
          const runs = timelineDay(db, range);
          // 默认打开当天最近一轮「有新内容」的（只是重复看到旧闻的轮次没有新事件，首屏会是空的）
          const kind = body.kind === "items" ? "items" : "events";
          const withNew = runs.filter((r) => (kind === "items" ? r.items_new : r.events_new) > 0);
          const pick = strOrNull(body.run_id) || (withNew.length ? withNew[withNew.length - 1].run_id : runs.length ? runs[runs.length - 1].run_id : null);
          return { date, range, runs, run_id: pick, entries: pick ? timelineRun(db, pick, kind, body.limit, body.offset) : [] };
        });
        out.ms = Date.now() - t0;
        return jsonResponse(out, 200);
      },
    });

    route({
      path: "/api/newswire/timeline/run",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const runId = strOrNull(body.run_id);
        if (!runId) return jsonResponse({ error: "run_id_required" }, 400);
        const kind = body.kind === "items" ? "items" : "events";
        return jsonResponse({ run_id: runId, kind, entries: withDb(p, (db) => timelineRun(db, runId, kind, body.limit, body.offset)) }, 200);
      },
    });

    route({
      path: "/api/newswire/schedule",
      methods: ["GET", "HEAD"],
      fetch: async () => {
        const svc = optional.schedule;
        if (!svc) return jsonResponse({ available: false, task: null }, 200);
        try {
          const all = (await svc.list({ limit: 500 })).items || [];
          const view = (t) => (t ? { id: t.id, title: t.title, status: t.status, scheduledAt: t.scheduledAt ?? null } : null);
          const packs = Object.keys(packSchedule(p, "core").packs);
          const tasks = (packs.length ? packs : ["core"]).map((k) => ({ pack: k, task: view(all.find((x) => x.title === packSchedule(p, k).title) || null) }));
          return jsonResponse({ available: true, task: (tasks.find((x) => x.pack === "core") || {}).task || null, tasks, running: busyWith() }, 200);
        } catch (error) {
          return jsonResponse({ available: true, task: null, error: String(error && error.message ? error.message : error) }, 200);
        }
      },
    });

    route({
      path: "/api/newswire/trail",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const id = strOrNull(body.id);
        if (!id) return jsonResponse({ error: "id_required" }, 400);
        return jsonResponse({ id, trail: withDb(p, (db) => signalTrail(db, id, 200)) }, 200);
      },
    });

    route({
      path: "/api/newswire/attempts",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const out = withDb(p, (db) => {
          const runs = recentRuns(db, Math.min(Number(body.runs) || 5, 30));
          const runId = strOrNull(body.run_id) ?? (runs[0] ? runs[0].run_id : null);
          return { run_id: runId, runs, attempts: attemptRows(db, runId, Math.min(Number(body.limit) || 120, 500)), continuity: continuityRows(db, runId), gaps: recentGaps(db, 20), pushes: recentPushes(db, 20) };
        });
        return jsonResponse(out, 200);
      },
    });

    route({
      path: "/api/newswire/run",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        if (busyWith()) return jsonResponse({ ok: false, error: "run_in_progress", run_id: busyWith() }, 409);
        const res = await guardedRun(body, newRunId("web"));
        if (res.ok && res.run_id) backgroundEdition(res.run_id, body.packs || "all");
        const snap = await snapshotOf(cfg, p);
        return jsonResponse({ ok: res.ok, stage: res.stage, run_id: res.run_id, tail: res.tail, snapshot: { window_hours: snap.window_hours, latest_run: snap.latest_run, categories: snap.categories, failed: snap.failed, digest_path: snap.digest_path } }, res.ok === true ? 200 : 502);
      },
    });

    // 版面：GET/POST 取最新一份；POST {refresh:true} 在后台重新编排（按当前模式），返回 202，面板轮询 model.busy
    route({
      path: "/api/newswire/edition",
      methods: ["GET", "POST"],
      fetch: async (request) => {
        const body = request.method === "POST" ? await bodyOf(request) : {};
        const pack = strOrNull(body.pack) || "all";
        if (body.refresh === true) {
          if (modelState.busy) return jsonResponse({ ok: false, error: "model_busy", model: modelView() }, 409);
          await ensureData(p);
          if (modeNow() === "llm" && model.available()) {
            void makeEdition({ pack, wantLlm: true });
            return jsonResponse({ ok: true, started: true, model: modelView() }, 202);
          }
          await makeEdition({ pack, wantLlm: false });
        }
        // 自上次查看以来：mark_seen 时返回上次查看时间与各故事线的变化，并把查看时间记为现在
        const out = withDb(p, (db) => {
          const edition = body.id ? (db ? editionById(db, Number(body.id)) : null) : latestEdition(db, pack);
          let since = null;
          if (db && body.mark_seen === true && !body.id) {
            const key = "seen:" + pack;
            const prev = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
            const prevAt = prev ? prev.value : null;
            since = { at: prevAt, stories: edition && edition.content ? sinceSeen(db, Object.keys(edition.content.stories || {}), prevAt) : {} };
            const now = new Date().toISOString().replace("T", " ").slice(0, 19);
            db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, now, now);
          }
          // 影响与走势：各故事线最新一次分析的摘要
          const analyses = db && edition && edition.content ? analysisBrief(db, Object.keys(edition.content.stories || {})) : {};
          return { edition, since, analyses };
        });
        return jsonResponse(Object.assign({ ok: true, model: modelView(), can_analyze: modeNow() === "llm" && llmReady() }, out), 200);
      },
    });

    // 历史版面列表
    route({
      path: "/api/newswire/editions",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        return jsonResponse({ editions: withDb(p, (db) => (db ? editionList(db, strOrNull(body.pack) || "all", clampNum(body.limit, 1, 200, 40)) : [])) }, 200);
      },
    });

    // 日报：{pack, date, refresh}；LLM 模式下重写在后台进行（202）
    route({
      path: "/api/newswire/daily",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const pack = strOrNull(body.pack) || "all";
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : todayBj();
        if (body.refresh === true) {
          if (modelState.busy) return jsonResponse({ ok: false, error: "model_busy", model: modelView() }, 409);
          await ensureData(p);
          if (modeNow() === "llm" && model.available()) { void makeDaily({ pack, date }); return jsonResponse({ ok: true, started: true, model: modelView() }, 202); }
          await makeDaily({ pack, date });
        }
        return jsonResponse(withDb(p, (db) => ({ ok: true, model: modelView(), date, daily: db ? latestDaily(db, pack, date) : null, dates: db ? dailyDates(db, pack, 60) : [] })), 200);
      },
    });

    // 读者报错：{kind: error（错句）| misplaced（这篇不属于这条故事线）, story_id, edition_id?, text?, note?, article_id?}
    route({
      path: "/api/newswire/feedback",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const sid = strOrNull(body.story_id);
        // 推送有用 / 没用：记到版块上，同一版块「没用」多了就提高它的推送门槛
        if (body.kind === "push_up" || body.kind === "push_down") {
          if (!sid) return jsonResponse({ error: "story_required" }, 400);
          withDb(p, (db) => {
            const st = db.prepare("SELECT section FROM stories WHERE story_id = ?").get(sid);
            db.prepare("DELETE FROM feedback WHERE story_id = ? AND kind IN ('push_up', 'push_down')").run(sid);
            db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (?,?,?,?)").run(new Date().toISOString().replace("T", " ").slice(0, 19), body.kind, sid, st ? st.section : null);
          });
          return jsonResponse({ ok: true }, 200);
        }
        // 读者判定「这不是新闻」（广告、引流）或「这是新闻」（被误过滤）：立即生效，读者的判断不被规则与模型覆盖
        if (body.kind === "promo" || body.kind === "not_promo") {
          const aid = strOrNull(body.article_id);
          if (!sid && !aid) return jsonResponse({ error: "feedback_invalid" }, 400);
          const n = withDb(p, (db) => {
            const ids = aid ? [aid] : db.prepare("SELECT article_id FROM story_items WHERE story_id = ?").all(sid).map((r) => r.article_id);
            const now = new Date().toISOString().replace("T", " ").slice(0, 19);
            db.prepare("INSERT INTO feedback (at, kind, story_id, article_id, note) VALUES (?,?,?,?,?)").run(now, body.kind, sid, aid, strOrNull(body.note));
            const changed = markKind(db, ids, body.kind === "promo" ? "promo" : "news", "reader", body.kind === "promo" ? "读者标记" : "读者恢复");
            if (body.kind === "promo" && sid) {
              const latest = latestEdition(db, "all");
              if (latest && latest.content && latest.content.stories && latest.content.stories[sid]) {
                const c = Object.assign({}, latest.content, { stories: Object.assign({}, latest.content.stories) });
                delete c.stories[sid];
                saveEdition(db, reassemble(c, { follows: loadFollows(p.follows), layout: loadLayout(p.layoutFile, p.layoutSeed), names: taxonomyNames() }), { runId: null });
              }
            }
            return changed;
          });
          return jsonResponse({ ok: true, changed: n }, 200);
        }
        if (!sid || (body.kind !== "error" && body.kind !== "misplaced")) return jsonResponse({ error: "feedback_invalid" }, 400);
        if (body.kind === "error" && !strOrNull(body.text)) return jsonResponse({ error: "text_required" }, 400);
        if (body.kind === "misplaced" && !strOrNull(body.article_id)) return jsonResponse({ error: "article_required" }, 400);
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        const errs = withDb(p, (db) => {
          db.prepare("INSERT INTO feedback (at, kind, story_id, edition_id, target, text, note, article_id) VALUES (?,?,?,?,?,?,?,?)").run(now, body.kind, sid, Number(body.edition_id) || null, strOrNull(body.target), strOrNull(body.text), strOrNull(body.note), strOrNull(body.article_id));
          // 放错故事线的报道退回去，下次重新归并（且不再归回这条）；这条故事线的稿件下次重写
          if (body.kind === "misplaced") { db.prepare("DELETE FROM story_items WHERE article_id = ? AND story_id = ?").run(String(body.article_id), sid); db.prepare("UPDATE stories SET copy = NULL WHERE story_id = ?").run(sid); }
          return db.prepare("SELECT text, note FROM feedback WHERE story_id = ? AND kind = 'error' AND resolved_at IS NULL").all(sid);
        });
        if (body.kind === "error") reflowWithFeedback(sid, errs);
        return jsonResponse({ ok: true }, 200);
      },
    });

    // 源的取舍：每个源的贡献与建议；三态开关（开 / 试用 / 关）
    route({
      path: "/api/newswire/sources/scores",
      methods: ["GET", "HEAD"],
      fetch: async (request) => {
        const days = Number(new URL(request.url, "http://x").searchParams.get("days")) || 7;
        return jsonResponse({ sources: withDb(p, (db) => (db ? sourceScores(db, { days }) : [])) }, 200);
      },
    });
    route({
      path: "/api/newswire/sources/state",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const conf = await readConfigSources(p);
        const hit = setSourceState(conf.data, strOrNull(body.id), String(body.state || ""));
        if (!hit) return jsonResponse({ error: "source_or_state_invalid", states: ["on", "trial", "off"] }, 400);
        await writeConfigSources(p, conf.data);
        syncSourceState(hit);
        return jsonResponse({ ok: true, id: hit.id, enabled: hit.enabled !== false, trial: Boolean(hit.trial) }, 200);
      },
    });

    // 推送设置：节奏（改定时任务的时间）、门槛档位、每轮与每天上限；推送记录与「有用 / 没用」
    async function pushView() {
      const prefs = loadPush(p.pushPrefs);
      let task = null;
      try { const r = await scheduleSetup({ action: "status" }); task = r && r.task; } catch { /* 没有定时服务 */ }
      return { prefs, cadences: Object.fromEntries(Object.entries(CADENCES).map(([k, v]) => [k, v.label])), levels: Object.keys(LEVELS), task, schedule_available: Boolean(optional.schedule),
        penalties: withDb(p, (db) => (db ? sectionPenalties(db) : {})), pushes: withDb(p, (db) => (db ? pushHistory(db, 40) : [])) };
    }
    async function applyPush(next) {
      await ensureData(p);
      const prev = loadPush(p.pushPrefs);
      const prefs = savePush(p.pushPrefs, Object.assign({}, prev, next));
      let schedule = null;
      // 节奏改了、且已经安排过定时推送：同步改定时任务（只看日报 = 暂停每轮要闻、确保有日报）
      if (prefs.cadence !== prev.cadence && optional.schedule) {
        const st = await scheduleSetup({ action: "status" });
        if (st && st.task) {
          if (prefs.cadence === "daily_only") { schedule = await scheduleSetup({ action: "pause" }); await scheduleSetup({ action: "create", kind: "daily" }); }
          else schedule = await scheduleSetup({ action: "create", cron: CADENCES[prefs.cadence].cron });
        }
      }
      return { prefs, schedule };
    }
    route({
      path: "/api/newswire/push",
      methods: ["GET", "HEAD", "POST"],
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = await bodyOf(request);
          const r = await applyPush(body.prefs || body);
          return jsonResponse(Object.assign(await pushView(), { saved: true, schedule_note: r.schedule ? r.schedule.note : null }), 200);
        }
        return jsonResponse(await pushView(), 200);
      },
    });

    // 问新闻：搜索本地库；answer=true 且模型可用时据检索结果作答（每句核对）
    function taxRegions() { try { return JSON.parse(readFileSync(existsSync(p.taxFile) ? p.taxFile : p.taxSeed, "utf8")).regions || {}; } catch { return {}; } }
    function taxEntities() { try { return JSON.parse(readFileSync(existsSync(p.taxFile) ? p.taxFile : p.taxSeed, "utf8")).entities || {}; } catch { return {}; } }
    route({
      path: "/api/newswire/ask",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const q = String(body.q || "").trim().slice(0, 200);
        if (!q) return jsonResponse({ error: "q_required" }, 400);
        const hours = clampNum(body.hours, 6, 24 * 30, 72);
        const since = new Date(Date.now() - hours * 3600000).toISOString().replace("T", " ").slice(0, 19);
        const hits = withDb(p, (db) => (db ? searchNews(db, { q, since, entities: taxEntities() }) : { terms: [], stories: [], items: [] }));
        if (!body.answer) return jsonResponse(Object.assign({ q, hours, can_answer: modeNow() === "llm" && llmReady() }, hits), 200);
        if (!(modeNow() === "llm" && llmReady())) return jsonResponse({ q, error: "no_model" }, 409);
        try {
          const bodies = withDb(p, (db) => bodiesFor(db, hits.items.map((x) => x.id)));
          const a = await answerNews(model, q, hits, bodies, { timeoutMs: Math.max(cfg.modelTimeoutMs, 180000) });
          return jsonResponse(Object.assign({ q, model: model.label() }, a), 200);
        } catch (err) {
          return jsonResponse({ q, error: errText(err) }, 502);
        }
      },
    });

    // 首次使用：不想看的版块（屏蔽）、想重点关注的词、留学资讯开关、推送节奏；之后面板发起第一轮抓取
    route({
      path: "/api/newswire/onboard",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        await ensureData(p);
        const tops = new Set(taxonomyLabels().map((l) => l.id));
        let f = loadFollows(p.follows);
        for (const t of Array.isArray(body.mute_topics) ? body.mute_topics : []) if (tops.has(String(t))) f = updateFollows(f, "mute", "topic", String(t));
        for (const k of (Array.isArray(body.keywords) ? body.keywords : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20)) f = updateFollows(f, "follow", "keyword", k);
        await saveFollows(f);
        if (typeof body.study === "boolean") {
          const conf = await readConfigSources(p);
          if (conf.data.packs && conf.data.packs.study_abroad) { conf.data.packs.study_abroad.enabled = body.study; await writeConfigSources(p, conf.data); }
        }
        if (body.cadence) await applyPush({ cadence: String(body.cadence) });
        return jsonResponse({ ok: true, follows: f, push: loadPush(p.pushPrefs) }, 200);
      },
    });

    // 影响与走势：分析一条故事线（模型），约 1–2 分钟
    route({
      path: "/api/newswire/analyze",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const id = strOrNull(body.story_id);
        if (!id) return jsonResponse({ error: "story_required" }, 400);
        if (!(modeNow() === "llm" && llmReady())) return jsonResponse({ error: "no_model" }, 409);
        try { return jsonResponse({ ok: true, analysis: await runAnalysis(id, false) }, 200); }
        catch (err) { return jsonResponse({ error: errText(err) }, err && err.message === "not_found" ? 404 : 502); }
      },
    });

    // 追踪：追踪对象列表与建议；增删、重写综述；单个对象的详情
    function latestThemes(db) { const ed = latestEdition(db, "all"); return (ed && ed.content && ed.content.themes) || []; }
    route({
      path: "/api/newswire/track",
      methods: ["GET", "HEAD", "POST"],
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = await bodyOf(request);
          const action = String(body.action || "");
          if (action === "add") {
            const r = withDb(p, (db) => {
              if (!db) return null;
              const id = addTracker(db, { name: body.name, kind: body.kind, ticker: body.ticker, aliases: Array.isArray(body.aliases) ? body.aliases : String(body.aliases || "").split(/[,，、|]/).map((x) => x.trim()).filter(Boolean), stories: body.stories, origin: body.origin || "manual", entities: taxEntities() });
              return { id, stories: db.prepare("SELECT story_id FROM tracker_stories WHERE tracker_id = ?").all(id).map((x) => x.story_id) };
            });
            if (!r) return jsonResponse({ error: "no_data" }, 409);
            withDb(p, (db) => { if (db) void syncTrackerFollows(db, r.id, r.stories); });
            return jsonResponse({ ok: true, id: r.id }, 200);
          }
          if (action === "remove") { const t = withDb(p, (db) => (db ? removeTracker(db, String(body.id)) : null)); await dropTrackerFollows(t); return jsonResponse({ ok: Boolean(t) }, t ? 200 : 404); }
          if (action === "unlink") { withDb(p, (db) => db && unlinkStory(db, String(body.id), String(body.story_id))); await saveFollows(updateFollows(loadFollows(p.follows), "unfollow", "story", String(body.story_id))); return jsonResponse({ ok: true }, 200); }
          if (action === "synth") {
            if (!(modeNow() === "llm" && llmReady())) return jsonResponse({ error: "no_model" }, 409);
            try { return jsonResponse({ ok: true, synthesis: await runSynthesis(String(body.id)) }, 200); } catch (err) { return jsonResponse({ error: errText(err) }, 502); }
          }
          return jsonResponse({ error: "action_invalid", actions: ["add", "remove", "unlink", "synth"] }, 400);
        }
        const out = withDb(p, (db) => (db ? { trackers: listTrackers(db), suggestions: trackSuggestions(db, { themes: latestThemes(db), entities: taxEntities(), regions: taxRegions() }) } : { trackers: [], suggestions: [] }));
        return jsonResponse(Object.assign({ can_synth: modeNow() === "llm" && llmReady() }, out), 200);
      },
    });
    route({
      path: "/api/newswire/track/item",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const d = withDb(p, (db) => (db ? trackerDetail(db, String(body.id || "")) : null));
        return d ? jsonResponse(Object.assign(d, { can_synth: modeNow() === "llm" && llmReady() }), 200) : jsonResponse({ error: "not_found" }, 404);
      },
    });

    // 质量面板
    route({
      path: "/api/newswire/quality",
      methods: ["GET", "HEAD"],
      fetch: async () => jsonResponse({ content: withDb(p, (db) => (db ? contentHealth(db) : null)), filtered: withDb(p, (db) => (db ? filteredItems(db, { hours: 72, limit: 60 }) : [])), editions: withDb(p, (db) => (db ? qualityRows(db, 30) : [])), feedback: withDb(p, (db) => (db ? db.prepare("SELECT kind, COUNT(*) n, SUM(CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END) resolved FROM feedback GROUP BY kind").all() : [])) }, 200),
    });

    // 故事线详情：稿件、每篇报道、进展、推送
    route({
      path: "/api/newswire/story",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const id = strOrNull(body.id);
        if (!id) return jsonResponse({ error: "id_required" }, 400);
        const st = withDb(p, (db) => {
          const d = db ? storyDetail(db, id) : null;
          if (d) {
            d.analysis = latestAnalysis(db, d.id);
            // 关键主体：每个都能一键追踪；已在追踪的标出来
            const tracked = db.prepare("SELECT t.id, t.name, t.aliases FROM trackers t WHERE t.status = 'active'").all();
            d.entities = db.prepare("SELECT name FROM story_entities WHERE story_id = ?").all(d.id).map((r) => { const t = tracked.find((x) => x.name === r.name || JSON.parse(x.aliases || "[]").includes(r.name)); return { name: r.name, tracker: t ? t.id : null }; });
          }
          return d;
        });
        return st ? jsonResponse(Object.assign(st, { can_analyze: modeNow() === "llm" && llmReady() }), 200) : jsonResponse({ error: "not_found" }, 404);
      },
    });

    // 关注与屏蔽：GET 列表；POST {action: follow|unfollow|mute|unmute, kind, value, name?}
    route({
      path: "/api/newswire/follows",
      methods: ["GET", "POST"],
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = await bodyOf(request);
          if (!["follow", "unfollow", "mute", "unmute"].includes(body.action) || !FOLLOW_KINDS.includes(body.kind) || !strOrNull(body.value)) return jsonResponse({ error: "follow_invalid", kinds: FOLLOW_KINDS }, 400);
          await saveFollows(updateFollows(loadFollows(p.follows), body.action, body.kind, String(body.value), strOrNull(body.name)));
        }
        return jsonResponse(loadFollows(p.follows), 200);
      },
    });

    // 模型：GET 当前模式、选择与 harness 里可用的模型；POST {mode, provider, model} 保存（provider/model 留空 = harness 默认模型）
    route({
      path: "/api/newswire/model",
      methods: ["GET", "POST"],
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = await bodyOf(request);
          const next = Object.assign({}, prefs());
          if (body.mode !== undefined) {
            if (body.mode !== "llm" && body.mode !== "economy") return jsonResponse({ error: "mode_invalid" }, 400);
            next.mode = body.mode;
          }
          if (body.provider !== undefined || body.model !== undefined) {
            const prov = strOrNull(body.provider);
            const mod = strOrNull(body.model);
            if (prov && mod) {
              const cat = await modelCatalog(false);
              const pr = cat.find((x) => x.id === prov);
              if (cat.length && (!pr || (pr.models.length && !pr.models.some((m) => m.id === mod)))) return jsonResponse({ error: "model_unknown" }, 400);
              next.provider = prov.slice(0, 200);
              next.model = mod.slice(0, 200);
            } else { delete next.provider; delete next.model; }
          }
          if (body.depth !== undefined) { if (!DEPTHS[body.depth]) return jsonResponse({ error: "depth_invalid" }, 400); next.depth = body.depth; }
          if (body.daily_tokens !== undefined) next.daily_tokens = Math.max(0, Math.min(1e9, Math.round(Number(body.daily_tokens) || 0)));
          next.updated_at = new Date().toISOString();
          await mkdir(path.dirname(p.modelPrefs), { recursive: true });
          await writeFileAtomic(p.modelPrefs, JSON.stringify(next, null, 2) + "\n");
        }
        let providers = [];
        let catalogError = null;
        try { providers = await modelCatalog(request.method === "POST" ? false : new URL(request.url, "http://x").searchParams.get("refresh") === "1"); } catch (err) { catalogError = errText(err); }
        const usage = withDb(p, (db) => (db ? usageToday(db) : null));
        return jsonResponse({ model: modelView(), providers, catalog_error: catalogError, usage }, 200);
      },
    });

    // 单个事件解读（强制重写）
    route({
      path: "/api/newswire/event/analyze",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        const id = strOrNull(body.id);
        if (!id) return jsonResponse({ error: "id_required" }, 400);
        if (!llmReady()) return jsonResponse({ ok: false, error: modeNow() === "economy" ? "economy_mode" : "model_unavailable", model: modelView() }, 503);
        const db = openIfExists(p.db);
        if (!db) return jsonResponse({ error: "not_found" }, 404);
        try {
          const r = await analyzeEvents(db, model, { eventIds: [id], max: 1, force: true });
          const ev = eventDetail(db, id);
          return jsonResponse({ ok: r.done === 1, error: r.errors[0] || null, event: ev }, r.done === 1 ? 200 : 502);
        } finally {
          db.close();
        }
      },
    });

    // 更新检查（做法同 dsh-switchboard）：source 为 profile 里的安装写法，面板从插件管理器读到后传过来
    route({
      path: "/api/newswire/update-check",
      methods: ["POST"],
      fetch: async (request) => {
        const body = await bodyOf(request);
        try {
          return jsonResponse(await updates.check(strOrNull(body.source) || "", body.force === true), 200);
        } catch (error) {
          const pkg = await installedPackage();
          return jsonResponse({ installed: pkg.version, newer: false, error: String(error && error.message ? error.message : error) }, 200);
        }
      },
    });

    // ---------------------------------------------------------------- 工具
    tool({
      name: "newswire_run",
      description: "Fetch one round of news (channels browse → agent_reach → http, falling back per source) and store articles with the source-reported heat signals of every item. Optional: sources (comma-separated ids), categories, packs, window_hours, max_items, per_source, export (jsonl|csv|both|none). Returns {ok, stage, run_id, tail, snapshot}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: { type: "string", description: "Only these source ids (comma-separated); omit for every enabled source." },
          categories: { type: "string", description: "Only these categories (comma-separated)." },
          packs: { type: "string", description: "Only these topic packs (comma-separated); default every enabled pack." },
          window_hours: { type: "number", description: "Fetch window in hours; default the plugin's windowHours." },
          max_items: { type: "number", description: "Item limit per source; 0 uses each source's max_items." },
          per_source: { type: "number", description: "Items shown per source in each digest category." },
          export: { type: "string", description: "jsonl | csv | both | none; default both." },
        },
      },
      timeoutMs: 1800000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok", "tail"], properties: { ok: { type: "boolean" }, stage: { type: "string" }, run_id: { oneOf: [{ type: "string" }, { type: "null" }] }, tail: { type: "string" }, snapshot: { type: "object" } } },
        render: (_args, value) => [{
          type: "text",
          text: [
            value.ok === true ? "抓取完成 " + (value.run_id ?? "") : "抓取未完成（" + (value.stage ?? "?") + "）",
            value.snapshot ? "源 " + (value.snapshot.latest_run?.sources_ok ?? "?") + "/" + ((value.snapshot.latest_run?.sources_ok ?? 0) + (value.snapshot.latest_run?.sources_failed ?? 0)) + "｜窗口 " + value.snapshot.window_hours + "h｜分类 " + (value.snapshot.categories || []).map((c) => c.category + ":" + c.n).join(" ") : "",
            value.snapshot && value.snapshot.failed && value.snapshot.failed.length ? "失败源：" + value.snapshot.failed.map((f) => f.source_id + "=" + f.error_kind).join(" ") : "",
            "--- log tail ---",
            value.tail,
          ].filter((l) => l !== "").join("\n"),
        }],
      },
      async execute(args) {
        const res = await guardedRun(args || {}, newRunId("tool"));
        if (res.ok && res.run_id) backgroundEdition(res.run_id, (args && args.packs) || "all");
        const snap = await snapshotOf(cfg, p);
        return { ok: res.ok, stage: res.stage, run_id: res.run_id, tail: res.tail, snapshot: { window_hours: snap.window_hours, latest_run: snap.latest_run, categories: snap.categories, failed: snap.failed.map((f) => ({ source_id: f.source_id, error_kind: f.error_kind, hint: f.hint })), digest_path: snap.digest_path } };
      },
    });

    tool({
      name: "newswire_cycle",
      description: "Run one full cycle (used by the scheduled task): fetch every enabled source from its continuity checkpoint (gaps are recovered by paging or search; 6 hours or more since the last cycle, or before 08:00, runs in overnight mode and fetches more) → classify, cluster cross-source events and score them → write the digest → lay out the edition (in LLM mode a model reads the news, groups, ranks and writes it; in economy mode the program does) → pick the new or upgraded top stories → return `message`, the text to send to the phone (one line when nothing qualifies, with open gaps and repeatedly failing sources appended). In a scheduled task, reply with `message` verbatim.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pack: { type: "string", description: "Topic pack; default every enabled pack (currently only core)." },
          sources: { type: "string", description: "For debugging: only these source ids (comma-separated). Do not pass it in the scheduled task." },
          overnight: { type: "boolean", description: "Force overnight mode." },
          dry_run: { type: "boolean", description: "Dry run: record no pushes, so the next run picks the same events again." },
          min_corroborated: { type: "number", description: "Minimum importance for multi-source events (corroborated, confirmed, disputed); default 50 or the push config." },
          min_single: { type: "number", description: "Minimum importance for single-source events; default 36." },
          max_push: { type: "number", description: "Maximum events per push; default 8." },
        },
      },
      timeoutMs: 1800000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["message"], properties: { ok: { type: "boolean" }, message: { type: "string" }, run_id: { oneOf: [{ type: "string" }, { type: "null" }] }, stats: { type: "object" } } },
        render: (_args, value) => [{ type: "text", text: String(value.message || "") }],
      },
      async execute(args) {
        return await runCycle(args || {});
      },
    });

    tool({
      name: "newswire_edition",
      description: "The latest news edition, laid out like a newspaper: a one-line headline, front-page stories, stories by section (each with title, lead, key points, what each side says, impact, credibility, outlets, and event ids), things worth watching, and items to verify (single-source or disputed). In LLM mode a model reads the round's news and lays it out; in economy mode the program does. refresh=true lays it out again now (minutes on a local model). Returns {ok, model, edition}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pack: { type: "string", description: "Topic pack (core, study_abroad, …) or all; default all." },
          refresh: { type: "boolean", description: "Lay out the edition again now in the current mode." },
        },
      },
      timeoutMs: 1500000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" }, error: { type: "string" }, model: { type: "object" }, edition: { oneOf: [{ type: "object" }, { type: "null" }] } } },
        render: (_args, v) => {
          const ed = v.edition;
          const c = ed && ed.content;
          if (!c) return [{ type: "text", text: v.error ? "版面编排失败：" + v.error : "还没有版面" }];
          const st = c.stories || {};
          const lines = ["📰 " + (c.headline || "") + "（" + ed.created_at + "，" + (ed.mode === "llm" ? "模型 " + ed.model : "程序编排") + "）"];
          c.front.forEach((id, i) => { const x = st[id]; if (x) lines.push((i + 1) + ". " + x.title + (x.lead ? "——" + x.lead : "")); });
          for (const sec of c.sections) lines.push("【" + sec.name + "】" + sec.stories.map((id) => (st[id] || {}).title).filter(Boolean).join("；"));
          if (c.watch.length) lines.push("值得关注：" + c.watch.map((w) => w.text).join("；"));
          if (c.verify.length) lines.push("待核实：" + c.verify.map((w) => w.text).join("；"));
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args) {
        const pack = strOrNull(args && args.pack) || "all";
        let error;
        if (args && args.refresh === true) {
          if (modelState.busy) error = "model_busy";
          else {
            await ensureData(p);
            const ed = await makeEdition({ pack, wantLlm: modeNow() === "llm" });
            if (!ed) error = "no_data";
            else if (ed.error) error = ed.error;
          }
        }
        const edition = withDb(p, (db) => latestEdition(db, pack));
        return Object.assign({ ok: Boolean(edition), model: modelView(), edition }, error ? { error } : {});
      },
    });

    tool({
      name: "newswire_daily",
      description: "The day's news wrap-up (Beijing time): a one-line headline, the main storylines with how each developed today, what to watch tomorrow, and the day's numbers. Written by the model in LLM mode (fact-checked), by the program in save-tokens mode. Builds a fresh one by default; refresh=false returns the latest stored one. In a scheduled task, reply with `message` verbatim.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pack: { type: "string", description: "Topic pack or all; default all." },
          date: { type: "string", description: "YYYY-MM-DD (Beijing time); default today." },
          refresh: { type: "boolean", description: "Build a new one (default true)." },
        },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["message"], properties: { ok: { type: "boolean" }, message: { type: "string" }, daily: { oneOf: [{ type: "object" }, { type: "null" }] } } },
        render: (_a, v) => [{ type: "text", text: String(v.message || "") }],
      },
      async execute(args) {
        const a = args || {};
        const pack = strOrNull(a.pack) || "all";
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || "")) ? String(a.date) : todayBj();
        await ensureData(p);
        let d = null;
        if (a.refresh !== false) {
          const until = Date.now() + 300000;
          while (modelState.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
          d = await makeDaily({ pack, date });
        } else d = withDb(p, (db) => (db ? latestDaily(db, pack, date) : null));
        if (!d) return { ok: false, message: date + " 还没有日报", daily: null };
        return { ok: true, message: composeDailyMessage(d, taxonomyNames()), daily: d };
      },
    });

    tool({
      name: "newswire_story",
      description: "One storyline in full: its current copy, every report in time order (source, time, title, link), the developments recorded edition by edition, and its pushes. Storyline ids come from newswire_edition. Use it to answer 'what happened with X so far'.",
      parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", description: "Storyline id (st-…)." } } },
      output: {
        schema: { type: "object", additionalProperties: true, required: ["found"], properties: { found: { type: "boolean" }, story: { oneOf: [{ type: "object" }, { type: "null" }] } } },
        render: (_a, v) => {
          if (!v.story) return [{ type: "text", text: "没有这条故事线" }];
          const st = v.story;
          const lines = ["【" + st.title + "】" + st.items.length + " 篇报道"].concat(st.updates.map((u) => u.at.slice(5, 16) + " 进展：" + u.text), st.items.slice(-8).map((it) => "· " + String(it.published_at || it.first_seen_at).slice(5, 16) + " " + (it.source_name || it.source_id) + "：" + it.title));
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args) {
        const st = withDb(p, (db) => (db ? storyDetail(db, String((args && args.id) || "")) : null));
        return { found: Boolean(st), story: st };
      },
    });

    tool({
      name: "newswire_follow",
      description: "Follow or mute what the user cares about. kind: story (a storyline id from newswire_edition), keyword (a person, company, or term; aliases separated by |, e.g. 英伟达|NVIDIA), topic (a taxonomy id such as study or macro), source (a source id). Followed items get their own 'Following' section in the edition, a lower push threshold, and a new push when a followed storyline gains reports; muted ones never appear or get pushed. action list returns the current lists.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["list", "follow", "unfollow", "mute", "unmute"] },
          kind: { type: "string", enum: ["story", "keyword", "topic", "source"] },
          value: { type: "string", description: "Storyline id, keyword (aliases with |), taxonomy id, or source id." },
          name: { type: "string", description: "Display name (optional)." },
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true, required: ["follow", "mute"], properties: { follow: { type: "array" }, mute: { type: "array" } } },
        render: (_a, v) => [{ type: "text", text: "关注：" + (v.follow.map((x) => x.name || x.value).join("、") || "无") + "\n屏蔽：" + (v.mute.map((x) => x.name || x.value).join("、") || "无") }],
      },
      async execute(args) {
        const a = args || {};
        if (a.action !== "list") {
          if (!FOLLOW_KINDS.includes(a.kind) || !strOrNull(a.value)) throw new Error("kind and value are required for " + a.action);
          await ensureData(p);
          await saveFollows(updateFollows(loadFollows(p.follows), a.action, a.kind, String(a.value), strOrNull(a.name)));
        }
        return loadFollows(p.follows);
      },
    });

    tool({
      name: "newswire_schedule_setup",
      description: "Schedule the news push with the host's schedule service: action=create (default; updates the task if it exists) / status / pause / resume / remove. Default: every 2 hours from 07:00 to 21:00 Beijing time (cron 0 7-21/2 * * *), delivered to one reused conversation; link that conversation to Telegram or Feishu with /use or /watch once, and every round reaches the phone.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["create", "status", "pause", "resume", "remove"], description: "Default create." },
          cron: { type: "string", description: "Five-field cron; default 0 7-21/2 * * *." },
          time_zone: { type: "string", description: "IANA time zone; default Asia/Shanghai." },
          pack: { type: "string", description: "Topic pack; default core. Each pack gets its own task, with its default time from sources.json (core: every 2 hours 07–21; study_abroad: 08:30 and 20:30)." },
          kind: { type: "string", enum: ["cycle", "daily"], description: "cycle (default) = the push rounds; daily = the evening wrap-up via newswire_daily, default 21:30 Beijing time." },
          title: { type: "string", description: "Task title, used to find this plugin's task; default \"" + SCHEDULE_TITLE + "\"." },
          cwd: { type: "string", description: "Working directory for the new conversation (optional; default the host's)." },
          agent_preset: { type: "string", description: "Agent preset for the new conversation (optional; a cheaper model saves tokens)." },
        },
      },
      timeoutMs: 30000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok", "note"], properties: { ok: { type: "boolean" }, note: { type: "string" }, task: { oneOf: [{ type: "object" }, { type: "null" }] } } },
        render: (_args, v) => [{ type: "text", text: v.note + (v.task ? "\n任务 " + v.task.id + "｜" + v.task.title + "｜" + v.task.status + (v.task.scheduledAt ? "｜下一次 " + v.task.scheduledAt : "") : "") }],
      },
      async execute(args, exec) {
        return await scheduleSetup(args, exec && exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.id : undefined);
      },
    });

    /** 定时任务的增改查（工具与推送设置共用）。 */
    async function scheduleSetup(args, actor) {
        const svc = optional.schedule;
        if (!svc) return { ok: false, task: null, note: "当前宿主没有定时任务服务（schedule）。请在 Web 或桌面版 harness 里使用，或在「自动化任务」页面手工创建：cron " + SCHEDULE_CRON + "，指令见 README。" };
        const a = args || {};
        const pack = a.pack || "core";
        const defaults = packSchedule(p, pack);
        if (pack !== "core" && !defaults.packs[pack]) return { ok: false, task: null, note: "没有主题包「" + pack + "」；现有：" + Object.keys(defaults.packs).join("、") };
        const daily = a.kind === "daily";
        const title = (a.title || (daily ? "今日回顾" + (pack === "core" ? "" : " · " + pack) + " · dsh-newswire" : defaults.title)).trim();
        const view = (t) => (t ? { id: t.id, title: t.title, status: t.status, scheduledAt: t.scheduledAt ?? null, target: t.target ?? null } : null);
        const all = (await svc.list({ limit: 500 })).items || [];
        const mine = all.find((t) => t.title === title) || null;
        const action = a.action || "create";
        if (action === "status") return { ok: true, task: view(mine), note: mine ? "已安排" : "还没有安排（用 action=create 创建）" };
        if (action !== "create" && !mine) return { ok: false, task: null, note: "找不到标题为「" + title + "」的任务" };
        if (action === "remove") { await svc.edit({ id: mine.id, action: "delete" }, actor); return { ok: true, task: null, note: "已删除定时任务「" + title + "」" }; }
        if (action === "pause" || action === "resume") {
          const r = await svc.edit({ id: mine.id, action: "update", patch: { active: action === "resume" } }, actor);
          if (r && r.code) return { ok: false, task: view(mine), note: "操作失败：" + r.code };
          return { ok: true, task: view(r), note: action === "pause" ? "已暂停" : "已恢复" };
        }
        const timing = { kind: "cron", cron: { expression: (a.cron || (daily ? DAILY_CRON : defaults.cron)).trim(), time_zone: a.time_zone || defaults.tz } };
        const prompt = daily ? dailyPrompt(pack === "core" ? "all" : pack) : schedulePrompt(pack);
        try {
          if (mine) {
            const r = await svc.edit({ id: mine.id, action: "update", patch: { prompt, timing, active: true } }, actor);
            if (r && r.code) return { ok: false, task: view(mine), note: "更新失败：" + r.code };
            return { ok: true, task: view(r), note: "已更新定时任务（" + timing.cron.expression + " " + timing.cron.time_zone + "）。" };
          }
          const create = {};
          if (a.cwd) create.cwd = a.cwd;
          if (a.agent_preset) create.agentPreset = a.agent_preset;
          const t = await svc.create({ title, prompt, timing, target: { kind: "new_once", create } }, actor);
          return { ok: true, task: view(t), note: "已创建定时任务（" + timing.cron.expression + " " + timing.cron.time_zone + "），投递到一个固定复用的会话。第一次投递后，在 Telegram/飞书里对该会话 /use 或 /watch 一次，之后每轮消息会推到手机。" };
        } catch (e) {
          return { ok: false, task: view(mine), note: "宿主拒绝了这个定时任务：" + String(e && e.message ? e.message : e) };
        }
    }

    tool({
      name: "newswire_analyze",
      description: "Analyze a storyline's potential impact and likely evolution with the model (LLM mode): who is affected (markets, companies with tickers, industries, policy) and in which direction, 2–3 scenarios with likelihood and signals to watch, and what to watch next. Grounded in the storyline's own reports; invented numbers are dropped. It is speculation, not fact or investment advice — say so. story_id comes from newswire_edition; with refresh=false (default) the latest stored analysis is returned if one exists.",
      parameters: { type: "object", additionalProperties: false, required: ["story_id"], properties: { story_id: { type: "string" }, refresh: { type: "boolean" } } },
      timeoutMs: 300000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" } } },
        render: (_a, v) => [{ type: "text", text: !v.ok ? "分析失败：" + v.error : [v.analysis.summary].concat((v.analysis.impacts || []).map((x) => "· " + x.area + "｜" + x.target + (x.ticker ? "（" + x.ticker + "）" : "") + "｜" + x.direction + "：" + x.why), (v.analysis.scenarios || []).map((x) => "→ " + x.name + "（可能性" + x.likelihood + "）：" + x.what + "；信号：" + x.signals)).join("\n") + "\n（模型推演，非事实，不构成投资建议）" }],
      },
      async execute(args) {
        const id = String((args && args.story_id) || "");
        if (!args.refresh) { const cur = withDb(p, (db) => (db ? latestAnalysis(db, id) : null)); if (cur) return { ok: true, analysis: cur }; }
        if (!(modeNow() === "llm" && llmReady())) return { ok: false, error: "需要 LLM 模式且模型可用" };
        try { return { ok: true, analysis: await runAnalysis(id, false) }; } catch (err) { return { ok: false, error: errText(err) }; }
      },
    });

    tool({
      name: "newswire_track",
      description: "Track a company, technology, person or ongoing theme over time: related storylines are linked automatically after every edition, and in LLM mode the model writes an incremental synthesis (current state, trend — e.g. whether the company keeps shipping new technology —, milestones, implications for its own stock, peers, the industry and technology trends with direction and confidence, possible paths with signals, what to watch, and what changed since last time). action: list (default; also returns suggestions worth tracking), add (name, kind company|technology|person|theme, optional ticker and aliases), get (id), synth (id; rewrite the synthesis now), remove (id; deletes the subject, its linked storylines, syntheses and the follows it added). Tracked subjects also enter the reader's Following section and get the lower push threshold. Syntheses are speculation, not investment advice.",
      parameters: { type: "object", additionalProperties: false, properties: {
        action: { type: "string", enum: ["list", "add", "get", "synth", "remove"] }, id: { type: "string" }, name: { type: "string" },
        kind: { type: "string", enum: ["company", "technology", "person", "theme"] }, ticker: { type: "string" }, aliases: { type: "array", items: { type: "string" } } } },
      timeoutMs: 330000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" } } },
        render: (_a, v) => [{ type: "text", text: !v.ok ? "失败：" + v.error : v.trackers ? v.trackers.map((t) => "· " + t.name + "（" + t.kind + (t.ticker ? " " + t.ticker : "") + "）" + t.stories + " 条故事线" + (t.synthesis ? "｜" + t.synthesis.state : "")).join("\n") + (v.suggestions && v.suggestions.length ? "\n值得追踪：" + v.suggestions.map((x) => x.name).join("、") : "") : v.synthesis ? [v.synthesis.state, v.synthesis.trend].concat((v.synthesis.implications || []).map((x) => "· " + x.area + "｜" + x.target + (x.ticker ? "（" + x.ticker + "）" : "") + "｜" + x.direction + "：" + x.why), (v.synthesis.outlook || []).map((x) => "→ " + x.name + "（" + x.likelihood + "）" + x.what)).filter(Boolean).join("\n") + "\n（模型推演，非事实，不构成投资建议）" : JSON.stringify(v).slice(0, 1500) }],
      },
      async execute(args) {
        const a = args || {};
        const act = a.action || "list";
        if (act === "list") return withDb(p, (db) => (db ? { ok: true, trackers: listTrackers(db), suggestions: trackSuggestions(db, { themes: latestThemes(db), entities: taxEntities(), regions: taxRegions() }) } : { ok: false, error: "no_data" }));
        if (act === "add") {
          const r = withDb(p, (db) => { if (!db) return null; const id = addTracker(db, { name: a.name, kind: a.kind, ticker: a.ticker, aliases: a.aliases, origin: "agent", entities: taxEntities() }); return { id, stories: db.prepare("SELECT story_id FROM tracker_stories WHERE tracker_id = ?").all(id).map((x) => x.story_id) }; });
          if (!r) return { ok: false, error: "no_data" };
          withDb(p, (db) => { if (db) void syncTrackerFollows(db, r.id, r.stories); });
          return { ok: true, id: r.id, detail: withDb(p, (db) => trackerDetail(db, r.id)) };
        }
        if (act === "get") { const d = withDb(p, (db) => (db ? trackerDetail(db, String(a.id)) : null)); return d ? { ok: true, synthesis: d.synthesis, detail: d } : { ok: false, error: "not_found" }; }
        if (act === "remove") { const t = withDb(p, (db) => (db ? removeTracker(db, String(a.id)) : null)); await dropTrackerFollows(t); return t ? { ok: true } : { ok: false, error: "not_found" }; }
        if (act === "synth") { if (!(modeNow() === "llm" && llmReady())) return { ok: false, error: "需要 LLM 模式且模型可用" }; try { return { ok: true, synthesis: await runSynthesis(String(a.id)) }; } catch (err) { return { ok: false, error: errText(err) }; } }
        return { ok: false, error: "unknown action" };
      },
    });

    tool({
      name: "newswire_push_prefs",
      description: "Read or change how often and how much news is pushed to the phone. cadence: every2h (07–21) / every4h (8, 12, 16, 20) / thrice (8, 12, 18) / daily_only (no rounds, only the evening recap) — changing it updates the scheduled task if one exists. level: fewer (higher bar) / normal / more. per_round: max stories per push (1–15). daily_max: max stories per day (1–100). With no arguments, returns the current settings, recent pushes and per-section adjustments learned from the reader's feedback.",
      parameters: { type: "object", additionalProperties: false, properties: {
        cadence: { type: "string", enum: Object.keys(CADENCES) }, level: { type: "string", enum: Object.keys(LEVELS) },
        per_round: { type: "number" }, daily_max: { type: "number" } } },
      timeoutMs: 30000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["prefs"], properties: { prefs: { type: "object" } } },
        render: (_a, v) => [{ type: "text", text: "推送节奏：" + (CADENCES[v.prefs.cadence] || {}).label + "｜档位：" + v.prefs.level + "｜每轮最多 " + v.prefs.per_round + " 条｜每天最多 " + v.prefs.daily_max + " 条" + (v.schedule_note ? "\n" + v.schedule_note : "") }],
      },
      async execute(args) {
        const a = args || {};
        const changed = ["cadence", "level", "per_round", "daily_max"].some((k) => a[k] !== undefined);
        if (!changed) { const v = await pushView(); return { prefs: v.prefs, penalties: v.penalties, task: v.task }; }
        const r = await applyPush(a);
        return { prefs: r.prefs, schedule_note: r.schedule ? r.schedule.note : null };
      },
    });

    tool({
      name: "newswire_events",
      description: "List cross-source events (reports of one story from several outlets grouped, with cross-validation): hours (default 24) / min_importance / credibility (single|corroborated|confirmed|disputed, comma-separated) / label (topic prefix such as macro or politics.conflict) / region (CN/US/ME…) / query / multi_only / limit. Each event carries importance (0–100), credibility, outlets with first-report times, labels, regions, score factors, and whether it was pushed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          hours: { type: "number" }, min_importance: { type: "number" }, credibility: { type: "string" }, label: { type: "string" }, region: { type: "string" },
          pack: { type: "string", description: "Only events of this topic pack, for example study_abroad." },
          query: { type: "string" }, multi_only: { type: "boolean", description: "Only events reported by two or more independent outlets." }, limit: { type: "number", description: "Default 20, at most 100." },
        },
      },
      timeoutMs: 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["count", "events"], properties: { count: { type: "number" }, events: { type: "array", items: { type: "object" } } } },
        render: (_args, v) => [{ type: "text", text: "自 " + v.since_iso + " 起 " + v.count + " 个事件\n" + v.events.map((e) => "- [" + Math.round(e.importance) + "]【" + CRED_TEXT[e.credibility] + "·" + e.source_count + "源】" + e.title + "｜" + e.outlets.map((x) => x.name).join("、") + "｜" + (e.lead_url || "") + "｜id " + e.event_id).join("\n") + "\n" + DISCLAIMER }],
      },
      async execute(args) {
        await ensureData(p);
        const a = args || {};
        const since = sinceIso(clampNum(a.hours, 1, 24 * 90, 24));
        const events = withDb(p, (db) => eventRows(db, { since, pack: a.pack, minImportance: a.min_importance, credibility: a.credibility, label: a.label, region: a.region, query: a.query, multiOnly: a.multi_only === true, limit: Math.min(Number(a.limit) || 20, 100) }));
        return { count: events.length, since_iso: since, events };
      },
    });

    tool({
      name: "newswire_event",
      description: "Show one event: every outlet's report (title, time, link, heat signals, labels, how it joined), the score trail, pushes, and any dispute.",
      parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", description: "Event id from newswire_events." } } },
      timeoutMs: 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["found"], properties: { found: { type: "boolean" }, event: { oneOf: [{ type: "object" }, { type: "null" }] } } },
        render: (_args, v) => [{ type: "text", text: !v.found ? "找不到这个事件" : [
          "[" + Math.round(v.event.importance) + "]【" + CRED_TEXT[v.event.credibility] + "·" + v.event.source_count + "源】" + v.event.title,
          "因子：" + Object.entries(v.event.factors).map((e) => e[0] + "=" + e[1]).join(" "),
          v.event.dispute ? "分歧（" + v.event.dispute.kind + "）：" + v.event.dispute.values.map((x) => x.outlet + " " + x.value).join(" / ") : "",
          ...v.event.members.map((m) => "- " + (m.published_at || "~") + " " + (m.source_name || m.source_id) + "｜" + m.title + " " + signalText({ hot: m.hot, level: m.level, views: m.views, comments: m.comments, likes: m.likes }) + "｜" + m.url + "（" + m.method + "）"),
          v.event.pushes.length ? "推送：" + v.event.pushes.map((x) => x.pushed_at + " " + x.reason).join("；") : "未推送",
        ].filter(Boolean).join("\n") }],
      },
      async execute(args) {
        const ev = withDb(p, (db) => eventDetail(db, String(args?.id || "")));
        return { found: Boolean(ev), event: ev };
      },
    });

    tool({
      name: "newswire_reprocess",
      description: "After editing dataDir/taxonomy.json (topic keywords, regions, entity aliases, watch and mute words), recompute labels for items in the window; with stage=events (default), recluster and rescore events too.",
      parameters: { type: "object", additionalProperties: false, properties: { stage: { type: "string", enum: ["labels", "events"] }, hours: { type: "number", description: "Hours to look back; default 72, at most 2160." } } },
      timeoutMs: 600000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" } } },
        render: (_args, v) => [{ type: "text", text: v.ok ? "已重算：条目 " + v.articles + "，事件 " + v.events + "（合并 " + v.merged + "），规则版本 " + v.rules_version : "重算失败：" + (v.error || v.tail || "") }],
      },
      async execute(args) {
        const busy = busyWith();
        if (busy) return { ok: false, error: "有一轮在跑：" + busy };
        await ensureData(p);
        const res = await runEngine(ctx, cfg, p, ["--mode", "reprocess", "--config", p.cfgFile, "--db", p.db, ...taxFlags(p), "--stage", args?.stage || "events", "--hours", String(clampNum(args?.hours, 1, 2160, 72))], 600000);
        return engineJson(res.stdout) || { ok: false, error: res.stage, tail: res.tail };
      },
    });

    tool({
      name: "newswire_export",
      description: "Export a training / backtesting dataset for a date range (Beijing dates, inclusive) into dataDir/datasets: articles.jsonl (each item with body when training-ready, labels, event, and its heat at every round), events.jsonl (members, score trail, pushes), and manifest.json (sources, versions, runs, and the open gaps and failed source-rounds in the range, so missing coverage is not mistaken for no news).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["from"],
        properties: {
          from: { type: "string", description: "First day, YYYY-MM-DD (Beijing time)." },
          to: { type: "string", description: "Last day, YYYY-MM-DD; default the same as from." },
          kind: { type: "string", enum: ["all", "articles", "events", "stories"], description: "What to export; default all. stories = storylines, editions (the per-item story, section, and importance labels), digests, and reader feedback." },
          pack: { type: "string", description: "Only this topic pack." },
        },
      },
      timeoutMs: 600000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" } } },
        render: (_args, v) => [{ type: "text", text: v.ok ? "已导出到 " + v.dir + "\n" + Object.entries(v.files || {}).map((e) => e[0] + "：" + e[1] + " 行").join("\n") + "\n范围内运行 " + v.runs + " 轮｜未补全缺口 " + v.open_gaps + "｜失败的源轮次 " + v.failed_source_runs + "（详见 manifest.json）" : "导出失败：" + (v.error || v.tail || "") }],
      },
      async execute(args) {
        await ensureData(p);
        const a = args || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.from || "")) || (a.to && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.to)))) return { ok: false, error: "from / to 需为 YYYY-MM-DD" };
        const flags = ["--mode", "export", "--config", p.cfgFile, "--db", p.db, ...taxFlags(p), "--datasets", p.datasets, "--from", a.from, "--to", a.to || a.from, "--kind", a.kind || "all"];
        if (a.pack) flags.push("--pack", String(a.pack));
        const res = await runEngine(ctx, cfg, p, flags, 600000);
        return engineJson(res.stdout) || { ok: false, error: res.stage, tail: res.tail };
      },
    });

    tool({
      name: "newswire_snapshot",
      description: "Status of the latest run: run id and time, whether it is stale (>26h), counts per category, hot keywords, failed sources with error_kind and hint, digest path and excerpt. Always cite the data time; not investment advice.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      timeoutMs: 30000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["data_asof", "categories", "latest_run"], properties: { data_asof: { type: "string" }, latest_run: { oneOf: [{ type: "object" }, { type: "null" }] }, categories: { type: "array" }, keywords: { type: "array" }, failed: { type: "array" }, digest_path: { oneOf: [{ type: "string" }, { type: "null" }] }, stale: { type: "boolean" }, disclaimer: { type: "string" } } },
        render: (_args, value) => [{
          type: "text",
          text: [
            "数据时间 " + value.data_asof + "｜窗口 " + value.window_hours + "h" + (value.stale === true ? "｜⚠ 最新一轮超过 26 小时" : ""),
            value.latest_run ? "最新运行 " + value.latest_run.run_id + "（" + (value.latest_run.finished_at || value.latest_run.started_at) + "）成功 " + value.latest_run.sources_ok + "/" + ((value.latest_run.sources_ok ?? 0) + (value.latest_run.sources_failed ?? 0)) + "｜新增 " + value.latest_run.items_new + " 重复 " + value.latest_run.items_dup : "还没有抓取记录，先跑 newswire_run",
            "分类：" + (value.categories || []).map((c) => c.category + " " + c.n).join(" ｜ "),
            "热点：" + (value.keywords || []).map((k) => k.tag + " " + k.n).join(" ｜ "),
            value.failed && value.failed.length ? "失败：" + value.failed.map((f) => f.source_id + "=" + f.error_kind).join(" ｜ ") : "失败：无",
            "汇总：" + (value.digest_path ?? "（未生成）"),
            String(value.disclaimer ?? DISCLAIMER),
          ].join("\n"),
        }],
      },
      async execute() {
        await ensureData(p);
        return await snapshotOf(cfg, p);
      },
    });

    tool({
      name: "newswire_items",
      description: "Read stored items, newest first: category / source / pack / label / query (3+ characters uses full-text search) / hours / hot_only / limit. Each item has time, time_confidence (feed = time given by the source, fetched = approximated by fetch time), source, title, summary, url (the original link), and signals (source-reported heat: views, comments, likes, hot marks, level, position).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", description: "Category name, as in sources.json." },
          source: { type: "string", description: "Source id, for example cls_telegraph." },
          pack: { type: "string", description: "Topic pack, for example core." },
          query: { type: "string", description: "Keyword in title or summary (3+ characters uses full-text search; shorter ones match substrings)." },
          hours: { type: "number", description: "Hours to look back; default the plugin's windowHours." },
          hot_only: { type: "boolean", description: "Only items the source marked as hot, red, or with a level." },
          label: { type: "string", description: "Topic label (prefix match), for example macro, markets.crypto, study." },
          limit: { type: "number", description: "Item limit; default 30, at most 300." },
        },
      },
      timeoutMs: 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["count", "items"], properties: { count: { type: "number" }, since_iso: { type: "string" }, items: { type: "array", items: { type: "object" } }, note: { type: "string" } } },
        render: (_args, value) => [{
          type: "text",
          text: "自 " + value.since_iso + " 起 " + value.count + " 条" + (value.note ? "（" + value.note + "）" : "") + "\n" + value.items.map((r) => "- " + (r.time_confidence === "fetched" ? "~" + r.time : r.time_confidence === "url_date" ? String(r.time).slice(0, 10) : r.time) + " " + r.source + "｜" + r.title + " " + signalText(r.signals) + "｜" + r.url).join("\n") + "\n" + DISCLAIMER,
        }],
      },
      async execute(args) {
        await ensureData(p);
        const since = sinceIso(args?.hours ?? cfg.windowHours);
        if (!existsSync(p.db)) return { count: 0, items: [], since_iso: since, note: "本地库还不存在，先跑 newswire_run" };
        const items = withDb(p, (db) => itemRows(db, { since, category: args?.category, source: args?.source, pack: args?.pack, label: args?.label, query: args?.query, hotOnly: args?.hot_only === true, limit: Math.min(Number(args?.limit) || 30, 300) }));
        return { count: items.length, since_iso: since, items };
      },
    });

    tool({
      name: "newswire_sources",
      description: "List sources with health: enabled, successes/attempts, average latency, last working channel, last failure kind, and the heat signals actually collected.",
      parameters: { type: "object", additionalProperties: false, properties: { include_removed: { type: "boolean", description: "Include soft-deleted sources; default false." } } },
      timeoutMs: 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["count", "sources", "config_path"], properties: { count: { type: "number" }, config_path: { type: "string" }, sources: { type: "array", items: { type: "object" } } } },
        render: (_args, value) => [{
          type: "text",
          text: "配置 " + value.config_path + "｜" + value.count + " 个源\n" + value.sources.map((s) => "- " + s.id + " [" + s.category + "] " + s.type + (s.adapter ? "/" + s.adapter : "") + " " + (s.removed_at ? "已删除" : s.enabled ? "启用" : "停用") + " 成功 " + s.ok + "/" + s.tries + (s.avg_latency_ms ? " 平均 " + s.avg_latency_ms + "ms" : "") + (s.last_error_kind ? " 最近失败 " + s.last_error_kind : "") + (s.signals.length ? " 信号 " + s.signals.join("/") : "")).join("\n"),
        }],
      },
      async execute(args) {
        await ensureData(p);
        const doc = await sourcesDocOf(p, cfg);
        const sources = doc.sources.filter((s) => args?.include_removed === true || !s.removed_at).map((s) => ({
          id: s.id, name: s.name, category: s.category, type: s.type, adapter: s.adapter ?? null, url: s.url, region: s.region ?? null, weight: s.weight ?? null, tier: s.tier ?? null, group: s.group ?? null, pack: s.pack ?? "core",
          channels: s.channels ?? doc.defaults.channels ?? [], enabled: s.enabled !== false, removed_at: s.removed_at ?? null,
          tries: s.health?.tries ?? 0, ok: s.health?.ok ?? 0, avg_latency_ms: s.health?.avg_latency_ms ?? null, last_try: s.health?.last_try ?? null,
          last_ok_channel: s.health?.last_ok_channel ?? null, last_error_kind: s.health?.last_error_kind ?? null, signals: s.health?.signals ?? [],
        }));
        return { count: sources.length, config_path: p.cfgFile, sources };
      },
    });

    tool({
      name: "newswire_source_toggle",
      description: "Enable or disable a source (edits dataDir/sources.json, effective next run). The seed config inside engine/ is not changed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", description: "Source id (see newswire_sources)." }, enabled: { type: "boolean", description: "true to enable, false to disable." }, trial: { type: "boolean", description: "With enabled=true: true puts the source on trial (it corroborates other outlets but cannot put a story on the board alone), false makes it a full source." } },
        required: ["id", "enabled"],
      },
      timeoutMs: 15000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["changed", "note"], properties: { changed: { oneOf: [{ type: "object" }, { type: "null" }] }, note: { type: "string" }, config_path: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: value.note + "\n" + JSON.stringify(value.changed ?? null) }],
      },
      async execute(args) {
        await ensureData(p);
        const conf = await readConfigSources(p);
        const hit = conf.data.sources.find((s) => s.id === args?.id);
        if (!hit) return { changed: null, note: "找不到源 " + String(args?.id) + "；现有：" + conf.data.sources.map((s) => s.id).join(", "), config_path: p.cfgFile };
        const state = args.enabled !== true ? "off" : args.trial === true ? "trial" : args.trial === false || !hit.trial ? "on" : "trial";
        setSourceState(conf.data, hit.id, state);
        await writeConfigSources(p, conf.data);
        syncSourceState(hit);
        return { changed: { id: hit.id, name: hit.name, enabled: hit.enabled, trial: Boolean(hit.trial) }, note: state === "off" ? "已停用，下一轮抓取跳过" : state === "trial" ? "已设为试用：照常抓取、参与印证，但不能单独上版或推送" : "已启用，下一轮抓取生效", config_path: p.cfgFile };
      },
    });

    tool({
      name: "newswire_source_upsert",
      description: "Add or change a source, merged by id: give only the fields to change; a new source needs id/name/category/type/url. Writes dataDir/sources.json, effective next run. Try it with newswire_source_test first.",
      parameters: { type: "object", additionalProperties: false, required: ["source"], properties: { source: { type: "object", additionalProperties: false, required: ["id"], properties: SOURCE_PROPS } } },
      timeoutMs: 15000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" }, created: { type: "boolean" }, source: { type: "object" }, problems: { type: "array", items: { type: "string" } } } },
        render: (_args, value) => [{ type: "text", text: value.ok ? (value.created ? "已新增 " : "已更新 ") + value.source.id + "\n" + JSON.stringify(value.source) : "未保存：" + (value.problems || []).join("；") }],
      },
      async execute(args) {
        await ensureData(p);
        if (!args?.source || typeof args.source.id !== "string") return { ok: false, problems: ["source.id 必填"] };
        return await upsertSourceInConfig(p, args.source);
      },
    });

    tool({
      name: "newswire_source_remove",
      description: "Remove a source. By default a soft delete (disabled and marked removed_at; stored items and observations stay; restore with newswire_source_toggle); purge=true removes it from the config (history in the database stays).",
      parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, purge: { type: "boolean", description: "Remove from the config file; default false." } } },
      timeoutMs: 15000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok", "note"], properties: { ok: { type: "boolean" }, note: { type: "string" } } },
        render: (_args, value) => [{ type: "text", text: value.note }],
      },
      async execute(args) {
        await ensureData(p);
        const conf = await readConfigSources(p);
        const at = conf.data.sources.findIndex((s) => s.id === args?.id);
        if (at < 0) return { ok: false, note: "找不到源 " + String(args?.id) };
        if (args.purge === true) {
          conf.data.sources.splice(at, 1);
          await writeConfigSources(p, conf.data);
          return { ok: true, note: "已从配置移除 " + args.id + "（库里的历史条目保留）" };
        }
        conf.data.sources[at] = Object.assign({}, conf.data.sources[at], { enabled: false, removed_at: nowIsoUtc() });
        await writeConfigSources(p, conf.data);
        return { ok: true, note: "已软删除 " + args.id + "：下一轮起不再抓取，历史保留；恢复用 newswire_source_toggle enabled=true" };
      },
    });

    tool({
      name: "newswire_source_test",
      description: "Trial-fetch a source without storing anything: id for a configured source, or source for an unsaved one. Returns each channel attempt, parsed counts, the first N items (title, time, link, heat signals), and the signal kinds found.",
      parameters: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, source: { type: "object", additionalProperties: false, properties: SOURCE_PROPS }, max_items: { type: "number", description: "Items to show; default 10, at most 30." } } },
      timeoutMs: TEST_TIMEOUT_MS + 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" } } },
        render: (_args, v) => [{
          type: "text",
          text: v.problems ? "源配置有问题：" + v.problems.join("；") : [
            (v.ok ? "✓ " : "✗ ") + (v.source_id || "") + " 通道 " + (v.channel || "-") + " 解析 " + (v.parsed ?? 0) + " 条，保留 " + (v.kept ?? 0) + (v.parsed_by ? "（" + v.parsed_by + "）" : ""),
            "通道链：" + (v.attempts || []).map((a) => a.channel + (a.backend ? "/" + a.backend : "") + "=" + (a.ok ? "ok" : a.error_kind || "fail")).join(" → "),
            "信号：" + (Object.keys(v.signals || {}).length ? Object.entries(v.signals).map((e) => e[0] + "×" + e[1]).join(" ") : "无（只有位置）") + "｜时间来源：" + JSON.stringify(v.time_confidence || {}),
            ...(v.items || []).map((r) => "- " + (r.published_at || "~") + " " + r.title + " " + signalText(r.signals) + "｜" + r.url),
            ...(v.attempts || []).filter((a) => !a.ok && a.hint).map((a) => "hint(" + a.channel + ")：" + a.hint),
            v.error ? "错误：" + v.error : "",
          ].filter(Boolean).join("\n"),
        }],
      },
      async execute(args) {
        await ensureData(p);
        return await testSource(ctx, cfg, p, args || {});
      },
    });

    tool({
      name: "newswire_failures",
      description: "Failed attempts of a run (default the latest): source_id, channel, backend, http_status, error_kind, error, and hint (a fix you can apply).",
      parameters: { type: "object", additionalProperties: false, properties: { run_id: { type: "string", description: "Run id; omit for the latest run." }, limit: { type: "number", description: "Maximum attempts to return; default 40." } } },
      timeoutMs: 20000,
      output: {
        schema: { type: "object", additionalProperties: true, required: ["run_id", "count", "failures"], properties: { run_id: { oneOf: [{ type: "string" }, { type: "null" }] }, count: { type: "number" }, failures: { type: "array", items: { type: "object" } } } },
        render: (_args, value) => [{
          type: "text",
          text: "运行 " + (value.run_id ?? "?") + "｜失败尝试 " + value.count + "\n" + value.failures.map((f) => "- " + f.source_id + " " + f.channel + (f.backend ? "/" + f.backend : "") + " " + (f.http_status ?? "") + " " + f.error_kind + "\n  " + f.error + "\n  hint: " + (f.hint ?? "")).join("\n"),
        }],
      },
      async execute(args) {
        await ensureData(p);
        return withDb(p, (db) => {
          const run = args?.run_id ? { run_id: args.run_id } : latestRun(db);
          const failures = failureRows(db, run?.run_id ?? null, args?.limit);
          return { run_id: run?.run_id ?? null, count: failures.length, failures };
        });
      },
    });

    disposers.push(ctx.systemPrompt.section({
      name: "dsh-newswire",
      order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + 1,
      text: "The dsh-newswire plugin keeps a local news store. For news, read newswire_snapshot / newswire_items first (stored items with source-reported heat signals); fetch a round with newswire_run only when that is not enough. To see which stories several outlets carry and how credible they are, use newswire_events / newswire_event; for a laid-out overview of what happened and what is worth watching, read newswire_edition (sections, leads, key points, items to verify; in LLM mode written by a model from the stored news, so check facts against the events). Scheduled pushes are set up with newswire_schedule_setup and each round runs newswire_cycle; when the user asks for a nightly news recap (e.g. 「每晚推送新闻回顾」), call newswire_schedule_setup with kind \"daily\"; when they want fewer, more, or differently timed pushes (e.g. 「推少一点」「晚上别推」「一天三次就行」), use newswire_push_prefs. To explain what an important story could lead to (impact on markets, companies, technology; possible scenarios), use newswire_analyze. To follow a company, technology, person or theme over weeks and get a synthesized view of its trend and implications (e.g. 「追踪英伟达」「帮我盯着固态电池」), use newswire_track. Add or remove sources with newswire_source_upsert / newswire_source_remove after trying them with newswire_source_test. Fetching tries browse first and falls back per source, recording error_kind and hint. Cite the outlet and data time for every news item (time_confidence=fetched means the time is approximated by the fetch time); mark financial content as not investment advice.",
      interpolate: false,
    }));

    ctx.logger.info("dsh-newswire: engine=" + p.engine + " data=" + p.data + " window=" + cfg.windowHours + "h browse=" + (cfg.browseBin || "auto") + " agent-reach=" + (cfg.agentReachBin || "auto"));

    return () => {
      for (let i = disposers.length - 1; i >= 0; i -= 1) {
        const dispose = disposers[i];
        if (typeof dispose !== "function") continue;
        try {
          const result = dispose();
          if (result !== undefined && result !== null && typeof result.then === "function") result.then(() => {}, () => {});
        } catch {
          // 单个 disposer 失败不影响其它注册项撤除
        }
      }
    };
  }, "dsh-newswire: routes, tools, prompt section");
}
