/**
 * 前情：给正在写的报道找以前的相关故事线（参考 Horizon 的 history_search，改成查本地故事线）。
 *
 * 只在读法的某一块声明能依据以前的报道（blocks[].materials 含 history，如「技术长文」的「背景」）时用；
 * 材料编号 H1、H2……，只能写进那一块，核对时只对那一块放开。不调用模型、不联网。
 *
 * 相关度：标题字二元组相似度 + 共同的关键主体（story_entities）；要比这篇早、不是同一条故事线、
 * 有模型写过的导语（只有标题的旧故事线给不了前情）。
 */
import { bigrams, similarity } from "../engine/pipeline/select.mjs";

const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/**
 * @param story { id, title, entities?, first_seen_at? }
 * @param o { days（默认 90）, max（默认 2）, min（最低相关度，默认 0.3）}
 * @returns [{ ref: "H1", story_id, title, lead, at, score }]
 */
export function relatedStories(db, story, o) {
  const opt = Object.assign({ days: 90, max: 2, min: 0.3 }, o || {});
  const bg = bigrams(story.title || "");
  const ents = new Set((story.entities || []).filter(Boolean));
  if (!ents.size && story.id) for (const r of db.prepare("SELECT name FROM story_entities WHERE story_id = ?").all(story.id)) ents.add(r.name);
  const before = story.first_seen_at || new Date().toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare(`SELECT story_id, title, copy, created_at, updated_at FROM stories
    WHERE status = 'active' AND story_id != ? AND created_at < ? AND created_at >= datetime(?, '-' || ? || ' days') AND copy IS NOT NULL
    ORDER BY updated_at DESC LIMIT 3000`).all(story.id || "", before, before, opt.days);
  const entOf = db.prepare("SELECT name FROM story_entities WHERE story_id = ?");
  const scored = [];
  for (const r of rows) {
    const copy = parseJ(r.copy, null);
    if (!copy || !copy.lead) continue;
    let score = similarity(bg, bigrams(r.title || ""));
    if (ents.size) {
      const shared = entOf.all(r.story_id).filter((x) => ents.has(x.name)).length;
      score += 0.2 * Math.min(2, shared);
    }
    if (score >= opt.min) scored.push({ story_id: r.story_id, title: r.title, lead: clip(copy.lead, 160), at: r.updated_at || r.created_at, score: Math.round(score * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, opt.max).map((x, i) => Object.assign({ ref: "H" + (i + 1) }, x));
}

/** 前情给模型看的文字（也是核对时用的材料）。 */
export const historyText = (h) => h.title + "｜" + h.lead;
