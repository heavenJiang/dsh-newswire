/**
 * 内容健康度：抓到了但不全，比抓不到更难发现——不报错，只是内容变少。
 *
 * 按源统计近 24 小时入库条目的完整度（完整 / 截断 / 只有标题）、近 7 天正文抓取成败，
 * 与该源前 7 天的常态比较：只有标题的比例突然升高（≥ 50 个百分点）记为 degraded（多半是页面改版、接口变了）；
 * 长期只有标题、正文也抓不到的记为 titles_only（这个源只能提供标题，版面上它的报道只能靠别家补内容）。
 */
import { bodyProfiles } from "../engine/pipeline/bodies.mjs";

/** 给只有标题 / 内容变少的源一条建议（代码，面板按语言显示）。 */
function advice(status, p) {
  if (status === "degraded") return "degraded";
  return p && ["blocked", "slow", "fetch", "probe", "none"].includes(p.mode) ? p.mode : null;
}

export function contentHealth(db) {
  const srcMap = new Map(db.prepare("SELECT id, paywall FROM sources WHERE removed_at IS NULL").all().map((r) => [r.id, { paywall: Boolean(r.paywall) }]));
  const prof = bodyProfiles(db, srcMap);
  const recent = db.prepare(`SELECT a.source_id, s.name, COUNT(*) n,
      SUM(CASE WHEN a.completeness = 'full' THEN 1 ELSE 0 END) n_full,
      SUM(CASE WHEN a.completeness = 'truncated' THEN 1 ELSE 0 END) n_trunc,
      SUM(CASE WHEN a.completeness = 'title_only' THEN 1 ELSE 0 END) n_title,
      SUM(CASE WHEN a.kind = 'promo' THEN 1 ELSE 0 END) n_promo,
      SUM(CASE WHEN a.kind = 'digest' THEN 1 ELSE 0 END) n_digest,
      SUM(CASE WHEN a.kind = 'digest_item' THEN 1 ELSE 0 END) n_items
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.first_seen_at >= datetime('now', '-1 day') GROUP BY a.source_id`).all();
  const base = new Map(db.prepare(`SELECT source_id, COUNT(*) n, SUM(CASE WHEN completeness = 'title_only' THEN 1 ELSE 0 END) t
    FROM articles WHERE first_seen_at >= datetime('now', '-8 days') AND first_seen_at < datetime('now', '-1 day') GROUP BY source_id`).all().map((r) => [r.source_id, r]));
  const bodies = new Map(db.prepare(`SELECT a.source_id, COUNT(*) tried, SUM(b.ok) ok FROM article_bodies b JOIN articles a ON a.id = b.article_id
    WHERE b.fetched_at >= datetime('now', '-7 days') GROUP BY a.source_id`).all().map((r) => [r.source_id, r]));
  const sources = recent.map((r) => {
    const b = base.get(r.source_id);
    const bd = bodies.get(r.source_id) || { tried: 0, ok: 0 };
    const share = r.n ? r.n_title / r.n : 0;
    const was = b && b.n >= 10 ? b.t / b.n : null;
    let status = "ok";
    if (r.n >= 8 && was != null && share - was >= 0.5) status = "degraded";
    else if (r.n >= 5 && share >= 0.8 && (bd.tried < 3 || bd.ok / bd.tried < 0.3)) status = "titles_only";
    else if (r.n >= 5 && (r.n_trunc + r.n_title) / r.n >= 0.5) status = "partial";
    return { source_id: r.source_id, name: r.name || r.source_id, n: r.n, full: r.n_full, truncated: r.n_trunc, title_only: r.n_title, promo: r.n_promo, digest: r.n_digest, digest_items: r.n_items,
      title_only_before: was == null ? null : Math.round(was * 100), bodies_tried: bd.tried, bodies_ok: bd.ok || 0, status,
      body_mode: (prof.get(r.source_id) || {}).mode || null, advice: status === "ok" ? null : advice(status, prof.get(r.source_id)) };
  }).sort((a, b) => ["degraded", "titles_only", "partial", "ok"].indexOf(a.status) - ["degraded", "titles_only", "partial", "ok"].indexOf(b.status) || b.n - a.n);
  const sum = (k) => sources.reduce((s, x) => s + (x[k] || 0), 0);
  return { sources, totals: { items: sum("n"), full: sum("full"), truncated: sum("truncated"), title_only: sum("title_only"), promo: sum("promo"), digest: sum("digest"), digest_items: sum("digest_items") }, degraded: sources.filter((x) => x.status === "degraded").map((x) => x.name) };
}

/** 被过滤的条目（广告、引流、合集原稿），供面板查看与恢复。 */
export function filteredItems(db, o) {
  return db.prepare(`SELECT a.id, a.title, a.url, a.source_id, s.name AS source_name, a.kind, a.kind_by, a.kind_note, a.first_seen_at
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.kind IN ('promo', 'digest') AND a.first_seen_at >= datetime('now', ?) ORDER BY a.first_seen_at DESC LIMIT ?`).all("-" + Math.max(1, Number(o && o.hours) || 72) + " hours", Number(o && o.limit) || 100);
}
