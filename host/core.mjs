/**
 * 插件入口用到的模块级工具：默认设置与路径、读写源配置、引擎子进程、源的校验与规范化、定时任务的指令、面板响应的小函数。
 * 都不依赖某一次 apply() 的状态；路由（routes.mjs）、工具（tools.mjs）和入口（index.js）共用。
 */
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { continuitySummary, countsByCategory, eventRows, failureRows, keywords, latestRun, openIfExists, sinceIso, sourceHealth } from "../engine/query.mjs";
import { cleanExtract } from "./recipe.mjs";
import { loadConfig, loadTaxonomyFile, readJson } from "../engine/config.mjs";
import { adapterIds } from "../engine/adapters/index.mjs";
import { CHANNELS } from "../engine/constants.mjs";

export // 插件根目录（本文件在 host/ 下）
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULTS = {
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
  cycleBudgetMs: 540000,
};

export const COLLECT_BYTES = 1048576;
export const GRACE_MS = 5000;
export const EXCERPT_CHARS = 1400;
export const TEST_TIMEOUT_MS = 180000;
/** 定时任务投递给会话的指令：Agent 只调一个工具并原样转述，控制 token。 */
export const SCHEDULE_TITLE = "新闻要闻 · dsh-newswire";
export const SCHEDULE_CRON = "0 7-21/2 * * *";
export const SCHEDULE_TZ = "Asia/Shanghai";
/** 主题包的定时默认值：标题、cron、时区（来自 sources.json 的 packs.<包>.schedule，核心包沿用原标题）。 */
export function packSchedule(p, pack) {
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

export const DAILY_CRON = "30 21 * * *";
// 宿主 run_code 默认只等 2 分钟、最多 10 分钟；这两个工具会在 9 分钟内返回
export const SLOW_HINT = "这一步通常要几分钟：如果通过 run_code 调用，把 timeoutMs 设为 600000。";
export function dailyPrompt(pack) {
  return "调用工具 newswire_daily（参数 pack=\"" + pack + "\"）。" + SLOW_HINT + "把返回结果里 message 字段的文本原样作为你的回复：不要改写、不要补充、不要调用其他工具。工具报错时只回复一行错误原因。";
}
export function schedulePrompt(pack) {
  return "调用工具 newswire_cycle（参数 pack=\"" + pack + "\"）。" + SLOW_HINT + "把返回结果里 message 字段的文本原样作为你的回复：不要改写、不要补充、不要调用其他工具。message 为空时不要回复任何文字，直接结束。工具报错时只回复一行错误原因。";
}
// 「写完再推」：本轮版面最多等这么久；过了就按已有的最新版面推
export const PENDING_MAX_MS = 45 * 60000;
export const CRED_TEXT = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };
export const CYCLE_WAIT_MS = 15 * 60000;
export const DISCLAIMER = "来源与数据时间已在每条行内标注；标题/摘要来自列表页或 feed，未逐条核原文；热度信号为源头原值；财经内容非投资建议。";

// ------------------------------------------------------------------ 配置
export function liveValue(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

export function strSetting(raw, key) {
  const v = liveValue(raw[key]);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULTS[key];
}

export function numSetting(raw, key, min, max) {
  const v = Number(liveValue(raw[key]));
  if (!Number.isFinite(v)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function settingsFrom(config) {
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
    cycleBudgetMs: numSetting(raw, "cycleBudgetMs", 120000, 3600000),
  };
}

export function pathsOf(cfg) {
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
export async function ensureData(p) {
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

export async function readConfigSources(p) {
  const text = await readFile(p.cfgFile, "utf8");
  return { text, data: JSON.parse(text) };
}

// 同一个文件的写入排队，临时文件名各不相同：并发写同一个文件时不会互相改名失败
export const writeQueues = new Map();
export let tmpSeq = 0;
export function writeFileAtomic(file, text) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmpFile = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      await writeFile(tmpFile, text);
      await rename(tmpFile, file);
    } catch (err) {
      await rm(tmpFile, { force: true }).catch(() => {});
      throw err;
    }
  });
  writeQueues.set(file, next);
  next.catch(() => {}).then(() => { if (writeQueues.get(file) === next) writeQueues.delete(file); });
  return next;
}

