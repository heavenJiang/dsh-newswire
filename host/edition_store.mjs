/**
 * 版面 · 存取：登记故事线、存版面、读版面与历史、版面之间的差异、故事线详情与「自上次查看」。
 */
import { applyFollows } from "./follows.mjs";
import { PUB, assemble, bodiesFor, nowSql, parseJ, strip } from "./edition_base.mjs";

// ------------------------------------------------------------------ 存取
/** 登记故事线：新故事线、新归入的新闻、合并；模型写的稿记在故事线上供下一份版面沿用。 */
export function persistStories(db, list, editionId, pack) {
  if (!list || !list.length) return;
  const now = nowSql();
  const ins = db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, copy, created_at, updated_at, created_edition, updated_edition, profile) VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?) ON CONFLICT(story_id) DO NOTHING");
  const upProfile = db.prepare("UPDATE stories SET profile = ? WHERE story_id = ?");
  const upMeta = db.prepare("UPDATE stories SET title = ?, section = ?, labels = ?, importance = ?, status = 'active', merged_into = NULL, updated_at = ?, updated_edition = ? WHERE story_id = ?");
  const touch = db.prepare("UPDATE stories SET updated_at = ?, updated_edition = ? WHERE story_id = ?");
  const upCopy = db.prepare("UPDATE stories SET copy = ? WHERE story_id = ?");
  const item = db.prepare("INSERT INTO story_items (article_id, story_id, event_id, joined_at, joined_edition) VALUES (?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET story_id = excluded.story_id");
  const move = db.prepare("UPDATE story_items SET story_id = ? WHERE story_id = ?");
  const retire = db.prepare("UPDATE stories SET status = 'merged', merged_into = ?, updated_at = ? WHERE story_id = ?");
  const upd = db.prepare("INSERT INTO story_updates (story_id, edition_id, at, text, items, by) VALUES (?,?,?,?,?,?)");
  const resolve = db.prepare("UPDATE feedback SET resolved_at = ? WHERE story_id = ? AND kind = 'error' AND resolved_at IS NULL");
  const ent = db.prepare("INSERT OR IGNORE INTO story_entities (story_id, name, at) VALUES (?,?,?)");
  db.exec("BEGIN");
  try {
    for (const s of list) {
      ins.run(s.id, pack || "all", s.title, s.section, JSON.stringify(s.labels || []), s.importance, s.copy ? JSON.stringify(s.copy) : null, now, now, editionId, editionId, s.profile || null);
      if (s.profile && !s.isNew) upProfile.run(s.profile, s.id);
      if (s.isNew) { /* 刚插入 */ } else if (s.keepMeta) { if (s.items.length) touch.run(now, editionId, s.id); } else upMeta.run(s.title, s.section, JSON.stringify(s.labels || []), s.importance, now, editionId, s.id);
      if (s.copy && !s.isNew) upCopy.run(JSON.stringify(s.copy), s.id);
      for (const src of s.absorbed || []) { move.run(s.id, src); retire.run(s.id, now, src); }
      for (const it of s.items) item.run(it.article_id, s.id, it.event_id, now, editionId);
      if (s.update && s.update.text) upd.run(s.id, editionId, now, s.update.text, s.update.items, s.update.by);
      if (s.resolve) resolve.run(now, s.id);
      for (const e of s.entities || []) ent.run(s.id, e, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function saveEdition(db, ed, meta) {
  const created = nowSql();
  const content = Object.assign({}, ed);
  const itemMap = content._items;
  const persist = content._persist;
  delete content._items;
  delete content._persist;
  const r = db.prepare("INSERT INTO editions (pack, run_id, created_at, mode, model, layout_version, hours, items_read, headline, content, ok, error, ms, calls) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(ed.pack, meta.runId || null, created, ed.mode, ed.model, ed.layout_version, ed.hours, ed.items_read, ed.headline || null, JSON.stringify(content), 1, meta.error || null, meta.ms || null, (ed.stats && ed.stats.calls) || 0);
  const id = Number(r.lastInsertRowid);
  persistStories(db, persist, id, ed.pack);
  const ins = db.prepare("INSERT OR IGNORE INTO edition_items (edition_id, story_id, article_id, event_id, section, labels, importance) VALUES (?,?,?,?,?,?,?)");
  if (itemMap) for (const [aid, x] of itemMap) ins.run(id, x.story, aid, x.event_id, x.section, JSON.stringify(x.labels || []), x.importance);
  else for (const s of Object.values(ed.stories)) for (const aid of s.article_ids || []) ins.run(id, s.id, aid, s.lead_event_id, s.section, JSON.stringify(s.labels || []), s.importance);
  return { id, created_at: created };
}

/** 边写边出的进度版：只更新内容，不登记故事线、不记 edition_items；正式版存好后删掉。 */
export function updateEditionContent(db, id, ed) {
  const content = Object.assign({}, ed);
  delete content._items;
  delete content._persist;
  db.prepare("UPDATE editions SET headline = ?, content = ?, items_read = ?, created_at = ? WHERE id = ?").run(ed.headline || null, JSON.stringify(content), ed.items_read || 0, nowSql(), id);
}

// ------------------------------------------------------------------ 故事线详情与「自上次查看」
/** 详情页每篇报道最多带多少字的原文。 */
const DETAIL_TEXT_CHARS = 4000;
/** 一条故事线的全部：稿件、每篇报道（按时间）、进展、推送。被并入的跟到并入者。 */
export function storyDetail(db, id) {
  let row = db.prepare("SELECT * FROM stories WHERE story_id = ?").get(id);
  for (let k = 0; row && row.status === "merged" && row.merged_into && k < 5; k++) row = db.prepare("SELECT * FROM stories WHERE story_id = ?").get(row.merged_into);
  if (!row) return null;
  const items = db.prepare(`SELECT a.id, a.title, a.summary, a.url, ${PUB} AS published_at, a.first_seen_at, a.time_confidence, a.source_id, a.kind, a.kind_note, a.title_zh, s.name AS source_name, i.joined_at, i.event_id
    FROM story_items i JOIN articles a ON a.id = i.article_id LEFT JOIN sources s ON s.id = a.source_id WHERE i.story_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at)`).all(row.story_id);
  const updates = db.prepare("SELECT at, text, items, by, edition_id FROM story_updates WHERE story_id = ? ORDER BY at").all(row.story_id);
  const pushes = db.prepare("SELECT pushed_at, reason, credibility, score FROM pushes WHERE story_id = ? ORDER BY id").all(row.story_id);
  const merged = db.prepare("SELECT story_id, title FROM stories WHERE merged_into = ?").all(row.story_id);
  // 每篇报道的原文（正文优先，没有就用摘要）：详情页可以展开看，不用跳出去
  const bodies = bodiesFor(db, items.map((x) => x.id));
  for (const it of items) {
    const t = String(bodies.get(it.id) || it.summary || "").replace(/\s+\n/g, "\n").trim();
    if (t && t !== String(it.title || "").trim()) it.text = t.length > DETAIL_TEXT_CHARS ? t.slice(0, DETAIL_TEXT_CHARS - 1) + "…" : t;
  }
  return { id: row.story_id, title: row.title, section: row.section, labels: parseJ(row.labels, []), importance: row.importance, created_at: row.created_at, updated_at: row.updated_at, copy: parseJ(row.copy, null), items, updates, pushes, merged };
}

/** 自某个时间以来：哪些故事线是新起的、哪些新增了几篇。 */
export function sinceSeen(db, ids, seenAt) {
  const out = {};
  if (!seenAt || !ids.length) return out;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const qs = chunk.map(() => "?").join(",");
    for (const r of db.prepare("SELECT story_id, COUNT(*) n FROM story_items WHERE joined_at > ? AND story_id IN (" + qs + ") GROUP BY story_id").all(seenAt, ...chunk)) out[r.story_id] = { added: r.n };
    for (const r of db.prepare("SELECT story_id FROM stories WHERE created_at > ? AND story_id IN (" + qs + ")").all(seenAt, ...chunk)) out[r.story_id] = Object.assign(out[r.story_id] || {}, { new: true });
  }
  return out;
}

/**
 * 不调用模型、按上一份版面重新组版（改了关注或屏蔽后立即生效）。
 * 关键词按标题、导语、要点与各方说法匹配。
 */
export function reassemble(content, o) {
  const all = Object.values(content.stories || {}).map((s) => Object.assign({}, s, { _g: { items: [{ title: [s.lead].concat((s.points || []).map((p) => (typeof p === "string" ? p : p.text)), (s.views || []).map((v) => v.says)).filter(Boolean).join("\n"), source_id: null }].concat((s.outlets || []).map((x) => ({ title: "", source_id: x.source_id }))) } }));
  const stories = applyFollows(all, o.follows);
  const parts = assemble(stories, o.layout, o.names || {}, { front: (content.front || []).filter((i) => stories.some((s) => s.id === i)), watch: (content.watch || []).map((w) => ({ text: w.text, stories: (w.stories || []).filter((i) => stories.some((s) => s.id === i)) })).filter((w) => w.stories.length || !(w.stories || []).length), headline: content.headline });
  return Object.assign({}, content, { front: parts.front, sections: parts.sections, watch: parts.watch, verify: parts.verify, stories: Object.fromEntries(stories.map((s) => { const c = strip(s); return [s.id, c]; })), stats: Object.assign({}, content.stats, { reassembled: true }) });
}

/** 质量面板：最近几份版面的耗时、调用、沿用、核对与退回规则，以及读者报错数。 */
export function qualityRows(db, limit) {
  const rows = db.prepare("SELECT id, pack, created_at, mode, model, ms, calls, items_read, content FROM editions ORDER BY id DESC LIMIT ?").all(limit || 30);
  const fbc = db.prepare("SELECT COUNT(*) n FROM feedback WHERE edition_id = ?");
  return rows.map((r) => {
    const c = parseJ(r.content, {}) || {};
    const st = c.stats || {};
    return { id: r.id, pack: r.pack, created_at: r.created_at, mode: r.mode, model: r.model, ms: r.ms, calls: r.calls, items_read: r.items_read, fresh: st.fresh_items ?? null, reused: st.reused ?? null, written: st.written ?? null,
      check: st.check || null, fallbacks: (st.fallbacks || []).length, reassembled: Boolean(st.reassembled), reported: fbc.get(r.id).n };
  });
}

export function editionById(db, id) {
  return editionRow(db.prepare("SELECT * FROM editions WHERE id = ?").get(id));
}

export function editionList(db, pack, limit) {
  // 同一轮抓取的程序预览、进度版、重排都算一版，只列这一轮最新的那份（列表里不再是一串同标题的重复项）
  const rows = db.prepare("SELECT id, pack, run_id, created_at, mode, model, headline FROM editions" + (pack && pack !== "all" ? " WHERE pack = ?" : "") + " ORDER BY id DESC LIMIT ?").all(...(pack && pack !== "all" ? [pack] : []), (limit || 40) * 5);
  const round = new Map();
  let run = null;
  for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].run_id) run = rows[i].pack + ":" + rows[i].run_id; round.set(rows[i].id, run || rows[i].pack + ":#" + rows[i].id); }
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = round.get(r.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: r.id, pack: r.pack, created_at: r.created_at, mode: r.mode, model: r.model, headline: r.headline });
    if (out.length >= (limit || 40)) break;
  }
  return out;
}

