/**
 * 版面 · 基础：版式与读法、分类表、取材料、报道的事实与程序稿、材料与出处（核对）、组版、故事线的延续、
 * 节省 token 的程序编排、读者报错。模型编排（edition_llm）、存取（edition_store）、推送（edition_push）都建在这上面。
 */
import { bigrams, markReposts, similarity } from "../engine/pipeline/select.mjs";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyCopy } from "./factcheck.mjs";
import { isFirstHand, siteOf } from "../engine/pipeline/origin.mjs";
import { applyFollows } from "./follows.mjs";
import { historyText } from "./history.mjs";
import { BUILTIN_PROFILES_DIR, builtinProfiles, focusOf, loadProfiles, profileFor, withFocus } from "./profiles.mjs";
import path from "node:path";

export const EDITION_VERSION = 1;

export const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
export const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);
export const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const CRED_RANK = { single: 0, disputed: 1, corroborated: 1, confirmed: 2 };
const CRED_TEXT = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };
export const tz = (iso) => {
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
  story: { lead_chars: 120, points: 3, point_chars: 40, views: 3, impact_chars: 60, rich_items: 4, rich_points: 6, rich_point_chars: 60, rich_materials: 10,
    // 省模型时间：已有模型稿、不在头版的故事线，新报道不到 rewrite_min 篇也不到原有篇数的 rewrite_ratio 时先沿用旧稿（标出新增了什么），攒够了再重写；
    // 只有一篇、原文不超过 brief_chars 字的快讯不交给模型改写（程序稿就是原文）。rewrite_min 设 0、brief_chars 设 0 各自关闭
    rewrite_min: 2, rewrite_ratio: 0.25, brief_chars: 160 },
  // 统筹（总括、头版、值得关注）：变化小（头版没动、新报道都排不进头版、不超过 reuse_changes 条）且上次统筹不超过 reuse_hours 小时时沿用，不调用模型。reuse_hours 设 0 关闭
  plan: { reuse_hours: 3, reuse_changes: 6 },
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
export const PUB = "(CASE WHEN a.time_confidence = 'url_date' AND a.first_seen_at >= a.published_at AND a.first_seen_at < datetime(a.published_at, '+1 day') THEN a.first_seen_at ELSE a.published_at END)";
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
      rich_items: num(st.rich_items, 0, 50, D.story.rich_items), rich_points: num(st.rich_points, 1, 8, D.story.rich_points),
      rich_point_chars: num(st.rich_point_chars, 10, 120, D.story.rich_point_chars), rich_materials: num(st.rich_materials, 1, 16, D.story.rich_materials),
      rewrite_min: num(st.rewrite_min, 0, 20, D.story.rewrite_min), rewrite_ratio: num(st.rewrite_ratio, 0, 1, D.story.rewrite_ratio), brief_chars: num(st.brief_chars, 0, 600, D.story.brief_chars),
    },
    plan: { reuse_hours: num(r.plan && r.plan.reuse_hours, 0, 24, D.plan.reuse_hours), reuse_changes: num(r.plan && r.plan.reuse_changes, 0, 50, D.plan.reuse_changes) },
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
export const topOf = (label) => String(label || "").split(".")[0];

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
  const rows = db.prepare(`SELECT ${focusSql} AS focus, a.id, a.title, a.summary, a.comments, a.origin_url, a.origin_site, a.origin_text, s.tier AS src_tier, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, a.pack, a.completeness, a.kind, a.parent_id, COALESCE(s.trial, 0) AS trial,
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
export const notTrialOnly = (s) => !(s._g && s._g.items.length && s._g.items.every((it) => it.trial));

/** 由一组新闻得出报道的事实部分：媒体、家数、可信度、时间、主条目、所属规则事件。 */
export function storyFacts(items) {
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
  const origin = originOf(items);
  return {
    outlets, reposts, ...(community.length ? { community } : {}), ...(origin ? { origin } : {}), source_count: outlets.length, credibility, event_ids: eventIds, lead_event_id: leadEvent ? leadEvent[0] : null,
    article_ids: items.map((it) => it.id), lead_article_id: lead.id, url: lead.url, first_seen_at: times[0] || null, published_at: pubs[0] || null,
    dispute: items.map((it) => parseJ(it.ev_dispute, null)).find(Boolean) || null,
  };
}

/**
 * 一篇报道的原文（一手信息）：聚合站条目页上找到的出处（engine/pipeline/origin.mjs），或报道本身就发在一手站点上（官方博客源）。
 * 一手站点（官网、论文、官方账号、代码仓库）优先，其次最早的。@returns { url, site, first_hand } 或 null
 */
export function originOf(items) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const cands = [];
  for (const it of items) {
    if (it.origin_url) cands.push({ url: it.origin_url, site: it.origin_site || host(it.origin_url), first_hand: isFirstHand(it.origin_url, it.title) });
    else if (it.url && isFirstHand(it.url, it.title) && it.src_tier !== "community") cands.push({ url: it.url, site: siteOf(it.url), first_hand: true });
  }
  if (!cands.length) return null;
  return cands.find((c) => c.first_hand) || cands[0];
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
export function ruleCopy(items, facts, layout, factors, bodies) {
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
  const M = max || 6;
  const tOf = (it) => String(it.published_at || it.first_seen_at || "");
  const sorted = items.slice().sort((a, b) => tOf(a).localeCompare(tOf(b)));
  if (sorted.length <= M) return sorted;
  // 几乎一样的（转载、同一条快讯的更新版）只留长的那篇，把位置让给有新内容的
  const textLen = (it) => String(it.summary || "").length + String(it.title || "").length;
  const uniq = [];
  for (const it of sorted) {
    const bg = bigrams(it.title);
    const k = uniq.findIndex((x) => similarity(x._bg, bg) >= 0.6);
    if (k < 0) uniq.push(Object.assign(Object.create(Object.getPrototypeOf(it)), it, { _bg: bg }));
    else if (textLen(it) > textLen(uniq[k])) uniq[k] = Object.assign(Object.create(Object.getPrototypeOf(it)), it, { _bg: bg });
  }
  const pool = uniq.length >= M ? uniq : uniq.concat(sorted.filter((it) => !uniq.some((u) => u.id === it.id)));
  // 起因（最早的一篇）+ 最新的进展（从新往旧，不同媒体优先）。以前只取最早的几篇：
  // 一条故事线有十几篇报道时，导语停在最早那条，后来的关键进展（谁承认了、数字更新了）写不进去
  const byNew = pool.slice(1).reverse();
  const pick = [pool[0]].concat(byNew.slice(0, M - 1));
  // 都是同一家的、而别的媒体也报过：换进一篇别家最新的（印证与不同说法要靠它），换掉同一家里最旧的那篇
  const grps = new Set(pick.map((x) => x.grp));
  const other = byNew.find((x) => !grps.has(x.grp));
  if (other && pick.length >= 3) {
    const counts = new Map();
    for (const x of pick.slice(1)) counts.set(x.grp, (counts.get(x.grp) || 0) + 1);
    const dom = [...counts].sort((x, y) => y[1] - x[1])[0];
    if (dom && dom[1] >= 2) { const out = pick.slice(1).filter((x) => x.grp === dom[0]).pop(); pick[pick.indexOf(out)] = other; }
  }
  // 给模型看时按时间先后排（M1 最早），经过一目了然
  return pick.map((it) => { const x = sorted.find((y) => y.id === it.id) || it; return x; }).sort((a, b) => tOf(a).localeCompare(tOf(b)));
}
/**
 * 材料文本：与写稿时给模型看的一致（核对只认模型看到过的内容）。
 * content 是读法的材料设置：正文截多少字、摘要截多少字、截取方式（prefix 取开头；head-middle-tail 取开头、中段、结尾，长文的结论不会被截掉）。
 */
export const materialText = (it, bodies, content) => {
  const c = content || {};
  const body = bodies && bodies.get(it.id);
  // 有正文时给正文（摘要多半是正文开头，不重复给）；没有就给摘要
  const main = [it.title, body ? sample(body, c.body_chars || 900, c.sampling) : it.summary ? clip(it.summary, c.summary_chars || 240) : "",
    // 原文（一手信息）：聚合站转述后面附上它标出的出处原文，写稿以原文为准，核对也认它
    it.origin_text ? ORIGIN_MARK + (it.origin_site || "") + "）】" + sample(it.origin_text, c.body_chars || 900, c.sampling) : ""].filter(Boolean).join("｜");
  // 社区评论（Hacker News 等）：读法要看评论（content.comments > 0）时附在后面，标明是评论，不是报道原文
  return c.comments > 0 && it.comments ? main + "｜" + COMMENTS_MARK + clip(it.comments, c.comments) : main;
};
export const COMMENTS_MARK = "【社区评论】";
export const ORIGIN_MARK = "【原文（";

/** 材料够「多」：报道篇数到了 rich_items，多读几篇后的材料合起来也够长（一两句的快讯凑不出细节）。 */
const RICH_MIN_CHARS = 800;
/**
 * 材料多的报道：要点放宽（条数、字数），写稿时多读几篇。只有一两篇报道的照旧。
 * @returns null 或 { materials, points, point_chars }
 */
export function richSpec(items, bodies, S, profile) {
  const P = profile.blocks.find((b) => b.kind === "points");
  if (!P || !S.rich_items || items.length < S.rich_items) return null;
  const materials = Math.max(profile.content.materials, S.rich_materials);
  const len = pickMaterials(items, materials).reduce((n, it) => n + materialText(it, bodies, profile.content).length, 0);
  if (len < RICH_MIN_CHARS) return null;
  const points = Math.max(P.max || S.points, S.rich_points), point_chars = Math.max(P.chars || S.point_chars, S.rich_point_chars);
  return { materials, points, point_chars };
}
/** 只认报道原文的材料设置（核对导语、要点等不能依据评论的块）。 */
export const sourceOnly = (content) => (content && content.comments ? Object.assign({}, content, { comments: 0 }) : content);

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
  return db.prepare(`SELECT a.id, a.title, a.summary, a.comments, a.origin_url, a.origin_site, a.origin_text, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, s.name AS source_name, COALESCE(s.grp, a.source_id) AS grp
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
  let mats = pickMaterials(items, (story.rich && story.rich.materials) || (content && content.materials));
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
  // 材料前面带上来源名称：模型看到了来源（「NVIDIA Technical Blog 介绍……」），写出来不算编造
  const named = (m, t) => (m.source_name ? m.source_name + "｜" : "") + t;
  const srcTexts = mats.map((m) => named(m, materialText(m, bodies, sourceOnly(content))));
  const wideTexts = mats.map((m) => named(m, materialText(m, bodies, content)));
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
export function assemble(stories, layout, names, extra) {
  const byImp = stories.slice().sort((a, b) => b.importance - a.importance);
  const shown = byImp.filter((s) => s.importance >= layout.min_importance);
  const sections = [];
  const placed = new Set();
  const known = new Set(layout.sections.map((x) => x.id));
  // 我的关注：不受上版门槛限制，放在各版块之前；这些报道不再在各版块重复
  const fol = byImp.filter((s) => s.followed && s.followed.length).slice(0, 6).map((s) => s.id);
  if (fol.length) { sections.push({ id: "following", name: "我的关注", stories: fol }); fol.forEach((i) => placed.add(i)); }
  const focal = (s) => inFocus(layout.focus, [s.section].concat(s.labels || []));
  // 重点领域（AI 与新技术）的报道记下来：推送不按家数设门槛，待核实不列它们（这类新闻要的是一手原文，不是多家印证）
  for (const s of stories) { if (focal(s)) s.focal = true; else delete s.focal; }
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
    .filter((s) => !s.focal && (s.source_count === 1 || (s.source_count === 0 && !(s.community || []).length)) && s.importance >= layout.verify.min_importance || s.credibility === "disputed")
    .slice(0, layout.verify.count)
    .map((s) => ({ text: s.title + (s.credibility === "disputed" ? "：各家" + ((s.dispute && s.dispute.kind) || "说法") + "不一" : "：仅 " + ((s.outlets[0] || {}).name || "一家") + " 报道"), stories: [s.id] }));
  const watch = (extra.watch || []).filter((w) => w.text).slice(0, layout.watch.count);
  // 没有模型写的总括时，用头条的标题（几条截断的标题拼在一起读不通）
  const headline = extra.headline || clip(cleanLead(((get(front[0]) || {}).title) || ""), 40);
  return { headline, front, sections, watch, verify, placed: [...placed, ...front] };
}

export function finish(o, stories, parts, meta) {
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

/**
 * 先不重写：故事线已有模型稿，写稿后新加入的报道不到 rewrite_min 篇、也不到写稿时篇数的 rewrite_ratio，且重要度不到 60。
 * 旧稿照样逐句核对；新报道攒够（或故事线变重要、上了头版）再重写。
 */
export function deferRewrite(row, s, S) {
  if (!row || !row.copy || row.copy.by !== "llm" || !row.copy.lead || !(S && S.rewrite_min > 0)) return false;
  const had = Number(row.copy.items) || 0;
  const pending = s._total - had;
  if (pending <= 0 || s.importance >= 60 || newOrigin(row, originCount(s._g && s._g.items))) return false;
  return pending < S.rewrite_min || pending < Math.ceil(had * S.rewrite_ratio);
}
/**
 * 一句话快讯：故事线只有一篇报道，原文完整且不超过 brief_chars 字，不算重要，读法不是要长材料的那种。
 * 这种稿子模型写出来就是把原文换个说法，不值一次调用。
 */
export function isBriefWire(g, s, S, profile) {
  if (!(S && S.brief_chars > 0) || g.items.length !== 1 || s.importance >= 60) return false;
  if (profile && profile.content && profile.content.body_chars >= 2000) return false;
  const it = g.items[0];
  const text = String(it.summary || "").replace(/\s+/g, " ").trim();
  if (it.completeness && it.completeness !== "full" && text && text !== String(it.title || "").trim()) return false;
  return Math.max(text.length, String(it.title || "").length) <= S.brief_chars;
}
/** 稿件可以沿用：模型写的，且写稿后没有新报道加入。 */
export const copyFresh = (row, total, origins) => Boolean(row && row.copy && row.copy.by === "llm" && row.copy.items >= total && !newOrigin(row, origins));
/** 这条故事线的新闻里读回原文（一手信息）的篇数。 */
export const originCount = (items) => (items || []).filter((it) => it && it.origin_text).length;
/** 写稿之后又找到了原文：旧稿是照着转述写的，要按原文重写（不沿用、不延后）。 */
export const newOrigin = (row, origins) => Number(origins || 0) > Number((row && row.copy && row.copy.origins) || 0);
export const copyOf = (c) => Object.assign({ lead: c.lead || "", lead_refs: c.lead_refs || [], points: c.points || [], views: c.views || [], impact: c.impact || "" }, Array.isArray(c.extra) && c.extra.length ? { extra: c.extra } : {}, Array.isArray(c.history) && c.history.length ? { history: c.history } : {});

// ------------------------------------------------------------------ 节省 token：程序编排
export function ruleEdition(db, o) {
  const layout = o.layout;
  const where = ["e.last_seen_at >= ?", "e.importance >= ?", "e.first_seen_at >= ?"];
  const args = [o.since, Math.min(layout.min_importance, layout.verify.min_importance), staleBefore(o.since)];
  if (o.pack && o.pack !== "all") { where.push("e.pack = ?"); args.push(o.pack); }
  const events = db.prepare("SELECT e.* FROM events e WHERE " + where.join(" AND ") + " ORDER BY e.importance DESC LIMIT 80").all(...args);
  const memQ = db.prepare(`SELECT a.id, a.title, a.summary, a.comments, a.origin_url, a.origin_site, a.origin_text, s.tier AS src_tier, a.url, ${PUB} AS published_at, a.first_seen_at, a.source_id, a.completeness, COALESCE(s.trial, 0) AS trial, s.name AS source_name, s.profile AS src_profile, COALESCE(m.grp, a.source_id) AS grp, m.event_id
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
    if (copyFresh(row, total, originCount(g.items))) { copy = Object.assign(copyOf(row.copy), { by: "llm", reused: true }); reused++; }
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
    .map((e) => stories.find((x) => x.event_ids.includes(e.event_id))).filter(Boolean)
    // 几个规则事件归在同一条故事线里时只列一次
    .filter((st, i, arr) => arr.findIndex((x) => x.id === st.id) === i)
    .slice(0, layout.watch.count).map((s) => ({ text: s.title + "：" + s.source_count + " 家跟进，仍在发展", stories: [s.id] }));
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
export function programUpdate(fresh) {
  if (!fresh || !fresh.length) return {};
  const last = fresh.slice().sort((a, b) => String(b.published_at || b.first_seen_at).localeCompare(String(a.published_at || a.first_seen_at)))[0];
  return { update_text: "新增 " + fresh.length + " 篇：" + clip(last.title, 40) + "（" + (last.source_name || last.source_id) + "）", update_by: "rules" };
}

/** 全版核对汇总：核对了多少句、通过多少、丢弃多少、标待核多少。 */
export function sumChecks(stories) {
  const t = { stories: 0, checked: 0, passed: 0, dropped: 0, flagged: 0 };
  for (const s of stories) if (s.check) { t.stories++; t.checked += s.check.checked; t.passed += s.check.passed; t.dropped += s.check.dropped; t.flagged += s.check.flagged; }
  return t;
}

export const strip = (s) => { const c = Object.assign({}, s); delete c._g; delete c._total; delete c._k; if (Array.isArray(c.history) && !c.history.length) delete c.history; return c; };
