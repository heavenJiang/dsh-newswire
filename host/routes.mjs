/**
 * 面板路由（/api/newswire/*），以及路由和工具共用的几个函数（推送设置、定时任务、日报）。
 * 状态都在 index.js 的 apply() 里，经 app 传进来；这里只注册路由，返回共用的函数给工具那边用。
 */
import { contentHealth, filteredItems } from "./health.mjs";
import { setSourceState, sourceScores, thinCoverage } from "./sources.mjs";
import { DEPTHS, usageToday } from "./runtime.mjs";
import { answerNews, searchNews } from "./ask.mjs";
import { latestDetail } from "./detail.mjs";
import { analysisBrief, latestAnalysis } from "./analysis.mjs";
import { addTracker, listTrackers, removeTracker, suggestions as trackSuggestions, trackerDetail, unlinkStory } from "./tracking.mjs";
import { PRIORITY } from "./queue.mjs";
import { CADENCES, FORMATS, LEVELS, feedbackStats, loadPush, noteInterest, recentPushes as pushHistory, savePush, sectionPenalties } from "./push.mjs";
import { markKind } from "../engine/pipeline/quality.mjs";
import { coolingMap } from "../engine/pipeline/cooling.mjs";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { attemptRows, continuityRows, dayRange, eventDetail, eventRows, itemRows, labelCounts, openIfExists, recentGaps, recentPushes, recentRuns, signalTrail, sinceIso, timelineDay, timelineRun } from "../engine/query.mjs";
import { analyzeEvents } from "./model.mjs";
import { judgeRecipe, learnRecipe } from "./recipe.mjs";
import { bodiesFor, editionById, editionDiff, editionList, latestEdition, loadLayout, qualityRows, reassemble, saveEdition, sinceSeen, storyDetail } from "./edition.mjs";
import { composeDailyMessage, dailyDates, latestDaily, todayBj } from "./daily.mjs";
import { KINDS as FOLLOW_KINDS, loadFollows, updateFollows } from "./follows.mjs";
import { installedPackage } from "./update.mjs";
import { DAILY_CRON, SCHEDULE_CRON, bodyOf, clampNum, dailyPrompt, draftSource, ensureData, findDigest, jsonResponse, normalizeSource, packSchedule, pageOutline, readConfigSources, schedulePrompt, snapshotOf, sourcesDocOf, strOrNull, testSource, upsertSourceInConfig, validateSources, withDb, withSources, writeConfigSources, writeFileAtomic } from "./core.mjs";

