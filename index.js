/**
 * dsh-newswire — 新闻抓取插件（Host 半边，plain ESM JS，零构建）。
 *
 * 这个文件：Config，以及 apply() 里一次运行的状态与流程（模型与排队、编版面、推送与插件时钟、追踪、详细报道）。
 * 模块级的工具函数在 host/core.mjs，面板路由在 host/routes.mjs，模型工具与 systemPrompt 段落在 host/tools.mjs；
 * 后两者经 app 对象拿到这里的状态和函数。
 * 抓取与入库在 engine/（子进程跑 engine/run.mjs，崩了不拖垮宿主）；读查询统一走 engine/query.mjs。
 * 产物（sources.json / news.sqlite / raw / out）写到 config.dataDir，与包目录解耦。任何密钥都不进 Config。
 */

import { makeDeepRead, modelSplitDigests } from "./host/deepread.mjs";
import { translateTitles } from "./host/translate.mjs";
import { DEPTHS, depthOf, depthParams, makeGate, recordCall } from "./host/runtime.mjs";
import { detailMaterials, latestDetail, saveDetail, writeDetail } from "./host/detail.mjs";
import { analysisMaterials, analyzeStory, autoAnalyzeTargets, saveAnalysis, searchQuery, webMaterials } from "./host/analysis.mjs";
import { linkAll, repairThemeLinks, synthTargets, synthesize } from "./host/tracking.mjs";
import { PRIORITY, createQueue } from "./host/queue.mjs";
import { prune } from "./host/retention.mjs";
import { cronMatches, minuteKey, nextCron, parseCron } from "./host/clock.mjs";
import { REPLY_HELP, composeDetail, composeExpand, numberPicks, parseReply, storyOfNumber, trackedIn } from "./host/reply.mjs";
import { applyDailyCap, loadPush, noteInterest, rulesFor, sectionPenalties } from "./host/push.mjs";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { openIfExists, sinceIso } from "./engine/query.mjs";
import { readLock } from "./engine/lock.mjs";
import { createModel } from "./host/model.mjs";
import { learnRecipe } from "./host/recipe.mjs";
import { readSource, readTargets } from "./host/modelread.mjs";
import { bodiesFor, composeEditionMessage, editionById, editionPicks, inFocus, latestEdition, llmEdition, loadLayout, notesFromEdition, orderPicks, restGroups, tierPicks, profilesOf, reassemble, recordEditionPushes, ruleEdition, saveEdition, scrubStory, storyDetail, storyProfile, tickerBoard, updateEditionContent } from "./host/edition.mjs";
import { promptOf } from "./host/profiles.mjs";
import { buildDaily, saveDaily, todayBj } from "./host/daily.mjs";
import { DEFAULT_RULES, recordPushes } from "./engine/pipeline/select.mjs";
import { loadFollows, updateFollows } from "./host/follows.mjs";
import { UpdateChecker, githubToken } from "./host/update.mjs";
import { findBin } from "./engine/bins.mjs";
import { readJson } from "./engine/config.mjs";
import { DEFAULTS, PENDING_MAX_MS, SCHEDULE_TZ, binFlags, cycleFlags, engineJson, ensureData, hhmmShanghai, losslessJson, nowIsoUtc, packSchedule, pageOutline, pageRead, pathsOf, readConfigSources, runEngine, runFlags, schedulePrompt, settingsFrom, taxFlags, testSource, upsertSourceInConfig, withDb, writeFileAtomic } from "./host/core.mjs";
import { registerRoutes } from "./host/routes.mjs";
import { registerTools } from "./host/tools.mjs";

// 测试和别的模块从入口引用的几个函数
export { draftSource, losslessJson, telegramChannel, validateSources, writeFileAtomic } from "./host/core.mjs";

export const name = "dsh-newswire";

export const inject = ["connection", "tools", "subprocess", "systemPrompt"];

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
  cycleBudgetMs: z.number().min(120000).max(3600000).step(10000).default(DEFAULTS.cycleBudgetMs),
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
    cycleBudgetMs: "Longest a scheduled push round may take, in milliseconds. The harness stops a tool call after 10 minutes, so the default leaves a minute of margin. With a slow model the edition is prepared ahead of each scheduled push, and a round that runs out of time sends the edition the model has finished so far.",
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
    cycleBudgetMs: "定时推送每轮最多用多久（毫秒）。宿主对一次工具调用最多等 10 分钟，默认留 1 分钟余量。模型慢时会在每次定时推送前提前编排；到点时间不够，就发模型已经写好的版面。",
  },
});

/** 定时任务投递给会话的指令：Agent 只调一个工具并原样转述，控制 token。 */

/** 主题包的定时默认值：标题、cron、时区（来自 sources.json 的 packs.<包>.schedule，核心包沿用原标题）。 */

// 宿主 run_code 默认只等 2 分钟、最多 10 分钟；这两个工具会在 9 分钟内返回

// 「写完再推」：本轮版面最多等这么久；过了就按已有的最新版面推

// ------------------------------------------------------------------ 配置

/** 建目录；首次复制种子配置；旧版配置自动升级（补新源与新字段，原文件留 .bak）。 */

// 同一个文件的写入排队，临时文件名各不相同：并发写同一个文件时不会互相改名失败

// ------------------------------------------------------------------ 汇总快照

// ------------------------------------------------------------------ 引擎子进程

/** 工具返回值转成宿主收的无损 JSON：去掉 undefined，NaN/Infinity 变 null，-0 变 0，Date 变字符串。 */

/** 页面全文快照（模型读页面用）：链接就地标号，时间标出。 */

/** 页面结构概要（给模型学解析规则）：用试抓的 browse 会话打开页面，返回骨架。 */

/** 试抓：只抓不入库，用独立 browse 会话，避免和正在跑的一轮抢同一个标签页。 */

// ------------------------------------------------------------------ 数据源校验与写回

/** 只保留认识的字段并规范化（防止面板把健康度之类的派生字段写回配置）。 */

/**
 * 面板「添加数据源」：只填名称和地址，其余按地址推断——id 取域名，看起来像 feed 的按 RSS、否则按新闻列表页；
 * 新加的源先「试用」（只帮别家印证，不单独上版或推送），攒够数据后在成绩单里决定开不开。
 */
/** Telegram 公开频道：t.me/<名>、t.me/s/<名>、t.me/<名>/123、telegram.me/<名>、@<名> → 频道名；邀请链接（t.me/+…、joinchat）不是公开频道，返回 null。 */

