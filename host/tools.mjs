/**
 * 模型工具（newswire_*）与系统提示段落。状态在 index.js 的 apply() 里，经 app 传进来；路由那边的共用函数也在 app 上。
 */
import { setSourceState } from "./sources.mjs";
import { latestDetail } from "./detail.mjs";
import { latestAnalysis } from "./analysis.mjs";
import { addTracker, listTrackers, removeTracker, suggestions as trackSuggestions, trackerDetail } from "./tracking.mjs";
import { CADENCES, DELIVERIES, FORMATS, LEVELS, SCOPES, TIMINGS } from "./push.mjs";
import { existsSync } from "node:fs";
import { eventDetail, eventRows, failureRows, itemRows, latestRun, sinceIso } from "../engine/query.mjs";
import { latestEdition, storyDetail } from "./edition.mjs";
import { KINDS as FOLLOW_KINDS, loadFollows, updateFollows } from "./follows.mjs";
import { CRED_TEXT, DISCLAIMER, SCHEDULE_TITLE, SOURCE_PROPS, TEST_TIMEOUT_MS, clampNum, engineJson, ensureData, nowIsoUtc, readConfigSources, runEngine, signalText, snapshotOf, sourcesDocOf, strOrNull, taxFlags, testSource, upsertSourceInConfig, withDb, writeConfigSources } from "./core.mjs";

