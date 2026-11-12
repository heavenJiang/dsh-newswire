/**
 * 一轮的流程与进度：抓取 → 编版面 → 推送，每一步在做什么、做到第几个、用了多久、预计还要多久。
 * 面板按它画流程图（当前在哪一步一眼看得出）。
 *
 * 一轮（flow）由触发它的地方开（定时、手动抓取、预编排、重新编排、写完再推）；后面的步骤沿用同一轮（按 run_id 找）。
 * 每一步：pending → running → done / skipped / failed，带 detail（一句话）、done/total（计数）、items（如各源的成败）。
 * 预计时间：每一步最近 8 次实际耗时的中位数（存 kv「flow_stats」）；上一轮的完整流程存 kv「flow_last」，重启后面板照样看得到。
 */

/** 三段 12 步。phase 用来在面板上分组；model 为真的步骤在节省模式下跳过。 */
export const STEPS = [
  { id: "prep", phase: "fetch", label: "准备通道" },
  { id: "sources", phase: "fetch", label: "抓取各源" },
  { id: "clean", phase: "fetch", label: "清洗与拆条" },
  { id: "events", phase: "fetch", label: "分类与聚类" },
  { id: "bodies", phase: "fetch", label: "补正文" },
  { id: "translate", phase: "edition", label: "译外文标题", model: true },
  { id: "group", phase: "edition", label: "归并故事线", model: true },
  { id: "plan", phase: "edition", label: "统筹头版", model: true },
  { id: "write", phase: "edition", label: "写稿", model: true },
  { id: "check", phase: "edition", label: "逐句核对" },
  { id: "save", phase: "edition", label: "组版存档" },
  { id: "push", phase: "push", label: "发到手机" },
];
export const PHASES = [
  { id: "fetch", label: "抓取" },
  { id: "edition", label: "编版面" },
  { id: "push", label: "推送" },
];
/** 各种触发方式走哪几段。 */
export const KINDS = {
  cycle: { label: "定时一轮", phases: ["fetch", "edition", "push"] },
  manual: { label: "手动抓取", phases: ["fetch", "edition", "push"] },
  prewarm: { label: "推送前预编排", phases: ["fetch", "edition"] },
  refresh: { label: "重新编排", phases: ["edition"] },
  deliver: { label: "推送", phases: ["push"] },
};

const now = () => Date.now();
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * @param o { load(key) → value|null, save(key, value) } 存取 kv（可省：只在内存里）
 */