export async function writeConfigSources(p, data) {
  await writeFileAtomic(p.cfgFile, JSON.stringify(data, null, 2) + "\n");
}

export function withDb(p, fn) {
  const db = openIfExists(p.db);
  try {
    return fn(db);
  } finally {
    if (db) db.close();
  }
}

// ------------------------------------------------------------------ 汇总快照
export async function findDigest(outDir) {
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

export async function snapshotOf(cfg, p) {
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
export function tailOf(parts, maxChars) {
  const text = parts.filter((x) => typeof x === "string" && x !== "").join("\n").replace(/\s+\n/g, (m) => m.trimEnd() + "\n");
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - maxChars);
}

export function runIdFrom(text) {
  const m = /(?:run|web|tool)-[0-9]{12,14}-[0-9a-z-]{3,14}/.exec(String(text || ""));
  return m ? m[0] : null;
}

export async function runEngine(ctx, cfg, p, flags, timeoutMs) {
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

export function taxFlags(p) { return existsSync(p.taxFile) ? ["--taxonomy", p.taxFile] : []; }

export function roundFlags(cfg) { return ["--body-budget", String(cfg.bodyBudget), "--raw-retention-days", String(cfg.rawRetentionDays)]; }

export function binFlags(cfg, session) {
  const out = ["--browse-session", session || cfg.browseSession];
  if (cfg.browseBin) out.push("--browse-bin", cfg.browseBin);
  if (cfg.agentReachBin) out.push("--agent-reach-bin", cfg.agentReachBin);
  if (cfg.mcporterBin) out.push("--mcporter-bin", cfg.mcporterBin);
  return out;
}

export function runFlags(p, cfg, args) {
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

export function cycleFlags(p, cfg, args, runId) {
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

export function engineJson(stdout) {
  const line = String(stdout || "").split("\n").reverse().find((l) => l.startsWith("NEWSWIRE_JSON "));
  if (!line) return null;
  try { return JSON.parse(line.slice("NEWSWIRE_JSON ".length)); } catch { return null; }
}

/** 工具返回值转成宿主收的无损 JSON：去掉 undefined，NaN/Infinity 变 null，-0 变 0，Date 变字符串。 */
export function losslessJson(v) {
  if (v === undefined) return null;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? (Number.isFinite(x) ? (Object.is(x, -0) ? 0 : x) : null) : typeof x === "bigint" ? String(x) : x)));
}

export function hhmmShanghai() { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()); }

/** 页面全文快照（模型读页面用）：链接就地标号，时间标出。 */
export async function pageRead(ctx, cfg, p, url, waitFor) {
  const res = await runEngine(ctx, cfg, p, ["--mode", "read", "--config", p.cfgFile, "--url", url, ...(waitFor ? ["--wait-for", waitFor] : []), ...binFlags(cfg, "newswire-read")], 150000);
  return engineJson(res.stdout) || { ok: false, error: "engine_" + res.stage };
}

/** 页面结构概要（给模型学解析规则）：用试抓的 browse 会话打开页面，返回骨架。 */
export async function pageOutline(ctx, cfg, p, url) {
  const res = await runEngine(ctx, cfg, p, ["--mode", "outline", "--config", p.cfgFile, "--url", url, ...binFlags(cfg, "newswire-test")], 150000);
  return engineJson(res.stdout) || { ok: false, error: "engine_" + res.stage };
}

