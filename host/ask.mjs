/**
 * 问新闻：在本地新闻库里搜索，LLM 模式下由模型据检索到的报道作答。
 *
 * 搜索：问题去掉虚词（最近、怎么样、有什么……）切成关键词；命中 taxonomy 实体别名的，把同一实体的其它写法一并加上
 *   （问「英伟达」也能找到 Nvidia 的报道）。标题、中文译名、摘要逐词匹配，按命中词数、标题命中、重要度与新近程度排序，按故事线归拢。
 * 作答：只给模型检索到的报道（标题与正文），要求每句标出处 [n]、材料没有的不说、材料不够就直说；
 *   每句再做数字与专名核对，不过关的句子丢掉。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const STOP = /(请问|告诉我|帮我|说说|讲讲|看看|关于|最近|近期|近来|现在|目前|今天|昨天|今日|这几天|这两天|一下|怎么样了?|怎样|如何|为什么|为何|什么|哪些|是否|有没有|有什么|发生了|情况|局势|形势|走势|进展|动态|消息|新闻|最新|的|了|吗|呢|吧|呀|啊|和|与|及|在|是|有)/g;

/** 问题 → 关键词（含实体的别名）。 */
export function searchTerms(q, entities) {
  const text = String(q || "");
  const out = [];
  // 短的英文别名（Fed、AI）按子串匹配会误中 Federal、said：不用
  const push = (t) => { const x = String(t).trim(); if ([...x].length >= 2 && !(/^[A-Za-z.]+$/.test(x) && x.length < 4) && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x); };
  // 实体别名先认（「英伟达」→ Nvidia / NVIDIA）
  for (const [id, e] of Object.entries(entities || {})) {
    if (id.startsWith("_") || !e || e.weak) continue;
    const al = (e.aliases || []).filter((a) => [...String(a)].length >= 2);
    if (al.some((a) => text.toLowerCase().includes(String(a).toLowerCase()))) al.forEach(push);
  }
  text.replace(/[？?！!，,。.、：:；;“”"'‘’（）()《》\[\]【】\s]+/g, " ").replace(STOP, " ").split(/\s+/).forEach(push);
  return out.slice(0, 10);
}

/** 按关键词搜本地库，按故事线归拢。@returns { terms, stories, items } */
export function searchNews(db, o) {
  const terms = searchTerms(o.q, o.entities);
  if (!terms.length) return { terms, stories: [], items: [] };
  const like = terms.map(() => "(a.title LIKE ? OR COALESCE(a.title_zh, '') LIKE ? OR COALESCE(a.summary, '') LIKE ?)").join(" OR ");
  const args = [o.since].concat(...terms.map((t) => ["%" + t + "%", "%" + t + "%", "%" + t + "%"]));
  const rows = db.prepare(`SELECT a.id, a.title, a.title_zh, a.summary, a.url, a.source_id, s.name AS source_name, a.published_at, a.first_seen_at,
      si.story_id, COALESCE(e.importance, 0) AS importance
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id LEFT JOIN story_items si ON si.article_id = a.id
      LEFT JOIN event_members m ON m.article_id = a.id LEFT JOIN events e ON e.event_id = m.event_id
    WHERE a.first_seen_at >= ? AND COALESCE(a.kind, 'news') IN ('news', 'digest_item') AND (${like})
    ORDER BY a.first_seen_at DESC LIMIT 600`).all(...args);
  const now = Date.now();
  for (const r of rows) {
    const t = (r.title + " " + (r.title_zh || "")).toLowerCase();
    const body = String(r.summary || "").toLowerCase();
    let hit = 0, inTitle = 0;
    for (const w of terms) { const x = w.toLowerCase(); if (t.includes(x)) { hit++; inTitle++; } else if (body.includes(x)) hit++; }
    const ageH = (now - Date.parse(String(r.published_at || r.first_seen_at).replace(" ", "T") + "Z")) / 3600000;
    r.score = hit * 10 + inTitle * 6 + r.importance / 10 + Math.max(0, 12 - ageH / 6);
  }
  rows.sort((a, b) => b.score - a.score);
  const storyQ = db.prepare("SELECT story_id, title, section, copy, updated_at FROM stories WHERE story_id = ?");
  const by = new Map();
  for (const r of rows) {
    if (!r.story_id) continue;
    if (!by.has(r.story_id)) { const st = storyQ.get(r.story_id); if (!st) continue; by.set(r.story_id, { id: st.story_id, title: st.title, section: st.section, lead: (parseJ(st.copy, null) || {}).lead || "", score: 0, n: 0, latest: "" }); }
    const g = by.get(r.story_id);
    g.score += r.score; g.n++;
    const t = r.published_at || r.first_seen_at;
    if (t > g.latest) g.latest = t;
  }
  const items = rows.slice(0, o.limit || 30).map((r) => ({ id: r.id, title: r.title_zh || r.title, original: r.title_zh ? r.title : null, summary: clip(r.summary, 160), url: r.url, source: r.source_name || r.source_id, t: r.published_at || r.first_seen_at, story_id: r.story_id || null }));
  return { terms, stories: [...by.values()].sort((a, b) => b.score - a.score).slice(0, 12), items, total: rows.length };
}

export function askPrompt(q, mats) {
  return "任务：只依据给出的材料，用中文回答问题（3 到 6 句，先说结论，再按时间说经过与各方说法）。每句话都要标出依据的材料编号；材料里没有的不要说，不要推测。材料不足以回答就直说。" +
    '\n只输出一个 JSON 对象：{"answer":[{"text":"","refs":[1]}],"enough":true}' +
    "\n\n材料（编号｜来源｜时间｜标题｜内容）：\n" + mats.map((m, i) => "[" + (i + 1) + "] " + m.source + "｜" + String(m.t || "").slice(0, 16) + "｜" + m.title + "｜" + clip(m.text, 500)).join("\n") +
    "\n\n问题：" + q;
}

/**
 * 据检索结果作答。@param hits searchNews 的结果；@param bodies 文章 id → 正文
 * @returns { answer: [{ text, refs:[materials 下标] }], enough, materials, dropped }
 */
export async function answerNews(model, q, hits, bodies, o) {
  const mats = hits.items.slice(0, (o && o.max) || 14).map((it) => ({ id: it.id, title: it.title, source: it.source, t: it.t, url: it.url, text: (bodies && bodies.get(it.id)) || it.summary || it.title }));
  if (!mats.length) return { answer: [], enough: false, materials: [], dropped: 0 };
  const j = parseJsonLoose(await model.complete(askPrompt(q, mats), { step: "ask", maxTokens: 6000, timeoutMs: (o && o.timeoutMs) || 180000 }));
  if (!j) throw new Error("bad_json");
  const out = [];
  let dropped = 0;
  for (const s of Array.isArray(j.answer) ? j.answer : []) {
    const text = String((s && s.text) || "").trim().slice(0, 200);
    const refs = [...new Set((Array.isArray(s && s.refs) ? s.refs : []).map((n) => Number(n) - 1).filter((i) => i >= 0 && i < mats.length))];
    if (!text) continue;
    // 每句核对：数字与专名要在它引用的材料里（没标出处的对照全部材料）
    const src = (refs.length ? refs : mats.map((_, i) => i)).map((i) => mats[i].title + "｜" + mats[i].text);
    if (checkText(text, src).ok) out.push({ text, refs }); else dropped++;
  }
  return { answer: out, enough: j.enough !== false && out.length > 0, materials: mats.map((m) => ({ id: m.id, title: m.title, source: m.source, t: m.t, url: m.url })), dropped };
}
