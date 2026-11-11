/**
 * 单源一轮：抓取 → 衔接判定 → （缺口时）翻页 / 搜索补抓 → 入库（文章 + 观测 + 信号可用性）→ 记录衔接状态、缺口与游标。
 */
import { fetchSource } from "./fetch.mjs";
import { toRecord } from "./normalize.mjs";
import { presentSignals } from "./signals.mjs";
import { morePages, missingIds } from "./paging.mjs";
import { exaBackfill } from "../channels/exa.mjs";
import { upsertArticle, hasArticle, insertObservation, touchSignals, logAttempt } from "../store/db.mjs";
import { loadCursor, saveCursor, evaluate, nextCursor, sinceHoursFor, recordContinuity, recordGap, numericId, isStream } from "../cursor.mjs";
import { isoUtc } from "../util/text.mjs";
import { assess } from "./quality.mjs";

/**
 * @param env {
 *   db, runId, now (Date), nowIso, defaults, scale (隔夜/长间隔放大倍数), backfillBudget ({ left }),
 *   fetchEnv（传给 fetchSource 的通道环境）, writeRaw
 * }
 */
export async function processSource(src0, env) {
  const { db, runId, nowIso } = env;
  const prev = loadCursor(db, src0.id);
  const scale = env.scale || 1;
  const sinceH = sinceHoursFor(prev, env.now.getTime(), env.fetchEnv.windowHours || 24);
  // 回看时长决定本轮规模：间隔越久（隔夜）抓得越多；财联社原生按时间回翻，页数随回看时长走
  // 衔接优先：有断点的源一直往回翻到上一轮的位置为止，而不是按时长估一个页数、按条数截断——
  // 实测财联社下午一小时约 50 条，原来按「时长×1.5+1 页」只翻 6 页（120 条），3 小时没抓就漏掉 25 分钟。
  // 条数只是安全上限：首轮按配置的条数；有断点后每轮最多 300 条，财联社最多翻 60 页（防接口异常时无限翻）
  const hasCursor = Boolean(prev && prev.head_time);
  const src = Object.assign({}, src0, {
    since_hours: sinceH,
    until: hasCursor ? prev.head_time : null,
    // 快照源（首页、列表页）多半没有可信时间、不会有 head_time：抓过一轮后每轮读到 60 条，页面上更多的内容也收进来
    max_items: hasCursor ? Math.max(300, src0.max_items || 20) : prev && prev.last_ok_at && !isStream(src0) ? Math.max(60, src0.max_items || 20) : Math.min(300, Math.round((src0.max_items || 20) * scale)),
    pages: src0.type === "cls_api" ? (hasCursor ? 60 : Math.min(20, Math.max(Number(src0.pages || 2), Math.ceil(sinceH * 1.5) + 1))) : src0.pages,
  });
  // 快照类网页源（首页、列表页）没有翻页接口：把上一轮抓到的链接交给 browse，往下滚到看见其中一条（接上了）为止
  if (!isStream(src0)) {
    try { src.known_links = db.prepare("SELECT url FROM articles WHERE source_id = ? ORDER BY first_seen_at DESC LIMIT 80").all(src0.id).map((r) => r.url); } catch { src.known_links = []; }
  }
  // 翻得多时给足时间（隔夜可能要翻二三十页）
  if (src0.type === "cls_api" && hasCursor) src.timeout_ms = Math.max(Number(src0.timeout_ms) || 30000, 90000);

  const res = await fetchSource(src, Object.assign({}, env.fetchEnv, {
    onAttempt: (a) => logAttempt(db, Object.assign({ run_id: runId }, a, { attempted_at: isoUtc(a.attempted_at) })),
  }));

  const skipped = {};
  const byId = new Map();
  const addItems = (items, page, channel, parser) => {
    let added = 0;
    items.forEach((it, i) => {
      const r = toRecord(it, src, { index: i, nowMs: env.now.getTime(), minTextLen: env.defaults.min_text_len, parser });
      if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; return; }
      if (byId.has(r.id)) return;
      r.page = page;
      r.channel = channel;
      byId.set(r.id, r);
      added++;
    });
    return added;
  };
  addItems(res.items, 0, res.won || "none", res.parsed_by);

  if (!res.won) {
    recordContinuity(db, runId, src.id, { status: "failed", pages: 0, note: res.attempts.map((a) => a.channel + ":" + (a.error_kind || "err")).join(" -> ") });
    return { id: src.id, name: src.name, category: src.category, ok: false, channel: null, items: 0, stored: 0, continuity: "failed", attempts: res.attempts };
  }

  // ---- 衔接判定与补抓
  let cont = evaluate(prev, Array.from(byId.values()), src);
  let pages = 1;
  let backfilled = 0;
  let method = null;
  const firstGap = cont.status === "gap" ? { from: cont.gap_from, to: cont.gap_to } : null;
  if (cont.status === "gap" && src.paging && src.paging.mode && src.paging.mode !== "native") {
    method = "paging";
    let ids = [];
    if (src.paging.mode === "id_walk") {
      const present = Array.from(byId.values()).map((r) => numericId(r.url, src.paging.id_pattern)).filter((x) => x);
      ids = missingIds(prev && prev.max_id, present);
    }
    for await (const pg of morePages(src, { scale, missingIds: ids, writeRaw: env.writeRaw })) {
      pages++;
      backfilled += addItems(pg.items, pg.page, "paging", "paging:" + src.paging.mode);
      cont = evaluate(prev, Array.from(byId.values()), src);
      if (cont.status !== "gap" && src.paging.mode !== "id_walk") break;
    }
    if (src.paging.mode === "id_walk" && ids.length) cont = evaluate(prev, Array.from(byId.values()), src);
  }
  // Exa 搜索补抓是收费接口：默认不用，只有源里明确写了 backfill: true 才用（缺口主要靠翻页补）
  if (cont.status === "gap" && src.backfill === true && env.backfillBudget && env.backfillBudget.left > 0) {
    env.backfillBudget.left--;
    method = method ? method + "+agent_reach_search" : "agent_reach_search";
    const bf = await exaBackfill(src, { gapFrom: cont.gap_from, gapTo: cont.gap_to, max: 10 });
    logAttempt(db, { run_id: runId, source_id: src.id, channel: "agent_reach_backfill", url: src.url, ok: bf.ok, items: bf.items.length, backend: "exa", error: bf.error || null, error_kind: bf.ok ? null : "unknown", hint: bf.ok ? null : "Exa 搜索补抓失败：检查 mcporter 与 exa 配置", attempted_at: isoUtc(Date.now()) });
    backfilled += addItems(bf.items, -1, "agent_reach_backfill", "exa");
  }
  let status = cont.status;
  if (firstGap) status = cont.status === "gap" ? (backfilled > 0 ? "gap_partial" : "gap_open") : "gap_filled";

  // ---- 定性（广告 / 合集 / 完整度），合集拆出子条目一并入库
  const records = [];
  for (const r of byId.values()) { records.push(r); for (const c of assess(r, env.noise)) if (!byId.has(c.id)) records.push(c); }
  // ---- 入库
  let stored = 0, fresh = 0, dup = 0;
  const sigSeen = new Set();
  db.exec("BEGIN");
  try {
    for (const r of records) {
      const isNew = !hasArticle(db, r.id);
      upsertArticle(db, r, { nowIso, channel: r.channel, rawPath: res.raw_path });
      insertObservation(db, r, { runId, nowIso, channel: r.channel, page: r.page });
      for (const n of presentSignals(r.signals)) sigSeen.add(n);
      stored++;
      if (isNew) fresh++; else dup++;
    }
    touchSignals(db, src.id, sigSeen, nowIso);
    recordContinuity(db, runId, src.id, { status, overlap: cont.overlap, pages, backfilled, gap_from: firstGap && firstGap.from, gap_to: firstGap && firstGap.to, note: method || cont.note || null });
    if (firstGap) recordGap(db, { source_id: src.id, run_id: runId, gap_from: firstGap.from, gap_to: firstGap.to, status: status === "gap_filled" ? "backfilled" : status === "gap_partial" ? "partial" : "open", method: method || "none", recovered: backfilled, updated_at: nowIso });
    saveCursor(db, nextCursor(prev, records, src, runId, nowIso));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id: src.id, name: src.name, category: src.category, ok: true, channel: res.won, items: res.items.length, stored, fresh, dup, continuity: status, pages, backfilled, signals: Array.from(sigSeen), since_hours: sinceH, attempts: res.attempts };
}
