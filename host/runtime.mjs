/**
 * 模型运行时：和大模型深度结合，同时省 token。
 *
 * 模型投入（depth）：节省 / 均衡 / 深度——决定每份版面让模型读多少、写多少、自动分析几篇、译多少外文标题。
 * 不限：在深度之上，网页类的源每轮都由模型直接读页面（见 host/modelread.mjs），不受每日 token 预算限制。
 * 速度自适应：并发数由实测决定（服务端真能并行就 3，本地单卡就 1）。
 * 账本：每次调用的步骤、耗时、输入 / 输出 / 缓存命中 token 都记下；可设每天的 token 预算，用完了模型步骤退回程序结果。
 */
export const DEPTHS = {
  lean: { maxItems: 100, maxStories: 8, autoAnalyze: 0, translate: 30, track: 1, label: "节省" },
  balanced: { maxItems: 150, maxStories: 16, autoAnalyze: 2, translate: 60, track: 2, label: "均衡" },
  deep: { maxItems: 220, maxStories: 24, autoAnalyze: 4, translate: 120, track: 4, label: "深度" },
  full: { maxItems: 400, maxStories: 40, autoAnalyze: 8, translate: 300, track: 8, modelRead: true, unlimited: true, label: "不限" },
};
export const depthOf = (prefs) => (DEPTHS[prefs && prefs.depth] ? prefs.depth : "balanced");
export const depthParams = (prefs) => DEPTHS[depthOf(prefs)];

const bjMidnight = () => {
  const bj = new Date(Date.now() + 8 * 3600000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
};

export function recordCall(db, r) {
  db.prepare("INSERT INTO llm_calls (at, step, model, ms, tokens_in, tokens_out, tokens_cache, estimated, ok, error) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString().replace("T", " ").slice(0, 19), r.step, r.model, r.ms, r.in, r.out, r.cache, r.est ? 1 : 0, r.ok ? 1 : 0, r.error);
}

/** 今天（北京时间）用了多少；按步骤分。 */
export function usageToday(db) {
  const since = bjMidnight();
  const t = db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(tokens_cache),0) tcache, COALESCE(SUM(ms),0) ms, MAX(estimated) est FROM llm_calls WHERE at >= ?").get(since);
  const steps = db.prepare("SELECT step, COUNT(*) calls, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(tokens_cache) tcache, SUM(ms) ms FROM llm_calls WHERE at >= ? GROUP BY step ORDER BY SUM(tokens_in + tokens_out) DESC").all(since);
  return { calls: t.calls, tokens_in: t.tin, tokens_out: t.tout, tokens_cache: t.tcache, total: t.tin + t.tout + t.tcache, ms: t.ms, estimated: Boolean(t.est),
    cache_rate: t.tin + t.tcache ? Math.round((100 * t.tcache) / (t.tin + t.tcache)) : null, steps: steps.map((x) => Object.assign({}, x)) };
}

/** 预算闸门：今天用量超过 daily_tokens 就拦。用一个短缓存，免得每次调用都查库。 */
export function makeGate(getDb, getPrefs) {
  let cache = { at: 0, total: 0 };
  return () => {
    const pr = getPrefs() || {};
    const limit = Number(pr.daily_tokens) || 0;
    if (!limit || (DEPTHS[pr.depth] && DEPTHS[pr.depth].unlimited)) return null;
    if (Date.now() - cache.at > 30000) {
      try { const db = getDb(); if (db) { cache = { at: Date.now(), total: usageToday(db).total }; db.close(); } } catch { /* 查不到就放行 */ }
    }
    return cache.total >= limit ? "token_budget" : null;
  };
}
