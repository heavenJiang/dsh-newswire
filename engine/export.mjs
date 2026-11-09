/**
 * 数据集导出（训练 / 回测用）。一次导出一个目录：articles.jsonl、events.jsonl、stories.jsonl、editions.jsonl、digests.jsonl、manifest.json。
 *
 * - 时间范围按北京时间日期（含首尾），条目按 first_seen_at 落在范围内取。
 * - 正文只在 training_ready=1 时给出；付费墙或过短的给 null 并写明 content_withheld。
 * - manifest 列出范围内未补全的缺口与失败的源轮次（与面板「运行」页同源），下游据此区分「没抓到」和「没新闻」。
 */
import fs from "node:fs";
import path from "node:path";
import { dayRange } from "./query.mjs";
import { SCHEMA_VERSION } from "./store/schema.mjs";
import { PARSER_VERSION } from "./pipeline/normalize.mjs";

export const DATASET_SCHEMA = "dsh-newswire-dataset/1";

const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function writeJsonl(file, rows) {
  const fd = fs.openSync(file, "w");
  let n = 0;
  try {
    for (const r of rows) { fs.writeSync(fd, JSON.stringify(r) + "\n"); n++; }
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

/**
 * @param o { from, to（北京时间 YYYY-MM-DD，含）, kind: all|articles|events|stories, pack?, outDir, cfg（sources.json 文档）, tax（已编译分类）, now }
 * @returns { dir, manifest }
 */
export function exportDataset(db, o) {
  const r0 = dayRange(o.from, 8);
  const r1 = dayRange(o.to || o.from, 8);
  if (!r0 || !r1) throw new Error("from/to 需为 YYYY-MM-DD");
  const range = { from: r0.from, to: r1.to };
  const kind = o.kind || "all";
  const stamp = new Date(o.now || Date.now()).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = path.join(o.outDir, "dataset-" + o.from + "_" + (o.to || o.from) + "-" + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const packWhere = o.pack ? " AND a.pack = ?" : "";
  const packArgs = o.pack ? [o.pack] : [];
  const sources = new Map((o.cfg.sources || []).map((s) => [s.id, s]));
  const counts = {};

  if (kind === "all" || kind === "articles") {
    const obsQ = db.prepare("SELECT run_id, seen_at, rank, page, section, views, comments, likes, shares, favorites, hot, level, channel FROM observations WHERE article_id = ? ORDER BY seen_at");
    const labQ = db.prepare("SELECT label, confidence, origin FROM article_labels WHERE article_id = ?");
    const evQ = db.prepare("SELECT event_id FROM event_members WHERE article_id = ?");
    const bodyQ = db.prepare("SELECT extractor, channel FROM article_bodies WHERE article_id = ? AND ok = 1");
    const rows = db.prepare("SELECT a.* FROM articles a WHERE a.first_seen_at >= ? AND a.first_seen_at < ?" + packWhere + " ORDER BY a.first_seen_at").iterate(range.from, range.to, ...packArgs);
    function* gen() {
      for (const a of rows) {
        const src = sources.get(a.source_id) || {};
        const labels = labQ.all(a.id);
        const body = bodyQ.get(a.id);
        const ready = a.training_ready === 1;
        yield {
          id: a.id, url: a.url, title: a.title, summary: a.summary || null,
          content: ready ? a.content || null : null,
          content_withheld: ready ? null : a.paywalled ? "paywall" : "too_short",
          content_source: body ? "body:" + body.extractor : a.content ? "list" : null,
          published_at: a.published_at, time_confidence: a.time_confidence, first_seen_at: a.first_seen_at, last_seen_at: a.last_seen_at,
          source: { id: a.source_id, name: src.name || null, region: src.region || null, lang: src.lang || null, weight: src.weight ?? null, tier: src.tier || null, group: src.group || a.source_id },
          pack: a.pack || "core", channel: a.channel, parser_version: a.parser_version,
          // v13 内容质量：广告与引流是带标签的负样本；合集子条目指向原稿
          kind: a.kind || "news", kind_by: a.kind_by || null, kind_note: a.kind_note || null, parent_id: a.parent_id || null, completeness: a.completeness || null,
          labels: labels.filter((l) => !l.label.startsWith("region:")), regions: labels.filter((l) => l.label.startsWith("region:")).map((l) => l.label.slice(7)),
          event_id: (evQ.get(a.id) || {}).event_id || null,
          observations: obsQ.all(a.id).map((x) => Object.assign({}, x, { hot: parseJ(x.hot, []) })),
        };
      }
    }
    counts.articles = writeJsonl(path.join(dir, "articles.jsonl"), gen());
  }

  if (kind === "all" || kind === "events") {
    const memQ = db.prepare("SELECT m.article_id, m.source_id, m.grp, m.method, m.similarity, m.joined_run, a.title, a.url, a.published_at FROM event_members m JOIN articles a ON a.id = m.article_id WHERE m.event_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at)");
    const scoreQ = db.prepare("SELECT run_id, importance, source_count, credibility, factors, scored_at FROM event_scores WHERE event_id = ? ORDER BY scored_at");
    const pushQ = db.prepare("SELECT run_id, score, reason, credibility, pushed_at FROM pushes WHERE event_id = ? ORDER BY id");
    const rows = db.prepare("SELECT e.* FROM events e WHERE e.first_seen_at >= ? AND e.first_seen_at < ?" + (o.pack ? " AND e.pack = ?" : "") + " ORDER BY e.first_seen_at").iterate(range.from, range.to, ...packArgs);
    function* gen() {
      for (const e of rows) {
        yield {
          event_id: e.event_id, title: e.title, pack: e.pack, first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at,
          importance: e.importance, credibility: e.credibility, source_count: e.source_count, member_count: e.member_count, region_mix: e.region_mix,
          labels: parseJ(e.labels, []), regions: parseJ(e.regions, []), entities: parseJ(e.entities, []), factors: parseJ(e.factors, {}), dispute: parseJ(e.dispute, null),
          lead_article_id: e.lead_article_id,
          members: memQ.all(e.event_id),
          scores: scoreQ.all(e.event_id).map((s) => Object.assign({}, s, { factors: parseJ(s.factors, {}) })),
          pushes: pushQ.all(e.event_id),
        };
      }
    }
    counts.events = writeJsonl(path.join(dir, "events.jsonl"), gen());
  }

  // 故事线、版面（含每条新闻被归到哪篇报道、哪个版块、多重要——模型模式下是模型的判断）、日报、读者报错
  if (kind === "all" || kind === "stories") {
    const itemQ = db.prepare("SELECT i.article_id, i.event_id, i.joined_at, i.joined_edition FROM story_items i WHERE i.story_id = ? ORDER BY i.joined_at");
    const upQ = db.prepare("SELECT at, text, items, by, edition_id FROM story_updates WHERE story_id = ? ORDER BY at");
    const fbQ = db.prepare("SELECT at, kind, target, text, note, article_id, resolved_at FROM feedback WHERE story_id = ? ORDER BY at");
    const rows = db.prepare("SELECT * FROM stories WHERE created_at < ? AND COALESCE(updated_at, created_at) >= ?" + (o.pack ? " AND pack = ?" : "") + " ORDER BY created_at").iterate(range.to, range.from, ...packArgs);
    function* gen() {
      for (const st of rows) {
        yield { story_id: st.story_id, pack: st.pack, title: st.title, section: st.section, labels: parseJ(st.labels, []), importance: st.importance, status: st.status, merged_into: st.merged_into,
          created_at: st.created_at, updated_at: st.updated_at, copy: parseJ(st.copy, null), items: itemQ.all(st.story_id), updates: upQ.all(st.story_id), feedback: fbQ.all(st.story_id) };
      }
    }
    counts.stories = writeJsonl(path.join(dir, "stories.jsonl"), gen());
    const edItems = db.prepare("SELECT story_id, article_id, event_id, section, labels, importance FROM edition_items WHERE edition_id = ?");
    const eds = db.prepare("SELECT id, pack, run_id, created_at, mode, model, hours, items_read, headline, content, ms, calls, error FROM editions WHERE created_at >= ? AND created_at < ?" + (o.pack ? " AND pack = ?" : "") + " ORDER BY id").iterate(range.from, range.to, ...packArgs);
    function* genE() {
      for (const e of eds) {
        const c = parseJ(e.content, {}) || {};
        yield { id: e.id, pack: e.pack, run_id: e.run_id, created_at: e.created_at, mode: e.mode, model: e.model, hours: e.hours, items_read: e.items_read, headline: e.headline, ms: e.ms, calls: e.calls, error: e.error,
          front: c.front || [], sections: (c.sections || []).map((x) => ({ id: x.id, stories: x.stories })), watch: c.watch || [], verify: c.verify || [], stats: c.stats || {},
          items: edItems.all(e.id).map((x) => Object.assign({}, x, { labels: parseJ(x.labels, []) })) };
      }
    }
    counts.editions = writeJsonl(path.join(dir, "editions.jsonl"), genE());
    const dg = db.prepare("SELECT pack, date, created_at, mode, model, content FROM digests WHERE date >= ? AND date <= ?" + (o.pack ? " AND pack = ?" : "") + " ORDER BY id").iterate(o.from, o.to || o.from, ...packArgs);
    function* genD() { for (const d of dg) yield Object.assign({ created_at: d.created_at }, parseJ(d.content, {})); }
    counts.digests = writeJsonl(path.join(dir, "digests.jsonl"), genD());
  }

  // 覆盖情况：范围内的运行、未补全的缺口、失败的源轮次
  const runs = db.prepare("SELECT run_id, started_at, finished_at, mode, sources_total, sources_ok, sources_failed, items_new FROM runs WHERE started_at >= ? AND started_at < ? AND mode IN ('fetch', 'cycle') ORDER BY started_at").all(range.from, range.to);
  const gaps = db.prepare("SELECT source_id, run_id, gap_from, gap_to, status, method, recovered FROM coverage_gaps WHERE status <> 'backfilled' AND COALESCE(gap_to, gap_from) >= ? AND gap_from < ? ORDER BY gap_from").all(range.from, range.to);
  const failed = db.prepare("SELECT c.source_id, c.run_id, r.started_at, c.note FROM continuity c JOIN runs r ON r.run_id = c.run_id WHERE c.status = 'failed' AND r.started_at >= ? AND r.started_at < ? ORDER BY r.started_at").all(range.from, range.to);
  const parsers = db.prepare("SELECT parser_version, COUNT(*) n FROM articles WHERE first_seen_at >= ? AND first_seen_at < ? GROUP BY 1").all(range.from, range.to);
  const manifest = {
    schema: DATASET_SCHEMA,
    generated_at: new Date(o.now || Date.now()).toISOString(),
    range: { from_date: o.from, to_date: o.to || o.from, timezone: "Asia/Shanghai", from_utc: range.from, to_utc: range.to },
    kind, pack: o.pack || null,
    files: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k + ".jsonl", n])),
    versions: { db_schema: SCHEMA_VERSION, sources_config: o.cfg.version ?? null, taxonomy_rules: o.tax ? o.tax.rulesVersion : null, parser: PARSER_VERSION, parsers_seen: parsers },
    sources: (o.cfg.sources || []).map((s) => ({ id: s.id, name: s.name, type: s.type, adapter: s.adapter || null, region: s.region || null, lang: s.lang || null, weight: s.weight ?? null, tier: s.tier || null, group: s.group || s.id, pack: s.pack || "core", enabled: s.enabled !== false && !s.removed_at, paywall: Boolean(s.paywall) })),
    coverage: {
      runs: runs.length,
      runs_by_mode: runs.reduce((m, r) => ((m[r.mode] = (m[r.mode] || 0) + 1), m), {}),
      first_run: runs[0] ? runs[0].started_at : null,
      last_run: runs.length ? runs[runs.length - 1].started_at : null,
      open_gaps: gaps,
      failed_source_runs: failed,
    },
    notes: [
      "Times are UTC (YYYY-MM-DD HH:MM:SS). time_confidence=fetched means the source gave no time and the fetch time stands in.",
      "content is given only for training-ready items; paywalled or too-short items have content=null and content_withheld set.",
      "observations hold the source-reported heat at every round the item was seen (rank, views, comments, likes, hot marks, level).",
      "A source missing from a period may mean a failed run or an open gap (see coverage), not an absence of news.",
    ],
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir, manifest };
}
