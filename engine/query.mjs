/**
 * 读查询（插件工具与面板路由共用，只此一份）。所有函数接受已打开的 db，可为 null（库还没建）。
 */
import { existsSync } from "node:fs";
import { openDb } from "./store/schema.mjs";
import { isoUtc } from "./util/text.mjs";
import { scrub } from "./channels/classify.mjs";

/** 库存在才打开（会顺带迁移到最新版本）；不存在返回 null。 */
export function openIfExists(dbPath) {
  return existsSync(dbPath) ? openDb(dbPath) : null;
}

export function sinceIso(hours) { return isoUtc(Date.now() - hours * 3600 * 1000); }

export function latestRun(db) {
  if (!db) return null;
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get() ?? null;
}

export function recentRuns(db, limit) {
  if (!db) return [];
  return db.prepare("SELECT run_id, started_at, finished_at, mode, sources_total, sources_ok, sources_failed, items_raw, items_new, items_dup, notes FROM runs ORDER BY started_at DESC LIMIT ?").all(limit || 5);
}

export function countsByCategory(db, since) {
  if (!db) return [];
  return db.prepare("SELECT category, COUNT(*) AS n FROM articles WHERE COALESCE(published_at, last_seen_at) >= ? GROUP BY category ORDER BY n DESC").all(since).map((r) => ({ category: r.category, n: r.n }));
}

const KEY = ["关税", "制裁", "美联储", "降息", "加息", "CPI", "PPI", "央行", "外汇储备", "回购", "增资", "IPO", "AI", "算力", "机器人", "芯片", "数据中心", "中东", "伊朗", "以色列", "乌克兰", "俄罗斯", "选举", "黄金", "原油", "汇率", "并购", "重组", "银行", "新能源"];

export function keywords(db, since, top) {
  if (!db) return [];
  const kc = {};
  for (const r of db.prepare("SELECT title, summary FROM articles WHERE COALESCE(published_at, last_seen_at) >= ?").all(since)) {
    const hay = (String(r.title || "") + " " + String(r.summary || "")).toLowerCase();
    for (const k of KEY) if (hay.includes(k.toLowerCase())) kc[k] = (kc[k] || 0) + 1;
  }
  return Object.entries(kc).sort((a, b) => b[1] - a[1]).slice(0, top || 14).map((e) => ({ tag: e[0], n: e[1] }));
}

export function failureRows(db, runId, limit) {
  if (!db || !runId) return [];
  return db.prepare("SELECT source_id, channel, backend, http_status, error_kind, error, hint, attempted_at FROM fetch_attempts WHERE run_id = ? AND ok = 0 ORDER BY source_id, id LIMIT ?").all(runId, limit || 40).map((r) => ({
    source_id: r.source_id, channel: r.channel, backend: r.backend ?? null, http_status: r.http_status ?? null,
    error_kind: r.error_kind ?? null, error: scrub(r.error || "").slice(0, 240), hint: r.hint ?? null, attempted_at: r.attempted_at,
  }));
}

export function attemptRows(db, runId, limit) {
  if (!db || !runId) return [];
  return db.prepare("SELECT source_id, channel, backend, ok, http_status, bytes, items, latency_ms, error_kind, error, hint, note, attempted_at FROM fetch_attempts WHERE run_id = ? ORDER BY source_id, id LIMIT ?").all(runId, limit || 120).map((r) => ({
    source_id: r.source_id, channel: r.channel, backend: r.backend ?? null, ok: r.ok === 1, http_status: r.http_status ?? null, bytes: r.bytes ?? null, items: r.items ?? null,
    latency_ms: r.latency_ms == null ? null : Math.round(r.latency_ms), error_kind: r.error_kind ?? null, error: scrub(r.error || "").slice(0, 300), hint: r.hint ?? null, note: r.note ?? null, attempted_at: r.attempted_at,
  }));
}