export function registerRoutes(app) {
  const {
    afterManualFetch, background, busyWith, cfg, clock, clockNext, clockSync, ctx, detailJobs, direct, dropTrackerFollows, editFollows, errText,
    guardedRun, handleReply, llmReady, makeDaily, makeEdition, modeNow, model, modelCatalog, modelState, modelView, newRunId, optional, p, prefs,
    pushHealth, pushNow, queue, readTaken, reflowWithFeedback, route, runAnalysis, runDetail, runSynthesis, startDetail, syncSourceState,
    syncTrackerFollows, taxonomyLabels, taxonomyNames, updates, writeTaken,
  } = app;

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

  // 添加数据源：{name, url, pack, category?, type?}；test=true 只试抓（RSS / 列表页都不行时换另一种再试），否则保存为试用源
  route({
    path: "/api/newswire/sources/add",
    methods: ["POST"],
    fetch: async (request) => {
      const body = await bodyOf(request);
      await ensureData(p);
      const conf = await readConfigSources(p);
      const list = conf.data.sources || [];
      let src = draftSource(body, list);
      if (list.some((x) => String(x.url || "").replace(/\/+$/, "") === String(src.url || "").replace(/\/+$/, ""))) return jsonResponse({ ok: false, error: "duplicate_url" }, 409);
      const problems = validateSources({ sources: [src] }, { allowSingle: true });
      if (problems.length) return jsonResponse({ ok: false, error: "invalid_source", problems }, 400);
      // 通用解析认不出来时：让模型读页面结构、写出解析规则，程序试抓验证（不过关再改一次）
      if (body.learn === true) {
        if (!llmReady()) return jsonResponse({ ok: false, error: "no_model" }, 409);
        const learned = await learnRecipe({ outline: (u) => pageOutline(ctx, cfg, p, u), test: (s2) => testSource(ctx, cfg, p, { source: s2, max_items: 8 }), model }, src, { timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) });
        const source = learned.extract ? draftSource(Object.assign({}, body, { extract: learned.extract }), list) : src;
        return jsonResponse({ ok: Boolean(learned.ok), source, test: learned.test || null, learned: { tries: learned.tries || 0, note: learned.note || "", why: learned.why || "", error: learned.error || null, detail: learned.detail || null } }, 200);
      }
      if (body.test === true) {
        // 抓到不等于抓对：登录页、导航之类的一两条不算，和学规则用同一个标准
        let res = await testSource(ctx, cfg, p, { source: src, max_items: 8 });
        let verdict = judgeRecipe(res);
        if (!body.type && !src.adapter && !verdict.ok) {
          const other = Object.assign({}, src, { type: src.type === "rss" ? "html_index" : "rss" });
          const res2 = await testSource(ctx, cfg, p, { source: other, max_items: 8 });
          const v2 = judgeRecipe(res2);
          if (v2.ok || (res2 && res2.kept) > ((res && res.kept) || 0)) { src = other; res = res2; verdict = v2; }
        }
        return jsonResponse({ ok: verdict.ok, why: verdict.why, source: src, test: res, can_learn: llmReady() }, 200);
      }
      const out = await upsertSourceInConfig(p, src);
      if (!out.ok) return jsonResponse(out, 400);
      return jsonResponse(out, 200);
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
      if (res.ok && res.run_id) await afterManualFetch(res.run_id, body.packs || "all");
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
      // 面板开着时每分钟问一次：有没有更新的版面（定时任务、后台编排写完都会出新版面），只回 id 与时间
      if (body.head === true) {
        const head = withDb(p, (db) => (db ? db.prepare("SELECT id, created_at, mode FROM editions WHERE pack = ? ORDER BY id DESC LIMIT 1").get(pack) || null : null));
        return jsonResponse({ ok: true, head, model: modelView(), run: busyWith() || null }, 200);
      }
      if (body.refresh === true) {
        if (modelState.busy) return jsonResponse({ ok: false, error: "model_busy", model: modelView() }, 409);
        await ensureData(p);
        if (modeNow() === "llm" && model.available()) {
          void background(makeEdition({ pack, wantLlm: true }), "edition");
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
        // 和上一轮的版面比：新、有进展、沿用
        let diff = null;
        try { diff = db && edition ? editionDiff(db, edition) : null; } catch { diff = null; }
        return { edition, since, analyses, diff };
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
        if (modeNow() === "llm" && model.available()) { void background(makeDaily({ pack, date }), "daily"); return jsonResponse({ ok: true, started: true, model: modelView() }, 202); }
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
      // 面板里打开了推送过的故事线：算一次「感兴趣」（没推过的不记，同一条一天一次）
      if (body.kind === "open") {
        if (!sid) return jsonResponse({ error: "story_required" }, 400);
        const noted = withDb(p, (db) => (db && db.prepare("SELECT 1 FROM pushes WHERE story_id = ? LIMIT 1").get(sid) ? noteInterest(db, "open", sid) : false));
        return jsonResponse({ ok: true, noted: Boolean(noted) }, 200);
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
      return jsonResponse({ sources: withDb(p, (db) => (db ? sourceScores(db, { days }) : [])), thin: withDb(p, (db) => (db ? thinCoverage(db) : [])), cooling: withDb(p, (db) => (db ? [...coolingMap(db, db.prepare("SELECT id FROM sources WHERE enabled = 1 AND removed_at IS NULL").all().map((r) => r.id))].map(([id, c]) => Object.assign({ id, name: (db.prepare("SELECT name FROM sources WHERE id = ?").get(id) || {}).name || id }, c)) : [])) }, 200);
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
    // 打开推送设置时顺带对一次时钟（接管或交还定时任务），面板显示的就是当前状态
    try { await clockSync(false); } catch { /* 定时服务一时不可用 */ }
    const prefs = loadPush(p.pushPrefs);
    let task = null;
    try { const r = await scheduleSetup({ action: "status" }); task = r && r.task; } catch { /* 没有定时服务 */ }
    const dp = { service: Boolean(optional.phonePush), on: Boolean(direct()), clock: clock.tasks.length > 0, next: clockNext() };
    let health = null;
    try { health = await pushHealth(); } catch { health = null; }
    return { prefs, direct: dp, health, cadences: Object.fromEntries(Object.entries(CADENCES).map(([k, v]) => [k, v.label])), levels: Object.keys(LEVELS), task, schedule_available: Boolean(optional.schedule),
      penalties: withDb(p, (db) => (db ? sectionPenalties(db) : {})), feedback: withDb(p, (db) => (db ? feedbackStats(db) : null)), formats: FORMATS, pushes: withDb(p, (db) => (db ? pushHistory(db, 40) : [])) };
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
    path: "/api/newswire/push/now",
    methods: ["POST"],
    fetch: async () => { await ensureData(p); const r = await pushNow(); return jsonResponse(r, r.ok ? 200 : 409); },
  });
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
        const a = await queue.run({ kind: "ask", label: "问答：" + String(q).slice(0, 20), priority: PRIORITY.reader }, () => answerNews(model, q, hits, bodies, { timeoutMs: Math.max(cfg.modelTimeoutMs, 180000) }));
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
      const follows = await editFollows((f) => {
        for (const t of Array.isArray(body.mute_topics) ? body.mute_topics : []) if (tops.has(String(t))) f = updateFollows(f, "mute", "topic", String(t));
        for (const k of (Array.isArray(body.keywords) ? body.keywords : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20)) f = updateFollows(f, "follow", "keyword", k);
        return f;
      });
      if (typeof body.study === "boolean") {
        const conf = await readConfigSources(p);
        if (conf.data.packs && conf.data.packs.study_abroad) { conf.data.packs.study_abroad.enabled = body.study; await writeConfigSources(p, conf.data); }
      }
      if (body.cadence) await applyPush({ cadence: String(body.cadence) });
      return jsonResponse({ ok: true, follows, push: loadPush(p.pushPrefs) }, 200);
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

  // 详细报道：模型读一条故事线的全部报道写长稿（本地模型约 2–4 分钟）。后台写，立即返回；面板查故事线详情看进度
  // （detail_running / detail_error），wait=true 时等写完再返回（工具调用用）
  route({
    path: "/api/newswire/detail",
    methods: ["POST"],
    fetch: async (request) => {
      const body = await bodyOf(request);
      const id = strOrNull(body.story_id);
      if (!id) return jsonResponse({ error: "story_required" }, 400);
      if (!(modeNow() === "llm" && llmReady())) return jsonResponse({ error: "no_model" }, 409);
      if (!withDb(p, (db) => db && db.prepare("SELECT 1 FROM stories WHERE story_id = ?").get(id))) return jsonResponse({ error: "not_found" }, 404);
      if (body.wait === true) {
        try { return jsonResponse({ ok: true, detail: await runDetail(id) }, 200); }
        catch (err) { return jsonResponse({ error: errText(err) }, 502); }
      }
      startDetail(id);
      return jsonResponse({ ok: true, running: true }, 202);
    },
  });
  // 手机上回复序号（「3」「3 详」「3 没用」）：和工具 newswire_reply 同一个处理
  route({
    path: "/api/newswire/reply",
    methods: ["POST"],
    fetch: async (request) => {
      const body = await bodyOf(request);
      await ensureData(p);
      return jsonResponse(await handleReply(String(body.text || "")), 200);
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
          withDb(p, (db) => { if (db) void background(syncTrackerFollows(db, r.id, r.stories), "tracker follows"); });
          return jsonResponse({ ok: true, id: r.id }, 200);
        }
        if (action === "remove") { const t = withDb(p, (db) => (db ? removeTracker(db, String(body.id)) : null)); await dropTrackerFollows(t); return jsonResponse({ ok: Boolean(t) }, t ? 200 : 404); }
        if (action === "unlink") { withDb(p, (db) => db && unlinkStory(db, String(body.id), String(body.story_id))); await editFollows((f) => updateFollows(f, "unfollow", "story", String(body.story_id))); return jsonResponse({ ok: true }, 200); }
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
          d.detail = latestDetail(db, d.id);
          // 关键主体：每个都能一键追踪；已在追踪的标出来
          const tracked = db.prepare("SELECT t.id, t.name, t.aliases FROM trackers t WHERE t.status = 'active'").all();
          d.entities = db.prepare("SELECT name FROM story_entities WHERE story_id = ?").all(d.id).map((r) => { const t = tracked.find((x) => x.name === r.name || JSON.parse(x.aliases || "[]").includes(r.name)); return { name: r.name, tracker: t ? t.id : null }; });
        }
        return d;
      });
      const job = st ? detailJobs.get(st.id) : null;
      return st ? jsonResponse(Object.assign(st, { can_analyze: modeNow() === "llm" && llmReady(), detail_running: Boolean(job && !job.error), detail_error: (job && job.error) || null }), 200) : jsonResponse({ error: "not_found" }, 404);
    },
  });

  // 关注与屏蔽：GET 列表；POST {action: follow|unfollow|mute|unmute, kind, value, name?}
  route({
    path: "/api/newswire/follows",
    methods: ["GET", "POST"],
    fetch: async (request) => {
      if (request.method === "POST") {
        const body = await bodyOf(request);
        // values：一次取消一组（面板里合成一行的主线故事线）
        const values = Array.isArray(body.values) ? body.values.map(strOrNull).filter(Boolean).slice(0, 200) : strOrNull(body.value) ? [String(body.value)] : [];
        if (!["follow", "unfollow", "mute", "unmute"].includes(body.action) || !FOLLOW_KINDS.includes(body.kind) || !values.length) return jsonResponse({ error: "follow_invalid", kinds: FOLLOW_KINDS }, 400);
        await editFollows((f) => { for (const v of values) f = updateFollows(f, body.action, body.kind, v, strOrNull(body.name)); return f; });
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

  // ---------------------------------------------------------------- 路由和工具共用
  /** 今日回顾（工具与插件自己的时钟共用）。 */
  async function dailyRun(args) {
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
  }

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
        // 插件自己按时钟推送时，宿主任务本来就是暂停的：暂停 = 时钟不再跑它；恢复 = 时钟重新接管
        if (action === "pause") { writeTaken(readTaken().filter((x) => x.id !== mine.id)); clock.tasks = clock.tasks.filter((x) => x.id !== mine.id); }
        const r = await svc.edit({ id: mine.id, action: "update", patch: { active: action === "resume" } }, actor);
        if (r && r.code) return { ok: false, task: view(mine), note: "操作失败：" + r.code };
        if (action === "resume") void background(clockSync(true), "direct clock");
        return { ok: true, task: view(r), note: action === "pause" ? "已暂停" : "已恢复" + (direct() ? "（由插件按时直接推送到手机）" : "") };
      }
      const timing = { kind: "cron", cron: { expression: (a.cron || (daily ? DAILY_CRON : defaults.cron)).trim(), time_zone: a.time_zone || defaults.tz } };
      const prompt = daily ? dailyPrompt(pack === "core" ? "all" : pack) : schedulePrompt(pack);
      try {
        if (mine) {
          const r = await svc.edit({ id: mine.id, action: "update", patch: { prompt, timing, active: true } }, actor);
          if (r && r.code) return { ok: false, task: view(mine), note: "更新失败：" + r.code };
          void background(clockSync(true), "direct clock");
          return { ok: true, task: view(r), note: "已更新定时任务（" + timing.cron.expression + " " + timing.cron.time_zone + "）。" };
        }
        const create = {};
        if (a.cwd) create.cwd = a.cwd;
        if (a.agent_preset) create.agentPreset = a.agent_preset;
        const t = await svc.create({ title, prompt, timing, target: { kind: "new_once", create } }, actor);
        void background(clockSync(true), "direct clock");
        return { ok: true, task: view(t), note: "已创建定时任务（" + timing.cron.expression + " " + timing.cron.time_zone + "），投递到一个固定复用的会话。第一次投递后，在 Telegram/飞书里对该会话 /use 或 /watch 一次，之后每轮消息会推到手机。" };
      } catch (e) {
        return { ok: false, task: view(mine), note: "宿主拒绝了这个定时任务：" + String(e && e.message ? e.message : e) };
      }
  }

  return { pushView, applyPush, taxRegions, taxEntities, latestThemes, dailyRun, scheduleSetup };
}