export function createProgress(o) {
  const load = (k) => { try { return o && o.load ? o.load(k) : null; } catch { return null; } };
  const save = (k, v) => { try { if (o && o.save) o.save(k, v); } catch { /* 记不下不影响流程 */ } };
  let active = null;
  let last = load("flow_last");
  let stats = load("flow_stats") || {};

  function makeFlow(kind, meta) {
    const k = KINDS[kind] || KINDS.manual;
    const steps = STEPS.filter((s) => k.phases.includes(s.phase)).map((s) => ({ id: s.id, phase: s.phase, label: s.label, status: "pending", detail: "", done: null, total: null, items: null, started: 0, ended: 0 }));
    return { id: (meta && meta.runId) || kind + "-" + now(), kind, label: k.label, pack: (meta && meta.pack) || null, model: Boolean(meta && meta.model), started: now(), ended: 0, touched: now(), outcome: null, note: "", steps };
  }
  const stepOf = (flow, id) => { if (flow) flow.touched = now(); return flow ? flow.steps.find((s) => s.id === id) : null; };
  /** 多久没有动静就当这一轮已经断了（宿主重启、某条路径漏了收尾），免得面板一直显示「进行中」。 */
  const STALL_MS = 45 * 60000;
  function close(flow, outcome, note) {
    if (!flow || flow.ended) return;
    const t = now();
    for (const s of flow.steps) {
      if (s.status === "running") { s.status = outcome === "failed" ? "failed" : "done"; s.ended = t; }
      else if (s.status === "pending") s.status = "skipped";
    }
    flow.ended = t;
    flow.outcome = outcome || "done";
    if (note) flow.note = note;
    // 记各步的实际耗时（跑完的、用时超过 1 秒的才算，跳过的不算）
    for (const s of flow.steps) {
      if (s.status !== "done" || !s.started || !s.ended || s.ended - s.started < 1000) continue;
      const key = s.id + (s.phase === "edition" ? (flow.model ? ":llm" : ":rules") : "");
      stats[key] = (stats[key] || []).concat(s.ended - s.started).slice(-8);
    }
    save("flow_stats", stats);
    last = view1(flow);
    save("flow_last", last);
    if (active === flow) active = null;
  }

  const api = {
    /**
     * 开一轮。已有一轮在跑：同一个 run_id 就接着用；不然把旧的收掉（不会同时有两轮抓取，旧的多半是没收尾的）。
     * @param meta { runId, pack, model: 这一轮编版面用不用模型 }
     */
    begin(kind, meta) {
      if (active && meta && meta.runId && active.id === meta.runId) return active;
      if (active) close(active, "replaced");
      active = makeFlow(kind, meta);
      return active;
    },
    /** 接着已有的一轮（run_id 对得上）；对不上就新开一轮。用于版面、推送这些后面的段落。 */
    attach(kind, meta) {
      if (active && (!meta || !meta.runId || active.id === meta.runId)) {
        // 后面的段落还没在这一轮里：补上（比如预编排后又要推送）
        const k = KINDS[kind] || KINDS.manual;
        for (const st of STEPS.filter((s) => k.phases.includes(s.phase))) if (!stepOf(active, st.id)) active.steps.push({ id: st.id, phase: st.phase, label: st.label, status: "pending", detail: "", done: null, total: null, items: null, started: 0, ended: 0 });
        if (meta && "model" in meta) active.model = Boolean(meta.model);
        return active;
      }
      return api.begin(kind, meta);
    },
    /** 一步开始（前面还在跑的步骤顺带收掉）。 */
    start(id, patch) {
      const s = stepOf(active, id);
      if (!s) return;
      const t = now();
      for (const x of active.steps) {
        if (x === s) break;
        if (x.status === "running") { x.status = "done"; x.ended = t; }
        if (x.status === "pending") x.status = "skipped";
      }
      if (s.status !== "running") { s.status = "running"; s.started = t; s.ended = 0; }
      Object.assign(s, patch || {});
    },
    /** 更新这一步的计数和一句话。 */
    update(id, patch) { const s = stepOf(active, id); if (s) Object.assign(s, patch || {}); },
    done(id, patch) { const s = stepOf(active, id); if (!s) return; if (!s.started) s.started = now(); s.status = "done"; s.ended = now(); Object.assign(s, patch || {}); },
    /** 按引擎记的时间补齐一步（跑得太快、宿主没读到的）。 */
    stamp(id, started, ended) {
      const s = stepOf(active, id);
      if (!s || !started) return;
      s.started = started;
      if (ended) { s.ended = ended; if (s.status !== "failed") s.status = "done"; }
    },
    skip(id, why) { const s = stepOf(active, id); if (!s || s.status === "done") return; s.status = "skipped"; s.ended = now(); s.detail = why || ""; },
    fail(id, why) { const s = stepOf(active, id); if (!s) return; if (!s.started) s.started = now(); s.status = "failed"; s.ended = now(); s.detail = why || ""; },
    /** 收尾。outcome：done / failed / skipped。 */
    finish(outcome, note) { if (active) close(active, outcome, note); },
    /** 这一轮的 id（没有在跑的返回 null）。 */
    activeId: () => (active ? active.id : null),
    view() {
      if (active && now() - active.touched > STALL_MS) close(active, "stalled", "很久没有动静，这一轮可能中断了");
      return { active: active ? view1(active) : null, last };
    },
  };

  /** 给面板：每步加上用时与预计时间，整轮加上进度百分比和预计剩余。 */
  function view1(flow) {
    const t = flow.ended || now();
    let spent = 0, left = 0;
    const steps = flow.steps.map((s) => {
      const key = s.id + (s.phase === "edition" ? (flow.model ? ":llm" : ":rules") : "");
      const est = median(stats[key] || []);
      const ms = s.started ? (s.ended || t) - s.started : 0;
      if (s.status === "done" || s.status === "failed") spent += ms;
      else if (s.status === "running") { spent += ms; left += est != null ? Math.max(est - ms, est * 0.1) : 0; }
      else if (s.status === "pending") left += est || 0;
      return Object.assign({}, s, { started: iso(s.started), ended: iso(s.ended), ms, est });
    });
    const current = steps.find((s) => s.status === "running") || null;
    // 进度：剩下的步骤里有历史耗时就按时间算（一秒内跑完的步骤不记耗时，算 0）；
    // 一个都没有（第一次跑、换了模式）就按步数算，免得一开始就显示 99%
    const open = steps.filter((s) => s.status === "running" || s.status === "pending");
    const timed = open.length > 0 && open.some((s) => s.est != null);
    let pct;
    if (timed && spent + left > 0) pct = Math.round((100 * spent) / (spent + left));
    else {
      const live = steps.filter((s) => s.status !== "skipped");
      const doneN = live.filter((s) => s.status === "done" || s.status === "failed").length + (current ? (current.total ? Math.min(1, (current.done || 0) / current.total) : 0.5) : 0);
      pct = live.length ? Math.round((100 * doneN) / live.length) : 0;
    }
    pct = Math.max(1, Math.min(99, pct));
    return { id: flow.id, kind: flow.kind, label: flow.label, pack: flow.pack, model: flow.model, started: iso(flow.started), ended: iso(flow.ended), outcome: flow.outcome, note: flow.note,
      ms: t - flow.started, pct: flow.ended ? 100 : pct, eta_ms: flow.ended || !timed ? 0 : Math.round(left), current: current ? current.id : null, steps };
  }
  return api;
}

/** 引擎写的进度文件 → 「抓取」各步的状态。 */
export function applyEngineProgress(pg, j) {
  if (!j || typeof j !== "object") return;
  const order = ["prep", "sources", "clean", "events", "bodies"];
  if (order.indexOf(j.stage) < 0 && j.stage !== "done") return;
  // 先按引擎记的时间补齐已经走过的步骤，再标当前这一步
  const m = j.marks || {};
  const seen = order.filter((id) => m[id]);
  seen.forEach((id, i) => { if (id !== j.stage) pg.stamp(id, m[id], m[seen[i + 1]] || m.done || Date.now()); });
  if (j.stage === "done") return;
  pg.start(j.stage);
  if (j.stage === "sources" && j.sources) {
    const x = j.sources;
    pg.update("sources", { done: x.done, total: x.total, detail: x.current ? "正在抓：" + x.current : x.failed ? "失败 " + x.failed + " 个" : "", items: (x.list || []).slice(0, 40) });
  }
  if (j.detail) pg.update(j.stage, { detail: String(j.detail).slice(0, 80) });
}