/** 每源健康度 + 实际出现过的热度信号。 */
export function sourceHealth(db) {
  if (!db) return {};
  const out = {};
  for (const r of db.prepare("SELECT source_id, COUNT(*) AS tries, SUM(ok) AS ok, MAX(attempted_at) AS last_try, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_ms FROM fetch_attempts GROUP BY source_id").all()) {
    out[r.source_id] = { tries: r.tries ?? 0, ok: r.ok ?? 0, last_try: r.last_try ?? null, avg_latency_ms: r.avg_ms == null ? null : Math.round(r.avg_ms), last_error_kind: null, last_ok_channel: null, signals: [] };
  }
  for (const r of db.prepare("SELECT f.source_id, f.ok, f.channel, f.error_kind FROM fetch_attempts f JOIN (SELECT source_id, MAX(id) AS id FROM fetch_attempts GROUP BY source_id, ok) x ON x.id = f.id").all()) {
    const h = out[r.source_id];
    if (!h) continue;
    if (r.ok === 1) h.last_ok_channel = r.channel; else h.last_error_kind = r.error_kind;
  }
  for (const r of db.prepare("SELECT source_id, signal, seen_count, last_seen_at FROM signal_availability ORDER BY source_id, signal").all()) {
    if (!out[r.source_id]) out[r.source_id] = { tries: 0, ok: 0, last_try: null, avg_latency_ms: null, last_error_kind: null, last_ok_channel: null, signals: [] };
    out[r.source_id].signals.push(r.signal);
  }
  return out;
}

