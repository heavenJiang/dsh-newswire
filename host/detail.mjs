/**
 * 详细报道：读者在故事线详情里要看细节时，模型读这条故事线的全部报道（去掉重复的），写一篇分块的长稿：
 * 概述、经过（按时间）、关键数字、各方说法、背景、说法不一或待确认。
 *
 * 和版面上的稿件一样逐句核对：每句话里的数字、外文专名、引号里的词都要在材料里找得到，
 * 核对不过的句子删掉（段落按句删，不整段撤下）；出处改标到含这些成分的材料上。
 * 不联网、不用以前的报道。存 story_details（每次一行）；故事线有了新报道可以重写。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { bigrams, similarity } from "../engine/pipeline/select.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** 材料上限：篇数、总字数、每篇最多字数。 */
export const DETAIL_LIMITS = { items: 20, chars: 12000, per: 1500 };

/**
 * 详细报道的材料：这条故事线的全部报道按时间排，几乎一样的（转载、同一条快讯的更新版）只留最长的一篇；
 * 超过篇数上限时留最早的几篇（起因）和最近的（进展）。每篇的字数按总字数平分，不超过 per。
 * @returns [{ id, title, source, t, url, text }]（按时间）
 */
export function detailMaterials(db, storyId, bodiesFor, o) {
  const L = Object.assign({}, DETAIL_LIMITS, o || {});
  const rows = db.prepare(`SELECT a.id, a.title, a.title_zh, a.summary, a.url, a.published_at, a.first_seen_at, s.name AS source_name, a.source_id
    FROM story_items i JOIN articles a ON a.id = i.article_id LEFT JOIN sources s ON s.id = a.source_id
    WHERE i.story_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at)`).all(storyId);
  const bodies = bodiesFor ? bodiesFor(db, rows.map((x) => x.id)) : new Map();
  const all = rows.map((it) => {
    const title = it.title_zh || it.title || "";
    const text = String(bodies.get(it.id) || it.summary || "").replace(/\s+/g, " ").trim();
    return { id: it.id, title, source: it.source_name || it.source_id, t: it.published_at || it.first_seen_at, url: it.url, text: text === title ? "" : text, bg: bigrams(title + text.slice(0, 200)) };
  });
  // 去重：和已留下的某篇几乎一样，留长的那篇
  const kept = [];
  for (const m of all) {
    const k = kept.findIndex((x) => similarity(x.bg, m.bg) >= 0.75);
    if (k < 0) kept.push(m);
    else if (m.text.length > kept[k].text.length) kept[k] = m;
  }
  kept.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  let pick = kept;
  if (kept.length > L.items) {
    const head = Math.max(1, Math.min(4, Math.floor(L.items / 4)));
    pick = kept.slice(0, head).concat(kept.slice(kept.length - (L.items - head)));
  }
  const per = Math.max(200, Math.min(L.per, Math.floor(L.chars / Math.max(1, pick.length))));
  return pick.map((m) => ({ id: m.id, title: m.title, source: m.source, t: m.t, url: m.url, text: clip(m.text, per) }));
}

/** 给模型看的一篇材料（也是核对时用的文字：来源名称算材料）。 */
const matLine = (m) => m.source + "｜" + String(m.t || "").slice(0, 16) + "｜" + m.title + (m.text ? "｜" + m.text : "");

export function detailPrompt(story, mats, style) {
  return "任务：为一条新闻故事线写一篇详细报道，让没看过前面报道的读者读完就清楚来龙去脉和细节。" +
    "写作要求：" + (style || "客观、准确；用简体中文写，外文报道译成中文；数字、人名、机构名照录原文；不加评论性形容词。") +
    "每句话只能依据下面的材料，并在 refs 里标出依据的材料编号；材料里没有的数字、人名、机构名一律不写；各家说法不一致时如实并列，不要替读者下结论；不要写「材料称」「材料显示」这类字眼，直接写谁说了什么。" +
    "\n- overview 概述（150到250字）：这是一件什么事、起因、目前进展到哪一步" +
    "\n- timeline 经过：按时间先后 3 到 10 条，time 写材料里的日期和时间（如「11月10日 14:30」），text 写发生了什么（每条不超过80字）" +
    "\n- numbers 关键数字：金额、数量、比例、价格等，最多 6 条，每条一句话说清数字是什么（不超过60字）；只有日期的不算；没有就给空数组" +
    "\n- views 各方说法：当事方、官方、机构、分析人士的表态，最多 5 条，who 写谁，says 写说了什么（不超过80字）；没有就给空数组" +
    "\n- background 背景（不超过150字）：材料里提到的前因或相关情况；材料里没有就给空字符串" +
    "\n- open 说法不一或尚待确认的地方：最多 3 条（每条不超过60字）；没有就给空数组" +
    '\n只输出一个 JSON 对象：{"overview":{"text":"","refs":[1]},"timeline":[{"time":"","text":"","refs":[1]}],"numbers":[{"text":"","refs":[1]}],"views":[{"who":"","says":"","refs":[1]}],"background":{"text":"","refs":[1]},"open":[{"text":"","refs":[1]}]}' +
    "\n\n故事线：" + story.title + (story.lead ? "\n现有导语：" + story.lead : "") +
    "\n\n报道材料（编号｜来源｜时间｜标题｜内容），按时间先后：\n" + mats.map((m, i) => "[" + (i + 1) + "] " + matLine(m)).join("\n");
}

