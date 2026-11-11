/**
 * 版面：把一段时间的新闻编排成「分栏报纸式」版面，两种模式产出同一种结构，面板只负责渲染。
 *
 *   节省 token（rules）：不调用模型。报道 = 规则聚出的事件；版块 = 规则标签；导语 / 要点 / 各方说法 / 影响由程序从各家报道拼出。
 *   模型（llm）：模型全权编排。
 *     1. 归并：本时段的新闻分批交给模型，模型把讲同一件事的新闻归为一篇报道，给出标题、版块、标签和重要度（噪声条目丢弃）；
 *     2. 统筹：模型看全部报道，合并跨批重复、写一句话总括、选头版、列值得关注；
 *     3. 写稿：头版与各版块入选的报道按版式（layout.json）写导语、要点、各方说法、影响。
 *     任何一步失败都退回规则结果（该批按规则事件归并、按重要度选头版、用程序拼的稿），并记下错误。
 *   可信度始终由程序按独立报道家数与源头计算（是事实，不交给模型判断）。
 *
 * 版面整份存 editions；每条新闻在版面里的归属（报道、版块、标签、重要度）存 edition_items，模型的判断留作训练标签。
 */
import { bigrams, similarity, markReposts } from "../engine/pipeline/select.mjs";
import { markKind, isDigestTitle } from "../engine/pipeline/quality.mjs";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseJsonLoose } from "./model.mjs";
import { verifyCopy, checkText } from "./factcheck.mjs";
import { applyFollows, matchList } from "./follows.mjs";
import { relatedStories, historyText } from "./history.mjs";
import { loadProfiles, builtinProfiles, withFocus, focusOf, profileFor, promptOf, BUILTIN_PROFILES_DIR, DEFAULT_PROFILE, DEFAULT_BLOCKS } from "./profiles.mjs";
import path from "node:path";

export const EDITION_VERSION = 1;

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const CRED_RANK = { single: 0, disputed: 1, corroborated: 1, confirmed: 2 };
const CRED_TEXT = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };
const tz = (iso) => {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T") + (String(iso).includes("T") ? "" : "Z"));
  return isNaN(d) ? "" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(/\//g, "-");
};

// ------------------------------------------------------------------ 版式
export const DEFAULT_LAYOUT = {
  version: 1,
  window_hours: 12,
  min_importance: 25,
  front: { count: 3 },
  sections: [{ id: "politics", max: 4 }, { id: "macro", max: 3 }, { id: "markets", max: 3 }, { id: "industry", max: 4 }, { id: "tech", max: 8 }, { id: "study", max: 4 }, { id: "society", max: 2 }],
  story: { lead_chars: 120, points: 3, point_chars: 40, views: 3, impact_chars: 60 },
  watch: { count: 3 },
  verify: { count: 4, min_importance: 30 },
  // 重点领域：读者最关心的方向。挑材料时优先、不做规则分诊，模型评重要度时按技术影响力评，头版留位置，影响写技术带来的变化。labels 留空即关闭
  focus: { name: "AI 与新技术", labels: ["tech", "industry.ai_semis"], boost: 20 },
  style: "客观、准确、简洁；用简体中文写，外文报道译成中文；数字、人名、机构名照录原文；不加评论性形容词；材料里没有的不写；各家说法不一致时如实并列。",
};

/**
 * 版面里用的发布时间：链接里只有日期的（url_date，记成北京时间零点）当天首次抓到时用首见时间，
 * 不然同花顺这类首页源每条都显示「00:00」，还会因为「最早」被排成主条目。
 */
const PUB = "(CASE WHEN a.time_confidence = 'url_date' AND a.first_seen_at >= a.published_at AND a.first_seen_at < datetime(a.published_at, '+1 day') THEN a.first_seen_at ELSE a.published_at END)";
const staleBefore = (since) => new Date(Date.parse(String(since).replace(" ", "T") + "Z") - 24 * 3600000).toISOString().replace("T", " ").slice(0, 19);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** 合并默认值并夹紧数值；坏的版式文件退回默认。 */
export function normalizeLayout(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const D = DEFAULT_LAYOUT;
  const st = r.story || {};
  const sections = Array.isArray(r.sections) ? r.sections.filter((x) => x && typeof x.id === "string" && x.id.trim()).map((x) => ({ id: x.id.trim(), max: num(x.max, 1, 12, 3), ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim() } : {}) })) : [];
  return {
    version: num(r.version, 1, 1e6, 1),
    window_hours: num(r.window_hours, 2, 72, D.window_hours),
    min_importance: num(r.min_importance, 0, 100, D.min_importance),
    front: { count: num(r.front && r.front.count, 1, 8, D.front.count) },
    sections: sections.length ? sections : D.sections,
    story: {
      lead_chars: num(st.lead_chars, 30, 400, D.story.lead_chars), points: num(st.points, 0, 6, D.story.points), point_chars: num(st.point_chars, 10, 120, D.story.point_chars),
      views: num(st.views, 0, 6, D.story.views), impact_chars: num(st.impact_chars, 0, 200, D.story.impact_chars),
    },
    watch: { count: num(r.watch && r.watch.count, 0, 6, D.watch.count) },
    verify: { count: num(r.verify && r.verify.count, 0, 8, D.verify.count), min_importance: num(r.verify && r.verify.min_importance, 0, 100, D.verify.min_importance) },
    focus: normalizeFocus(r.focus),
    style: typeof r.style === "string" && r.style.trim() ? r.style.trim().slice(0, 600) : D.style,
  };
}

function normalizeFocus(f) {
  const D = DEFAULT_LAYOUT.focus;
  if (!f || typeof f !== "object") return Object.assign({}, D, { labels: D.labels.slice() });
  const labels = Array.isArray(f.labels) ? f.labels.filter((x) => typeof x === "string" && /^[a-z_]+(\.[a-z_]+)?$/.test(x.trim())).map((x) => x.trim()).slice(0, 8) : D.labels.slice();
  return { name: typeof f.name === "string" && f.name.trim() ? f.name.trim().slice(0, 20) : D.name, labels, boost: num(f.boost, 0, 50, D.boost) };
}

/** 分类标签是否落在重点领域（一级 id 命中其下所有二级）。 */
export function inFocus(focus, labels) {
  const fl = (focus && focus.labels) || [];
  if (!fl.length) return false;
  return (labels || []).some((l) => fl.some((f) => l === f || String(l).startsWith(f + ".")));
}

/**
 * 读版式并挂上读法表（layout.profiles，不参与序列化）：内置读法 → 版式种子旁的 profiles/ → 数据目录的 profiles/（后者覆盖前者）。
 * 版式文件里写了 focus 的，覆盖重点领域读法的名称、分类与加权；layout.focus 始终由读法表得出（旧代码照常用）。
 */
export function loadLayout(file, seedFile) {
  let raw = null;
  for (const f of [file, seedFile]) {
    if (f && existsSync(f)) { try { raw = JSON.parse(readFileSync(f, "utf8")); break; } catch { /* 坏文件：试下一个 */ } }
  }
  const layout = normalizeLayout(raw);
  const dirs = [BUILTIN_PROFILES_DIR];
  for (const f of [seedFile, file]) if (f) { const d = path.join(path.dirname(f), "profiles"); if (!dirs.includes(d)) dirs.push(d); }
  return attachProfiles(layout, loadProfiles(dirs), raw && raw.focus && typeof raw.focus === "object" ? layout.focus : null);
}

/** 把读法表挂到版式上；focus 给了就先覆盖重点领域读法。 */
export function attachProfiles(layout, reg, focus) {
  const r = focus ? withFocus(reg, focus) : reg;
  const f = focusOf(r);
  layout.focus = { name: f.name || layout.focus.name, labels: f.labels, boost: f.labels.length ? f.boost : layout.focus.boost };
  Object.defineProperty(layout, "profiles", { value: r, enumerable: false, configurable: true, writable: true });
  return layout;
}

/** 版式的读法表；没挂（测试里直接 normalizeLayout 的）就用内置读法 + 版式的 focus。 */
export function profilesOf(layout) {
  if (layout && layout.profiles) return layout.profiles;
  return withFocus(builtinProfiles(), layout && layout.focus);
}

/** 一篇报道（或一组新闻）用的读法。 */
export function storyProfile(layout, story, items) {
  const its = items || [];
  return profileFor(profilesOf(layout), { section: story.section, labels: story.labels || [], sources: [...new Set(its.map((it) => it.source_id).filter(Boolean))], declared: its.map((it) => it.src_profile || null) });
}

// ------------------------------------------------------------------ 分类表
/** taxonomy → { tops: Set, all: Set, text: 给模型看的分类表 } */
export function taxonomyIndex(labels) {
  const tops = new Set();
  const all = new Set();
  const lines = [];
  for (const t of labels || []) {
    tops.add(t.id); all.add(t.id);
    for (const c of t.children || []) all.add(c.id);
    lines.push(t.id + " " + t.name + "：" + (t.children || []).map((c) => c.id + " " + c.name).join("，"));
  }
  return { tops, all, text: lines.join("\n") };
}
const topOf = (label) => String(label || "").split(".")[0];

// ------------------------------------------------------------------ 材料
/** 源声明了读法（非默认）的新闻挑材料时加的分：规则给它们的分很低（单一来源、社区讨论不算媒体），不加会被条数上限截掉。 */
const DECLARED_BOOST = 20;

/** 时段内首次出现的新闻，附规则事件（同一事件的排在一起）。 */
export function gatherItems(db, o) {
  // 新源首轮会抓到列表里的旧闻：发布时间早于时段一天以上的不算本时段的新闻（与推送的旧闻规则一致）
  const where = ["a.first_seen_at >= ?", "(a.published_at IS NULL OR a.published_at >= ?)"];
  const args = [o.since, staleBefore(o.since)];
  if (o.pack && o.pack !== "all") { where.push("a.pack = ?"); args.push(o.pack); }
  // 重点领域的新闻：按条目自己的分类标签认（没归进事件的也算），排序时加分，免得被条数上限截掉
  const fl = (o.focus && o.focus.labels) || [];
  const focusSql = fl.length ? "EXISTS (SELECT 1 FROM article_labels l WHERE l.article_id = a.id AND (" + fl.map(() => "l.label = ? OR l.label LIKE ?").join(" OR ") + "))" : "0";
  const focusArgs = fl.flatMap((f) => [f, f + ".%"]);
  const boost = fl.length ? Number(o.focus.boost ?? 20) : 0;
  const rows = db.prepare(`SELECT ${focusSql} AS focus, a.id, a.title, a.summary, a.comments, s.tier AS src_tier, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, a.pack, a.completeness, a.kind, a.parent_id, COALESCE(s.trial, 0) AS trial,
      s.name AS source_name, s.profile AS src_profile, COALESCE(s.grp, a.source_id) AS grp, m.event_id, e.importance AS ev_importance, e.credibility AS ev_cred, e.labels AS ev_labels, e.dispute AS ev_dispute
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id LEFT JOIN event_members m ON m.article_id = a.id LEFT JOIN events e ON e.event_id = m.event_id
    WHERE ${where.join(" AND ")} AND a.title IS NOT NULL AND a.title != '' AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker')
    ORDER BY COALESCE(e.importance, 0) + ${boost} * focus + ${DECLARED_BOOST} * (COALESCE(s.profile, '') NOT IN ('', 'wire')) DESC, m.event_id, a.first_seen_at DESC LIMIT ?`).all(...focusArgs, ...args, o.limit || 150);
  return rows.map((r, i) => Object.assign(r, { n: i + 1, labels: parseJ(r.ev_labels, []), focus: Boolean(r.focus) }));
}