// ------------------------------------------------------------------ 渲染

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
  // 读-改-写排队：同时改设置时不丢改动
  let prefsQ = Promise.resolve();
  function savePrefs(patch) {
    const run = prefsQ.catch(() => {}).then(async () => {
      const next = Object.assign({}, prefs(), patch, { updated_at: new Date().toISOString() });
      await mkdir(path.dirname(p.modelPrefs), { recursive: true });
      await writeFileAtomic(p.modelPrefs, JSON.stringify(next, null, 2) + "\n");
    });
    prefsQ = run;
    return run;
  }
  const modeNow = () => (prefs().mode === "llm" || prefs().mode === "economy" ? prefs().mode : cfg.modelMode);
  // 宿主的模型服务与默认模型（可选）：LLM 模式下有它们才调用模型；没有就退回程序编排
  // 模型调用统一排队：读者点的（详细报道、影响分析、问答）排在版面和后台任务前面；名额数是实测的并发数（没测过先给 2，让第一次能并行试）
  const queue = createQueue({ slots: () => Number(prefs().concurrency) || 2 });
  const model = createModel({
    slot: (step) => queue.acquire(step),
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
    // 桥接插件（掌上指挥台）提供的直接推送：有就用，没有照旧经定时任务里的模型转发；两边互不依赖
    ctx.inject(["phonePush"], (scope) => {
      optional.phonePush = scope.phonePush;
      optional.phonePushSeen = true;
      scope.effect(() => () => { delete optional.phonePush; }, "dsh-newswire: phonePush service");
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
    let pf = null;
    try {
      await ensureData(p);
      pf = await modelReadPrefetch({ packs: args.packs, sources: args.sources, runId, budgetMs: args.read_budget_ms || 4 * 60000 });
      return await runEngine(ctx, cfg, p, runFlags(p, cfg, Object.assign({}, args, { run_id: runId })).concat(pf ? ["--prefetched", pf.dir] : []));
    } finally {
      inflight.current = null;
      if (pf) await rm(pf.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 「不限」档：网页类的源先由模型读页面（程序核对过的条目存成 <dir>/<源 id>.json，引擎照常入库）。
   * 有时间预算：读不完的源、读失败的源照常走程序解析。不是「不限」档、没有可用模型时返回 null。
   */
  async function modelReadPrefetch(o) {
    if (!llmReady() || !depthParams(prefs()).modelRead || modelState.busy) return null;
    const conf = await readConfigSources(p);
    const targets = readTargets(conf.data.sources || [], { packs: o.packs, sources: o.sources });
    if (!targets.length || !(o.budgetMs > 0)) return null;
    const dir = path.join(p.tmp, "prefetch-" + o.runId);
    await mkdir(dir, { recursive: true });
    const t0 = Date.now();
    const deadline = t0 + o.budgetMs;
    const rs = { at: new Date().toISOString(), run_id: o.runId, targets: targets.length, read: 0, ok: 0, items: 0, dropped: 0, failed: [], skipped: 0, ms: 0, model: model.label() };
    modelState.busy = "read";
    try {
      for (const src of targets) {
        // 估一个源要多久（已读源的平均耗时，至少 40 秒）：来不及就留给程序
        const per = rs.read ? Math.max(40000, (Date.now() - t0) / rs.read) : 40000;
        if (Date.now() + per > deadline) { rs.skipped = targets.length - rs.read; break; }
        rs.read++;
        try {
          const r = await queue.run({ kind: "read", label: "读页面：" + src.id, priority: PRIORITY.background }, () => readSource({ read: (u, w) => pageRead(ctx, cfg, p, u, w), model }, src, { timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) }));
          if (r.ok) { rs.ok++; rs.items += r.items.length; rs.dropped += r.dropped || 0; await writeFile(path.join(dir, src.id + ".json"), JSON.stringify({ items: r.items, dropped: r.dropped || 0, why: r.why || {}, ms: r.ms, model: model.label() })); }
          else rs.failed.push(src.id + ":" + (r.error || "empty"));
        } catch (err) { rs.failed.push(src.id + ":" + errText(err).slice(0, 60)); }
      }
    } finally {
      modelState.busy = null;
      rs.ms = Date.now() - t0;
      modelState.read = rs;
    }
    return { dir, stat: rs };
  }

  const errText = (err) => String(err && err.message ? err.message : err).slice(0, 200);

  function defaultSelection() {
    try { const d = optional.defaultModel && optional.defaultModel.currentSelection(); return d && d.provider && d.model ? { provider: d.provider, model: d.model } : null; } catch { return null; }
  }

  function modelView() {
    const pr = prefs();
    return {
      mode: modeNow(), mode_from: pr.mode ? "panel" : "settings", service: Boolean(optional.llm), available: model.available(), ready: llmReady(), label: model.label(),
      pinned: pr.provider && pr.model ? { provider: pr.provider, model: pr.model } : null, default: defaultSelection(), busy: modelState.busy, queue: queue.view(), last: modelState.last, read: modelState.read || null,
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
  function makeEdition(o) {
    const pack = o.pack && !String(o.pack).includes(",") ? String(o.pack) : "all";
    return queue.run({ kind: "edition", label: "版面" + (pack === "all" ? "" : "（" + pack + "）"), priority: Number.isInteger(o.priority) ? o.priority : PRIORITY.push }, () => makeEditionNow(o));
  }
  async function makeEditionNow(o) {
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
            concurrency: Number(prefs().concurrency) || 1, probe: !prefs().concurrency, onProbe: (r) => { void background(savePrefs({ concurrency: r.concurrency, probe: Object.assign({ at: new Date().toISOString() }, r) }), "save prefs"); } }));
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

  // 关注的读-改-写排队：几处同时改关注（比如一轮里几条主线同时挂上新故事线）时不丢改动、不撞文件
  let followsQ = Promise.resolve();
  function editFollows(fn) {
    const run = followsQ.catch(() => {}).then(async () => {
      const f = fn(loadFollows(p.follows));
      await mkdir(path.dirname(p.follows), { recursive: true });
      await writeFileAtomic(p.follows, JSON.stringify(f, null, 2) + "\n");
      reflowEdition(f);
      return f;
    });
    followsQ = run;
    return run;
  }
  /** 后台顺手做的事出错只记一笔，不能变成未处理的拒绝把宿主整个带崩。 */
  const background = (pr, what) => Promise.resolve(pr).catch((err) => { try { console.error(`[newswire] ${what} failed:`, errText(err)); } catch { /* ignore */ } });

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
  function makeDaily(o) { return queue.run({ kind: "daily", label: "日报", priority: PRIORITY.push }, () => makeDailyNow(o)); }
  async function makeDailyNow(o) {
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
  function runAnalysis(storyId, auto) { return queue.run({ kind: "analysis", label: "影响分析：" + storyTitle(storyId), priority: auto ? PRIORITY.background : PRIORITY.reader }, () => runAnalysisNow(storyId, auto)); }
  /** 故事线标题（排队显示用）。 */
  function storyTitle(storyId) { try { const r = withDb(p, (db) => (db ? db.prepare("SELECT title FROM stories WHERE story_id = ?").get(storyId) : null)); return r && r.title ? String(r.title).slice(0, 24) : String(storyId); } catch { return String(storyId); } }
  async function runAnalysisNow(storyId, auto) {
    const db = openIfExists(p.db);
    if (!db) throw new Error("no_db");
    try {
      const row = db.prepare("SELECT story_id, title, copy, section, labels, profile FROM stories WHERE story_id = ?").get(storyId);
      if (!row) throw new Error("not_found");
      let copy = null; try { copy = JSON.parse(row.copy || "null"); } catch { copy = null; }
      let labels = []; try { labels = JSON.parse(row.labels || "[]"); } catch { labels = []; }
      const lay = loadLayout(p.layoutFile, p.layoutSeed);
      const mats = analysisMaterials(db, storyId, bodiesFor);
      // 分析的侧重按故事线的读法（写稿时记下的；旧故事线没记的按版块与分类认）
      const reg = profilesOf(lay);
      const prof = row.profile && reg.byId.has(row.profile) ? reg.get(row.profile) : storyProfile(lay, { section: row.section, labels }, []);
      // 读法要联网的（search.analysis > 0）：用 browse 搜一次，搜索结果作背景材料；搜不到照常分析
      if (prof.search && prof.search.analysis > 0 && mats.length) {
        const q = searchQuery(row.title);
        if (q) {
          try {
            const res = await runEngine(ctx, cfg, p, ["--mode", "search", "--query", q, "--max", "5", ...binFlags(cfg, "newswire-search")], 90000);
            const j = engineJson(res.stdout);
            if (j && j.ok) mats.push(...webMaterials(j.results, 4));
          } catch { /* 搜不到不影响分析 */ }
        }
      }
      const a = await analyzeStory(model, { title: row.title, lead: copy && copy.lead, hint: promptOf(prof, "analysis") }, mats, { timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) });
      return saveAnalysis(db, storyId, a, { model: model.label(), auto });
    } finally { db.close(); }
  }
  /** 正在写的详细报道：故事线 id → { at, error }（写完删掉；失败留下错误，下次查看时告诉读者）。 */
  const detailJobs = new Map();
  /** 后台写详细报道（本地模型要几分钟，不让面板的请求一直挂着）；同一条已在写就不重复开。 */
  function startDetail(storyId, o) {
    const cur = detailJobs.get(storyId);
    // 已经在写：手机上要的也等这一篇，写完一并发过去
    if (cur && !cur.error) { if (o && o.notify) cur.notify = o.notify; return; }
    const job = { at: Date.now(), error: null, notify: (o && o.notify) || null };
    detailJobs.set(storyId, job);
    void runDetail(storyId).then((d) => {
      detailJobs.delete(storyId);
      // 手机上回复「N 详」要的：写完直接发过去
      if (job.notify) void background(sendDirect(composeDetail(job.notify.n, job.notify.title, d)), "detail to phone");
    }).catch((err) => {
      detailJobs.set(storyId, { at: Date.now(), error: errText(err) });
      if (job.notify) void background(sendDirect("第 " + job.notify.n + " 条的详细报道没写成（" + errText(err) + "），可以稍后再回复「" + job.notify.n + " 详」试一次。"), "detail to phone");
    });
  }

  /**
   * 手机上回复序号：「3」展开要点，「3 详」详细报道，「3 有用 / 没用」反馈，「3 追踪」关注进展。
   * 能直接发到手机时由插件自己发（返回 sent: true、message 为空，模型不用再转述）；不能时把 message 交回去由模型原样回复。
   */
  async function handleReply(text) {
    const r = parseReply(text);
    if (!r) return { ok: false, error: "not_a_reply", message: "没看懂这条回复。" + REPLY_HELP };
    const hit = withDb(p, (db) => (db ? storyOfNumber(db, r.n) : null));
    if (!hit) return finishReply({ ok: false, error: "no_such_number", n: r.n, message: "没找到第 " + r.n + " 条（序号每天从 1 重新编，只认推送过的）。" });
    const d = withDb(p, (db) => (db ? storyDetail(db, hit.story_id) : null));
    if (!d) return finishReply({ ok: false, error: "not_found", n: r.n, message: "第 " + r.n + " 条的故事线找不到了。" });
    const base = { ok: true, n: r.n, action: r.action, story_id: d.id, title: d.title };
    const note = (kind) => { try { withDb(p, (db) => { if (db) noteInterest(db, kind, d.id); }); } catch { /* 只是记录 */ } };
    if (r.action === "up" || r.action === "down") {
      const kind = r.action === "up" ? "push_up" : "push_down";
      withDb(p, (db) => {
        db.prepare("DELETE FROM feedback WHERE story_id = ? AND kind IN ('push_up', 'push_down')").run(d.id);
        db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (?,?,?,?)").run(nowIsoUtc(), kind, d.id, d.section || null);
      });
      const sec = taxonomyNames()[d.section] || d.section || "";
      return finishReply(Object.assign(base, { message: r.action === "up" ? "已记下：「" + d.title + "」有用。" : "已记下：「" + d.title + "」没用。" + (sec ? "「" + sec + "」这类没用的多了会自动少推。" : "") }));
    }
    if (r.action === "follow") {
      note("push_follow");
      await editFollows((f) => updateFollows(f, "follow", "story", d.id, d.title));
      return finishReply(Object.assign(base, { message: "已关注「" + d.title + "」：有进展会标 ★ 并优先推给你。" }));
    }
    if (r.action === "detail") {
      note("push_detail");
      const have = withDb(p, (db) => (db ? latestDetail(db, d.id) : null));
      if (have && !have.newer) return finishReply(Object.assign(base, { message: composeDetail(r.n, d.title, have) }));
      if (!(modeNow() === "llm" && llmReady())) return finishReply(Object.assign(base, { ok: false, error: "no_model", message: have ? composeDetail(r.n, d.title, have) : "详细报道要模型来写，现在没有可用的模型。先回复「" + r.n + "」看要点。" }));
      if (direct()) {
        startDetail(d.id, { notify: { n: r.n, title: d.title } });
        return finishReply(Object.assign(base, { running: true, message: "正在写第 " + r.n + " 条「" + d.title + "」的详细报道，写好直接发给你（本地模型约 2–4 分钟）。" }));
      }
      startDetail(d.id);
      return finishReply(Object.assign(base, { running: true, message: "正在写第 " + r.n + " 条「" + d.title + "」的详细报道，约 2–4 分钟。写好后再回复「" + r.n + " 详」来取。" }));
    }
    note("push_open");
    return finishReply(Object.assign(base, { message: composeExpand(r.n, d) }));
  }
  async function finishReply(out) {
    if (out.message && direct() && (await sendDirect(out.message))) return Object.assign(out, { sent: true, message: "", note: "已直接发到手机，不要再回复任何文字" });
    return Object.assign(out, { sent: false });
  }
  /** 详细报道：模型读这条故事线的全部报道写一篇分块的长稿，逐句核对，存档并返回。 */
  function runDetail(storyId) { return queue.run({ kind: "detail", label: "详细报道：" + storyTitle(storyId), priority: PRIORITY.reader }, () => runDetailNow(storyId)); }
  async function runDetailNow(storyId) {
    const db = openIfExists(p.db);
    if (!db) throw new Error("no_db");
    try {
      const row = db.prepare("SELECT story_id, title, copy FROM stories WHERE story_id = ?").get(storyId);
      if (!row) throw new Error("not_found");
      let copy = null; try { copy = JSON.parse(row.copy || "null"); } catch { copy = null; }
      const mats = detailMaterials(db, storyId, bodiesFor);
      const d = await writeDetail(model, { title: row.title, lead: copy && copy.lead }, mats, { style: loadLayout(p.layoutFile, p.layoutSeed).style, timeoutMs: Math.max(cfg.modelTimeoutMs, 300000) });
      return saveDetail(db, storyId, d, { model: model.label() });
    } finally { db.close(); }
  }
  /** 追踪对象的关注项：公司 / 技术 / 人物按别名关注（报道进「我的关注」、推送门槛更低），主线按挂上的故事线关注。 */
  async function syncTrackerFollows(db, trackerId, storyIds) {
    const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(trackerId);
    if (!t) return;
    await editFollows((f) => {
      if (t.kind === "theme") for (const sid of storyIds || []) f = updateFollows(f, "follow", "story", sid, t.name, "tracker:" + t.id);
      else f = updateFollows(f, "follow", "keyword", JSON.parse(t.aliases || "[]").join("|") || t.name, t.name);
      return f;
    });
  }

  /** 删掉追踪对象时撤掉它加的关注（别名关键词 / 主线的故事线）。 */
  async function dropTrackerFollows(t) {
    if (!t) return;
    await editFollows((f) => {
      if (t.kind === "theme") for (const sid of t.stories || []) f = updateFollows(f, "unfollow", "story", sid);
      else f = updateFollows(f, "unfollow", "keyword", (t.aliases || []).join("|") || t.name);
      return f;
    });
  }

  /** 版面出来后的后台工作（不挡推送）：头版里重要的报道分析影响；追踪对象挂上新的故事线，新动态够多的重写综述。 */
  function autoAnalyze(ed) {
    // 挂故事线不调用模型，两种模式都做
    let linked = {};
    try { linked = withDb(p, (db) => (db ? linkAll(db, ed.themes || []) : {})) || {}; } catch { linked = {}; }
    for (const [tid, sids] of Object.entries(linked)) withDb(p, (db) => { if (db) { const t = db.prepare("SELECT kind FROM trackers WHERE id = ?").get(tid); if (t && t.kind === "theme") void background(syncTrackerFollows(db, tid, sids), "tracker follows"); } });
    if (!(modeNow() === "llm" && llmReady())) return;
    const dp = depthParams(prefs());
    // 这些后台工作不占「模型正忙」：它们的调用排在版面后面（队列按优先级），新一轮版面不用等它们；同时只跑一组
    setTimeout(async () => {
      if (autoWork.running) return;
      autoWork.running = true;
      try { await autoWorkNow(ed, dp); } finally { autoWork.running = false; }
    }, 0);
  }
  const autoWork = { running: false };
  async function autoWorkNow(ed, dp) {
    {
      let ids = [];
      try { ids = dp.autoAnalyze ? withDb(p, (db) => (db ? autoAnalyzeTargets(db, ed, { max: dp.autoAnalyze, isFocus: (s) => { const lay = loadLayout(p.layoutFile, p.layoutSeed); return Boolean(s && inFocus(lay.focus, [s.section].concat(s.labels || []))); } }) : [])) : []; } catch { ids = []; }
      for (const id of ids) {
        if (modelState.busy) break;
        try { await runAnalysis(id, true); } catch { /* 下一份版面再试 */ }
      }
      let ts = [];
      try { ts = withDb(p, (db) => (db ? synthTargets(db, dp.track || 0, { gapHours: dp.trackGapH }) : [])); } catch { ts = []; }
      for (const id of ts) {
        if (modelState.busy) break;
        try { await runSynthesis(id, true); } catch { /* 下一份版面再试 */ }
      }
      try { await repairRecipes(); } catch { /* 下一份版面再试 */ }
    }
  }

  /**
   * 解析失灵的源：最近两次抓取都解析出 0 条（多半是网站改版），均衡 / 深度档下让模型重新学解析规则，
   * 试抓验证过才写回配置。只管没有专用适配器的列表页源；一个源一天最多试一次，每次最多修一个。
   */
  async function repairRecipes() {
    if (!llmReady() || depthOf(prefs()) === "lean" || modelState.busy || busyWith()) return;
    const conf = await readConfigSources(p);
    const sources = (conf.data.sources || []).filter((x) => x.enabled !== false && !x.removed_at && !x.adapter && (x.type || "html_index") === "html_index" && (!x.channels || x.channels.includes("browse")));
    if (!sources.length) return;
    const broken = withDb(p, (db) => {
      if (!db) return [];
      const out = [];
      const q = db.prepare("SELECT run_id, MAX(ok) ok, MAX(CASE WHEN error LIKE '0 items parsed%' THEN 1 ELSE 0 END) zero FROM fetch_attempts WHERE source_id = ? GROUP BY run_id ORDER BY MAX(attempted_at) DESC LIMIT 2");
      for (const x of sources) { const rs = q.all(x.id); if (rs.length === 2 && rs.every((r) => !r.ok && r.zero)) out.push(x); }
      return out;
    }) || [];
    for (const src of broken) {
      const key = "recipe:" + src.id;
      const last = withDb(p, (db) => (db ? db.prepare("SELECT value FROM kv WHERE key = ?").get(key) : null));
      if (last && Date.now() - Date.parse(last.value) < 86400000) continue;
      const now = new Date().toISOString();
      withDb(p, (db) => { if (db) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, now, now.replace("T", " ").slice(0, 19)); });
      try {
        const r = await queue.run({ kind: "recipe", label: "修解析规则：" + src.id, priority: PRIORITY.idle }, () => learnRecipe({ outline: (u) => pageOutline(ctx, cfg, p, u), test: (s2) => testSource(ctx, cfg, p, { source: s2, max_items: 8 }), model }, src, { timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) }));
        if (r.ok) {
          await upsertSourceInConfig(p, { id: src.id, extract: r.extract, type: "html_index", channels: ["browse"], note: "解析规则由模型于 " + now.slice(0, 10) + " 自动更新（原来的解析连续两轮抓不到内容）" });
          ctx.logger?.info?.("dsh-newswire: 已为 " + src.id + " 重新学会解析规则");
        }
      } catch { /* 明天再试 */ }
      return;
    }
  }

  function runSynthesis(id, auto) {
    let name = String(id);
    try { const r = withDb(p, (db) => (db ? db.prepare("SELECT name FROM trackers WHERE id = ?").get(id) : null)); if (r && r.name) name = r.name; } catch { /* 用 id */ }
    return queue.run({ kind: "track", label: "追踪综述：" + name, priority: auto ? PRIORITY.idle : PRIORITY.reader }, () => runSynthesisNow(id));
  }
  async function runSynthesisNow(id) {
    const db = openIfExists(p.db);
    if (!db) throw new Error("no_db");
    try { return await synthesize(db, model, id, { model: model.label(), timeoutMs: Math.max(cfg.modelTimeoutMs, 300000) }); } finally { db.close(); }
  }

  function backgroundEdition(runId, pack) {
    if (modelState.busy) return;
    void background(makeEdition({ pack, runId, wantLlm: modeNow() === "llm", priority: PRIORITY.background }), "edition");
  }

  function taxonomyNames() {
    const names = {};
    try {
      for (const t of readJson(p.taxFile).labels || []) { names[t.id] = t.name; for (const c of t.children || []) names[c.id] = c.name; }
    } catch { /* 没有分类文件时用标签 id */ }
    return names;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 定时推送的一轮。宿主对一次工具调用最多等 10 分钟（run_code 的上限），所以整轮有预算（cycleBudgetMs）：
   * 抓取按剩余时间限时；版面在预算内编不完就不等了，发模型已经写好的那份（预编排的或边写边出的进度版），
   * 没写完的继续在后台写，下一轮再推。模型慢时 prewarmTick 会在定时推送前提前抓取和编排，到点只补增量。
   */
  async function runCycle(args) {
    const deadline = Date.now() + cfg.cycleBudgetMs;
    const left = () => deadline - Date.now();
    // 「写完再推」：到点只抓取、在后台编版面，写完后插件再触发一次同一个定时任务，那一次只推送
    const packKey = (args && args.pack) || "core";
    const deferring = loadPush(p.pushPrefs).timing === "when_ready" && !(args && args.dry_run === true);
    if (!(args && args.dry_run === true)) {
      // 待推送的（写完再推、手动抓取写完、面板上点「推送」）已备好：这一次只推送
      const pend = readPending(packKey);
      if (pend && pend.ready) return deliverPending(pend);
      if (deferring && pend && pend.source === "cycle" && Date.now() - Date.parse(pend.at) < PENDING_MAX_MS) return { ok: true, deferred: true, run_id: pend.run_id, message: "", note: "本轮版面还在写，写完自动推送" };
    }
    // 两个主题包的定时任务可能撞上，或预编排还在抓：等它结束，但给版面和发送留出时间
    while (inflight.current !== null && left() > 240000) await sleep(3000);
    if (inflight.current) return cycleFromLatest(args, "另一轮抓取（" + inflight.current + "）还没结束");
    const runId = newRunId("cycle");
    inflight.current = runId;
    try {
      await ensureData(p);
      // 两种模式都按版面推送（版面认得关注与屏蔽）：引擎只算规则候选、不记推送；版面编不出来时退回规则候选
      const wantLlm = modeNow() === "llm" && model.available();
      // 「不限」档：先让模型读网页类的源；给抓取、编排和发送留出时间（预编排已经读过一轮，这里只补到点前的变化）
      const pf = await modelReadPrefetch({ packs: args && args.pack, runId, budgetMs: Math.min(5 * 60000, left() - 4 * 60000) });
      let res;
      try {
        res = await runEngine(ctx, cfg, p, cycleFlags(p, cfg, Object.assign({}, args, { defer_push: !(args && args.dry_run === true) }), runId).concat(pf ? ["--prefetched", pf.dir] : []), Math.max(60000, Math.min(cfg.timeoutMs, left() - 120000)));
      } finally { if (pf) await rm(pf.dir, { recursive: true, force: true }).catch(() => {}); }
      const out = engineJson(res.stdout);
      if (out && out.run_id && deferring && out.parts) {
        const pend = { source: "cycle", pack: packKey, ed_pack: out.pack || (args && args.pack) || "all", run_id: out.run_id, at: new Date().toISOString(), parts: out.parts, rules: out.rules || null, lookback: out.lookback_hours || 6, want_llm: modeNow() === "llm" && model.available(), ready: false, edition_id: null };
        writePending(pend);
        void background(composeThenDeliver(pend), "deferred push");
        delete out.parts;
        return Object.assign(out, { deferred: true, message: "", note: "本轮已抓取，版面写完后推送" });
      }
      if (out && out.run_id) {
        const pack = out.pack || (args && args.pack) || "all";
        const fresh = (async () => {
          // 预编排或手动抓取后的模型编排还在跑：等它写完再在它的基础上补增量
          while (modelState.busy && left() > 90000) await sleep(2000);
          if (modelState.busy) return null;
          return makeEdition({ pack, runId: out.run_id, wantLlm, minHours: out.lookback_hours });
        })();
        let timer = null;
        const got = await Promise.race([fresh, new Promise((r) => { timer = setTimeout(() => r("timeout"), Math.max(5000, left() - 45000)); })]);
        clearTimeout(timer);
        let ed = got && got !== "timeout" ? got : null;
        if (!ed) {
          ed = latestContent(pack);
          if (ed) out.edition_note = "模型还在写稿，本轮先发 " + bjHhmm(ed.created_at) + " 编好的版面";
        }
        out.edition = ed ? { id: ed.id, mode: ed.mode, model: ed.model, headline: ed.headline, stories: Object.keys(ed.stories || {}).length, items_read: ed.items_read, error: ed.error, waited: got === "timeout" ? "timeout" : undefined } : null;
        {
          const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
          const db = openIfExists(p.db);
          try {
            if (ed && out.parts) {
              out.message = sendFromEdition(db, ed, out.parts, out.rules, out.run_id, out.lookback_hours || 6, out.defer_push, out);
              if (out.edition_note) out.message += "\n（" + out.edition_note + "）";
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

  // ---------------------------------------------------------------- 写完再推
  const pendingKey = (pack) => "push_pending:" + pack;
  const composing = new Set();
  function readPending(pack) {
    try { const r = withDb(p, (db) => (db ? db.prepare("SELECT value FROM kv WHERE key = ?").get(pendingKey(pack)) : null)); return r ? JSON.parse(r.value) : null; } catch { return null; }
  }
  function writePending(pend) {
    withDb(p, (db) => { if (db) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(pendingKey(pend.pack), JSON.stringify(pend), new Date().toISOString().replace("T", " ").slice(0, 19)); });
  }
  function clearPending(pack) {
    withDb(p, (db) => { if (db) db.prepare("DELETE FROM kv WHERE key = ?").run(pendingKey(pack)); });
  }
  /** 在后台编本轮版面（前一份还在写就等它），写完记下来并触发推送。 */
  async function composeThenDeliver(pend) {
    composing.add(pend.pack);
    try {
      const t0 = Date.now();
      while (modelState.busy && Date.now() - t0 < PENDING_MAX_MS - 15 * 60000) await sleep(5000);
      let ed = null;
      if (!modelState.busy) { try { ed = await makeEdition({ pack: pend.ed_pack, runId: pend.run_id, wantLlm: pend.want_llm, minHours: pend.lookback }); } catch { ed = null; } }
      if (!ed) {
        ed = latestContent(pend.ed_pack);
        if (ed) pend.note = "本轮版面没编出来，按 " + bjHhmm(ed.created_at) + " 的版面推送";
      }
      pend.edition_id = ed ? ed.id : null;
      pend.ready = true;
      pend.ready_at = new Date().toISOString();
      writePending(pend);
    } finally { composing.delete(pend.pack); }
    await deliver(pend.pack);
  }

  // ---------------------------------------------------------------- 直接推送
  /** 能直接推送吗：桥接插件的 phonePush 服务在、能送到聊天、推送方式不是「经定时任务」。 */
  function direct() {
    const svc = optional.phonePush;
    if (!svc || typeof svc.send !== "function" || typeof svc.available !== "function") return null;
    if (loadPush(p.pushPrefs).delivery === "task") return null;
    try { return svc.available() ? svc : null; } catch { return null; }
  }
  /** 直接发到手机；对方限流（10 秒一条）时等一下再试一次。发出去返回 true。 */
  async function sendDirect(text) {
    if (!String(text || "").trim()) return false;
    for (let k = 0; k < 2; k++) {
      const svc = direct();
      if (!svc) return false;
      let r = null;
      try { r = await svc.send(String(text), { source: "dsh-newswire" }); } catch (err) { noteSend(false, errText(err), text); return false; }
      if (r && r.delivered > 0) { noteSend(true, null, text, r.delivered); return true; }
      if (!(r && r.reason === "too-soon")) { noteSend(false, (r && r.reason) || "not-sent", text); return false; }
      await sleep(11000);
    }
    return false;
  }
  /** 记下最近一次直接发送的结果（自检页用）。 */
  function noteSend(ok, reason, text, chats) {
    try { kvSet("push_last", { at: new Date().toISOString(), ok, reason: reason || null, chars: String(text || "").length, chats: chats || 0 }); } catch { /* 只是记录 */ }
  }
  function kvGet(key) { try { const r = withDb(p, (db) => (db ? db.prepare("SELECT value FROM kv WHERE key = ?").get(key) : null)); return r ? JSON.parse(r.value) : null; } catch { return null; } }
  function kvSet(key, value) { withDb(p, (db) => { if (db) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, JSON.stringify(value), nowIsoUtc()); }); }

  /**
   * 推送链路自检：从「到点」到「手机收到」逐段看通不通，不通的写明原因和怎么修。
   * 两条路：直接发（插件自己到点、写完直接发，不经过模型）；经定时任务（宿主到点叫模型调工具、模型把消息转发出去，模型慢或忙时会超时、改写）。
   */
  async function pushHealth() {
    const pp = loadPush(p.pushPrefs);
    const steps = [];
    const add = (id, ok, text, fix) => steps.push(fix ? { id, ok, text, fix } : { id, ok, text });
    const svc = optional.phonePush;
    let avail = false;
    try { avail = Boolean(svc && typeof svc.available === "function" && svc.available()); } catch { avail = false; }
    if (!svc) add("bridge", false, "没找到掌上指挥台的「直接发到手机」服务", "装上或升级掌上指挥台（dsh-switchboard 0.5.23 以上）并启用。");
    else add("bridge", true, "掌上指挥台的「直接发到手机」服务在");
    if (svc) {
      if (avail) add("chats", true, "服务可用：已填接收推送的聊天");
      else add("chats", false, "服务在，但现在发不出去", "在掌上指挥台的设置里填「定时任务推送聊天」（Telegram 填你和机器人私聊的聊天 ID），并确认「允许其他插件发消息到手机」开着、总开关开着。");
    }
    if (pp.delivery === "task") add("delivery", false, "推送方式选的是「经定时任务」", "在「推送」→「方式」里改成「直接发到手机」。");
    else add("delivery", true, "推送方式：直接发到手机");
    let task = null;
    if (!optional.schedule) add("task", false, "宿主没有提供定时任务服务", "直接发也按定时任务的时间表跑：需要宿主的定时任务插件。");
    else {
      task = await pushTask("core");
      if (!task) add("task", false, "还没有定时推送任务（时间表）", "在「推送」里选一个节奏，会自动创建。");
      else add("task", true, "时间表：" + (task.expression || task.kind) + "（" + (task.status === "active" ? "由宿主的定时任务触发" : "宿主任务已暂停") + "）");
    }
    const on = Boolean(direct());
    const taken = clock.tasks.filter((t) => t.kind === "cycle").length > 0;
    if (on && taken) add("clock", true, "插件按自己的时钟到点运行，下一次 " + (clockNext() ? bjHhmm(clockNext().replace("T", " ").slice(0, 19)) : "—"));
    else if (on && task) add("clock", false, "直接发可用，但还没接管时间表", task.kind !== "cron" ? "定时任务不是 cron 时间规则，插件接管不了：在「推送」里重新选一次节奏。" : "一分钟内会自动接管；一直不接管就在「推送」里重新选一次节奏。");
    const last = kvGet("push_last");
    if (last) add("last", Boolean(last.ok), "最近一次直接发送：" + bjHhmm(String(last.at).replace("T", " ").slice(0, 19)) + (last.ok ? " 已送出（" + last.chars + " 字）" : " 没发出去（" + (last.reason || "未知原因") + "）"));
    const lastPush = withDb(p, (db) => (db ? db.prepare("SELECT MAX(pushed_at) t, COUNT(*) n FROM pushes WHERE pushed_at >= datetime('now', '-1 day') AND COALESCE(reason, '') != 'unlisted'").get() : null));
    if (lastPush && lastPush.t) add("recent", true, "近 24 小时记了 " + lastPush.n + " 条推送，最近一次 " + bjHhmm(lastPush.t));
    else add("recent", false, "近 24 小时没有推送记录");
    const pend = readPending("core");
    if (pend) add("pending", true, pend.ready ? "有一条写好的推送等着发" : "本轮版面正在写（" + bjHhmm(String(pend.at).replace("T", " ").slice(0, 19)) + " 抓取），写完就推");
    const route = on && taken ? "direct" : task && task.status === "active" ? "task" : on ? "direct_pending" : "none";
    const summary = route === "direct" ? "直接推送已生效：到点由插件抓取、写完直接发到手机，不经过模型，没有 10 分钟的时限。"
      : route === "task" ? "现在走的是「经定时任务」：宿主到点叫模型调用工具，再由模型把消息转发到手机。模型慢或正忙时会超时，长消息可能被改写。" + (steps.find((x) => !x.ok && x.fix) ? "按下面标出的一项改好，就会换成直接推送。" : "")
      : route === "direct_pending" ? "直接推送可用，正在接管时间表。" : "现在推不到手机：按下面标出的项逐个处理。";
    return { route, ok: route === "direct", summary, steps };
  }

  // ---------------------------------------------------------------- 数据保留
  /** 每天清理一次只增不减的表（版面、账本、抓取记录等），模型和抓取都闲着时做。 */
  function maintenanceTick() {
    if (modelState.busy || busyWith()) return;
    // 一次性修复：摘掉以前按过宽的规则挂到主线对象上的故事线（见 repairThemeLinks）
    if (!kvGet("tracker_links_v2")) {
      try { const n = withDb(p, (db) => (db ? repairThemeLinks(db) : null)); if (n != null) kvSet("tracker_links_v2", { at: new Date().toISOString(), removed: n }); } catch { /* 下一分钟再试 */ }
    }
    const last = kvGet("maintenance");
    if (last && Date.now() - Date.parse(last.at) < 24 * 3600000) return;
    const db = openIfExists(p.db);
    if (!db) return;
    try {
      const t0 = Date.now();
      const r = prune(db);
      db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run("maintenance", JSON.stringify(Object.assign({ at: new Date().toISOString(), ms: Date.now() - t0 }, r)), nowIsoUtc());
    } catch (err) { try { console.error("[newswire] maintenance failed:", errText(err)); } catch { /* ignore */ } } finally { db.close(); }
  }

  // ---------------------------------------------------------------- 插件自己的时钟
  // 直接推送可用时，宿主定时任务里的模型就不必每轮转发（本地模型会改写、漏发、把乱码发到手机）：
  // 暂停本插件建的定时任务，按它们的 cron 自己到点跑；直接推送断了 3 分钟以上（或改回「经定时任务」）就恢复那些任务。
  // 任务的时间仍以宿主里的任务为准（面板改节奏照样改那个任务），这里每 5 分钟重读一次。
  const clockKey = "direct_clock";
  const clock = { tasks: [], at: 0, offSince: 0, fired: new Set(), startedAt: Date.now() };
  // 工具区里定义的函数（日报）由那里登记进来
  const hooks = { dailyRun: null };
  function readTaken() { try { const r = withDb(p, (db) => (db ? db.prepare("SELECT value FROM kv WHERE key = ?").get(clockKey) : null)); return r ? JSON.parse(r.value) : []; } catch { return []; } }
  function writeTaken(list) { withDb(p, (db) => { if (db) db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(clockKey, JSON.stringify(list), new Date().toISOString().replace("T", " ").slice(0, 19)); }); }
  /** 本插件建的定时任务：各主题包的要闻任务与日报任务（按标题认）。 */
  function ownTasks(all) {
    const packs = Object.keys(packSchedule(p, "core").packs);
    const out = [];
    for (const pack of new Set(["core"].concat(packs))) {
      const t = all.find((x) => x.title === packSchedule(p, pack).title);
      if (t) out.push({ task: t, kind: "cycle", pack });
      const d = all.find((x) => x.title === "今日回顾" + (pack === "core" ? "" : " · " + pack) + " · dsh-newswire");
      if (d) out.push({ task: d, kind: "daily", pack: pack === "core" ? "all" : pack });
    }
    return out;
  }
  async function clockSync(force) {
    const svc = optional.schedule;
    if (!svc) return;
    const taken = readTaken();
    if (!direct()) {
      if (!taken.length) { clock.tasks = []; return; }
      if (!clock.offSince) clock.offSince = Date.now();
      // 服务还在、只是一时送不到（线路重连等），或刚启动、桥接插件可能还没加载：等 3 分钟再交还；
      // 服务卸载了或改回「经定时任务」：马上交还
      const waiting = optional.phonePush || (!optional.phonePushSeen && Date.now() - clock.startedAt < 3 * 60000);
      if (waiting && loadPush(p.pushPrefs).delivery !== "task" && Date.now() - clock.offSince < 3 * 60000) return;
      for (const x of taken) { try { await svc.edit({ id: x.id, action: "update", patch: { active: true } }); } catch { /* 下一分钟再试 */ } }
      writeTaken([]);
      clock.tasks = [];
      return;
    }
    clock.offSince = 0;
    if (!force && clock.tasks.length && Date.now() - clock.at < 5 * 60000) return;
    const all = (await svc.list({ limit: 500 })).items || [];
    const was = new Set(taken.map((x) => x.id));
    const next = [];
    for (const x of ownTasks(all)) {
      // 只接管五段 cron 的任务；用户在宿主里改成别的时间规则的，留给定时任务
      if (x.task.kind !== "cron" || !parseCron(x.task.expression)) continue;
      if (x.task.status === "active") {
        try { const r = await svc.edit({ id: x.task.id, action: "update", patch: { active: false } }); if (r && r.code) continue; } catch { continue; }
      } else if (!was.has(x.task.id)) continue; // 用户自己暂停的，不动
      next.push({ id: x.task.id, kind: x.kind, pack: x.pack, cron: x.task.expression, tz: x.task.timeZone || SCHEDULE_TZ });
    }
    writeTaken(next.map((x) => ({ id: x.id, kind: x.kind, pack: x.pack })));
    clock.tasks = next;
    clock.at = Date.now();
  }
  async function clockTick() {
    await clockSync(false);
    if (!clock.tasks.length || !direct()) return;
    const now = new Date();
    const mk = minuteKey(now);
    for (const k of clock.fired) if (Number(k.split("@")[1]) < mk - 5) clock.fired.delete(k);
    for (const t of clock.tasks) {
      const k = t.id + "@" + mk;
      if (clock.fired.has(k) || !cronMatches(t.cron, now, t.tz)) continue;
      clock.fired.add(k);
      void background(fireTask(t), "direct " + t.kind);
    }
  }
  /** 到点：要闻按一轮跑（写完再推的由版面写完时直接发），日报写好直接发。 */
  async function fireTask(t) {
    if (t.kind === "daily") {
      const r = hooks.dailyRun ? await hooks.dailyRun({ pack: t.pack }) : null;
      if (r && r.message) await sendDirect(r.message);
      return;
    }
    const out = await runCycle({ pack: t.pack });
    if (out && out.message && !(await sendDirect(out.message))) {
      // 发不出去：交给定时任务转发这条
      writePending({ source: "cycle", pack: t.pack, ed_pack: t.pack, run_id: out.run_id || newRunId("cycle"), at: new Date().toISOString(), ready: true, ready_at: new Date().toISOString(), message: out.message, parts: partsNow(t.pack), lookback: 6 });
      await triggerDelivery(t.pack);
    }
  }
  /** 下一次直接推送的时间（面板显示用）。 */
  function clockNext() {
    const ts = clock.tasks.filter((t) => t.kind === "cycle").map((t) => nextCron(t.cron, t.tz, Date.now())).filter(Boolean).sort((a, b) => a - b);
    return ts.length ? ts[0].toISOString() : null;
  }

  /** 推送写好的这一轮：能直接发就直接发（不经过模型）；发不出去时把拼好的消息留给定时任务转发。 */
  async function deliver(pack) {
    if (direct()) {
      const pend = readPending(pack);
      if (!pend || !pend.ready) return false;
      const out = deliverPending(pend);
      if (!out.message) return true;
      if (await sendDirect(out.message)) return true;
      writePending(Object.assign({}, pend, { message: out.message, ready: true, ready_at: new Date().toISOString() }));
    }
    return triggerDelivery(pack);
  }
  /** 触发这个主题包的定时任务一次（它调 newswire_cycle，取到写好的版面就推送）。宿主忙时隔一分钟再试。 */
  const triggering = new Set();
  async function triggerDelivery(pack) {
    if (triggering.has(pack)) return false;
    triggering.add(pack);
    try { return await triggerOnce(pack); } finally { triggering.delete(pack); }
  }
  async function triggerOnce(pack) {
    for (let i = 0; i < 15; i++) {
      const svc = optional.schedule;
      if (!svc) return false;
      try {
        const all = (await svc.list({ limit: 500 })).items || [];
        const task = all.find((x) => x.title === packSchedule(p, pack).title);
        if (!task) return false; // 没有定时任务：等下次有人调用 newswire_cycle 时推
        const r = await svc.run({ id: task.id });
        if (r && r.code === "schedule_not_found") return false;
        if (!(r && r.code)) return true;
      } catch { /* 下一分钟再试 */ }
      await sleep(60000);
    }
    return false;
  }
  /** 宿主重启等原因丢了后台编排：等太久的待推送按已有的最新版面推出去。 */
  async function checkPending() {
    for (const pack of Object.keys(packSchedule(p, "core").packs).concat("core")) {
      const pend = readPending(pack);
      if (!pend || composing.has(pack) || triggering.has(pack)) continue;
      const age = Date.now() - Date.parse(pend.at);
      // 插件重启丢了后台编排（没写完、也没人在写）：接着编一次，已写好的稿按材料复用，不用从头等模型
      if (!pend.ready && !pend.resumed && age < PENDING_MAX_MS - 10 * 60000 && !modelState.busy) {
        pend.resumed = true;
        writePending(pend);
        void background(composeThenDeliver(pend), "resume push");
        continue;
      }
      if (pend.ready ? Date.now() - Date.parse(pend.ready_at || pend.at) > 5 * 60000 : age > PENDING_MAX_MS) {
        if (!pend.ready) {
          const ed = latestContent(pend.ed_pack);
          Object.assign(pend, { ready: true, ready_at: new Date().toISOString(), edition_id: ed ? ed.id : null, note: ed ? "本轮版面没编完，按 " + bjHhmm(ed.created_at) + " 的版面推送" : null });
          writePending(pend);
        }
        if (age > 3 * 3600000) { clearPending(pack); continue; } // 太旧了，交给下一轮
        await deliver(pack);
      }
    }
  }
  /** 推送消息的固定部分（不经引擎时用）：此刻的北京时间、主题包标题。 */
  function partsNow(pack) {
    const bj = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    return { hhmm: bj.slice(11, 16), md: bj.slice(5, 10), warnings: [], title: (packSchedule(p, pack).packs[pack] || {}).title || "要闻", overnight: false };
  }
  /** 「本轮新」从上一次推送算起（多算半小时），2～14 小时。 */
  function hoursSinceLastPush() {
    const r = withDb(p, (db) => (db ? db.prepare("SELECT MAX(pushed_at) t FROM pushes").get() : null));
    if (!r || !r.t) return 6;
    return Math.min(14, Math.max(2, (Date.now() - Date.parse(r.t.replace(" ", "T") + "Z")) / 3600000 + 0.5));
  }
  /** 能推到手机吗：要有宿主的定时服务和这个主题包的定时任务（推送靠触发它）。 */
  async function pushTask(pack) {
    if (!optional.schedule) return null;
    try { return ((await optional.schedule.list({ limit: 500 })).items || []).find((x) => x.title === packSchedule(p, pack).title) || null; } catch { return null; }
  }
  /** 手动抓取完：编版面，写完推一条（只推没推过的；没有就不推）。推不了时照旧只编版面。 */
  async function afterManualFetch(runId, edPack) {
    const pack = "core";
    const cur = readPending(pack);
    if (loadPush(p.pushPrefs).cadence === "daily_only" || (cur && !cur.ready) || !(direct() || (await pushTask(pack)))) { backgroundEdition(runId, edPack); return; }
    const pend = { source: "manual", pack, ed_pack: edPack, run_id: runId, at: new Date().toISOString(), parts: partsNow(pack), rules: null, lookback: hoursSinceLastPush(), want_llm: llmReady(), ready: false, edition_id: null, quiet_if_empty: true };
    writePending(pend);
    void background(composeThenDeliver(pend), "manual push");
  }
  /** 面板上点「推送」：按现有的最新版面立即推一条。 */
  async function pushNow() {
    const pack = "core";
    if (!direct() && !(await pushTask(pack))) return { ok: false, error: "no_task", note: "还没有定时推送任务：先在「推送」里设置节奏（会创建定时任务），手机端才收得到。" };
    const ed = latestContent("all");
    if (!ed) return { ok: false, error: "no_edition", note: "还没有版面，先抓一轮。" };
    const now = new Date().toISOString();
    const cur = readPending(pack);
    writePending({ source: "button", pack, ed_pack: "all", run_id: newRunId("push"), at: now, ready: true, ready_at: now, edition_id: ed.id, parts: partsNow(pack), rules: null, lookback: hoursSinceLastPush(), quiet_if_empty: false });
    // 正在后台写的那一轮写完会自己再存一份、再触发，不受影响
    void background(deliver(pack), "push now");
    return { ok: true, edition: { id: ed.id, created_at: ed.created_at, mode: ed.mode }, replaced: Boolean(cur && cur.ready), note: "已发起推送（按 " + bjHhmm(ed.created_at) + " 的版面，只推还没推过的），稍后到手机。" };
  }
  function deliverPending(pend) {
    clearPending(pend.pack);
    // 直接推送没发出去、留给定时任务转发的：消息已经拼好、推送也记过了，原样交出
    if (typeof pend.message === "string") return { ok: true, run_id: pend.run_id, pack: pend.pack, fetched_at: pend.at, message: pend.message, edition: null };
    const ed = pend.edition_id ? withDb(p, (db) => (db ? edContent(editionById(db, pend.edition_id)) : null)) : null;
    const out = { ok: true, run_id: pend.run_id, pack: pend.pack, fetched_at: pend.at };
    const db = openIfExists(p.db);
    try {
      // 推送时离抓取已过了一阵：判断「本轮新」的时间窗口往前补上这段
      const lookback = pend.lookback + (Date.now() - Date.parse(pend.at)) / 3600000;
      if (ed) {
        out.message = sendFromEdition(db, ed, pend.parts, pend.rules, pend.run_id, lookback, true, out);
        if (pend.note) out.message += "\n（" + pend.note + "）";
        // 手动抓取后自动推的：没有没推过的新内容就不打扰
        if (pend.quiet_if_empty && !(out.picks || []).length) out.message = "";
        else if (pend.source === "button" && !(out.picks || []).length) out.message = pend.parts.hhmm + " " + pend.parts.title + "：当前版面（" + bjHhmm(ed.created_at) + "）里的内容都推过了";
      } else out.message = pend.quiet_if_empty ? "" : pend.parts.hhmm + " 本轮版面没编出来，详情见新闻面板";
    } finally { if (db) db.close(); }
    out.edition = ed ? { id: ed.id, mode: ed.mode, model: ed.model, headline: ed.headline, stories: Object.keys(ed.stories || {}).length, items_read: ed.items_read } : null;
    return out;
  }

  /** 按版面选出要推的报道、记推送、拼消息（out 上顺带挂 picks 与 held）。 */
  function sendFromEdition(db, ed, parts, rules, runId, lookbackHours, record, out) {
    const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
    // 推送偏好：门槛档位、每轮上限、按读者反馈调各版块门槛、每天上限；「全推」不看门槛和上限
    const pp = loadPush(p.pushPrefs);
    const full = pp.scope === "full";
    parts = Object.assign({}, parts, { full, from: bjHhmm(new Date(Date.now() - lookbackHours * 3600000).toISOString().replace("T", " ").slice(0, 19)) });
    const all = editionPicks(db, ed, rulesFor(Object.assign({}, DEFAULT_RULES, rules || {}), pp), { nowIso, lookbackHours, penalties: sectionPenalties(db), full });
    const cap = full ? { send: all, held: 0, today: 0 } : applyDailyCap(db, all, pp);
    // 一条消息写多少有上限：最重要的十来条写一句话，再十几条只列标题，其余只报个数（隔夜、「全推」时一轮可能上百条）
    const tiers = tierPicks(cap.send);
    tiers.titles.forEach((s) => { s.title_only = true; });
    const picks = tiers.detail.concat(tiers.titles);
    // 记推送的这一次给每条编当天的序号（按消息里的顺序），读者在手机上回复序号来展开、反馈
    if (record) {
      numberPicks(db, orderPicks(tiers.detail).flatMap((g) => g.items).concat(tiers.titles));
      recordEditionPushes(db, picks, runId, nowIso, out.pack || ed.pack);
      // 没列出来的也记一笔（原因记 unlisted、没有序号）：以后它升级或有进展时才认得出是「推过提了一句」的
      if (tiers.rest.length) recordEditionPushes(db, tiers.rest.map((s) => Object.assign({}, s, { reason: "unlisted", n: null })), runId, nowIso, out.pack || ed.pack);
    }
    parts = Object.assign({}, parts, { format: pp.format, tracked: trackedIn(db, picks.map((x) => x.id)), rest: restGroups(tiers.rest), totals: { all: cap.send.length, fresh: cap.send.filter((x) => x.reason === "new").length } });
    out.unlisted = tiers.rest.length;
    out.held = cap.held;
    out.picks = picks.map((x) => ({ story: x.id, event_id: x.lead_event_id, title: x.title, url: x.url, importance: x.importance, credibility: x.credibility, reason: x.reason, source_count: x.source_count, section: x.section, followed: x.followed || null }));
    return composeEditionMessage(parts, picks, ed, taxonomyNames()) + (cap.held ? "\n（今天已推 " + (cap.today + picks.length) + " 条，到了每天上限；另有 " + cap.held + " 条留在面板里）" : "");
  }

  /** 来不及等时用哪份版面：近 3 小时内模型写的（含边写边出的进度版）优先，没有就用最新一份。 */
  function latestContent(pack) {
    return withDb(p, (db) => {
      if (!db) return null;
      const since = new Date(Date.now() - 3 * 3600000).toISOString().replace("T", " ").slice(0, 19);
      const pick = db.prepare("SELECT id FROM editions WHERE pack IN (?, 'all') AND mode = 'llm' AND created_at >= ? ORDER BY (pack = ?) DESC, id DESC LIMIT 1").get(pack, since, pack)
        || db.prepare("SELECT id FROM editions WHERE pack IN (?, 'all') ORDER BY (pack = ?) DESC, id DESC LIMIT 1").get(pack, pack);
      return edContent(pick ? editionById(db, pick.id) : null);
    });
  }
  function edContent(row) {
    return row && row.content ? Object.assign({}, row.content, { id: row.id, pack: row.pack, mode: row.mode, model: row.model, created_at: row.created_at, headline: row.headline || row.content.headline, error: row.error }) : null;
  }

  function bjHhmm(utc) { try { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(String(utc).replace(" ", "T") + "Z")); } catch { return ""; } }

  /** 抓不了（另一轮占着）时：按已有的最新版面推送，不抓取。 */
  function cycleFromLatest(args, why) {
    const pack = (args && args.pack) || "core";
    const ed = latestContent(pack);
    const now = new Date();
    const bj = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
    const parts = { hhmm: bj.slice(11, 16), md: bj.slice(5, 10), warnings: [], title: (packSchedule(p, pack).packs[pack] || {}).title || "要闻", overnight: false };
    if (!ed) return { ok: false, error: "run_in_progress", message: parts.hhmm + " 本轮跳过：" + why };
    const out = { ok: true, run_id: newRunId("cycle"), pack, skipped_fetch: why };
    const db = openIfExists(p.db);
    try { out.message = sendFromEdition(db, ed, parts, null, out.run_id, 6, !(args && args.dry_run === true), out) + "\n（" + why + "，本轮未抓取，按 " + bjHhmm(ed.created_at) + " 的版面推送）"; } finally { if (db) db.close(); }
    return out;
  }

  // ---------------------------------------------------------------- 预编排
  // 模型慢（一份版面要十几分钟）时，定时推送那一刻才开始编排一定超时。提前一段时间在后台抓取并编排，
  // 到点的那一轮只补这几分钟的增量。提前量按最近几份模型版面的实际耗时估。
  const prewarm = { running: false, done: new Map(), tasks: [], tasksAt: 0 };
  function prewarmLeadMs() {
    const ms = (withDb(p, (db) => (db ? db.prepare("SELECT ms FROM editions WHERE mode = 'llm' AND ms IS NOT NULL ORDER BY id DESC LIMIT 5").all() : [])) || []).map((r) => r.ms).sort((a, b) => a - b);
    const typical = ms.length ? ms[Math.floor(ms.length / 2)] : 15 * 60000;
    // 「不限」档还要先让模型读页面：按上一次读的实际耗时算进去
    const reading = depthParams(prefs()).modelRead ? Math.min(25 * 60000, (modelState.read && modelState.read.ms) || 10 * 60000) : 0;
    // 抓取约 2 分钟：模型在一轮预算里读得完、写得完就不用提前
    if (typical + reading + 3 * 60000 <= cfg.cycleBudgetMs) return 0;
    return Math.min(60 * 60000, Math.max(8 * 60000, typical + reading + 5 * 60000));
  }
  async function prewarmTick() {
    if (prewarm.running || !optional.schedule || !(modeNow() === "llm" && llmReady())) return;
    if (busyWith() || modelState.busy) return;
    prewarm.running = true;
    try {
      if (Date.now() - prewarm.tasksAt > 5 * 60000) {
        const all = (await optional.schedule.list({ limit: 500 })).items || [];
        const packs = Object.keys(packSchedule(p, "core").packs);
        prewarm.tasks = (packs.length ? packs : ["core"]).map((k) => ({ pack: k, task: all.find((x) => x.title === packSchedule(p, k).title) })).filter((x) => x.task && x.task.status === "active" && x.task.scheduledAt);
        // 旧版本建的任务：指令里没有超时提示的，换成新指令（只改指令，不动时间）
        if (!prewarm.upgraded) {
          prewarm.upgraded = true;
          for (const { pack, task } of prewarm.tasks) {
            if (typeof task.prompt === "string" && task.prompt.startsWith("调用工具 newswire_cycle") && task.prompt !== schedulePrompt(pack)) {
              try { await optional.schedule.edit({ id: task.id, action: "update", patch: { prompt: schedulePrompt(pack) } }); } catch { /* 用户在对话里重新设置一次也行 */ }
            }
          }
        }
        prewarm.tasksAt = Date.now();
      }
      // 插件自己按时钟推送时宿主任务是暂停的：提前量按时钟算出的下一次
      if (clock.tasks.length && direct()) prewarm.tasks = clock.tasks.filter((t) => t.kind === "cycle").map((t) => { const at = nextCron(t.cron, t.tz, Date.now()); return { pack: t.pack, task: { id: t.id, status: "active", scheduledAt: at ? at.toISOString() : null } }; }).filter((x) => x.task.scheduledAt);
      const lead = prewarmLeadMs();
      if (!lead) return;
      for (const [k, at] of prewarm.done) if (at < Date.now() - 3600000) prewarm.done.delete(k);
      for (const { pack, task } of prewarm.tasks) {
        const at = Date.parse(task.scheduledAt);
        const until = at - Date.now();
        const key = pack + "@" + at;
        if (!Number.isFinite(at) || until > lead || until < 4 * 60000 || prewarm.done.has(key)) continue;
        prewarm.done.set(key, at);
        const runId = newRunId("prep");
        const res = await guardedRun({ packs: pack, read_budget_ms: Math.max(4 * 60000, until - 12 * 60000) }, runId);
        if (res.ok) await makeEdition({ pack, runId: res.run_id || runId, wantLlm: true, priority: PRIORITY.background });
        prewarm.tasksAt = 0;
        return;
      }
    } catch { /* 下一分钟再看 */ } finally { prewarm.running = false; }
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
    // 宿主只收「无损 JSON」：值里有 undefined、NaN、-0、Date 之类整个结果会被拒（报 value is not lossless JSON，
    // 而这时推送已经记下、消息却回不去）。所有工具的返回统一过一遍 JSON 往返。
    const tool = (def) => disposers.push(ctx.tools.register(Object.assign({}, def, { execute: async (...a) => losslessJson(await def.execute(...a)) })));
    disposers.push(() => { hooks.dailyRun = null; });
    // 预编排：每分钟看一眼下一次定时推送还有多久
    { const t = setInterval(() => { void background(prewarmTick(), "prewarm"); void background(checkPending(), "pending push"); try { maintenanceTick(); } catch { /* 明天再清 */ } }, 60000); disposers.push(() => clearInterval(t)); }
    // 30 秒看一次时钟（同一分钟只触发一次），保证不漏掉整点
    { const t = setInterval(() => { void background(clockTick(), "direct clock"); }, 30000); disposers.push(() => clearInterval(t)); }

    // 路由和工具各在一个文件里（host/routes.mjs、host/tools.mjs）：状态都在上面，经 app 传过去
    const app = {
      afterManualFetch, background, busyWith, cfg, clock, clockNext, clockSync, ctx, detailJobs, direct, dropTrackerFollows, editFollows, errText,
      guardedRun, handleReply, llmReady, makeDaily, makeEdition, modeNow, model, modelCatalog, modelState, modelView, newRunId, optional, p, prefs,
      pushHealth, pushNow, queue, readTaken, reflowWithFeedback, runAnalysis, runCycle, runDetail, runSynthesis, startDetail, syncSourceState,
      syncTrackerFollows, taxonomyLabels, taxonomyNames, updates, writeTaken,
      route, tool, disposers,
    };
    Object.assign(app, registerRoutes(app));
    hooks.dailyRun = app.dailyRun;
    registerTools(app);

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