export function registerTools(app) {
  const {
    afterManualFetch, applyPush, background, busyWith, cfg, ctx, dailyRun, disposers, dropTrackerFollows, editFollows, errText, guardedRun,
    handleReply, latestThemes, llmReady, makeEdition, modeNow, modelState, modelView, newRunId, p, pushView, runAnalysis, runCycle, runSynthesis,
    scheduleSetup, syncSourceState, syncTrackerFollows, taxEntities, taxRegions, tool, pg,
  } = app;

  /** 一轮流程的一句话（给对话里的助手看）：正在跑的到了哪一步、还要多久；没在跑就说上一轮怎么结束的。 */
  function flowText() {
    const v = pg.view();
    const f = v.active || v.last;
    if (!f) return "";
    const min = (ms) => (ms >= 60000 ? Math.round(ms / 60000) + " 分钟" : Math.max(1, Math.round(ms / 1000)) + " 秒");
    const lines = f.steps.map((s) => ({ done: "✓", running: "▶", pending: "·", skipped: "–", failed: "✕" }[s.status] || "·") + " " + s.label + (s.total ? " " + s.done + "/" + s.total : "") + (s.detail && s.status !== "pending" ? "：" + s.detail : ""));
    const head = v.active
      ? "本轮流程（" + f.label + "，已用 " + min(f.ms) + (f.eta_ms ? "，预计还要约 " + min(f.eta_ms) : "") + "，进度 " + f.pct + "%）："
      : "上一轮流程（" + f.label + "，" + ({ done: "已完成", failed: "失败", stalled: "中断", replaced: "被新一轮取代" }[f.outcome] || f.outcome) + "，用时 " + min(f.ms) + (f.note ? "，" + f.note : "") + "）：";
    return head + "\n" + lines.join("\n");
  }

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
      if (res.ok && res.run_id) await afterManualFetch(res.run_id, (args && args.packs) || "all");
      const snap = await snapshotOf(cfg, p);
      return { ok: res.ok, stage: res.stage, run_id: res.run_id, tail: res.tail, snapshot: { window_hours: snap.window_hours, latest_run: snap.latest_run, categories: snap.categories, failed: snap.failed.map((f) => ({ source_id: f.source_id, error_kind: f.error_kind, hint: f.hint })), digest_path: snap.digest_path } };
    },
  });

  tool({
    name: "newswire_cycle",
    description: "Run one full cycle (used by the scheduled task): fetch every enabled source from its continuity checkpoint (gaps are recovered by paging or search; 6 hours or more since the last cycle, or before 08:00, runs in overnight mode and fetches more) → classify, cluster cross-source events and score them → write the digest → lay out the edition (in LLM mode a model reads the news, groups, ranks and writes it; in economy mode the program does) → pick the new or upgraded top stories → return `message`, the text to send to the phone (one line when nothing qualifies, with open gaps and repeatedly failing sources appended). With the push timing set to when_ready, the scheduled call only fetches and returns an empty `message`; the plugin runs the same task again once the edition is written, and that call returns the push. In a scheduled task, reply with `message` verbatim, and reply nothing when it is empty.",
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
      return await dailyRun(args);
    },
  });

  tool({
    name: "newswire_story",
    description: "One storyline in full: its current copy, every report in time order (source, time, title, link, and the opening of its text), the developments recorded edition by edition, its pushes, and the latest detailed report if the reader generated one (overview, timeline, key numbers, who said what, background, open questions; every sentence checked against the reports). Storyline ids come from newswire_edition. Use it to answer 'what happened with X so far'.",
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
      const st = withDb(p, (db) => {
        const d = db ? storyDetail(db, String((args && args.id) || "")) : null;
        if (d) d.detail = latestDetail(db, d.id);
        return d;
      });
      // 每篇报道的原文只给开头（整条故事线可能几十篇），要细节看 detail（详细报道，读者在面板里生成过才有）
      if (st) for (const it of st.items) if (it.text && it.text.length > 200) it.text = it.text.slice(0, 199) + "…";
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
        await editFollows((f) => updateFollows(f, a.action, a.kind, String(a.value), strOrNull(a.name)));
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
        withDb(p, (db) => { if (db) void background(syncTrackerFollows(db, r.id, r.stories), "tracker follows"); });
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
    description: "Read or change how often and how much news is pushed to the phone. cadence: every2h (07–21) / every4h (8, 12, 16, 20) / thrice (8, 12, 18) / daily_only (no rounds, only the evening recap) — changing it updates the scheduled task if one exists. level: fewer (higher bar) / normal / more. per_round: max stories per push (1–15). daily_max: max stories per day (1–100). timing: on_time (push at the scheduled time; if the model has not finished, push the latest written edition) / when_ready (fetch at the scheduled time, push once this round's edition is written, usually 10–20 minutes later). scope: picked (stories over the bar, within the limits) / full (every new story and every story with new reports this round, ignoring the bar and limits). format: brief (each item is a headline, one sentence and its sources; the reader replies with the item number to expand it) / full (key stories carry points and impact). delivery: auto (when the chat bridge plugin offers its phonePush service, the plugin posts to the phone itself on the task's schedule and pauses the scheduled task, so no model relays the text; otherwise through the scheduled task) / task (always through the scheduled task). With no arguments, returns the current settings, per-section adjustments learned from the reader's feedback, and `health`: a step-by-step check of the push path (which route is in use, what is broken and how to fix it).",
    parameters: { type: "object", additionalProperties: false, properties: {
      cadence: { type: "string", enum: Object.keys(CADENCES) }, level: { type: "string", enum: Object.keys(LEVELS) },
      per_round: { type: "number" }, daily_max: { type: "number" }, timing: { type: "string", enum: TIMINGS }, scope: { type: "string", enum: SCOPES }, delivery: { type: "string", enum: DELIVERIES }, format: { type: "string", enum: FORMATS } } },
    timeoutMs: 30000,
    output: {
      schema: { type: "object", additionalProperties: true, required: ["prefs"], properties: { prefs: { type: "object" } } },
      render: (_a, v) => [{ type: "text", text: "推送节奏：" + (CADENCES[v.prefs.cadence] || {}).label + "｜档位：" + v.prefs.level + "｜每轮最多 " + v.prefs.per_round + " 条｜每天最多 " + v.prefs.daily_max + " 条｜" + (v.prefs.timing === "when_ready" ? "写完再推" : "到点推送") + "｜" + (v.prefs.scope === "full" ? "本轮新内容全推" : "挑重点") + (v.schedule_note ? "\n" + v.schedule_note : "") + (v.health ? "\n推送链路：" + v.health.summary + v.health.steps.filter((x) => !x.ok && x.fix).map((x) => "\n✗ " + x.text + "：" + x.fix).join("") : "") }],
    },
    async execute(args) {
      const a = args || {};
      const changed = ["cadence", "level", "per_round", "daily_max", "timing", "scope", "delivery", "format"].some((k) => a[k] !== undefined);
      if (!changed) { const v = await pushView(); return { prefs: v.prefs, penalties: v.penalties, task: v.task, health: v.health }; }
      const r = await applyPush(a);
      return { prefs: r.prefs, schedule_note: r.schedule ? r.schedule.note : null };
    },
  });

  tool({
    name: "newswire_reply",
    description: "Handle the reader's reply to a news push. Every pushed item carries a number that is unique for the day; the reader replies with that number, optionally followed by a short word: `3` expands item 3 (lead, all points, views, impact, sources); `3 详` sends its detailed report (written in the background if there is none yet, a few minutes on a local model); `3 有用` / `3 没用` records feedback that tunes what gets pushed; `3 追踪` follows the story. Pass the reader's message verbatim as `text`. When the result has `sent: true` the plugin has already posted the answer to the phone itself: do not repeat it, reply with just `✓`. Otherwise reply with `message` verbatim.",
    parameters: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", description: "The reader's message, verbatim, e.g. \"3\" or \"12 没用\"" } } },
    timeoutMs: 60000,
    output: {
      schema: { type: "object", additionalProperties: true, required: ["ok"], properties: { ok: { type: "boolean" }, message: { type: "string" }, sent: { type: "boolean" } } },
      render: (_a, v) => [{ type: "text", text: v.sent ? "已直接发到手机（第 " + v.n + " 条：" + (v.title || "") + "）" : v.message || "" }],
    },
    async execute(args) { await ensureData(p); return handleReply(String((args && args.text) || "")); },
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
    description: "Status of the latest run, including `flow`: which step the current round is on (fetch → edition → push), how long it has taken and roughly how long is left, or how the last round ended. Use it when the user asks how far the news is or why a push has not arrived. Also: run id and time, whether it is stale (>26h), counts per category, hot keywords, failed sources with error_kind and hint, digest path and excerpt. Always cite the data time; not investment advice.",
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
          value.flow ? value.flow : "",
          String(value.disclaimer ?? DISCLAIMER),
        ].join("\n"),
      }],
    },
    async execute() {
      await ensureData(p);
      return Object.assign(await snapshotOf(cfg, p), { flow: flowText() });
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
    text: "The dsh-newswire plugin keeps a local news store. For news, read newswire_snapshot / newswire_items first (stored items with source-reported heat signals); fetch a round with newswire_run only when that is not enough. To see which stories several outlets carry and how credible they are, use newswire_events / newswire_event; for a laid-out overview of what happened and what is worth watching, read newswire_edition (sections, leads, key points, items to verify; in LLM mode written by a model from the stored news, so check facts against the events). Scheduled pushes are set up with newswire_schedule_setup and each round runs newswire_cycle; when the user asks for a nightly news recap (e.g. 「每晚推送新闻回顾」), call newswire_schedule_setup with kind \"daily\"; when they want fewer, more, or differently timed pushes (e.g. 「推少一点」「晚上别推」「一天三次就行」), use newswire_push_prefs. To explain what an important story could lead to (impact on markets, companies, technology; possible scenarios), use newswire_analyze. To follow a company, technology, person or theme over weeks and get a synthesized view of its trend and implications (e.g. 「追踪英伟达」「帮我盯着固态电池」), use newswire_track. Add or remove sources with newswire_source_upsert / newswire_source_remove after trying them with newswire_source_test. Fetching tries browse first and falls back per source, recording error_kind and hint. Cite the outlet and data time for every news item (time_confidence=fetched means the time is approximated by the fetch time); mark financial content as not investment advice. Pushed news items are numbered; when the user's whole message is such a number, optionally followed by one short word (e.g. `3`, `3 详`, `12 没用`, `5 有用`, `7 追踪`), call newswire_reply with the message verbatim, then reply with just `✓` if the result has sent=true, otherwise with its `message` verbatim.",
    interpolate: false,
  }));
}