/** FTS5 trigram 至少 3 个字符才能命中；更短的词（如「央行」）退回 LIKE。 */
function ftsPhrase(q) { return '"' + String(q).replace(/"/g, '""') + '"'; }

/**
 * 条目查询：category / source / pack / query / hours / hot_only / limit / before（游标：上一页最后一条的 t）。
 * 每条附最近一次观测的热度信号。
 */
export function itemRows(db, opts) {
  if (!db) return [];
  const where = ["COALESCE(a.published_at, a.last_seen_at) >= ?"];
  const args = [opts.since];
  if (opts.category) { where.push("a.category = ?"); args.push(opts.category); }
  if (opts.source) { where.push("a.source_id = ?"); args.push(opts.source); }
  if (opts.pack) { where.push("a.pack = ?"); args.push(opts.pack); }
  if (opts.label) { where.push("a.id IN (SELECT article_id FROM article_labels WHERE label = ? OR label LIKE ? || '.%')"); args.push(opts.label, opts.label); }
  if (opts.before) { where.push("COALESCE(a.published_at, a.last_seen_at) < ?"); args.push(opts.before); }
  if (opts.query) {
    const q = String(opts.query).trim();
    if ([...q].length >= 3) { where.push("a.rowid IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)"); args.push(ftsPhrase(q)); }
    else { where.push("(a.title LIKE ? OR a.summary LIKE ?)"); args.push("%" + q + "%", "%" + q + "%"); }
  }
  if (opts.hotOnly) where.push("(o.hot IS NOT NULL OR o.level IS NOT NULL)");
  // 默认只看新闻（广告、行情跳动、合集原稿不进快讯流；想看可以打开「显示已过滤」）
  if (!opts.allKinds) where.push("COALESCE(a.kind, 'news') IN ('news', 'digest_item')");
  const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 400);
  const sql = "SELECT a.id, a.title, a.title_zh, a.kind, a.url, a.source_id, s.name AS source_name, a.category, a.pack, a.time_confidence, COALESCE(a.published_at, a.last_seen_at) AS t, substr(CASE WHEN EXISTS (SELECT 1 FROM article_bodies b WHERE b.article_id = a.id AND b.ok = 1) THEN a.content ELSE COALESCE(NULLIF(a.summary, ''), a.content, '') END, 1, 260) AS summary, a.channel, a.paywalled, "
    + "o.views, o.comments, o.likes, o.shares, o.favorites, o.hot, o.level, o.rank, o.section "
    + "FROM articles a LEFT JOIN sources s ON s.id = a.source_id "
    + "LEFT JOIN observations o ON o.rowid = (SELECT rowid FROM observations WHERE article_id = a.id ORDER BY seen_at DESC LIMIT 1) "
    + "WHERE " + where.join(" AND ") + " ORDER BY t DESC LIMIT ?";
  return db.prepare(sql).all(...args, limit).map((r) => ({
    id: r.id, time: r.t, time_confidence: r.time_confidence || null, source: r.source_name || r.source_id, source_id: r.source_id, category: r.category, pack: r.pack || "core",
    title: r.title, title_zh: r.title_zh || null, kind: r.kind || "news", summary: r.summary || "", channel: r.channel, paywalled: r.paywalled === 1, url: r.url,
    signals: { views: r.views ?? null, comments: r.comments ?? null, likes: r.likes ?? null, shares: r.shares ?? null, favorites: r.favorites ?? null, hot: r.hot ? JSON.parse(r.hot) : [], level: r.level ?? null, rank: r.rank ?? null, section: r.section ?? null },
  }));
}

/** 一条新闻在各轮的热度轨迹（排名与计数随时间变化）。 */
export function signalTrail(db, articleId, limit) {
  if (!db) return [];
  return db.prepare("SELECT run_id, source_id, rank, page, section, views, comments, likes, shares, favorites, hot, level, channel, seen_at FROM observations WHERE article_id = ? ORDER BY seen_at LIMIT ?").all(articleId, limit || 200)
    .map((r) => Object.assign({}, r, { hot: r.hot ? JSON.parse(r.hot) : [] }));
}

/** 某轮每源的衔接状态（first / connected / connected_time / gap_filled / gap_partial / gap_open / snapshot / failed）。 */
export function continuityRows(db, runId) {
  if (!db || !runId) return [];
  return db.prepare("SELECT source_id, status, overlap, pages, backfilled, gap_from, gap_to, note FROM continuity WHERE run_id = ? ORDER BY source_id").all(runId);
}

export function continuitySummary(db, runId) {
  const out = {};
  for (const r of continuityRows(db, runId)) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

/** 最近的缺口（含补抓结果）。 */
export function recentGaps(db, limit) {
  if (!db) return [];
  return db.prepare("SELECT source_id, run_id, gap_from, gap_to, status, method, recovered, updated_at FROM coverage_gaps ORDER BY id DESC LIMIT ?").all(limit || 20);
}

/** 最近的推送记录。 */
export function recentPushes(db, limit) {
  if (!db) return [];
  return db.prepare("SELECT p.run_id, p.article_id, p.score, p.reason, p.pushed_at, a.title, a.url, a.source_id FROM pushes p LEFT JOIN articles a ON a.id = p.article_id ORDER BY p.id DESC LIMIT ?").all(limit || 20);
}

// ------------------------------------------------------------------ 事件与标签
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** 模型解读：{summary, why, watch, model, at}；没有或坏的返回 null。 */
function notesView(s) {
  const n = parseJ(s, null);
  return n && n.summary ? { summary: n.summary, why: n.why || "", watch: n.watch || "", model: n.model || null, at: n.at || null } : null;
}

function eventView(e) {
  return {
    event_id: e.event_id, title: e.title, importance: e.importance, credibility: e.credibility, source_count: e.source_count, member_count: e.member_count,
    region_mix: e.region_mix, labels: parseJ(e.labels, []), regions: parseJ(e.regions, []), outlets: parseJ(e.outlets, []),
    first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at, factors: parseJ(e.factors, {}), dispute: parseJ(e.dispute, null),
    lead_url: e.lead_url || null, pushed: Boolean(e.pushed), pack: e.pack || null,
    notes: notesView(e.llm_notes),
  };
}

/** 事件列表：since / min_importance / credibility / label（前缀，如 macro）/ region / query / limit / before（游标：上一页最后一条的 last_seen_at）。 */
export function eventRows(db, o) {
  if (!db) return [];
  const where = ["e.last_seen_at >= ?"];
  const args = [o.since];
  if (o.pack) { where.push("e.pack = ?"); args.push(o.pack); }
  if (o.minImportance != null) { where.push("e.importance >= ?"); args.push(Number(o.minImportance)); }
  if (o.credibility) { const cs = String(o.credibility).split(","); where.push("e.credibility IN (" + cs.map(() => "?").join(",") + ")"); args.push(...cs); }
  if (o.multiOnly) where.push("e.source_count >= 2");
  if (o.label) { where.push("EXISTS (SELECT 1 FROM json_each(e.labels) j WHERE j.value = ? OR j.value LIKE ? || '.%')"); args.push(o.label, o.label); }
  if (o.region) { where.push("EXISTS (SELECT 1 FROM json_each(e.regions) j WHERE j.value = ?)"); args.push(o.region); }
  if (o.query) { where.push("(e.title LIKE ? OR EXISTS (SELECT 1 FROM event_members m JOIN articles a ON a.id = m.article_id WHERE m.event_id = e.event_id AND a.title LIKE ?))"); args.push("%" + o.query + "%", "%" + o.query + "%"); }
  if (o.before) { where.push("e.last_seen_at < ?"); args.push(o.before); }
  const order = o.order === "recent" ? "e.last_seen_at DESC" : "e.importance DESC, e.last_seen_at DESC";
  const limit = Math.min(Math.max(Number(o.limit) || 30, 1), 300);
  return db.prepare("SELECT e.*, a.url AS lead_url, EXISTS (SELECT 1 FROM pushes p WHERE p.event_id = e.event_id) AS pushed FROM events e LEFT JOIN articles a ON a.id = e.lead_article_id WHERE " + where.join(" AND ") + " ORDER BY " + order + " LIMIT ?").all(...args, limit).map(eventView);
}

/** 事件详情：成员（各源报道 + 最近热度信号 + 标签）、打分轨迹、推送记录。 */
export function eventDetail(db, id) {
  if (!db || !id) return null;
  const e = db.prepare("SELECT e.*, a.url AS lead_url, EXISTS (SELECT 1 FROM pushes p WHERE p.event_id = e.event_id) AS pushed FROM events e LEFT JOIN articles a ON a.id = e.lead_article_id WHERE e.event_id = ?").get(id);
  if (!e) return null;
  const members = db.prepare(`SELECT m.article_id, m.source_id, s.name AS source_name, m.grp, m.method, m.similarity, m.joined_at, m.repost_of, a.title, a.title_zh, a.url, a.published_at, a.time_confidence, a.summary,
      o.views, o.comments, o.likes, o.hot, o.level, o.section
    FROM event_members m JOIN articles a ON a.id = m.article_id LEFT JOIN sources s ON s.id = m.source_id
    LEFT JOIN observations o ON o.rowid = (SELECT rowid FROM observations WHERE article_id = m.article_id ORDER BY seen_at DESC LIMIT 1)
    WHERE m.event_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at)`).all(id).map((r) => Object.assign({}, r, { hot: parseJ(r.hot, []), summary: String(r.summary || "").slice(0, 240) }));
  const labelQ = db.prepare("SELECT label, confidence, origin FROM article_labels WHERE article_id = ?");
  for (const m of members) m.labels = labelQ.all(m.article_id);
  return Object.assign(eventView(e), {
    members,
    scores: db.prepare("SELECT run_id, importance, source_count, credibility, scored_at FROM event_scores WHERE event_id = ? ORDER BY scored_at").all(id),
    pushes: db.prepare("SELECT run_id, score, reason, credibility, pushed_at FROM pushes WHERE event_id = ? ORDER BY id").all(id),
    heat: eventHeat(db, id),
  });
}

/** 标签分布（时间窗内条目）。 */
export function labelCounts(db, since) {
  if (!db) return [];
  return db.prepare("SELECT l.label, COUNT(*) n FROM article_labels l JOIN articles a ON a.id = l.article_id WHERE COALESCE(a.published_at, a.last_seen_at) >= ? GROUP BY l.label ORDER BY n DESC").all(since);
}

// ------------------------------------------------------------------ 时间线
/** 本地日期（YYYY-MM-DD，默认 Asia/Shanghai = UTC+8）→ UTC 起止。 */
export function dayRange(date, offsetHours) {
  const off = offsetHours == null ? 8 : offsetHours;
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - off * 3600000;
  const iso = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
  return { from: iso(start), to: iso(start + 24 * 3600000) };
}

/** 某天的每一轮：时间、模式、成败源、新增条目、新事件、推送数、缺口与失败数。 */
export function timelineDay(db, range) {
  if (!db || !range) return [];
  return db.prepare(`SELECT r.run_id, r.started_at, r.finished_at, r.mode, r.sources_total, r.sources_ok, r.sources_failed, r.items_new, r.notes,
      (SELECT COUNT(*) FROM events e WHERE e.created_run = r.run_id) AS events_new,
      (SELECT COUNT(*) FROM events e WHERE e.created_run = r.run_id AND e.source_count >= 2) AS events_multi,
      (SELECT COUNT(*) FROM pushes p WHERE p.run_id = r.run_id) AS pushes,
      (SELECT COUNT(*) FROM continuity c WHERE c.run_id = r.run_id AND c.status IN ('gap_open', 'gap_partial')) AS gaps,
      (SELECT COUNT(*) FROM continuity c WHERE c.run_id = r.run_id AND c.status = 'failed') AS failed
    FROM runs r WHERE r.started_at >= ? AND r.started_at < ? AND r.mode IN ('fetch', 'cycle') ORDER BY r.started_at`).all(range.from, range.to);
}

/** 某一轮新出现的事件（按重要度）或条目（按时间）。 */
export function timelineRun(db, runId, kind, limit, offset) {
  if (!db || !runId) return [];
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const off = Math.max(0, Number(offset) || 0);
  if (kind === "items") {
    const run = db.prepare("SELECT started_at FROM runs WHERE run_id = ?").get(runId);
    if (!run) return [];
    return db.prepare(`SELECT a.id, a.title, a.url, a.source_id, s.name AS source_name, a.time_confidence, COALESCE(a.published_at, a.first_seen_at) AS t,
        o.views, o.comments, o.likes, o.hot, o.level
      FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      LEFT JOIN observations o ON o.run_id = ? AND o.article_id = a.id AND o.source_id = a.source_id
      WHERE a.first_seen_at = ? ORDER BY t DESC LIMIT ? OFFSET ?`).all(runId, run.started_at, lim, off)
      .map((r) => Object.assign({}, r, { hot: parseJ(r.hot, []) }));
  }
  return db.prepare("SELECT e.*, a.url AS lead_url, EXISTS (SELECT 1 FROM pushes p WHERE p.event_id = e.event_id) AS pushed FROM events e LEFT JOIN articles a ON a.id = e.lead_article_id WHERE e.created_run = ? ORDER BY e.importance DESC LIMIT ? OFFSET ?")
    .all(runId, lim, off).map(eventView);
}

/** 事件成员的热度序列（阅读 / 互动 / 排名随轮次），画热度曲线用。 */
export function eventHeat(db, eventId) {
  if (!db) return [];
  return db.prepare(`SELECT o.article_id, o.source_id, o.seen_at, o.views, o.comments, o.likes, o.rank
    FROM observations o JOIN event_members m ON m.article_id = o.article_id WHERE m.event_id = ? ORDER BY o.seen_at LIMIT 500`).all(eventId);
}