export function editionRow(r) {
  if (!r) return null;
  return { id: r.id, pack: r.pack, run_id: r.run_id, created_at: r.created_at, mode: r.mode, model: r.model, hours: r.hours, items_read: r.items_read, headline: r.headline, error: r.error, ms: r.ms, calls: r.calls, content: parseJ(r.content, null) };
}

/**
 * 这一版和上一轮抓取的版面比：哪些故事线是新的、哪些有新报道、哪些原样沿用，上一版有、这一版没了的有几条。
 * 「上一轮」按抓取轮次算：同一轮的程序预览、边写边出的进度版、改关注后的重排（run_id 为空）都算同一版，
 * 对照的是这一轮第一份版面之前的最后一份。
 * @returns { base_id, base_at, base_mode, stories:{id:"new"|"dev"|"same"}, counts:{new,dev,same,gone} } 或 null（没有上一版）
 */
export function editionDiff(db, row) {
  if (!db || !row || !row.content) return null;
  const runRow = row.run_id ? row : db.prepare("SELECT id, run_id FROM editions WHERE id < ? AND pack = ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(row.id, row.pack);
  const first = runRow && runRow.run_id ? db.prepare("SELECT MIN(id) id FROM editions WHERE run_id = ? AND pack = ?").get(runRow.run_id, row.pack) : null;
  const before = first && first.id ? first.id : row.id;
  const b = db.prepare("SELECT id, created_at, mode, content FROM editions WHERE id < ? AND pack = ? ORDER BY id DESC LIMIT 1").get(before, row.pack);
  const base = b ? parseJ(b.content, null) : null;
  if (!base || !base.stories) return null;
  const old = base.stories;
  const stories = {};
  const counts = { new: 0, dev: 0, same: 0, gone: 0 };
  const cur = row.content.stories || {};
  for (const [id, s] of Object.entries(cur)) {
    const o = old[id];
    let k = "same";
    if (!o) k = "new";
    else {
      const had = new Set(o.article_ids || []);
      if ((s.article_ids || []).some((a) => !had.has(a))) k = "dev";
    }
    stories[id] = k;
    counts[k]++;
  }
  for (const id of Object.keys(old)) if (!cur[id]) counts.gone++;
  return { base_id: b.id, base_at: b.created_at, base_mode: b.mode, stories, counts };
}

/** 某个包最新的一份；没有时取任意包最新的一份。 */
export function latestEdition(db, pack) {
  if (!db) return null;
  let r = db.prepare("SELECT * FROM editions WHERE pack = ? ORDER BY id DESC LIMIT 1").get(pack || "all");
  if (!r && (!pack || pack === "all")) r = db.prepare("SELECT * FROM editions ORDER BY id DESC LIMIT 1").get();
  return editionRow(r);
}

/** 模型写的稿记到主事件的解读上，详情页「解读」直接可用。 */
export function notesFromEdition(db, ed) {
  const up = db.prepare("UPDATE events SET llm_notes = ? WHERE event_id = ?");
  const mc = db.prepare("SELECT member_count FROM events WHERE event_id = ?");
  let n = 0;
  for (const s of Object.values(ed.stories || {})) {
    if (s.by !== "llm" || !s.lead_event_id || !s.lead || s.lead_missing) continue;
    const e = mc.get(s.lead_event_id);
    if (!e) continue;
    up.run(JSON.stringify({ summary: s.lead, why: s.impact || "", watch: (((s.points || [])[0] || {}).text || (s.points || [])[0] || ""), model: ed.model, at: new Date().toISOString(), members: e.member_count, v: 1, from: "edition" }), s.lead_event_id);
    n++;
  }
  return n;
}

/**
 * 最新快讯：刚抓到的新闻，按时间倒排，每件事（规则事件）只取最早的一篇。不依赖版面——版面要等模型写，
 * 本地模型一轮二三十分钟，这一栏每轮抓取后就是新的。广告、行情跳动、合集原稿不算。
 * fresh：版面（最新一份）编出来之后才抓到的，读者在版面里还看不到。
 * @param o { hours（默认 6）, limit（默认 12）, editionAt: 最新一份版面的时间 }
 */
export function latestWire(db, o) {
  const since = new Date(Date.now() - ((o && o.hours) || 6) * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare(`SELECT a.id, COALESCE(NULLIF(a.title_zh, ''), a.title) title, a.url, a.first_seen_at, ${PUB} AS published_at, a.time_confidence,
      COALESCE(s.name, a.source_id) source, m.event_id, si.story_id, e.importance, e.source_count
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id LEFT JOIN event_members m ON m.article_id = a.id LEFT JOIN events e ON e.event_id = m.event_id
      LEFT JOIN story_items si ON si.article_id = a.id
    WHERE a.first_seen_at >= ? AND COALESCE(a.kind, 'news') IN ('news', 'digest_item')
    ORDER BY COALESCE(${PUB}, a.first_seen_at) DESC LIMIT 400`).all(since);
  const seen = new Set();
  const perSource = new Map();
  const out = [];
  // 标题前面常带的「2026.11.11 - 9分钟前」「17:49 」这类列表页残留去掉
  const cleanTitle = (t) => String(t || "").replace(/^\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*(-\s*\d+\s*(分钟|小时|天)前)?\s*/, "").replace(/^\d{1,2}:\d{2}\s+/, "").trim();
  for (const r of rows) {
    const key = r.event_id || r.story_id || r.id;
    if (seen.has(key)) continue;
    // 规则打分很低的（分数已算出来、又只有一家报道）不进这一栏；一个源最多占 3 条，免得一家刷屏
    if (r.importance != null && r.importance < 25 && (r.source_count || 1) < 2) continue;
    if ((perSource.get(r.source) || 0) >= 3) continue;
    seen.add(key);
    perSource.set(r.source, (perSource.get(r.source) || 0) + 1);
    // 有的源把摘要拼在标题后面：截到第一个句号或 60 字
    const tt = cleanTitle(r.title) || r.title;
    const short = tt.length > 60 ? (tt.slice(0, 60).match(/^.{12,}?[。！？]/) || [tt.slice(0, 58) + "…"])[0] : tt;
    out.push({ id: r.id, title: short, url: r.url, at: r.published_at || r.first_seen_at, approx: r.time_confidence === "fetched", source: r.source, story_id: r.story_id || null,
      importance: r.importance == null ? null : Math.round(r.importance), outlets: r.source_count || 1, fresh: Boolean(o && o.editionAt && r.first_seen_at > o.editionAt) });
    if (out.length >= ((o && o.limit) || 12)) break;
  }
  return out;
}
