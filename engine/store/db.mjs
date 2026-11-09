/** 写入操作（引擎用）。读查询在 engine/query.mjs。 */
import { scrub } from "../channels/classify.mjs";
export { openDb } from "./schema.mjs";

export function upsertSource(db, s, nowIso) {
  db.prepare("INSERT INTO sources (id,name,category,region,lang,type,url,channels,enabled,max_items,paywall,note,weight,tier,grp,pack,adapter,removed_at,updated_at,trial) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET trial=excluded.trial, name=excluded.name, category=excluded.category, region=excluded.region, lang=excluded.lang, type=excluded.type, url=excluded.url, channels=excluded.channels, enabled=excluded.enabled, max_items=excluded.max_items, paywall=excluded.paywall, note=excluded.note, weight=excluded.weight, tier=excluded.tier, grp=excluded.grp, pack=excluded.pack, adapter=excluded.adapter, removed_at=excluded.removed_at, updated_at=excluded.updated_at")
    .run(s.id, s.name, s.category || "", s.region || "", s.lang || "", s.type, s.url, JSON.stringify(s.channels || []), s.enabled === false ? 0 : 1, s.max_items || null, s.paywall ? 1 : 0, s.note || "", s.weight == null ? null : Number(s.weight), s.tier || null, s.group || s.id, s.pack || "core", s.adapter || null, s.removed_at || null, nowIso, s.trial ? 1 : 0);
}

export function startRun(db, runId, startedAt, mode, pack) {
  db.prepare("INSERT OR REPLACE INTO runs (run_id, started_at, mode, pack) VALUES (?,?,?,?)").run(runId, startedAt, mode, pack || "all");
}

export function finishRun(db, runId, st) {
  db.prepare("UPDATE runs SET finished_at=?, sources_total=?, sources_ok=?, sources_failed=?, items_raw=?, items_new=?, items_dup=?, notes=? WHERE run_id=?")
    .run(st.finished_at, st.sources_total, st.sources_ok, st.sources_failed, st.items_raw, st.items_new, st.items_dup, st.notes || "", runId);
}

export function logAttempt(db, a) {
  db.prepare("INSERT INTO fetch_attempts (run_id,source_id,channel,url,ok,http_status,bytes,items,latency_ms,error_kind,error,hint,attempted_at,backend,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(a.run_id, a.source_id, a.channel, a.url, a.ok ? 1 : 0, a.http_status == null ? null : a.http_status, a.bytes == null ? null : a.bytes, a.items == null ? null : a.items, a.latency_ms == null ? null : a.latency_ms, a.error_kind || null, a.error ? scrub(a.error).slice(0, 900) : null, a.hint || null, a.attempted_at, a.backend || null, a.note || null);
}

export function hasArticle(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM articles WHERE id = ?").get(id));
}

/** 时间可信度等级：fetched < url_date < page_text < feed，合并时只升不降。 */
const RANK = (x) => "(CASE " + x + " WHEN 'feed' THEN 3 WHEN 'page_text' THEN 2 WHEN 'url_date' THEN 1 ELSE 0 END)";

/**
 * 去重键相同则合并：保留首见时间；摘要/正文取更长的；发布时间按可信度等级只升不降。
 */
const CRANK = (x) => `CASE ${x} WHEN 'full' THEN 2 WHEN 'truncated' THEN 1 ELSE 0 END`;

export function upsertArticle(db, r, ctx) {
  db.prepare(`INSERT INTO articles (id,url,canonical_url,title,title_norm,summary,content,published_at,time_confidence,fetched_at,first_seen_at,last_seen_at,source_id,category,region,lang,pack,channel,paywalled,metrics,content_hash,raw_path,text_len,training_ready,parser_version,kind,kind_by,kind_note,parent_id,completeness)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      url = excluded.url,
      summary = CASE WHEN LENGTH(excluded.summary) > LENGTH(COALESCE(articles.summary, '')) THEN excluded.summary ELSE articles.summary END,
      content = CASE WHEN LENGTH(excluded.content) > LENGTH(COALESCE(articles.content, '')) THEN excluded.content ELSE articles.content END,
      published_at = CASE WHEN ${RANK("excluded.time_confidence")} > ${RANK("COALESCE(articles.time_confidence, 'fetched')")} THEN excluded.published_at ELSE articles.published_at END,
      time_confidence = CASE WHEN ${RANK("excluded.time_confidence")} > ${RANK("COALESCE(articles.time_confidence, 'fetched')")} THEN excluded.time_confidence ELSE articles.time_confidence END,
      paywalled = excluded.paywalled,
      text_len = MAX(COALESCE(articles.text_len, 0), excluded.text_len),
      training_ready = MAX(COALESCE(articles.training_ready, 0), excluded.training_ready),
      parser_version = excluded.parser_version,
      -- 读者或模型判过的不被规则覆盖
      kind = CASE WHEN articles.kind_by IN ('reader', 'llm') THEN articles.kind ELSE excluded.kind END,
      kind_by = CASE WHEN articles.kind_by IN ('reader', 'llm') THEN articles.kind_by ELSE excluded.kind_by END,
      kind_note = CASE WHEN articles.kind_by IN ('reader', 'llm') THEN articles.kind_note ELSE excluded.kind_note END,
      parent_id = COALESCE(articles.parent_id, excluded.parent_id),
      completeness = CASE WHEN ${CRANK("excluded.completeness")} > ${CRANK("COALESCE(articles.completeness, 'title_only')")} THEN excluded.completeness ELSE articles.completeness END`)
    .run(r.id, r.url, r.canonical_url, r.title, r.title_norm, r.summary || "", r.content || "", r.published_at, r.time_confidence, ctx.nowIso, ctx.nowIso, ctx.nowIso, r.source_id, r.category, r.region, r.lang, r.pack, ctx.channel || "none", r.paywalled ? 1 : 0, JSON.stringify(r.metrics || {}), r.content_hash, ctx.rawPath || null, r.text_len, r.training_ready ? 1 : 0, r.parser_version, r.kind || "news", r.kind_by || null, r.kind_note || null, r.parent_id || null, r.completeness || null);
}

/** 同一轮同一源里重复出现的条目只记第一次（排名更靠前的那次）。 */
export function insertObservation(db, r, ctx) {
  const s = r.signals;
  db.prepare("INSERT INTO observations (run_id,source_id,article_id,rank,page,section,views,comments,likes,shares,favorites,hot,level,signals_raw,channel,seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id, source_id, article_id) DO NOTHING")
    .run(ctx.runId, r.source_id, r.id, s.rank, ctx.page || 0, s.section, s.views, s.comments, s.likes, s.shares, s.favorites, s.hot.length ? JSON.stringify(s.hot) : null, s.level, Object.keys(s.raw || {}).length ? JSON.stringify(s.raw) : null, ctx.channel || null, ctx.nowIso);
}

export function touchSignals(db, sourceId, names, nowIso) {
  const st = db.prepare("INSERT INTO signal_availability (source_id, signal, seen_count, last_seen_at) VALUES (?,?,1,?) ON CONFLICT(source_id, signal) DO UPDATE SET seen_count = seen_count + 1, last_seen_at = excluded.last_seen_at");
  for (const n of names) st.run(sourceId, n, nowIso);
}

export function attemptsForRun(db, runId) {
  return db.prepare("SELECT * FROM fetch_attempts WHERE run_id = ? ORDER BY source_id, id").all(runId);
}
