/**
 * 断点衔接：判断本轮与上轮之间有没有漏抓，并推进游标。
 *
 * 判定（只对「流式」源：按时间滚动的快讯/feed；首页推荐类「快照」源不判）：
 *   1. 键重叠（主判据）：本批出现了上轮 head_keys 里任意一条 → connected
 *   2. 时间覆盖（辅助）：本批最旧的可信发布时间 ≤ 上轮 head_time → connected_time
 *   3. id 连续（id_walk 源）：本批最小数字 id ≤ 上轮 max_id + 1 → connected
 *   都不满足 → gap，缺口区间 (上轮 head_time, 本批最旧可信时间)
 * 只有可信时间（feed / page_text）参与时间判断；fetched 是抓取时间近似，不能用来证明衔接。
 */

export const HEAD_KEYS = 50;

/** 源是否按时间滚动（可判断衔接）。显式 continuity 优先；否则 RSS / API 视为流式，列表页视为快照。 */
export function isStream(src) {
  if (src.continuity === "stream") return true;
  if (src.continuity === "snapshot") return false;
  return src.type === "rss" || src.type === "cls_api" || src.type === "json_api";
}

export function loadCursor(db, sourceId) {
  const r = db.prepare("SELECT * FROM source_cursors WHERE source_id = ?").get(sourceId);
  if (!r) return null;
  return Object.assign({}, r, { head_keys: r.head_keys ? JSON.parse(r.head_keys) : [] });
}

const trusted = (r) => r.published_at && (r.time_confidence === "feed" || r.time_confidence === "page_text");

/** 从链接里取数字 id（id_walk 源用）。 */
export function numericId(url, pattern) {
  if (!pattern) return null;
  const m = String(url).match(new RegExp(pattern));
  return m ? Number(m[1]) : null;
}

/**
 * @param prev 上轮游标（可为 null）
 * @param records 本批记录（含翻页/补抓得到的，toRecord 产物）
 * @returns { status, overlap, gap_from, gap_to, oldest, newest }
 */
export function evaluate(prev, records, src) {
  const times = records.filter(trusted).map((r) => r.published_at).sort();
  const oldest = times[0] || null;
  const newest = times[times.length - 1] || null;
  // 快照源（首页、列表页）不判缺口，但记下和上一轮重叠了几条：0 条说明两轮之间页面整个翻过去了，中间可能有漏
  if (!isStream(src)) {
    const keys = new Set((prev && prev.head_keys) || []);
    const overlap = keys.size ? records.filter((r) => keys.has(r.id)).length : 0;
    return { status: "snapshot", overlap, gap_from: null, gap_to: null, oldest, newest, note: prev && prev.last_ok_at && keys.size && !overlap ? "与上一轮无重叠，中间可能有漏" : null };
  }
  if (!prev || !prev.last_ok_at) return { status: "first", overlap: 0, gap_from: null, gap_to: null, oldest, newest };
  const keys = new Set(prev.head_keys || []);
  const overlap = records.filter((r) => keys.has(r.id)).length;
  if (overlap > 0) return { status: "connected", overlap, gap_from: null, gap_to: null, oldest, newest };
  const pattern = src.paging && src.paging.mode === "id_walk" ? src.paging.id_pattern : null;
  if (pattern && prev.max_id) {
    const ids = records.map((r) => numericId(r.url, pattern)).filter((x) => x);
    if (ids.length && Math.min(...ids) <= prev.max_id + 1) return { status: "connected", overlap: 0, gap_from: null, gap_to: null, oldest, newest };
  }
  if (oldest && prev.head_time && oldest <= prev.head_time) return { status: "connected_time", overlap: 0, gap_from: null, gap_to: null, oldest, newest };
  return { status: "gap", overlap: 0, gap_from: prev.head_time || prev.last_ok_at, gap_to: oldest || null, oldest, newest };
}

/** 下一轮游标：最新 HEAD_KEYS 条的键（按列表顺序，首页优先）、可信时间范围、数字 id 上界。 */
export function nextCursor(prev, records, src, runId, nowIso) {
  const ordered = records.slice().sort((a, b) => (a.page || 0) - (b.page || 0) || (a.signals.rank ?? 0) - (b.signals.rank ?? 0));
  const times = records.filter(trusted).map((r) => r.published_at).sort();
  const pattern = src.paging && src.paging.mode === "id_walk" ? src.paging.id_pattern : null;
  const ids = pattern ? records.map((r) => numericId(r.url, pattern)).filter((x) => x) : [];
  const headTime = times.length ? times[times.length - 1] : null;
  return {
    source_id: src.id,
    last_ok_run_id: runId,
    last_ok_at: nowIso,
    head_keys: ordered.slice(0, HEAD_KEYS).map((r) => r.id),
    head_time: prev && prev.head_time && (!headTime || prev.head_time > headTime) ? prev.head_time : headTime,
    tail_time: times[0] || null,
    max_id: ids.length ? Math.max(...ids, (prev && prev.max_id) || 0) : (prev && prev.max_id) || null,
    page_cursor: null,
    updated_at: nowIso,
  };
}

export function saveCursor(db, c) {
  db.prepare("INSERT INTO source_cursors (source_id, last_ok_run_id, last_ok_at, head_keys, head_time, tail_time, max_id, page_cursor, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET last_ok_run_id=excluded.last_ok_run_id, last_ok_at=excluded.last_ok_at, head_keys=excluded.head_keys, head_time=excluded.head_time, tail_time=excluded.tail_time, max_id=excluded.max_id, page_cursor=excluded.page_cursor, updated_at=excluded.updated_at")
    .run(c.source_id, c.last_ok_run_id, c.last_ok_at, JSON.stringify(c.head_keys), c.head_time, c.tail_time, c.max_id, c.page_cursor, c.updated_at);
}

/** 本源这一轮该回看多少小时：从上次成功往前多留 15 分钟；没有游标用默认窗口。 */
export function sinceHoursFor(prev, nowMs, fallback) {
  if (!prev || !prev.last_ok_at) return fallback;
  const h = (nowMs - Date.parse(prev.last_ok_at.replace(" ", "T") + "Z")) / 3600000 + 0.25;
  return Math.min(48, Math.max(1, Math.round(h * 100) / 100));
}

export function recordContinuity(db, runId, sourceId, c) {
  db.prepare("INSERT OR REPLACE INTO continuity (run_id, source_id, status, overlap, pages, backfilled, gap_from, gap_to, note) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(runId, sourceId, c.status, c.overlap || 0, c.pages || 1, c.backfilled || 0, c.gap_from || null, c.gap_to || null, c.note || null);
}

export function recordGap(db, g) {
  db.prepare("INSERT INTO coverage_gaps (source_id, run_id, gap_from, gap_to, status, method, recovered, note, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(g.source_id, g.run_id, g.gap_from, g.gap_to, g.status, g.method, g.recovered || 0, g.note || null, g.updated_at);
}