/** 每条能拿到的最全正文：单独抓到的正文与列表里带的全文取长的；比摘要长出一截才算（否则摘要就够了）。 */
export function bodiesFor(db, ids) {
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = db.prepare(`SELECT a.id, a.summary, a.content, b.content AS body FROM articles a
      LEFT JOIN article_bodies b ON b.article_id = a.id AND b.ok = 1 AND b.paywalled = 0
      WHERE a.id IN (` + part.map(() => "?").join(",") + ")").all(...part);
    for (const r of rows) {
      const best = [r.body, r.content].map((x) => String(x || "")).sort((a, b) => b.length - a.length)[0];
      if (best.length > String(r.summary || "").length + 40) out.set(r.id, best);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 报道（两种模式共用）
/** 试用源只能为别家印证：一篇报道的新闻全部来自试用源时，不上版（照样登记，别家跟进后自然上版）。 */
const notTrialOnly = (s) => !(s._g && s._g.items.length && s._g.items.every((it) => it.trial));

/** 由一组新闻得出报道的事实部分：媒体、家数、可信度、时间、主条目、所属规则事件。 */
function storyFacts(items) {
  // 转载：别家几小时内几乎一字不差的稿件不算独立的一家，单列为「转载」
  const tms = (it) => Date.parse(String(it.published_at || it.first_seen_at || "").replace(" ", "T") + "Z") || 0;
  const view = items.map((it) => ({ it, grp: it.grp || it.source_id, title: it.title, t: tms(it) }));
  markReposts(view);
  const outlets = [];
  const reposts = [];
  // 社区讨论（Hacker News 等）：不算独立媒体，单独列出
  const community = [];
  const seen = new Set();
  for (const v of view.slice().sort((a, b) => a.t - b.t)) {
    if (v.it.src_tier === "community") { if (!seen.has(v.grp)) { seen.add(v.grp); community.push({ source_id: v.it.source_id, name: v.it.source_name || v.it.source_id }); } continue; }
    if (!v.repost_of && !seen.has(v.grp)) { seen.add(v.grp); outlets.push({ source_id: v.it.source_id, name: v.it.source_name || v.it.source_id }); }
  }
  for (const v of view) if (v.repost_of && !seen.has(v.grp)) { seen.add(v.grp); reposts.push({ source_id: v.it.source_id, name: v.it.source_name || v.it.source_id }); }
  const evCount = new Map();
  for (const it of items) if (it.event_id) evCount.set(it.event_id, (evCount.get(it.event_id) || 0) + 1);
  const eventIds = [...evCount.keys()];
  const leadEvent = [...evCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const creds = items.map((it) => it.ev_cred).filter(Boolean);
  let credibility = "single";
  if (creds.includes("disputed")) credibility = "disputed";
  else if (outlets.length >= 2) credibility = creds.includes("confirmed") ? "confirmed" : "corroborated";
  const lead = items.slice().sort((a, b) => String(a.published_at || a.first_seen_at).localeCompare(String(b.published_at || b.first_seen_at)))[0];
  const times = items.map((it) => it.first_seen_at).filter(Boolean).sort();
  const pubs = items.map((it) => it.published_at).filter(Boolean).sort();
  return {
    outlets, reposts, ...(community.length ? { community } : {}), source_count: outlets.length, credibility, event_ids: eventIds, lead_event_id: leadEvent ? leadEvent[0] : null,
    article_ids: items.map((it) => it.id), lead_article_id: lead.id, url: lead.url, first_seen_at: times[0] || null, published_at: pubs[0] || null,
    dispute: items.map((it) => parseJ(it.ev_dispute, null)).find(Boolean) || null,
  };
}

/** 去掉快讯开头的套话：【标题】、「财联社11月9日电，」「新华社北京11月8日电」之类。 */
export function cleanLead(t) {
  return String(t || "")
    .replace(/^【[^】]{2,80}】\s*/, "")
    .replace(/^[\u4e00-\u9fa5A-Za-z]{2,12}(社|网|报|台|新闻)?(\s*[\u4e00-\u9fa5]{2,6})?\s*\d{1,2}月\d{1,2}日(电|讯|消息)[，,：:\s]*/, "")
    .trim();
}

/** 导语截到整句：限长内最后一个句号处（至少留下一半长度），找不到整句才硬截加省略号。 */
export function clipSentence(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const end = Math.max(...["。", "！", "？", "；"].map((p) => head.lastIndexOf(p)));
  return end >= n / 2 ? head.slice(0, end + 1) : clip(t, n);
}

/** 程序拼稿：导语取最早一条的摘要（去掉套话），要点取其它媒体说法不同的标题，各方说法取分歧数字；不写「影响」（程序说不出影响）。 */
function ruleCopy(items, facts, layout, factors, bodies) {
  const S = layout.story;
  // 导语：最早一条有摘要的；都没有摘要时用抓到的正文开头；再没有才用标题
  const body = (it) => (bodies && bodies.get(it.id)) || "";
  const first = items.find((it) => it.summary && it.summary !== it.title) || items.find((it) => body(it)) || items[0];
  const lead = clipSentence(cleanLead((first.summary && first.summary !== first.title ? first.summary : "") || body(first) || first.title), S.lead_chars);
  const points = [];
  const seen = [bigrams(lead)];
  for (const it of items) {
    if (points.length >= S.points) break;
    const t = cleanLead(it.title_zh || it.title);
    if (!t) continue;
    // 和导语或已有要点说的差不多的不要（几家媒体的标题常常只差几个字）
    const bg = bigrams(t);
    if (seen.some((x) => similarity(bg, x) >= 0.45) || lead.includes(t.slice(0, 12))) continue;
    seen.push(bg);
    points.push({ text: clip(t, S.point_chars + 20), refs: [it.id] });
  }
  const views = facts.dispute && Array.isArray(facts.dispute.values)
    ? facts.dispute.values.slice(0, S.views).map((v) => { const it = items.find((x) => x.grp === v.outlet); return { who: (it || {}).source_name || v.outlet, says: facts.dispute.kind + " " + v.value, refs: it ? [it.id] : [] }; })
    : [];
return { lead, lead_refs: [first.id], points, views, impact: "", by: "rules" };
}

// ------------------------------------------------------------------ 材料与出处
/** 写稿与核对用的材料：不同媒体优先、按时间，最多 6 条；可追加稿件里引用到的其它新闻。 */
export function pickMaterials(items, max) {
  const sorted = items.slice().sort((a, b) => String(a.published_at || a.first_seen_at).localeCompare(String(b.published_at || b.first_seen_at)));
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const it of sorted) { (seen.has(it.grp) ? rest : first).push(it); seen.add(it.grp); }
  return first.concat(rest).slice(0, max || 6);
}
/**
 * 材料文本：与写稿时给模型看的一致（核对只认模型看到过的内容）。
 * content 是读法的材料设置：正文截多少字、摘要截多少字、截取方式（prefix 取开头；head-middle-tail 取开头、中段、结尾，长文的结论不会被截掉）。
 */
export const materialText = (it, bodies, content) => {
  const c = content || {};
  const body = bodies && bodies.get(it.id);
  // 有正文时给正文（摘要多半是正文开头，不重复给）；没有就给摘要
  const main = [it.title, body ? sample(body, c.body_chars || 900, c.sampling) : it.summary ? clip(it.summary, c.summary_chars || 240) : ""].filter(Boolean).join("｜");
  // 社区评论（Hacker News 等）：读法要看评论（content.comments > 0）时附在后面，标明是评论，不是报道原文
  return c.comments > 0 && it.comments ? main + "｜" + COMMENTS_MARK + clip(it.comments, c.comments) : main;
};
export const COMMENTS_MARK = "【社区评论】";
/** 只认报道原文的材料设置（核对导语、要点等不能依据评论的块）。 */
const sourceOnly = (content) => (content && content.comments ? Object.assign({}, content, { comments: 0 }) : content);

/** 长文按读法截取：prefix 取开头；head-middle-tail 按 4:3:3 取开头、中段、结尾，用「……」隔开。 */
export function sample(text, n, mode) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (mode !== "head-middle-tail" || t.length <= n) return clip(t, n);
  const avail = n - 4;
  const a = Math.floor(avail * 0.4), b = Math.floor(avail * 0.3), c = avail - a - b;
  const mid = Math.max(a, Math.floor(t.length / 2 - b / 2));
  return t.slice(0, a).trim() + "……" + t.slice(mid, mid + b).trim() + "……" + t.slice(t.length - c).trim();
}
const matView = (it) => ({ id: it.id, name: it.source_name || it.source_id, url: it.url, t: it.published_at || it.first_seen_at });

function loadArticles(db, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT a.id, a.title, a.summary, a.comments, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, s.name AS source_name, COALESCE(s.grp, a.source_id) AS grp
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id WHERE a.id IN (` + ids.map(() => "?").join(",") + ")").all(...ids);
}

/**
 * 核对一篇模型稿并整理出处（出处存文章 id）。程序稿不核对（取自原文）。
 * 结果写回 story：lead / lead_refs / lead_missing / points / views / impact / materials / check / push_lead。
 */
export function verifyStory(db, story, items, bodies, content, blocks) {
  const hist = Array.isArray(story.history) ? story.history : [];
  const cited = [...new Set([].concat(story.lead_refs || [], ...(story.points || []).map((p) => (p && p.refs) || []), ...(story.views || []).map((v) => v.refs || []),
    ...(story.extra || []).flatMap((b) => [].concat(b.refs || [], ...(b.items || []).map((x) => x.refs || [])))).filter((x) => typeof x === "string"))];
  let mats = pickMaterials(items, content && content.materials);
  const missingIds = cited.filter((id) => !mats.some((m) => m.id === id));
  if (missingIds.length) mats = mats.concat(loadArticles(db, missingIds));
  const toIdx = (refs) => (refs || []).map((id) => mats.findIndex((m) => m.id === id)).filter((i) => i >= 0);
  // 下标超出材料的是以前的报道（前情）：记成 h:<故事线 id>
  const toIds = (idx) => (idx || []).map((i) => (mats[i] ? mats[i].id : hist[i - mats.length] ? "h:" + hist[i - mats.length].story_id : null)).filter(Boolean);
  story.materials = mats.map(matView);
  if (story.by !== "llm") { story.check = null; return story; }
  const histIdx = (refs) => (refs || []).map((r) => { const k = hist.findIndex((h) => "h:" + h.story_id === r); return k >= 0 ? mats.length + k : -1; }).filter((i) => i >= 0);
  const extra = (story.extra || []).map((b) => Object.assign({}, b, { refs: toIdx(b.refs).concat(histIdx(b.refs)), items: (b.items || []).map((x) => ({ text: x.text, refs: toIdx(x.refs).concat(histIdx(x.refs)) })) }));
  // 每一块能对照的材料：只认报道原文；能依据社区评论的块带上评论；能依据以前报道的块再接上前情（下标排在材料后面）
  const srcTexts = mats.map((m) => materialText(m, bodies, sourceOnly(content)));
  const wideTexts = mats.map((m) => materialText(m, bodies, content));
  const histTexts = hist.map(historyText);
  const byBlock = new Map((blocks || []).map((b) => [b.id, b.materials || ["source"]]));
  const sourcesFor = (id) => { const m = byBlock.get(id) || ["source"]; return (m.includes("community") ? wideTexts : srcTexts).concat(m.includes("history") ? histTexts : []); };
  const v = verifyCopy({ lead: story.lead, lead_refs: toIdx(story.lead_refs), points: (story.points || []).map((p) => (typeof p === "string" ? p : { text: p.text, refs: toIdx(p.refs) })), views: (story.views || []).map((x) => ({ who: x.who, says: x.says, refs: toIdx(x.refs) })), impact: story.impact, extra },
    srcTexts, { sourcesFor });
  Object.assign(story, {
    lead: v.copy.lead, lead_refs: toIds(v.copy.lead_refs), points: v.copy.points.map((p) => ({ text: p.text, refs: toIds(p.refs) })),
    views: v.copy.views.map((x) => ({ who: x.who, says: x.says, refs: toIds(x.refs) })), impact: v.copy.impact, check: v.check,
  });
  if (v.copy.extra && v.copy.extra.length) story.extra = v.copy.extra.map((b) => (b.kind === "list" ? { id: b.id, name: b.name, kind: "list", items: b.items.map((x) => ({ text: x.text, refs: toIds(x.refs) })) } : { id: b.id, name: b.name, kind: "text", text: b.text, refs: toIds(b.refs) }));
  else delete story.extra;
  if (v.copy.lead_missing) {
    story.lead_missing = v.copy.lead_missing;
    // 推送不用待核的导语：改用最早一条报道的摘要
    const first = items.find((it) => it.summary) || items[0];
    story.push_lead = clip(first.summary || first.title, 120);
  } else delete story.lead_missing;
  return story;
}

// ------------------------------------------------------------------ 组版（两种模式共用）
function assemble(stories, layout, names, extra) {
  const byImp = stories.slice().sort((a, b) => b.importance - a.importance);
  const shown = byImp.filter((s) => s.importance >= layout.min_importance);
  const sections = [];
  const placed = new Set();
  const known = new Set(layout.sections.map((x) => x.id));
  // 我的关注：不受上版门槛限制，放在各版块之前；这些报道不再在各版块重复
  const fol = byImp.filter((s) => s.followed && s.followed.length).slice(0, 6).map((s) => s.id);
  if (fol.length) { sections.push({ id: "following", name: "我的关注", stories: fol }); fol.forEach((i) => placed.add(i)); }
  const focal = (s) => inFocus(layout.focus, [s.section].concat(s.labels || []));
  for (const sec of layout.sections) {
    // 版块满了也给重点领域（AI 与新技术）的报道多留 3 个位置，不因条数上限漏掉
    const cand = shown.filter((s) => s.section === sec.id && !placed.has(s.id));
    const keep = cand.slice(0, sec.max);
    for (const s of cand.slice(sec.max)) { if (keep.length >= sec.max + 3) break; if (focal(s)) keep.push(s); }
    const ids = keep.map((s) => s.id);
    if (ids.length) { sections.push({ id: sec.id, name: sec.name || names[sec.id] || sec.id, stories: ids }); ids.forEach((i) => placed.add(i)); }
  }
  const others = shown.filter((s) => !known.has(s.section) && !placed.has(s.id)).slice(0, 3).map((s) => s.id);
  if (others.length) { sections.push({ id: "other", name: "其他", stories: others }); others.forEach((i) => placed.add(i)); }
  const ids = new Set(stories.map((s) => s.id));
  let front = (extra.front || []).filter((i) => ids.has(i));
  if (!front.length) front = byImp.slice(0, layout.front.count).map((s) => s.id);
  // 模型给的头版不够数（合并后重复被去掉等）：按重要度补齐
  for (const x of shown) { if (front.length >= layout.front.count) break; if (!front.includes(x.id)) front.push(x.id); }
  front = front.slice(0, layout.front.count);
  // 头版至少一篇重点领域的报道：最重要的那篇够分量（≥45）而头版没有时，换掉头版最后一篇（头条不动）
  const topFocal = layout.front.count >= 2 ? byImp.find((s) => focal(s) && s.importance >= 45) : null;
  if (topFocal && !front.some((i) => { const s = stories.find((x) => x.id === i); return s && focal(s); })) {
    if (front.length >= layout.front.count) front[front.length - 1] = topFocal.id; else front.push(topFocal.id);
  }
  const get = (i) => stories.find((s) => s.id === i);
  // 只有社区讨论、没有媒体报道的（Hacker News 帖子）不是待核实的新闻
  const verify = byImp
    .filter((s) => (s.source_count === 1 || (s.source_count === 0 && !(s.community || []).length)) && s.importance >= layout.verify.min_importance || s.credibility === "disputed")
    .slice(0, layout.verify.count)
    .map((s) => ({ text: s.title + (s.credibility === "disputed" ? "：各家" + ((s.dispute && s.dispute.kind) || "说法") + "不一" : "：仅 " + ((s.outlets[0] || {}).name || "一家") + " 报道"), stories: [s.id] }));
  const watch = (extra.watch || []).filter((w) => w.text).slice(0, layout.watch.count);
  // 没有模型写的总括时，用头条的标题（几条截断的标题拼在一起读不通）
  const headline = extra.headline || clip(cleanLead(((get(front[0]) || {}).title) || ""), 40);
  return { headline, front, sections, watch, verify, placed: [...placed, ...front] };
}

function finish(o, stories, parts, meta) {
  const map = {};
  for (const s of stories) map[s.id] = s;
  return {
    v: EDITION_VERSION, mode: meta.mode, model: meta.model || null, pack: o.pack || "all", hours: o.hours, since: o.since, layout_version: o.layout.version,
    items_read: meta.items_read, headline: parts.headline, front: parts.front, sections: parts.sections, watch: parts.watch, verify: parts.verify,
    stories: map, stats: meta.stats || {},
  };
}

// ------------------------------------------------------------------ 故事线：报道跨版面延续
export const storyIdFor = (articleId) => "st-" + createHash("sha1").update(String(articleId)).digest("hex").slice(0, 12);

/** 这些新闻已归入的故事线：article_id → story_id。 */
export function assignments(db, articleIds) {
  const out = new Map();
  for (let i = 0; i < articleIds.length; i += 400) {
    const chunk = articleIds.slice(i, i + 400);
    for (const r of db.prepare("SELECT article_id, story_id FROM story_items WHERE article_id IN (" + chunk.map(() => "?").join(",") + ")").all(...chunk)) out.set(r.article_id, r.story_id);
  }
  return out;
}

/** 故事线行：story_id → { title, section, labels, importance, copy, total（已归入的新闻总数）} */
export function storyRows(db, ids) {
  const out = new Map();
  const q = db.prepare("SELECT s.*, (SELECT COUNT(*) FROM story_items i WHERE i.story_id = s.story_id) AS total FROM stories s WHERE s.story_id = ?");
  for (const id of ids) {
    const r = q.get(id);
    if (r) out.set(id, Object.assign(r, { labels: parseJ(r.labels, []), copy: parseJ(r.copy, null), entities: db.prepare("SELECT name FROM story_entities WHERE story_id = ?").all(id).map((x) => x.name) }));
  }
  return out;
}

/** 稿件可以沿用：模型写的，且写稿后没有新报道加入。 */
const copyFresh = (row, total) => Boolean(row && row.copy && row.copy.by === "llm" && row.copy.items >= total);
const copyOf = (c) => Object.assign({ lead: c.lead || "", lead_refs: c.lead_refs || [], points: c.points || [], views: c.views || [], impact: c.impact || "" }, Array.isArray(c.extra) && c.extra.length ? { extra: c.extra } : {}, Array.isArray(c.history) && c.history.length ? { history: c.history } : {});

// ------------------------------------------------------------------ 节省 token：程序编排
export function ruleEdition(db, o) {
  const layout = o.layout;
  const where = ["e.last_seen_at >= ?", "e.importance >= ?", "e.first_seen_at >= ?"];
  const args = [o.since, Math.min(layout.min_importance, layout.verify.min_importance), staleBefore(o.since)];
  if (o.pack && o.pack !== "all") { where.push("e.pack = ?"); args.push(o.pack); }
  const events = db.prepare("SELECT e.* FROM events e WHERE " + where.join(" AND ") + " ORDER BY e.importance DESC LIMIT 80").all(...args);
  const memQ = db.prepare(`SELECT a.id, a.title, a.summary, a.comments, s.tier AS src_tier, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, a.completeness, COALESCE(s.trial, 0) AS trial, s.name AS source_name, s.profile AS src_profile, COALESCE(m.grp, a.source_id) AS grp, m.event_id
    FROM event_members m JOIN articles a ON a.id = m.article_id LEFT JOIN sources s ON s.id = a.source_id WHERE m.event_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at) LIMIT 10`);
  // 每个规则事件对应一条故事线：成员已归入的沿用那条（模型模式下起的标题、写的稿都能接着用），否则新起
  const byId = new Map();
  const groups = [];
  const fb = feedbackState(db);
  for (const e of events) {
    let items = memQ.all(e.event_id).map((it) => Object.assign(it, { ev_cred: e.credibility, ev_dispute: e.dispute, labels: parseJ(e.labels, []) }));
    if (!items.length) continue;
    const asg = assignments(db, items.map((it) => it.id));
    const counts = new Map();
    for (const v of asg.values()) counts.set(v, (counts.get(v) || 0) + 1);
    const id = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : storyIdFor(e.lead_article_id || items[0].id);
    items = items.filter((it) => !fb.banned(it.id, id));
    if (!items.length) continue;
    const fresh = items.filter((it) => !asg.has(it.id));
    if (byId.has(id)) { const g = byId.get(id); g.items.push(...items); g.fresh.push(...fresh); continue; }
    const g = { id, event: e, items, fresh };
    byId.set(id, g);
    groups.push(g);
  }
  const rows = storyRows(db, groups.map((g) => g.id));
  const gb = bodiesFor(db, groups.flatMap((g) => g.items.map((it) => it.id)));
  let reused = 0;
  const allStories = groups.map((g) => {
    const e = g.event;
    const row = rows.get(g.id);
    const labels = parseJ(e.labels, []);
    const facts = storyFacts(g.items);
    facts.credibility = e.credibility || facts.credibility;
    const total = (row ? row.total : 0) + g.fresh.length;
    let copy;
    if (copyFresh(row, total)) { copy = Object.assign(copyOf(row.copy), { by: "llm", reused: true }); reused++; }
    else copy = ruleCopy(g.items, facts, layout, parseJ(e.factors, {}), gb);
    const section = row ? row.section : topOf(labels[0]) || "other";
    const prof = storyProfile(layout, { section, labels: row ? row.labels : labels }, g.items);
    return Object.assign({ id: g.id, title: row ? row.title : e.title, section, labels: row ? row.labels : labels, importance: Math.round(e.importance || 0), profile: prof.id, ...(prof.badge ? { badge: prof.badge } : {}), is_new: !row, updated: Boolean(row) && g.fresh.length > 0 }, facts, copy, { _g: g, _total: total });
  });
  for (const s of allStories) if (s.updated) Object.assign(s, programUpdate(s._g.fresh));
  // 关注与屏蔽：屏蔽的不上版（但照样登记故事线，免得下次再处理）
  const stories = applyFollows(allStories.slice(), o.follows).filter(notTrialOnly);
  const rb = bodiesFor(db, stories.filter((s) => s.by === "llm").flatMap((s) => s._g.items.map((it) => it.id)));
  for (const s of stories) { verifyStory(db, s, s._g.items, rb, profilesOf(layout).get(s.profile).content, profilesOf(layout).get(s.profile).blocks); scrubStory(s, fb.errors.get(s.id)); }
  const watch = events.filter((e) => { const f = parseJ(e.factors, {}); return (f.persistence > 0 || f.speed > 0) && e.importance >= 40; })
    .slice(0, layout.watch.count).map((e) => { const s = stories.find((x) => x.event_ids.includes(e.event_id)); return s ? { text: s.title + "：" + s.source_count + " 家跟进，仍在发展", stories: [s.id] } : null; }).filter(Boolean);
  const parts = assemble(stories, layout, o.names || {}, { watch });
  const out = finish(o, stories.map(strip), parts, { mode: "rules", items_read: stories.reduce((n, s) => n + s.article_ids.length, 0), stats: { reused, fresh_items: groups.reduce((n, g) => n + g.fresh.length, 0), check: sumChecks(stories) } });
  // 规则模式只登记新故事线与新归入的新闻，不改已有故事线的标题、版块和模型写的稿
  out._persist = allStories.map((s) => ({ id: s.id, isNew: s.is_new, title: s.title, section: s.section, labels: s.labels, importance: s.importance, profile: s.profile, keepMeta: !s.is_new, copy: null, update: s.updated && s.update_text ? { text: s.update_text, by: s.update_by, items: s._g.fresh.length } : null, items: s._g.fresh.map((it) => ({ article_id: it.id, event_id: it.event_id || null })) }));
  return out;
}

// ------------------------------------------------------------------ 读者报错
/** 未处理的错句（按故事线）与「不属于这条故事线」的报道。 */
export function feedbackState(db) {
  const errors = new Map();
  const forbidden = new Map();
  for (const e of db.prepare("SELECT story_id, text, note FROM feedback WHERE kind = 'error' AND resolved_at IS NULL").all()) {
    if (!errors.has(e.story_id)) errors.set(e.story_id, []);
    errors.get(e.story_id).push({ text: e.text, note: e.note });
  }
  for (const m of db.prepare("SELECT story_id, article_id FROM feedback WHERE kind = 'misplaced'").all()) {
    if (!forbidden.has(m.article_id)) forbidden.set(m.article_id, new Set());
    forbidden.get(m.article_id).add(m.story_id);
  }
  return { errors, forbidden, banned: (aid, sid) => Boolean(forbidden.get(aid) && forbidden.get(aid).has(sid)) };
}

/** 撤下读者指出有误的句子；导语被指出时标待核，推送改用原文摘要。 */
export function scrubStory(story, errs) {
  if (!story || !errs || !errs.length) return story;
  const bad = new Set(errs.map((e) => String(e.text || "").trim()).filter(Boolean));
  const txt = (p) => (typeof p === "string" ? p : p && p.text);
  story.points = (story.points || []).filter((p) => !bad.has(String(txt(p) || "").trim()));
  story.views = (story.views || []).filter((v) => !bad.has(String(v.says || "").trim()) && !bad.has(v.who + "：" + v.says));
  if (story.impact && bad.has(story.impact.trim())) story.impact = "";
  if (Array.isArray(story.extra)) story.extra = story.extra.map((b) => (b.kind === "list" ? Object.assign({}, b, { items: (b.items || []).filter((x) => !bad.has(String(x.text || "").trim())) }) : b.text && bad.has(b.text.trim()) ? null : b)).filter((b) => b && (b.kind !== "list" || b.items.length));
  if (story.update_text && bad.has(story.update_text.trim())) delete story.update_text;
  if (story.lead && bad.has(story.lead.trim())) { story.lead_missing = ["读者指出有误"]; story.push_lead = story.push_lead || ""; }
  story.reported = errs.length;
  return story;
}

/** 程序写的进展：新增几篇、最新一篇的标题。 */
function programUpdate(fresh) {
  if (!fresh || !fresh.length) return {};
  const last = fresh.slice().sort((a, b) => String(b.published_at || b.first_seen_at).localeCompare(String(a.published_at || a.first_seen_at)))[0];
  return { update_text: "新增 " + fresh.length + " 篇：" + clip(last.title, 40) + "（" + (last.source_name || last.source_id) + "）", update_by: "rules" };
}

/** 全版核对汇总：核对了多少句、通过多少、丢弃多少、标待核多少。 */
function sumChecks(stories) {
  const t = { stories: 0, checked: 0, passed: 0, dropped: 0, flagged: 0 };
  for (const s of stories) if (s.check) { t.stories++; t.checked += s.check.checked; t.passed += s.check.passed; t.dropped += s.check.dropped; t.flagged += s.check.flagged; }
  return t;
}

const strip = (s) => { const c = Object.assign({}, s); delete c._g; delete c._total; delete c._k; if (Array.isArray(c.history) && !c.history.length) delete c.history; return c; };

// ------------------------------------------------------------------ 模型：提示词
/**
 * 一批新闻的候选已有报道：按相关度（标题字二元组相似度、关键主体是否出现在标题里）取前 n 个，不足的用最重要的补。
 */
export function pickCandidates(groups, batch, n) {
  const bgs = batch.map((it) => bigrams(it.title_zh || it.title || ""));
  const titles = batch.map((it) => String(it.title_zh || "") + " " + String(it.title || ""));
  const scored = groups.map((g) => {
    const gb = bigrams(g.title || "");
    let best = 0;
    for (const b of bgs) { const s0 = similarity(gb, b); if (s0 > best) best = s0; }
    const ents = (g.entities || []).filter((e) => e && titles.some((t) => t.includes(e))).length;
    return { g, score: best + 0.25 * ents };
  });
  const rel = scored.filter((x) => x.score >= 0.12).sort((a, b) => b.score - a.score).slice(0, Math.ceil(n * 0.75)).map((x) => x.g);
  const rest = groups.filter((g) => !rel.includes(g)).sort((a, b) => b.importance - a.importance).slice(0, n - rel.length);
  return rel.concat(rest);
}

/** 提示词的固定部分放前面、材料放后面：生产环境的大模型对相同前缀有缓存，固定部分命中就省 token。 */
/** 重点领域的评分要求（归并时给模型）。 */
/** 文字取自重点领域读法的 rubric.md；reg 是读法表（不给用内置读法）。 */
export function focusRubric(focus, reg) {
  if (!focus || !(focus.labels || []).length) return "";
  const r = withFocus(reg || builtinProfiles(), focus);
  return promptOf(r.list.find((p) => p.focus), "rubric");
}

/**
 * 有评分要求（rubric.md）的其他读法：这一批里有它的源（源声明了它，或在它的 match.sources 里）才告诉模型
 * （重点领域读法已由 focusRubric 给出）。
 */
function otherRubrics(reg, items) {
  const has = (p) => (items || []).some((it) => it.src_profile === p.id || p.match.sources.includes(it.source_id));
  return (reg ? reg.list : []).filter((p) => !p.focus && p.id !== DEFAULT_PROFILE && promptOf(p, "rubric") && has(p)).map((p) => promptOf(p, "rubric"));
}

export function groupPrompt(items, tax, cands, adExamples, focus, reg) {
  const fr = focusRubric(focus, reg);
  const more = otherRubrics(reg, items);
  const lines = items.map((it) => "[" + it.n + "] " + (fr && it.focus ? "★" : "") + (it.source_name || it.source_id) + "｜" + tz(it.published_at || it.first_seen_at) + "｜" + clip(it.title, 100) + (it.summary ? "｜" + clip(it.summary, 90) : "") +
    (it._peers && it._peers.length ? "（同一事件另有 " + it._peers.length + " 篇：" + [...new Set(it._peers.map((x) => x.source_name || x.source_id))].slice(0, 4).join("、") + "）" : ""));
  const known = (cands || []).map((g, i) => "[S" + (i + 1) + "] " + g.section + "｜" + clip(g.title, 50));
  return "任务：把讲同一件事的新闻归为一篇报道（中英文报道同一件事也要归在一起）。不是新闻的条目——广告、营销推广、付费栏目的引流预告（隐去公司名、写「这家公司」并给出看好结论的荐股稿）、栏目导航——编号放进 noise，不要收进报道。新闻合集、要闻汇总、日程预告、行情数据都是新闻，不放进 noise。" +
    "新闻讲的是某篇已有报道（编号 S…）的同一件事（含后续进展）时，填 story 为那篇的编号（如 \"S3\"），不必再给标题等；有重大进展时可给出新的 importance。其余的组成新报道，story 留空。" +
    "每篇新报道给出：\n- title：中文标题，概括这件事（不超过30字）\n- section：一级分类 id；labels：最贴切的 1–2 个二级分类 id" +
    "\n- importance：0–100 的重要度，看影响面、权威性、报道家数与时效（常规公告、个股小事 20–40；全国性政策、重大市场波动 50–70；重大国际事件、突发灾难 70 以上）" +
    (fr ? "\n" + fr + "标 ★ 的是程序按分类认出的这类新闻，没标的也可能是。" : "") +
    more.map((t) => "\n" + t).join("") +
    "\n- entities：这件事的关键主体（公司、机构、人物、产品或技术名，最多 4 个，用最常见的中文名）" +
    '\n只输出一个 JSON 对象：{"stories":[{"items":[编号],"story":"","title":"","section":"","labels":[""],"importance":0,"entities":[""]}],"noise":[编号]}' +
    "\n\n分类表（一级 id 名称：二级 id 名称……）：\n" + tax.text +
    ((adExamples || []).length ? "\n\n读者标记过的非新闻示例（同类的也放进 noise）：\n" + adExamples.map((x) => "- " + clip(x, 60)).join("\n") : "") +
    (known.length ? "\n\n已有报道（编号｜版块｜标题）：\n" + known.join("\n") : "") +
    "\n\n新抓到的新闻（编号｜来源｜时间｜标题｜摘要）：\n" + lines.join("\n");
}

export function planPrompt(stories, layout) {
  const fr = layout.focus && (layout.focus.labels || []).length ? layout.focus : null;
  const focal = fr ? profilesOf(layout).list.find((p) => p.focus) : null;
  const lines = stories.map((s, i) => "[" + (i + 1) + "] " + (fr && inFocus(fr, [s.section].concat(s.labels || [])) ? "★" : "") + s.section + "｜" + s.importance + "｜" + s.source_count + "家｜" + clip(s.title, 60));
  return "任务：给一份新闻版面做统筹。\n1. merge：讲同一件事、应当合并的报道编号组（没有就给空数组）\n2. headline：一句话总括这段时间最重要的事（不超过40字）\n3. front：头版放的 " + layout.front.count + " 篇报道编号，按重要性排序\n4. watch：值得继续关注的 " + Math.max(1, layout.watch.count) + " 件事以内，每件说明原因（不超过50字），附报道编号" +
    (focal && promptOf(focal, "plan") ? "\n" + promptOf(focal, "plan") : "") +
    "\n5. themes：把属于同一条更大的主线、但不是同一件事的报道串起来（如同一场冲突的不同事件、同一家公司接连的动作、同一项技术的多方进展），每条主线给 name（不超过12字）、kind（conflict/company/technology/policy/market/other）和报道编号；没有就给空数组" +
    '\n只输出一个 JSON 对象：{"merge":[[编号]],"headline":"","front":[编号],"watch":[{"text":"","refs":[编号]}],"themes":[{"name":"","kind":"","refs":[编号]}]}' +
    "\n\n这段时间按重要度排列的报道（编号｜版块｜重要度｜报道家数｜标题）：\n" + lines.join("\n");
}

/**
 * 输出块 → 版式说明与 JSON 格式。默认四块（导语、要点、各方说法、影响）的说法与原来一字不差。
 * 标准块可以用 chars / max / ask 改字数、条数和要求；自定义块：text 是一段话，list 是几条短句，都要标出处。
 */
export function blockSpec(blocks, S, comments) {
  const desc = [];
  const json = ['"ref":1'];
  const wide = (b) => (comments && (b.materials || []).includes("community") ? "，可以依据【社区评论】" : "");
  for (const b of blocks) {
    if (b.kind === "lead") { desc.push("lead 导语（不超过" + (b.chars || S.lead_chars) + "字，" + (b.ask || "说清谁、何时、何事") + "）"); json.push('"lead":""', '"lead_refs":["M1"]'); }
    else if (b.kind === "points") { desc.push("points 要点（最多" + (b.max || S.points) + "条，每条不超过" + (b.chars || S.point_chars) + "字，" + (b.ask || "写导语之外的关键事实或数字") + wide(b) + "）"); json.push('"points":[{"text":"","refs":["M2"]}]'); }
    else if (b.kind === "views") { desc.push("views " + (b.name || "各方说法") + "（最多" + (b.max || S.views) + "条，{who: " + (wide(b) ? "媒体、当事方或评论者" : "媒体或当事方") + ", says: 说法}，" + (b.ask || "只在各家说法不同或有当事方表态时写，否则给空数组") + wide(b) + "）"); json.push('"views":[{"who":"","says":"","refs":["M1"]}]'); }
    else if (b.kind === "impact") { desc.push("impact 影响（不超过" + (b.chars || S.impact_chars) + "字，" + (b.ask || "对市场、政策或相关人群的影响，材料不足就给空字符串") + "）"); json.push('"impact":""'); }
    else if (b.kind === "text") { desc.push(b.id + " " + b.name + "（不超过" + (b.chars || 80) + "字，" + (b.ask || "") + wide(b) + "；材料不足就给空字符串）"); json.push('"' + b.id + '":{"text":"","refs":["M1"]}'); }
    else if (b.kind === "list") { desc.push(b.id + " " + b.name + "（最多" + (b.max || 3) + "条，每条不超过" + (b.chars || 40) + "字，" + (b.ask || "") + wide(b) + "；没有就给空数组）"); json.push('"' + b.id + '":[{"text":"","refs":["M1"]}]'); }
  }
  json.push('"update":""');
  return { text: desc.join("；"), json: '{"stories":[{' + json.join(",") + "}]}" };
}

export function writePrompt(batch, layout) {
  const S = layout.story;
  const reg = profilesOf(layout);
  // 每篇的读法：调用方给了就用（entryOf），否则按版块与分类认
  const profs = batch.map((b) => b.profile || profileFor(reg, { section: b.story.section, labels: b.story.labels || [] }));
  // 材料编号 M1…：每句话都要标出依据哪几条材料，程序据此核对
  const blocks = batch.map((b, i) => {
    // 已有故事线有新报道：给出上次的导语，并标出哪些是新材料，让模型写「相比上次的新进展」
    const freshIds = new Set((b.fresh || []).map((it) => it.id));
    const fresh = b.mats.map((it, k) => (freshIds.has(it.id) ? "M" + (k + 1) : null)).filter(Boolean);
    const prev = b.prevLead ? "\n上次导语：" + clip(b.prevLead, 160) + (fresh.length ? "\n本次新增材料：" + fresh.join("、") : "") : "";
    const fbk = (b.errors || []).length ? "\n读者指出这些说法有误，不要再写：" + b.errors.map((e) => "『" + clip(e.text, 60) + "』" + (e.note ? "（" + clip(e.note, 40) + "）" : "")).join("；") : "";
    const p = profs[i];
    const star = p.id !== DEFAULT_PROFILE && promptOf(p, "write") ? "（" + p.name + "）" : "";
    // 前情：以前的相关故事线（H 编号），只能写进读法里能依据以前报道的块
    const hb = p.blocks.filter((x) => (x.materials || []).includes("history")).map((x) => x.name || x.id);
    const hist = (b.history || []).length && hb.length ? "\n以前的相关报道（前情，只能用在「" + hb.join("」「") + "」里，引用写 H 编号；和这件事没有直接关系就不要用）：\n" + b.history.map((h) => "[" + h.ref + "] " + String(h.at || "").slice(0, 10) + "｜" + historyText(h)).join("\n") : "";
    return "【报道" + (i + 1) + "】" + star + b.story.title + prev + fbk + "\n材料：\n" + b.mats.map((it, k) => "[M" + (k + 1) + "] " + (it.source_name || it.source_id) + "｜" + tz(it.published_at || it.first_seen_at) + "｜" + materialText(it, b.bodies, p.content)).join("\n") + hist;
  });
  // 版式与输出格式：这一批的读法都一样时按它的输出块，否则用默认的四块
  const spec = blockSpec(profs.every((p) => p.blocks === profs[0].blocks) ? profs[0].blocks : DEFAULT_BLOCKS, S, profs.some((p) => p.content.comments > 0));
  // 这一批里用到的其他读法的写稿要求
  const asks = [...new Set(profs.filter((p) => p.id !== DEFAULT_PROFILE && promptOf(p, "write")))].map((p) => "标了（" + p.name + "）的报道，" + promptOf(p, "write"));
  return "请按版式为以下每篇报道写稿。写作要求：" + layout.style + "每句话只能依据该报道的材料，并在 refs 里标出依据的材料编号；材料里没有的数字、人名、机构名一律不写。" +
    "\n版式：" + spec.text + "。" +
    asks.join("") + "\n\n" +
    "update：只对给了「上次导语」的报道写，说清相比上次有什么新进展（不超过40字，依据新增材料；没有实质进展给空字符串）。" +
    "\n只输出一个 JSON 对象：" + spec.json +
    "\n\n" + blocks.join("\n\n");
}

// ------------------------------------------------------------------ 模型编排（增量）
/**
 * 增量编排：已归入故事线的新闻不再交给模型归并；新新闻由模型归入已有故事线或另起；只有新增了报道的故事线才重写稿；
 * 没有新新闻时沿用上一份版面的统筹（总括、头版、值得关注）。
 * @param o { pack, since, hours, layout, names, taxonomy, maxItems, maxStories, batchSize, budgetMs, callTimeoutMs, prev（上一份版面内容）}
 * @returns 版面；材料太少时 { fallback: "too_few_items" }
 */
/** 按顺序分批，每批 n 篇、同一个读法：取下一篇，再从后面按顺序找同读法的凑满。 */
export function batchByProfile(list, n) {
  const rest = list.slice();
  const out = [];
  while (rest.length) {
    const head = rest.shift();
    const b = [head];
    for (let i = 0; i < rest.length && b.length < n; ) { if ((rest[i].profile || DEFAULT_PROFILE) === (head.profile || DEFAULT_PROFILE)) b.push(rest.splice(i, 1)[0]); else i++; }
    out.push(b);
  }
  return out;
}

/**
 * 模型写的一篇稿 → 报道字段，按读法的输出块取：读法里没有的块不收；自定义块收进 extra。
 * @param ids 把「M2」一类的材料编号换成文章 id
 */
export function parseCopy(w, blocks, S, ids) {
  const has = (k) => blocks.find((b) => b.kind === k);
  const P = has("points"), V = has("views"), I = has("impact"), L = has("lead");
  const line = (x, n) => (typeof x === "string" ? { text: str(x, n), refs: [] } : { text: str(x && x.text, n), refs: ids(x && x.refs) });
  const out = {
    lead: str(w.lead, ((L && L.chars) || S.lead_chars) + 20), lead_refs: ids(w.lead_refs),
    points: P ? (Array.isArray(w.points) ? w.points : []).map((x) => line(x, (P.chars || S.point_chars) + 20)).filter((x) => x.text).slice(0, P.max || S.points) : [],
    views: V ? (Array.isArray(w.views) ? w.views : []).map((v) => ({ who: str(v && v.who, 20), says: str(v && v.says, 80), refs: ids(v && v.refs) })).filter((v) => v.who && v.says).slice(0, V.max || S.views) : [],
    impact: I ? str(w.impact, (I.chars || S.impact_chars) + 20) : "", by: "llm",
  };
  const extra = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      const x = line(w[b.id], (b.chars || 80) + 20);
      if (x.text) extra.push({ id: b.id, name: b.name, kind: "text", text: x.text, refs: x.refs });
    } else if (b.kind === "list") {
      const items = (Array.isArray(w[b.id]) ? w[b.id] : []).map((x) => line(x, (b.chars || 40) + 20)).filter((x) => x.text).slice(0, b.max || 3);
      if (items.length) extra.push({ id: b.id, name: b.name, kind: "list", items });
    }
  }
  if (extra.length) out.extra = extra;
  return out;
}

/** 模型服务断连一类的错误：值得等一会儿重试。 */
const CONN_ERR = /connection error|econnreset|econnrefused|fetch failed|socket hang up|network|terminated/i;
/** 写稿缓存的版本：写稿提示词或写法改了就加一，旧缓存自然失效。 */
const WRITE_V = 1;
/** 一篇稿的材料指纹：材料、上次导语、读者报错、写法、重点领域标记与提示词版本都一样，才算同一份稿。 */
export function writeFingerprint(entry, layout) {
  const p = entry.profile || storyProfile(layout, entry.story, entry.items);
  // 读法的写法（名称、版本、写稿要求、材料设置、输出块）改了，旧稿就不能沿用
  const f = p.id === DEFAULT_PROFILE && !promptOf(p, "write") ? "" : [p.id, p.version, p.name, promptOf(p, "write"), JSON.stringify(p.content), JSON.stringify(p.blocks)].join("|");
  const h = (entry.history || []).map((x) => x.story_id);
  return createHash("sha1").update(JSON.stringify(Object.assign({ v: WRITE_V, t: entry.story.title, m: entry.mats.map((it) => it.id), p: entry.prevLead || "", e: (entry.errors || []).map((x) => x.text), s: layout.story, y: layout.style, f }, h.length ? { h } : {}))).digest("hex");
}
const COPY_KEYS = ["lead", "lead_refs", "points", "views", "impact", "extra", "history", "update_text", "update_by"];
function cacheGet(db, fp) {
  try { const r = db.prepare("SELECT copy FROM write_cache WHERE fp = ? AND created_at >= datetime('now', '-3 days')").get(fp); return r ? JSON.parse(r.copy) : null; } catch { return null; }
}
function cachePut(db, fp, story) {
  try {
    const copy = Object.fromEntries(COPY_KEYS.filter((k) => story[k] !== undefined).map((k) => [k, story[k]]));
    db.prepare("INSERT INTO write_cache (fp, story_id, copy, created_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(fp) DO UPDATE SET story_id = excluded.story_id, copy = excluded.copy, created_at = excluded.created_at").run(fp, story.id || null, JSON.stringify(copy));
  } catch { /* 存不下不影响这一版 */ }
}

export async function llmEdition(db, model, o) {
  const layout = o.layout;
  const reg = profilesOf(layout);
  const contentOf = (s) => reg.get(s.profile).content;
  const t0 = Date.now();
  const deadline = t0 + (o.budgetMs || 600000);
  const left = () => deadline - Date.now();
  // errors：每次失败的调用（含随后重试成功的）；fallbacks：真正退回规则结果的步骤
  const stats = { calls: 0, failed: 0, errors: [], fallbacks: [], steps: {} };
  const adExamples = db.prepare("SELECT title FROM articles WHERE kind = 'promo' AND kind_by = 'reader' ORDER BY first_seen_at DESC LIMIT 6").all().map((r) => r.title);
  const call = async (step, prompt, maxTokens, minTimeout) => {
    if (left() < 15000) { stats.errors.push(step + ": budget_exceeded"); throw new Error("budget_exceeded"); }
    stats.calls++;
    const t = Date.now();
    try {
      // 推理模型的推理也占 token：上限留足；解析不了重试一次
      // 本地模型服务偶尔断连（Connection error）：等一会儿重试一次，不直接退回程序稿
      const once = async () => {
        try { return await model.complete(prompt, { step, maxTokens, timeoutMs: Math.min(left(), Math.max(o.callTimeoutMs || 180000, minTimeout || 0)) }); } catch (err) {
          if (!CONN_ERR.test(String(err && err.message ? err.message : err)) || left() < (o.retryWaitMs ?? 20000) + 30000) throw err;
          stats.errors.push(step + ": " + String(err.message || err).slice(0, 80) + "（重试）");
          stats.calls++;
          await new Promise((r) => setTimeout(r, o.retryWaitMs ?? 20000));
          return await model.complete(prompt, { step, maxTokens, timeoutMs: Math.min(left(), Math.max(o.callTimeoutMs || 180000, minTimeout || 0)) });
        }
      };
      for (let k = 0; k < 2; k++) {
        const j = parseJsonLoose(await once());
        if (j) return j;
        if (k === 0) stats.calls++;
      }
      throw new Error("bad_json");
    } catch (err) {
      stats.failed++;
      stats.errors.push(step + ": " + String(err && err.message ? err.message : err).slice(0, 120));
      throw err;
    } finally {
      stats.steps[step] = (stats.steps[step] || 0) + (Date.now() - t);
    }
  };
  const tax = taxonomyIndex(o.taxonomy);
  const items = gatherItems(db, { pack: o.pack, since: o.since, limit: o.maxItems || 150, focus: layout.focus });
  if (items.length < 3) return { fallback: "too_few_items" };
  const byN = new Map(items.map((it) => [it.n, it]));

  // 0. 已归入故事线的新闻直接接上
  const fb = feedbackState(db);
  const asg = assignments(db, items.map((it) => it.id));
  const rows = storyRows(db, [...new Set(asg.values())]);
  const groups = [];
  const byId = new Map();
  for (const it of items) {
    const sid = asg.get(it.id);
    const row = sid && rows.get(sid);
    if (!row) continue;
    if (!byId.has(sid)) { const g = { id: sid, row, items: [], fresh: [], title: row.title, section: row.section, labels: row.labels, importance: Math.round(row.importance || 0), by: "llm", entities: row.entities || [] }; byId.set(sid, g); groups.push(g); }
    byId.get(sid).items.push(it);
  }
  let fresh = items.filter((it) => !byId.has(asg.get(it.id)));
  stats.fresh_items = fresh.length;
  // 规则事件已有成员归入某条故事线的，直接接上（规则聚类合并时是精确的），不必再问模型
  const evIds = [...new Set(fresh.map((it) => it.event_id).filter(Boolean))];
  const evStory = new Map();
  for (let i = 0; i < evIds.length; i += 400) {
    const chunk = evIds.slice(i, i + 400);
    for (const r of db.prepare("SELECT event_id, story_id, COUNT(*) n FROM story_items WHERE event_id IN (" + chunk.map(() => "?").join(",") + ") GROUP BY event_id, story_id ORDER BY n DESC").all(...chunk)) if (!evStory.has(r.event_id)) evStory.set(r.event_id, r.story_id);
  }
  const extraRows = storyRows(db, [...new Set(evStory.values())].filter((sid) => !byId.has(sid)));
  let auto = 0;
  fresh = fresh.filter((it) => {
    const sid = it.event_id && evStory.get(it.event_id);
    if (!sid || fb.banned(it.id, sid)) return true;
    let g = byId.get(sid);
    if (!g) {
      const row = extraRows.get(sid);
      if (!row || row.status !== "active") return true;
      g = { id: sid, row, items: [], fresh: [], title: row.title, section: row.section, labels: row.labels, importance: Math.round(row.importance || 0), by: "llm", entities: row.entities || [] };
      byId.set(sid, g);
      groups.push(g);
    }
    g.items.push(it);
    g.fresh.push(it);
    auto++;
    return false;
  });
  stats.auto_attached = auto;
  // 分诊：规则打分很低、又只有一家报道的新闻几乎不会上版——不交给模型，按规则事件归并；关注命中的照样交给模型
  const followList = (o.follows && o.follows.follow) || [];
  // 重点领域（AI 与新技术）的不分诊，全交给模型看，免得漏掉只有一家报道的新技术
  // 源声明了读法的（技术博客、Hacker News）也不分诊：它们多半只有一家、规则打分低，重要度交给模型按读法的评分要求判断
  const lowly = (it) => !it.focus && !(it.src_profile && it.src_profile !== DEFAULT_PROFILE) && it.event_id && it.ev_importance != null && it.ev_importance < (o.triageBelow ?? 18) && (!it.ev_cred || it.ev_cred === "single") &&
    !(followList.length && matchList(followList, { id: "", title: it.title, section: "", labels: it.labels || [], outlets: [{ source_id: it.source_id }] }, [it]).length);
  const triaged = o.triageBelow === 0 ? [] : fresh.filter(lowly);
  if (triaged.length) {
    const tset = new Set(triaged);
    fresh = fresh.filter((it) => !tset.has(it));
    for (const it of triaged) {
      const home = it.event_id ? groups.find((g) => g.triage && g.items.some((x) => x.event_id === it.event_id)) : null;
      if (home) { home.items.push(it); home.fresh.push(it); }
      else groups.push({ id: null, items: [it], fresh: [it], title: clip(it.title, 40), section: topOf(it.labels[0]) || "other", labels: it.labels.slice(0, 2), importance: Math.round(it.ev_importance || 0), by: "rules", triage: true });
    }
  }
  stats.triaged = triaged.length;

  // 1. 归并新新闻：归入已有故事线或另起；失败的批先拆半重试，仍失败按规则事件归并
  // 候选的已有报道按批检索：和这一批新闻最像的（标题字面、关键主体）在前，再补最重要的；
  // 前面几批刚建的报道也在候选里——原来候选只取一次（重要度前 40），不够重要的已有报道和刚建的报道都看不到，同一件事会被拆成两篇
  const candidatesFor = (batch) => pickCandidates(groups.filter((g) => !g.triage), batch, o.candidates || 30);
  // 实测（本地推理模型）：真实的一批每个事件约用 430 个输出 token、5 秒；40 个一批要 197 秒、1.7 万 token。
  // 一批 24 个（约 2 分钟），上限按每个 500 token 给足，超时放宽到 5 分钟——原来上限 3000+150×40 必然截断
  const size = o.batchSize || 24;
  // 按规则事件折叠：规则聚类的精确率实测 100%，同一事件的几篇只给模型看一行（附另有几家），归并完再展开——
  // 送给模型的行数少一大截，冷启动的归并时间与 JSON 被截断的次数都跟着降
  const peersOf = new Map();
  const repOfEvent = new Map();
  const units = [];
  for (const it of fresh) {
    const rep = it.event_id && repOfEvent.get(it.event_id);
    if (rep) { peersOf.get(rep).push(it); continue; }
    units.push(it);
    peersOf.set(it, []);
    if (it.event_id) repOfEvent.set(it.event_id, it);
  }
  for (const it of units) it._peers = peersOf.get(it);
  const expand = (its) => its.flatMap((it) => [it].concat(peersOf.get(it) || []));
  stats.units = units.length;
  const queue = [];
  for (let i = 0; i < units.length; i += size) queue.push(units.slice(i, i + size));
  // 归并最多用预算的 60%，留时间给统筹和写稿；超出后剩下的新闻按规则事件归并
  const groupDeadline = t0 + (o.budgetMs || 600000) * 0.6;
  const attach = (g, its) => { g.items.push(...its); g.fresh.push(...its); };
  // 服务端能并行时几批同时归并；本地单卡 concurrency=1 就是原来的一批一批
  const groupWorker = async () => {
    while (queue.length) {
    const batch = queue.shift();
    const inBatch = new Set(batch.map((it) => it.n));
    const cands = candidatesFor(batch);
    let got = null;
    try {
      if (Date.now() > groupDeadline) throw new Error("group_budget");
      const j = await call("group", groupPrompt(batch, tax, cands, adExamples, layout.focus, profilesOf(layout)), 2000 + 500 * batch.length, 300000);
      if (Array.isArray(j.stories)) got = j.stories;
      // 模型判为非新闻的：标成 promo（读者判过的不动），之后不再进版面
      const nz = (Array.isArray(j.noise) ? j.noise : []).map(Number).filter((n) => inBatch.has(n) && !["corroborated", "confirmed", "disputed"].includes(byN.get(n).ev_cred) && !isDigestTitle(byN.get(n).title) && byN.get(n).kind !== "digest_item" && !(got || []).some((g) => (g.items || []).map(Number).includes(n)));
      if (nz.length) { stats.noise = (stats.noise || 0) + markKind(db, nz.map((n) => byN.get(n).id), "promo", "llm", "模型判定"); nz.forEach((n) => inBatch.delete(n)); }
    } catch { got = null; }
    if (!got && batch.length > 12 && !batch._split && Date.now() < groupDeadline) {
      const half = Math.ceil(batch.length / 2);
      const a = batch.slice(0, half), b = batch.slice(half);
      a._split = b._split = true;
      queue.unshift(a, b);
      continue;
    }
    if (got) {
      const taken = new Set();
      for (const g of got) {
        const ns = (Array.isArray(g && g.items) ? g.items : []).map(Number).filter((n) => inBatch.has(n) && !taken.has(n));
        if (!ns.length) continue;
        ns.forEach((n) => taken.add(n));
        const its = expand(ns.map((n) => byN.get(n)));
        const imp = Number(g.importance);
        const m = /^S(\d+)$/i.exec(String(g.story || "").trim());
        const target = m ? cands[Number(m[1]) - 1] : null;
        // 读者指出不属于那条故事线的，不再归回去
        if (target && its.some((it) => fb.banned(it.id, target.id))) {
          const keep = its.filter((it) => !fb.banned(it.id, target.id));
          const out = its.filter((it) => fb.banned(it.id, target.id));
          if (keep.length) attach(target, keep);
          groups.push({ id: null, items: out, fresh: out.slice(), title: clip(out[0].title, 40), section: target.section, labels: target.labels, importance: Math.round(Math.max(...out.map((x) => x.ev_importance || 0))), by: "llm" });
          continue;
        }
        if (target) {
          attach(target, its);
          if (Number.isFinite(imp) && imp > 0) target.importance = Math.round(Math.min(100, Math.max(0, imp)));
          continue;
        }
        const labels = (Array.isArray(g.labels) ? g.labels : []).map(String).filter((l) => tax.all.has(l)).slice(0, 2);
        let section = tax.tops.has(String(g.section)) ? String(g.section) : topOf(labels[0]);
        if (!tax.tops.has(section)) section = topOf(its[0].labels[0]) || "other";
        groups.push({ id: null, items: its.slice(), fresh: its.slice(), title: str(g.title, 40) || clip(its[0].title, 40), section, labels: labels.length ? labels : its[0].labels.slice(0, 2), importance: Number.isFinite(imp) ? Math.round(Math.min(100, Math.max(0, imp))) : Math.round(Math.max(...its.map((x) => x.ev_importance || 0))), by: "llm",
          entities: (Array.isArray(g.entities) ? g.entities : []).map((x) => str(x, 20)).filter(Boolean).slice(0, 4) });
      }
    } else {
      stats.fallbacks.push("group:" + batch.length);
      for (const it of expand(batch)) {
        const home = it.event_id ? groups.find((g) => g.items.some((x) => x.event_id === it.event_id)) : null;
        if (home) attach(home, [it]);
        else groups.push({ id: null, items: [it], fresh: [it], title: clip(it.title, 40), section: topOf(it.labels[0]) || "other", labels: it.labels.slice(0, 2), importance: Math.round(it.ev_importance || 0), by: "rules" });
      }
    }
  }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency || 1) }, groupWorker));
  for (const g of groups) if (!g.id) { g.id = storyIdFor(g.items[0].id); g.isNew = true; }
  if (!groups.length) return { fallback: "no_stories" };
  groups.sort((a, b) => b.importance - a.importance);

  // 2. 统筹：有新新闻才调用；否则沿用上一份版面的总括、头版、值得关注
  const top = groups.slice(0, 80).map((g) => Object.assign(g, storyFacts(g.items)));
  const merged = new Map(); // 被并入者下标（1 起） → 并入目标下标
  let plan = null;
  const ids = new Set(groups.map((g) => g.id));
  const prevPlanOk = o.prev && o.prev.headline && !((o.prev.stats && o.prev.stats.fallbacks) || []).includes("plan");
  if (!fresh.length && prevPlanOk) {
    plan = { reuse: true, headline: o.prev.headline, frontIds: (o.prev.front || []).filter((i) => ids.has(i)), watch: (o.prev.watch || []).map((w) => ({ text: w.text, stories: (w.stories || []).filter((i) => ids.has(i)) })), themesKept: (o.prev.themes || []).map((t) => Object.assign({}, t, { stories: (t.stories || []).filter((i) => ids.has(i)) })).filter((t) => t.stories.length >= 2) };
    stats.plan_reused = true;
  } else {
    try { plan = await call("plan", planPrompt(top, layout), 6000); } catch { plan = {}; stats.fallbacks.push("plan"); }
    for (const m of Array.isArray(plan.merge) ? plan.merge : []) {
      const ks = (Array.isArray(m) ? m : []).map(Number).filter((k) => k >= 1 && k <= top.length && !merged.has(k));
      if (ks.length < 2) continue;
      // 并入已有的故事线（保住它的 id 和历史），没有已有的就并入第一个
      const head = ks.find((k) => !top[k - 1].isNew) || ks[0];
      for (const k of ks) {
        if (k === head) continue;
        const h = top[head - 1], src = top[k - 1];
        h.items.push(...src.items);
        h.fresh.push(...(src.isNew ? src.items : src.fresh));
        h.importance = Math.max(h.importance, src.importance);
        if (!src.isNew) (h.absorbed = h.absorbed || []).push(src.id);
        merged.set(k, head);
      }
    }
    if (!plan.merge) {
      const seen = new Map();
      top.forEach((g, i) => { const ev = g.event_ids[0]; if (!ev) return; if (seen.has(ev)) { const h = top[seen.get(ev)]; h.items.push(...g.items); h.fresh.push(...(g.isNew ? g.items : g.fresh)); if (!g.isNew) (h.absorbed = h.absorbed || []).push(g.id); merged.set(i + 1, seen.get(ev) + 1); } else seen.set(ev, i); });
    }
  }
  const finalGroups = top.filter((_, i) => !merged.has(i + 1)).concat(groups.slice(80));
  const allStories = finalGroups.map((g) => {
    const facts = storyFacts(g.items);
    const total = (g.row ? g.row.total : 0) + g.fresh.length;
    const prof = storyProfile(layout, g, g.items);
    return Object.assign({ id: g.id, title: g.title, section: g.section, labels: g.labels, importance: g.importance, profile: prof.id, ...(prof.badge ? { badge: prof.badge } : {}), by: g.by, is_new: Boolean(g.isNew), updated: !g.isNew && g.fresh.length > 0, _g: g, _total: total, _k: top.indexOf(g) + 1 }, facts);
  });
  // 关注与屏蔽：屏蔽的不上版、不写稿（但照样登记故事线，免得每轮再交给模型）
  const stories = applyFollows(allStories.slice(), o.follows).filter(notTrialOnly);
  const sid = (k) => { const n = Number(k); const target = merged.get(n) || n; const s = stories.find((x) => x._k === target); return s ? s.id : null; };
  const uniq = (xs) => [...new Set(xs)];
  const front = plan.reuse ? plan.frontIds : uniq((Array.isArray(plan.front) ? plan.front : []).map(sid).filter(Boolean));
  // 主线：同一条更大线索下、但不是同一件事的几篇报道（同一场冲突、同一家公司接连的动作、同一项技术的多方进展）
  const THEME_KINDS = ["conflict", "company", "technology", "policy", "market", "other"];
  const themes = plan.reuse ? plan.themesKept || [] : (Array.isArray(plan.themes) ? plan.themes : []).map((t) => ({ name: str(t && t.name, 16), kind: THEME_KINDS.includes(t && t.kind) ? t.kind : "other", stories: uniq((Array.isArray(t && t.refs) ? t.refs : []).map(sid).filter(Boolean)) })).filter((t) => t.name && t.stories.length >= 2).slice(0, 8);
  const watch = plan.reuse ? plan.watch.filter((w) => w.text) : (Array.isArray(plan.watch) ? plan.watch : []).map((w) => ({ text: str(w && w.text, 70), stories: uniq((Array.isArray(w && w.refs) ? w.refs : []).map(sid).filter(Boolean)) })).filter((w) => w.text);
  const parts = assemble(stories, layout, o.names || {}, { front, watch, headline: str(plan.headline, 60) });

  // 3. 写稿：上版的故事线里，没有稿或写稿后有新报道加入的才写；其余沿用；写不成的用程序拼的稿
  const placed = new Set(parts.placed);
  let reused = 0;
  const toWrite = [];
  for (const s of stories) {
    const g = s._g;
    // 有读者报错未处理的，重写
    if (!g.absorbed && copyFresh(g.row, s._total) && !fb.errors.has(s.id)) { Object.assign(s, copyOf(g.row.copy), { by: "llm", reused: true }); reused++; }
    else if (placed.has(s.id)) toWrite.push(s);
  }
  // 头版先写（读者最先看到），再按重要度
  const frontRank = new Map((parts.front || []).map((id, i) => [id, i]));
  toWrite.sort((a, b) => (frontRank.has(a.id) ? frontRank.get(a.id) : 99) - (frontRank.has(b.id) ? frontRank.get(b.id) : 99) || b.importance - a.importance).splice(o.maxStories || 16);
  // 边写边出：归并与统筹完成就先出一版（没写的用程序稿），之后每写完一批更新一次
  const progress = (bodiesNow) => {
    if (!o.onProgress) return;
    try {
      const pb = bodiesFor(db, stories.flatMap((s) => s._g.items.map((it) => it.id)));
      const snap = stories.map((s) => {
        const c = Object.assign({}, s, { points: JSON.parse(JSON.stringify(s.points || [])), views: JSON.parse(JSON.stringify(s.views || [])) });
        if (!written.has(s.id) && !s.reused) {
          const rc = ruleCopy(s._g.items, s, layout, {}, pb);
          Object.assign(c, { lead: rc.lead, lead_refs: rc.lead_refs, points: rc.points, views: rc.views, impact: rc.impact, by: s.by === "llm" ? "llm-group" : "rules" });
        }
        verifyStory(db, c, s._g.items, bodiesNow || pb, contentOf(s), reg.get(s.profile).blocks);
        return strip(c);
      });
      o.onProgress(finish(o, snap, parts, { mode: "llm", model: model.label(), items_read: items.length, stats: Object.assign({}, stats, { partial: true, written: written.size, to_write: toWrite.length }) }));
    } catch { /* 进度版出不来不影响正式版 */ }
  };
  const written = new Set();
  progress();
  // 深读：要写的报道里，只有标题或摘要被截断的材料先去原文抓正文（有预算），模型才有东西可写
  if (o.deepRead) {
    const have = bodiesFor(db, toWrite.flatMap((s) => s._g.items.map((it) => it.id)));
    const need = [];
    for (const s of toWrite) for (const it of pickMaterials(s._g.items, 4)) if (it.completeness !== "full" && !have.has(it.id) && !need.some((x) => x.id === it.id)) need.push(it);
    try { stats.deep = await o.deepRead(need); } catch (e) { stats.deep = { tried: 0, ok: 0, error: String(e.message || e).slice(0, 120) }; }
  }
  const bodies = bodiesFor(db, toWrite.flatMap((s) => s._g.items.map((it) => it.id)));
  // 写稿：一批 3 篇；服务端能并行处理时多批同时写（生产环境的大模型），本地单卡就一批一批写。
  // 并发数：o.concurrency 给了就用；o.probe 为真时先拿前两批并行试一次，比较「两批各自耗时之和 / 实际总耗时」，
  // 接近 2 说明服务端真在并行（之后用 3），接近 1 说明在排队（之后用 1），结果交给 o.onProbe 记住
  const entryOf = (story) => {
    const g = story._g;
    const profile = reg.get(story.profile);
    const M = profile.content.materials;
    const prevLead = !g.isNew && g.row && g.row.copy && g.row.copy.lead && g.fresh.length ? g.row.copy.lead : "";
    // 有进展的故事线：新材料优先放进去，模型才看得到新进展
    let mats = pickMaterials(g.items, M);
    if (prevLead) { const nf = pickMaterials(g.fresh, Math.min(3, M)); mats = nf.concat(pickMaterials(g.items.filter((it) => !nf.includes(it)), M - nf.length)); }
    // 读法有能依据以前报道的块（如「背景」）：找以前的相关故事线当前情（H 编号），只找一次
    if (story.history === undefined) story.history = profile.blocks.some((b) => (b.materials || []).includes("history")) ? relatedStories(db, { id: story.id, title: story.title, entities: g.entities || [], first_seen_at: story.first_seen_at }) : [];
    return { story, items: g.items, bodies, mats, fresh: g.fresh, prevLead, profile, history: story.history, errors: fb.errors.get(story.id) || [] };
  };
  // 断点续写：上一次（中断、重启或超时前）已经写好的同一份材料，直接用写好的稿
  try { db.prepare("DELETE FROM write_cache WHERE created_at < datetime('now', '-3 days')").run(); } catch { /* 旧库没有这张表 */ }
  stats.cached = 0;
  for (let i = toWrite.length - 1; i >= 0; i--) {
    const s = toWrite[i];
    const hit = cacheGet(db, writeFingerprint(entryOf(s), layout));
    if (!hit || !hit.lead) continue;
    Object.assign(s, hit, { by: "llm" });
    written.add(s.id);
    toWrite.splice(i, 1);
    stats.cached++;
  }
  if (stats.cached) progress(bodies);
  const writeBatch = async (group) => {
      const batch = group.map(entryOf);
      try {
        // 材料是正文，推理更长：上限按篇数给足（实测 3 篇约 6400 个输出 token），超时放宽到 5 分钟
        const j = await call("write", writePrompt(batch, layout), 4000 + 3000 * batch.length, 300000);
        for (const w of Array.isArray(j.stories) ? j.stories : []) {
          const b = batch[Number(w && w.ref) - 1];
          if (!b || !str(w.lead, 10)) continue;
          const S = layout.story;
          // 「M2」→ 文章 id
          const ids = (r) => (Array.isArray(r) ? r : [r]).map((x) => {
            const t = String(x || "").trim();
            const h = /^H(\d+)$/i.exec(t);
            if (h) { const x2 = (b.history || [])[Number(h[1]) - 1]; return x2 ? "h:" + x2.story_id : null; }
            const m = /^M?(\d+)$/i.exec(t);
            const it = m && b.mats[Number(m[1]) - 1];
            return it ? it.id : null;
          }).filter(Boolean);
          Object.assign(b.story, parseCopy(w, b.profile.blocks, S, ids));
          // 新进展同样要经得起核对（只认给模型看的报道原文）
          const up = b.prevLead ? str(w.update, 60) : "";
          if (up && checkText(up, b.mats.map((m) => materialText(m, b.bodies, sourceOnly(b.profile.content)))).ok) Object.assign(b.story, { update_text: up, update_by: "llm" });
          written.add(b.story.id);
          cachePut(db, writeFingerprint(b, layout), b.story);
        }
      } catch { stats.fallbacks.push("write:" + batch.length); /* 这一批用程序拼的稿 */ }
  };
  const groupsOf3 = [];
  // 一批里的报道用同一个读法（提示词的固定部分相同，生产环境的前缀缓存才命中）；按写稿顺序取，同读法的往前凑
  for (const b of batchByProfile(toWrite, 3)) groupsOf3.push(b);
  let conc = Math.max(1, o.concurrency || 1);
  let next = 0;
  if (o.probe && groupsOf3.length >= 2) {
    const t = Date.now();
    const d = await Promise.all([0, 1].map(async (k) => { const s0 = Date.now(); await writeBatch(groupsOf3[k]); return Date.now() - s0; }));
    const eff = (d[0] + d[1]) / Math.max(1, Date.now() - t);
    conc = eff >= 1.6 ? 3 : 1;
    stats.probe = { efficiency: Math.round(eff * 100) / 100, concurrency: conc };
    if (o.onProbe) try { o.onProbe(stats.probe); } catch { /* 记不住下次再试 */ }
    next = 2;
    progress(bodies);
  }
  const worker = async () => {
    while (next < groupsOf3.length) {
      const k = next++;
      if (k > 0 && conc === 1) progress(bodies);
      await writeBatch(groupsOf3[k]);
      if (conc > 1) progress(bodies);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, groupsOf3.length - next)) }, worker));
  stats.concurrency = conc;
  const restBodies = bodiesFor(db, stories.filter((s) => !written.has(s.id) && !s.reused).flatMap((s) => s._g.items.map((it) => it.id)));
  for (const s of stories) {
    if (written.has(s.id) || s.reused) continue;
    const copy = ruleCopy(s._g.items, s, layout, {}, restBodies);
    Object.assign(s, { lead: copy.lead, lead_refs: copy.lead_refs, points: copy.points, views: copy.views, impact: copy.impact, by: s.by === "llm" ? "llm-group" : "rules" });
  }
  for (const s of stories) if (s.updated && !s.update_text) Object.assign(s, programUpdate(s._g.fresh));
  // 4. 核对：模型稿（新写的与沿用的）逐句核对，整理出处
  const allBodies = bodiesFor(db, stories.filter((s) => s.by === "llm" && !written.has(s.id)).flatMap((s) => s._g.items.map((it) => it.id)));
  for (const [k, v] of bodies) allBodies.set(k, v);
  for (const s of stories) { verifyStory(db, s, s._g.items, allBodies, contentOf(s), reg.get(s.profile).blocks); if (!written.has(s.id)) scrubStory(s, fb.errors.get(s.id)); }
  stats.check = sumChecks(stories);
  Object.assign(stats, { written: written.size, reused, groups: groups.length, ms: Date.now() - t0 });
  const out = finish(o, stories.map(strip), parts, { mode: "llm", model: model.label(), items_read: items.length, stats });
  out.themes = themes;
  out._items = new Map(allStories.flatMap((s) => s._g.items.map((it) => [it.id, { story: s.id, event_id: it.event_id || null, section: s.section, labels: s.labels, importance: s.importance }])));
  const at = new Date().toISOString();
  // 模型失败时按规则临时归并出的新故事线不登记：下一轮这些新闻再交给模型
  out._persist = allStories.filter((s) => !(s._g.isNew && s._g.by === "rules")).map((s) => ({
    id: s.id, isNew: s.is_new, title: s.title, section: s.section, labels: s.labels, importance: s.importance, profile: s.profile, absorbed: s._g.absorbed || [], entities: s._g.entities || [],
    copy: written.has(s.id) ? Object.assign({ lead: s.lead, lead_refs: s.lead_refs, points: s.points, views: s.views, impact: s.impact, by: "llm", model: model.label(), at, items: s._total }, s.extra && s.extra.length ? { extra: s.extra } : {}, s.history && s.history.length ? { history: s.history } : {}) : null,
    update: s.updated && s.update_text ? { text: s.update_text, by: s.update_by, items: s._g.fresh.length } : null,
    resolve: written.has(s.id) && fb.errors.has(s.id),
    items: s._g.fresh.map((it) => ({ article_id: it.id, event_id: it.event_id || null })),
  }));
  return out;
}

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

// ------------------------------------------------------------------ 推送
/** 版面里要推的报道：新报道过门槛，或已推过但可信度升级 / 重要度大涨。规则与 select.mjs 一致。
 * o.full：本轮新内容全推——没推过的新报道都推，推过的有新报道加入就推进展；不看门槛和条数上限。 */
export function editionPicks(db, ed, rules, o) {
  const full = Boolean(o.full);
  const now = Date.parse(o.nowIso.replace(" ", "T") + "Z");
  const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const since = iso(now - o.lookbackHours * 3600000);
  const since24 = iso(now - 24 * 3600000);
  const staleBefore = iso(now - o.lookbackHours * 3600000 - 24 * 3600000);
  const req = Array.isArray(rules.require_labels) && rules.require_labels.length ? rules.require_labels : null;
  const picks = [];
  for (const s of Object.values(ed.stories || {}).sort((a, b) => b.importance - a.importance)) {
    const followed = Boolean(s.followed && s.followed.length);
    // 读者对某版块的推送多次说「没用」：这个版块门槛提高（关注的不受影响）
    const min = followed ? (rules.min_follow ?? 20) : (s.source_count >= 2 ? rules.min_corroborated : rules.min_single) + ((o.penalties && o.penalties[s.section]) || 0);
    if (!full && s.importance < min) continue;
    if (req && !followed && !req.some((p) => s.section === p || (s.labels || []).some((l) => l === p || l.startsWith(p + ".")))) continue;
    if (s.published_at && s.published_at < staleBefore) continue;
    // 推过与否按故事线（及其规则事件）判断：同一条故事线不因换了规则事件而重复推
    const evs = (s.event_ids || []).filter(Boolean);
    const last = db.prepare("SELECT * FROM pushes WHERE story_id = ?" + (evs.length ? " OR event_id IN (" + evs.map(() => "?").join(",") + ")" : "") + " ORDER BY id DESC LIMIT 1").get(s.id, ...evs);
    let reason = null;
    if (!last) { if (s.first_seen_at && s.first_seen_at >= since) reason = "new"; }
    else if (s.first_seen_at && s.first_seen_at >= since24) {
      if ((CRED_RANK[s.credibility] ?? 0) > (CRED_RANK[last.credibility] ?? 0)) reason = "upgraded";
      else if (s.importance - (last.score || 0) >= (rules.upgrade_jump || 20)) reason = "jumped";
      // 关注的故事线有新报道加入：再推一次
      else if ((followed || full) && s.updated) reason = "followup";
    }
    if (reason) picks.push(Object.assign({}, s, { reason, heat: heatOf(db, s.article_ids || []), links: linksOf(db, s) }));
    if (!full && picks.length >= (rules.max || 8)) break;
  }
  return picks;
}

/** 各家媒体的原文链接（每家取这条故事线里最早的一篇）：推送里媒体名就是链接。 */
function linksOf(db, s) {
  const ids = (s.article_ids || []).slice(0, 60);
  if (!ids.length) return [];
  const rows = db.prepare("SELECT source_id, url FROM articles WHERE id IN (" + ids.map(() => "?").join(",") + ") AND url IS NOT NULL ORDER BY first_seen_at").all(...ids);
  const first = new Map();
  for (const r of rows) if (!first.has(r.source_id)) first.set(r.source_id, r.url);
  const lead = (s.outlets || []).map((o) => ({ name: o.name || o.source_id, url: first.get(o.source_id) || null }));
  if (lead.length && s.url) lead[0].url = s.url;
  // 聚合站转的是同一篇原文：同一个链接只列一次
  const seen = new Set();
  return lead.filter((x) => !x.url || (!seen.has(x.url) && seen.add(x.url)));
}
/** 推送消息里的源头热度：这条故事线各篇最新一次观测里阅读数最高的那篇（阅读、评论、级别）。 */
function heatOf(db, ids) {
  if (!ids.length) return null;
  const qs = ids.slice(0, 50).map(() => "?").join(",");
  const r = db.prepare("SELECT o.views, o.comments, o.level FROM observations o WHERE o.article_id IN (" + qs + ") ORDER BY COALESCE(o.views, -1) DESC, o.seen_at DESC LIMIT 1").get(...ids.slice(0, 50));
  return r && (r.views != null || r.comments || r.level) ? { views: r.views, comments: r.comments, level: r.level } : null;
}
const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n));

export function recordEditionPushes(db, picks, runId, nowIso, pack) {
  const st = db.prepare("INSERT INTO pushes (run_id, article_id, event_id, pack, score, reason, credibility, pushed_at, story_id) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const p of picks) st.run(runId, p.lead_article_id, p.lead_event_id, pack && pack !== "all" ? pack : "core", p.importance, p.reason, p.credibility, nowIso, p.id);
}

/** 推送消息分组：重点在前，其余按领域。 */
export const PUSH_GROUPS = [
  { id: "tech", title: "💻 科技与产业", sections: ["tech", "industry"] },
  { id: "markets", title: "📈 市场与宏观", sections: ["markets", "macro"] },
  { id: "politics", title: "🌐 时政与国际", sections: ["politics"] },
  { id: "other", title: "📌 其他", sections: null },
];
/** 重点：模型给的重要度 60 以上（不按领域加减，轻重交给模型判断）。 */
export function isKeyStory(s) {
  return s.importance >= 60;
}
// 导语开头的「11月10日，」在推送里是多余的（标题行已有日期）
// 还有快讯原文常带的「17:49 」「ChainCatcher 消息，」
const dropDate = (t) => {
  let x = String(t || "").replace(/\s+/g, " ").trim();
  for (let k = 0; k < 3; k++) {
    const y = x.replace(/^\d{1,2}:\d{2}\s*/, "").replace(/^[A-Za-z][\w ]{1,20}\s*消息[，,]\s*/, "").replace(/^(\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日(凌晨|早间|早上|上午|中午|午间|下午|傍晚|晚间|晚|夜间)?[，,]\s*/, "");
    if (y === x) break;
    x = y;
  }
  return x;
};
/** 按句截：n 字以内取完整的句子；第一句就超长时在逗号处截断。 */
export function sentences(text, n) {
  const t = dropDate(text);
  if (t.length <= n) return t;
  const parts = t.match(/[^。！？；!?;]+[。！？；!?;]?/g) || [t];
  let out = "";
  for (const p of parts) { if ((out + p).length > n) break; out += p; }
  if (out) return out;
  const cut = t.slice(0, n);
  const k = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf(","));
  return (k > n * 0.5 ? cut.slice(0, k) : cut.slice(0, n - 1)) + "…";
}
const mdText = (t) => String(t || "").replace(/[\[\]]/g, (c) => (c === "[" ? "［" : "］")).replace(/\*/g, "＊");
const same = (x) => String(x || "").replace(/[\s，。、：:,.!！?？“”"'‘’《》（）()]/g, "");

/** 版面模式的推送消息（Markdown，手机端渲染）：汇总时段与统计、总括；重点详写，其余按领域简写；来源名即链接。 */
export function composeEditionMessage(parts, picks, ed, names) {
  const title = parts.title || "要闻";
  const head = parts.overnight ? "隔夜" + title : title;
  const nWarn = (parts.warnings || []).length;
  const warn = nWarn ? "⚠ 有 " + nWarn + " 处数据源异常，详见新闻面板「运行」" : null;
  if (!picks.length) return [parts.hhmm + " " + head + "：暂无新的重点"].concat(warn ? [warn] : []).join("\n");
  const md = String(parts.md || "").split("-").map(Number);
  const L = ["📰 **" + head + "** · " + (md.length === 2 && md[0] ? md[0] + "月" + md[1] + "日 " : "") + parts.hhmm];
  const nNew = picks.filter((x) => x.reason === "new").length;
  const span = parts.from ? "汇总 " + parts.from + "–" + parts.hhmm + " · " : "";
  L.push(span + "新报道 " + nNew + " 件" + (picks.length > nNew ? " · 有进展 " + (picks.length - nNew) + " 件" : ""));
  if (ed.headline) L.push("> " + mdText(ed.headline));
  let markets = false;
  let i = 0;
  const item = (s, detailed) => {
    i++;
    const again = s.reason !== "new";
    const tag = s.reason === "followup" ? "【进展】" : s.reason === "upgraded" || s.reason === "jumped" ? "【升级】" : "";
    L.push("", "**" + i + ". " + tag + mdText(s.title) + "**" + (s.followed && s.followed.length ? " ★" : ""));
    const lead = s.push_lead || s.lead;
    if (again && s.update_text) {
      L.push("进展：" + mdText(sentences(s.update_text, detailed ? 160 : 90)));
      if (detailed && lead && same(lead) !== same(s.title)) L.push("背景：" + mdText(sentences(lead, 100)));
    } else if (lead && same(lead) !== same(s.title)) L.push(mdText(sentences(lead, detailed ? 200 : 90)));
    if (detailed) {
      const leadKey = same(lead);
      const pts = (s.points || []).map((p) => (typeof p === "string" ? p : p && p.text) || "").filter((t) => t && !leadKey.includes(same(t))).slice(0, 2);
      for (const t of pts) L.push("· " + mdText(sentences(t, 70)));
      if (s.impact) L.push("影响：" + mdText(sentences(s.impact, 80)));
    }
    // 来源：媒体名就是链接（手机上点名字跳原文），最多列 3 家
    const links = (s.links && s.links.length ? s.links : [{ name: (s.outlets[0] || {}).name || (s.outlets[0] || {}).source_id, url: s.url }]).filter((x) => x && x.name);
    const shown = links.slice(0, 3).map((x) => { const n = mdText(String(x.name).replace(/·.*$/, "")); return x.url ? "[" + n + "](" + x.url + ")" : n; });
    const h = s.heat || {};
    L.push([shown.join("、") + (s.outlets.length > shown.length ? " 等 " + s.outlets.length + " 家" : ""), tz(s.published_at || s.first_seen_at).slice(-5),
      s.credibility === "confirmed" ? "权威确认" : s.credibility === "disputed" ? "说法有分歧" : "", h.views != null ? "阅读 " + fmtN(h.views) : ""].filter(Boolean).join(" · "));
    if (/^markets|^macro/.test(s.section || "")) markets = true;
  };
  const keys = picks.filter(isKeyStory);
  const rest = picks.filter((s) => !isKeyStory(s));
  if (keys.length) { L.push("", "**🔴 重点**"); for (const s of keys) item(s, true); }
  const placed = new Set();
  for (const g of PUSH_GROUPS) {
    const xs = rest.filter((s) => !placed.has(s.id) && (!g.sections || g.sections.includes(s.section)));
    if (!xs.length) continue;
    L.push("", "**" + g.title + "**");
    for (const s of xs) { placed.add(s.id); item(s, false); }
  }
  L.push("");
  if (warn) L.push(warn);
  L.push((ed.mode === "llm" ? "由 " + ed.model + " 阅读 " + ed.items_read + " 条新闻后编写，可能有误，以原文为准" : "按规则摘编自各家报道") + (markets ? "；财经内容非投资建议" : "") + "。");
  return L.join("\n");
}

// ------------------------------------------------------------------ 行情速览
const INSTRUMENT_CUT = /(高开|低开|平开|开盘|早盘|盘初|午盘|尾盘|日内|盘中|向上|向下|扭转|扩大|突破|跌破|上涨|下跌|大涨|大跌|暴涨|暴跌|拉升|走高|走低|收涨|收跌|收报|现涨|现跌|涨|跌|上行|下行|上升|下降|报|在上一)/;
/** 一条行情跳动属于哪个品种（「日经225指数期货早盘上涨1.1%」→「日经225指数期货」）。 */
function splitTick(title) {
  const t = String(title || "").replace(/^(美股|港股|A股|亚太|欧股)/, "").trim();
  const m = INSTRUMENT_CUT.exec(t);
  const raw = (m && m.index >= 2 ? t.slice(0, m.index) : t.slice(0, 8)).replace(/[，,:：\s]+$/, "").trim();
  return { raw, rest: t.slice(t.indexOf(raw) + raw.length).replace(/^[，,:：\s]+/, "").replace(/。$/, "") };
}
export function instrumentOf(title) {
  const k = splitTick(title).raw;
  // 同一品种的不同叫法归一
  return k.replace(/^香港恒生指数$|^恒指$/, "恒生指数").replace(/^台湾证交所/, "台交所").replace(/^纽约期金$/, "COMEX黄金").replace(/^美股/, "");
}

/** 时段内的行情跳动：每个品种只留最新一条，最多 n 条。 */
export function tickerBoard(db, o) {
  const where = ["a.kind = 'ticker'", "a.first_seen_at >= ?"];
  const args = [o.since];
  if (o.pack && o.pack !== "all") { where.push("a.pack = ?"); args.push(o.pack); }
  const rows = db.prepare(`SELECT a.id, a.title, a.url, a.first_seen_at, ${PUB} AS published_at, a.source_id, s.name AS source_name FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE ${where.join(" AND ")} ORDER BY COALESCE(a.published_at, a.first_seen_at) DESC`).all(...args);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = instrumentOf(r.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ instrument: k, text: r.title.replace(/。$/, ""), rest: splitTick(r.title).rest || r.title, t: r.published_at || r.first_seen_at, source: r.source_name || r.source_id, url: r.url });
    if (out.length >= (o.max || 12)) break;
  }
  return out;
}