/** 一段话拆成句子（按句号、问号、感叹号、分号）。 */
const sentences = (t) => String(t || "").match(/[^。！？；!?;]+[。！？；!?;]?/g) || [];

/**
 * 模型的回答 → 核对过的详细报道。refs 存文章 id。
 * 段落按句核对，不过的句子删掉；短句（经过、数字、说法、待确认）不过的整条删掉。
 */
export function verifyDetail(j, mats, story) {
  const src = mats.map(matLine).concat([story.title || ""]);
  const n = mats.length;
  let checked = 0, passed = 0, dropped = 0;
  const missing = [];
  const idx = (refs) => [...new Set((Array.isArray(refs) ? refs : [refs]).map((x) => Number(String(x).replace(/^M/i, "")) - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < n))];
  const judge = (text, refs) => {
    const r = checkText(text, src);
    if (r.claims) { checked++; if (r.ok) passed++; }
    if (!r.ok) { dropped++; missing.push(...r.missing); return null; }
    const hits = [...r.hits].filter((i) => i < n);
    const use = r.claims && hits.length ? hits.sort((a, b) => a - b).slice(0, 3) : idx(refs);
    return use.map((i) => mats[i].id);
  };
  const para = (x, max) => {
    const text = str(x && x.text, max);
    if (!text) return null;
    const keep = [];
    const refs = new Set();
    for (const s of sentences(text)) { const r = judge(s, x.refs); if (r) { keep.push(s); r.forEach((id) => refs.add(id)); } }
    const t = keep.join("").trim();
    return t ? { text: t, refs: [...refs].slice(0, 4) } : null;
  };
  const line = (x, max) => { const text = str(x && x.text, max); if (!text) return null; const r = judge(text, x.refs); return r ? { text, refs: r } : null; };
  const list = (v) => (Array.isArray(v) ? v : []);
  const out = {
    v: 1,
    overview: para(j.overview, 320),
    timeline: list(j.timeline).slice(0, 10).map((x) => { const l = line(x, 110); return l ? Object.assign({ time: str(x.time, 20) }, l) : null; }).filter(Boolean),
    numbers: list(j.numbers).slice(0, 6).map((x) => line(x, 90)).filter(Boolean),
    views: list(j.views).slice(0, 5).map((x) => { const who = str(x && x.who, 24); const says = str(x && x.says, 110); if (!who || !says) return null; const r = judge(who + "：" + says, x.refs); return r ? { who, says, refs: r } : null; }).filter(Boolean),
    background: para(j.background, 200),
    open: list(j.open).slice(0, 3).map((x) => line(x, 90)).filter(Boolean),
    materials: mats.map((m) => ({ id: m.id, title: m.title, source: m.source, t: m.t, url: m.url })),
    check: { checked, passed, dropped, missing: [...new Set(missing)].slice(0, 8) },
  };
  return out;
}

/** 写一篇详细报道并核对。@returns 详细报道，或抛错（no_materials / bad_json / nothing_verified） */
export async function writeDetail(model, story, mats, o) {
  if (!mats.length) throw new Error("no_materials");
  const j = parseJsonLoose(await model.complete(detailPrompt(story, mats, o && o.style), { step: "detail", maxTokens: 9000, timeoutMs: (o && o.timeoutMs) || 300000 }));
  if (!j || typeof j !== "object") throw new Error("bad_json");
  const d = verifyDetail(j, mats, story);
  if (!d.overview && !d.timeline.length) throw new Error("nothing_verified");
  return d;
}

export function saveDetail(db, storyId, d, meta) {
  const now = nowSql();
  const n = db.prepare("SELECT COUNT(*) n FROM story_items WHERE story_id = ?").get(storyId).n;
  db.prepare("INSERT INTO story_details (story_id, created_at, model, items, content) VALUES (?,?,?,?,?)").run(storyId, now, (meta && meta.model) || null, n, JSON.stringify(d));
  return Object.assign({ created_at: now, model: (meta && meta.model) || null, items: n, newer: 0 }, d);
}

/** 最新一篇详细报道，以及写完后故事线又多了几篇报道（多了就提示可以重写）。 */
export function latestDetail(db, storyId) {
  let r;
  try { r = db.prepare("SELECT * FROM story_details WHERE story_id = ? ORDER BY id DESC LIMIT 1").get(storyId); } catch { return null; }
  if (!r) return null;
  const n = db.prepare("SELECT COUNT(*) n FROM story_items WHERE story_id = ?").get(storyId).n;
  return Object.assign({ created_at: r.created_at, model: r.model, items: r.items, newer: Math.max(0, n - r.items) }, parseJ(r.content, {}));
}