/** 试抓：只抓不入库，用独立 browse 会话，避免和正在跑的一轮抢同一个标签页。 */
export async function testSource(ctx, cfg, p, args) {
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
export function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function strOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export const TYPES = ["rss", "html_index", "cls_api", "json_api"];
export const TIERS = ["primary", "secondary", "community"];
export const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function regexOk(pattern) {
  if (pattern === null || pattern === undefined || pattern === "") return true;
  if (typeof pattern !== "string") return false;
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

export function validateOne(s, at, problems) {
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
  if (s.tier !== undefined && s.tier !== null && s.tier !== "" && TIERS.indexOf(s.tier) < 0) problems.push(at + " tier 只能是 primary/secondary/community");
  for (const k of ["group", "pack", "profile"]) if (s[k] !== undefined && s[k] !== null && s[k] !== "" && (typeof s[k] !== "string" || !ID_RE.test(s[k]))) problems.push(at + " " + k + " 需为 [a-z0-9_-] 标识");
  if (s.region !== undefined && s.region !== null && (typeof s.region !== "string" || s.region.length > 8)) problems.push(at + " region 需为不超过 8 字符的地区码（如 CN/US/UK/INTL）");
  if (!regexOk(s.url_include) || !regexOk(s.url_exclude)) problems.push(at + " url_include/url_exclude 不是合法正则");
  if (s.continuity !== undefined && s.continuity !== null && s.continuity !== "" && ["stream", "snapshot"].indexOf(s.continuity) < 0) problems.push(at + " continuity 只能是 stream（按时间滚动，判断衔接）或 snapshot（首页推荐，不判断）");
  if (s.paging !== undefined && s.paging !== null) {
    const pg = s.paging;
    if (typeof pg !== "object" || ["param", "cursor", "id_walk", "before", "native"].indexOf(pg.mode) < 0) problems.push(at + " paging.mode 只能是 param/cursor/id_walk/before/native");
    else if (pg.mode === "before" && (!pg.id_pattern || !regexOk(pg.id_pattern))) problems.push(at + " paging before 需要合法的 id_pattern（从链接里取消息 id）");
    else if (pg.mode === "id_walk" && (typeof pg.template !== "string" || pg.template.indexOf("{id}") < 0 || !regexOk(pg.id_pattern) || !pg.id_pattern)) problems.push(at + " paging id_walk 需要含 {id} 的 template 与合法的 id_pattern");
  }
  if (s.backfill !== undefined && typeof s.backfill !== "boolean") problems.push(at + " backfill 需为布尔");
  if (s.body !== undefined && s.body !== null && ["fetch", "list", "none"].indexOf(s.body) < 0) problems.push(at + " body 只能是 fetch / list / none");
  if (s.enabled !== undefined && typeof s.enabled !== "boolean") problems.push(at + " enabled 需为布尔");
  if (s.extract !== undefined && s.extract !== null && !cleanExtract(s.extract)) problems.push(at + " extract 需为 { item, link?, title?, time?, summary?, wait_for? } 形式的 CSS 选择器");
}

export function validateSources(body, opts) {
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

export const STR_FIELDS = ["id", "name", "category", "region", "lang", "type", "adapter", "url", "note", "category_src", "url_include", "url_exclude", "tier", "group", "pack", "profile", "removed_at", "wait_for"];

/** 只保留认识的字段并规范化（防止面板把健康度之类的派生字段写回配置）。 */
export function normalizeSource(s) {
  const out = {};
  for (const key of STR_FIELDS) {
    if (s[key] !== undefined && s[key] !== null && s[key] !== "") out[key] = typeof s[key] === "string" ? s[key].trim() : s[key];
  }
  if (Array.isArray(s.channels) && s.channels.length) out.channels = s.channels.slice();
  if (s.json !== undefined && s.json !== null && typeof s.json === "object") out.json = s.json;
  if (s.signals !== undefined && s.signals !== null && typeof s.signals === "object") out.signals = s.signals;
  if (s.paging !== undefined && s.paging !== null && typeof s.paging === "object") out.paging = s.paging;
  if (s.continuity === "stream" || s.continuity === "snapshot") out.continuity = s.continuity;
  if (s.backfill === false || s.backfill === true) out.backfill = s.backfill;
  if (s.min_points !== undefined) out.min_points = clampNum(s.min_points, 0, 5000, 100);
  if (s.comment_items !== undefined) out.comment_items = clampNum(s.comment_items, 0, 30, 8);
  if (s.min_stars_today !== undefined) out.min_stars_today = clampNum(s.min_stars_today, 0, 100000, 100);
  if (s.body === "list" || s.body === "none") out.body = s.body;
  out.enabled = s.enabled !== false;
  if (s.max_items !== undefined) out.max_items = clampNum(s.max_items, 1, 300, 20);
  if (s.timeout_ms !== undefined) out.timeout_ms = clampNum(s.timeout_ms, 5000, 180000, 30000);
  if (s.pages !== undefined) out.pages = clampNum(s.pages, 1, 20, 3);
  if (s.weight !== undefined && s.weight !== null && s.weight !== "") out.weight = Math.round(Math.min(1, Math.max(0, Number(s.weight))) * 100) / 100;
  if (s.paywall === true) out.paywall = true;
  if (s.trial === true) out.trial = true;
  const ex = cleanExtract(s.extract);
  if (ex) out.extract = ex;
  return out;
}

export function withSources(doc, sources) {
  const categories = Array.isArray(doc.categories) ? doc.categories.slice() : [];
  for (const s of sources) if (typeof s.category === "string" && categories.indexOf(s.category) < 0) categories.push(s.category);
  return Object.assign({}, doc, { categories, sources });
}

export async function sourcesDocOf(p, cfg) {
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

export function nowIsoUtc() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

export async function upsertSourceInConfig(p, input) {
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

/**
 * 面板「添加数据源」：只填名称和地址，其余按地址推断——id 取域名，看起来像 feed 的按 RSS、否则按新闻列表页；
 * 新加的源先「试用」（只帮别家印证，不单独上版或推送），攒够数据后在成绩单里决定开不开。
 */
/** Telegram 公开频道：t.me/<名>、t.me/s/<名>、t.me/<名>/123、telegram.me/<名>、@<名> → 频道名；邀请链接（t.me/+…、joinchat）不是公开频道，返回 null。 */
export function telegramChannel(raw) {
  const s = String(raw || "").trim();
  const at = s.match(/^@([A-Za-z][A-Za-z0-9_]{3,31})$/);
  if (at) return at[1];
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#]|$)/i);
  return m && !/^(joinchat|addstickers|share|proxy|socks|iv)$/i.test(m[1]) ? m[1] : null;
}

export function draftSource(input, existing) {
  // Telegram 频道：统一成网页预览地址，用 telegram 适配器，按消息 id 往前翻补缺口
  const tg = telegramChannel(input.url);
  if (tg) {
    const ids = new Set((existing || []).map((x) => x.id));
    const base = ("tg_" + tg.toLowerCase().replace(/[^a-z0-9_]+/g, "_")).slice(0, 37);
    let id = base;
    for (let n = 2; ids.has(id); n++) id = base + "_" + n;
    const pack = input.pack === "study_abroad" ? "study_abroad" : "core";
    return {
      id, name: String(input.name || "Telegram·" + tg).trim().slice(0, 80), url: "https://t.me/s/" + tg,
      type: "html_index", adapter: "telegram",
      category: String(input.category || (pack === "study_abroad" ? "留学与签证" : "国际宏观")).slice(0, 40),
      region: "INTL", pack, channels: ["http", "browse"], max_items: 60, enabled: true, trial: true,
      continuity: "stream", paging: { mode: "before", param: "before", id_pattern: "t\\.me/[A-Za-z0-9_]+/(\\d+)", max_pages: 3 }, body: "list",
    };
  }
  // 只填了域名（x.com、www.stcn.com/kx）：补上 https://
  const url0 = String(input.url || "").trim();
  const url = /^https?:\/\//i.test(url0) || !/^[\w-]+(\.[\w-]+)+(\/|$)/.test(url0) ? url0 : "https://" + url0;
  let host = "", segs = [];
  try { const u = new URL(url); host = u.hostname.toLowerCase(); segs = u.pathname.split("/").map((x) => x.replace(/\.[a-z]+$/i, "").toLowerCase()).filter((x) => /^[a-z][a-z0-9-]{1,20}$/.test(x) && !/^(news|rss|feeds?|atom|xml|index|list|en|zh|cn|home|channel|api|v\d)$/.test(x)); } catch { host = ""; }
  const bare = host.replace(/^(www|feeds?|rss|m|news|wap|en|cn)\./, "");
  const core = bare.replace(/\.(com|net|org|gov|edu|co|ac|io|info)?\.?(cn|uk|hk|tw|jp|sg|de|fr|au|ca|us)?$/i, "").split(".").pop() || "source";
  // 主域名太短（x.com 的 x）时用完整域名：x_com
  const head = core.length >= 2 ? core : bare.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = [head].concat(segs.slice(0, 1)).join("_").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "source";
  const ids = new Set((existing || []).map((x) => x.id));
  let id = /^[a-z0-9]/.test(base) && base.length >= 2 ? base : "s_" + base;
  for (let n = 2; ids.has(id); n++) id = base.slice(0, 30) + "_" + n;
  const feed = /(\brss\b|feed|atom|\.xml)(\b|$)/i.test(url);
  const pack = input.pack === "study_abroad" ? "study_abroad" : "core";
  // 地区：先看域名后缀；通用域名（.com 等）再看试抓到的标题是不是中文
  const tld = (host.match(/\.([a-z]{2})$/) || [])[1];
  const region = { cn: "CN", uk: "UK", hk: "HK", tw: "TW", jp: "JP", sg: "SG", de: "DE", fr: "FR", au: "AU", ca: "CA", us: "US" }[tld] || (input.cjk === true ? "CN" : "INTL");
  const cnLike = region === "CN" || region === "HK" || region === "TW";
  return {
    id, name: String(input.name || bare || id).trim().slice(0, 80), url,
    type: input.type === "rss" || input.type === "html_index" ? input.type : feed ? "rss" : "html_index",
    category: String(input.category || (pack === "study_abroad" ? "留学与签证" : cnLike ? "国内财经与公告" : "国际宏观")).slice(0, 40),
    region, pack, channels: ["browse", "http", "agent_reach"], max_items: 20, enabled: true, trial: true,
    // 模型学会的解析规则：只有真实浏览器里才能照着选择器取，通道只留 browse
    ...(cleanExtract(input.extract) ? { extract: cleanExtract(input.extract), type: "html_index", channels: ["browse"] } : {}),
  };
}

// ------------------------------------------------------------------ 渲染
export function signalText(sig) {
  if (!sig) return "";
  const parts = [];
  if (sig.hot && sig.hot.length) parts.push("🔥" + sig.hot.join("/"));
  if (sig.level) parts.push("级别" + sig.level);
  if (sig.views != null) parts.push("阅读" + sig.views);
  if (sig.comments) parts.push("评论" + sig.comments);
  if (sig.likes) parts.push("赞" + sig.likes);
  return parts.length ? "〔" + parts.join(" ") + "〕" : "";
}

export function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), { status: status ?? 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export async function bodyOf(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

export const SOURCE_PROPS = {
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
  tier: { type: "string", enum: TIERS, description: "primary (first-hand, wire, official), secondary (reposts, aggregators), or community (discussion sites such as Hacker News; never counts as an independent outlet)." },
  profile: { type: "string", description: "Profile for this source's stories: wire, tech-frontier, tech-deep (tech blogs), community (discussion sites), oss (open-source projects), or one defined under dataDir/profiles." },
  min_points: { type: "number", description: "Hacker News / Reddit adapters: skip posts below this score (default 100 / 50)." },
  comment_items: { type: "number", description: "Hacker News / Reddit adapters: read the discussion page of this many top posts for comments (default 8 / 6, 0 = none)." },
  min_stars_today: { type: "number", description: "GitHub Trending adapter: skip repositories with fewer new stars today (default 100)." },
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
  paging: { type: "object", description: "How to recover a gap: {mode:param,param,start,max_pages} | {mode:cursor,param,next,max_pages} | {mode:id_walk,template,id_pattern,max_steps} | {mode:before,param,id_pattern,max_pages} (pages back with ?before=<smallest id on the page>, e.g. Telegram channels) | {mode:native}." },
  body: { type: "string", enum: ["fetch", "list", "none"], description: "Article bodies: fetch = fetch the page for top events (default); list = the list text is already the full body (news flashes); none = never fetch." },
  backfill: { type: "boolean", description: "Fall back to an Exa search (a paid API) when paging cannot close a gap; off unless set to true." },
  wait_for: { type: "string", description: "CSS selector browse waits for before reading the page (slow pages; up to 15 seconds)." },
  json: { type: "object", description: "json_api field mapping: list/title/link/time/summary/signals{views,comments,likes,shares,level,…}." },
};

// ------------------------------------------------------------------ 插件入口
