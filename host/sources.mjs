/**
 * 源的取舍：每个源值不值得开，用数据说话。
 *
 * 近 N 天（默认 7）每个源：
 *   n         入库的新闻条数（广告、合集原稿不算）
 *   full      内容完整的条数
 *   promo     被判为广告与引流的条数
 *   corrob    与别家报道了同一件事（事件 ≥ 2 家）
 *   first     在多家报道的事件里是最早的那家（首报）
 *   exclusive 只有它报道、但重要度 ≥ 45 的（独家）
 *   low       重要度 < 20 的（低价值）
 *   board     上过版面的条数（所在报道出现在版面的头版或版块里）
 *   fetch_ok  抓取成功的轮次占比
 *
 * 结论（verdict）与建议状态（suggest）：
 *   core       上版多或首报 / 独家多：开
 *   support    主要为别家提供印证：开
 *   ok         一般：已开的保持，关着的先试用
 *   low        绝大多数是低价值、几乎不与别家重合：还能偶尔印证的试用，从不重合的关
 *   unstable   一半以上的轮次抓取失败：关，先修抓取
 *   insufficient 数据太少：试用
 *
 * 状态：on（正常）｜ trial（试用：照常抓取并参与印证，但不能单独让一件事上版或推送）｜ off（停用）
 */
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function sourceState(s) {
  if (!s || s.removed_at || s.enabled === false) return "off";
  return s.trial ? "trial" : "on";
}

/** 版面上出现过的故事线 id（头版与各版块）。 */
function boardStories(db, sinceIso) {
  const ids = new Set();
  for (const r of db.prepare("SELECT content FROM editions WHERE created_at >= ?").all(sinceIso)) {
    const c = parseJ(r.content, null);
    if (!c) continue;
    for (const id of c.front || []) ids.add(id);
    for (const sec of c.sections || []) for (const id of sec.stories || []) ids.add(id);
  }
  return ids;
}

export function sourceScores(db, o) {
  const days = Math.max(1, Number(o && o.days) || 7);
  const since = new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare(`SELECT a.source_id, a.id, a.kind, a.completeness, e.source_count, e.importance, e.lead_article_id, si.story_id, m.repost_of
    FROM articles a LEFT JOIN event_members m ON m.article_id = a.id LEFT JOIN events e ON e.event_id = m.event_id
      LEFT JOIN story_items si ON si.article_id = a.id
    WHERE a.first_seen_at >= ?`).all(since);
  const board = boardStories(db, since);
  const by = new Map();
  const get = (id) => { if (!by.has(id)) by.set(id, { n: 0, full: 0, promo: 0, corrob: 0, first: 0, exclusive: 0, low: 0, board: 0 }); return by.get(id); };
  for (const r of rows) {
    const x = get(r.source_id);
    if (r.kind === "promo") { x.promo++; continue; }
    if (r.kind === "digest" || r.kind === "ticker") continue;
    x.n++;
    if (r.completeness === "full") x.full++;
    const sc = Number(r.source_count || 0);
    const imp = Number(r.importance || 0);
    // 转载别家的不算印证
    if (r.repost_of) { x.reposts = (x.reposts || 0) + 1; if (imp < 20) x.low++; continue; }
    if (sc > 1) x.corrob++;
    if (sc > 1 && r.lead_article_id === r.id) x.first++;
    if (sc === 1 && imp >= 45) x.exclusive++;
    if (imp < 20) x.low++;
    if (r.story_id && board.has(r.story_id)) x.board++;
  }
  const fetch = new Map(db.prepare(`SELECT source_id, COUNT(DISTINCT run_id) runs, COUNT(DISTINCT CASE WHEN ok = 1 THEN run_id END) ok
    FROM fetch_attempts WHERE attempted_at >= ? GROUP BY source_id`).all(since).map((r) => [r.source_id, r]));
  const meta = db.prepare("SELECT id, name, category, pack, enabled, removed_at, trial FROM sources").all();
  // 实际有数据的天数（新装或刚恢复的源不足 7 天）：按它折算每天的贡献
  const span = new Map(db.prepare("SELECT source_id, MIN(first_seen_at) a, MAX(first_seen_at) b FROM articles WHERE first_seen_at >= ? GROUP BY source_id").all(since).map((r) => [r.source_id, Math.max(1, (Date.parse(r.b.replace(" ", "T") + "Z") - Date.parse(r.a.replace(" ", "T") + "Z")) / 86400000)]));
  return meta.map((s) => {
    const x = get(s.id);
    const f = fetch.get(s.id) || { runs: 0, ok: 0 };
    const fetchOk = f.runs ? f.ok / f.runs : null;
    const share = (k) => (x.n ? x[k] / x.n : 0);
    const state = s.removed_at || !s.enabled ? "off" : s.trial ? "trial" : "on";
    let verdict;
    // 量大的源比例会被摊薄（财联社一天几十条）：比例与每天的绝对贡献，满足其一即可
    const d = Math.min(days, span.get(s.id) || days);
    const perDay = (k) => x[k] / d;
    if (f.runs >= 3 && fetchOk < 0.5) verdict = "unstable";
    else if (x.n < 5) verdict = "insufficient";
    else if (share("board") >= 0.25 || perDay("board") >= 4 || (x.first + x.exclusive) >= Math.max(3, 0.15 * x.n) || (x.first + x.exclusive) / d >= 3) verdict = "core";
    else if (share("corrob") >= 0.25 || perDay("corrob") >= 3 || perDay("board") >= 2) verdict = "support";
    else if (share("low") >= 0.75 && share("corrob") < 0.15) verdict = "low";
    else verdict = "ok";
    // 低价值但还能为别家印证的：试用（只印证、不添乱）；从不与别家重合的：关
    const suggest = verdict === "core" || verdict === "support" ? "on"
      : verdict === "low" ? (x.corrob > 0 ? "trial" : "off")
      : verdict === "unstable" ? "off"
      : verdict === "insufficient" ? (state === "off" ? "trial" : state)
      : state === "off" ? "trial" : state;
    // 排序分：上版、首报、独家最值钱，印证次之，低价值与广告扣分
    const score = x.n ? Math.round(100 * Math.max(0, Math.min(1, (2 * x.board + 2 * x.first + 2 * x.exclusive + x.corrob - 0.5 * x.low - 2 * x.promo) / (x.n * 1.5) + 0.3))) : 0;
    return { id: s.id, name: s.name || s.id, category: s.category, pack: s.pack, state, verdict, suggest, score, days,
      n: x.n, per_day: Math.round((x.n / Math.min(days, span.get(s.id) || days)) * 10) / 10, full: x.full, reposts: x.reposts || 0, promo: x.promo, corrob: x.corrob, first: x.first, exclusive: x.exclusive, low: x.low, board: x.board,
      fetch_ok: fetchOk == null ? null : Math.round(fetchOk * 100) };
  }).sort((a, b) => ["on", "trial", "off"].indexOf(a.state) - ["on", "trial", "off"].indexOf(b.state) || b.score - a.score);
}

/** 改一个源的状态（写配置对象，调用方负责落盘）。@returns 改后的源，或 null */
export function setSourceState(doc, id, state) {
  const s = (doc.sources || []).find((x) => x.id === id);
  if (!s || !["on", "trial", "off"].includes(state)) return null;
  if (state === "off") { s.enabled = false; delete s.trial; }
  else { s.enabled = true; delete s.removed_at; if (state === "trial") s.trial = true; else delete s.trial; }
  return s;
}
