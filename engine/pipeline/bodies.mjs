/**
 * 正文两段式：列表阶段只有标题、摘要和热度；本轮重点事件的成员才抓正文（每轮有预算），训练语料主要来自这里。
 *
 * 抽取顺序：http 取页 → JSON-LD articleBody / Next.js 数据 / 页面段落；被拒（401/403）且 browse 可用时用真实浏览器读正文；
 * 再不行用 agent-reach 阅读器（Jina）。近 7 天正文抓取失败 ≥3 次且从未成功的源暂时跳过，预算留给能抓到的源。
 * 付费墙源不抓；抓到的正文写 article_bodies，并在比原内容长时回填 articles.content / training_ready。
 */
import { httpFetch, jinaFetch } from "../channels/http.mjs";
import { browseFetch } from "../channels/browse.mjs";
import { classify } from "../channels/classify.mjs";
import { clean, isoUtc } from "../util/text.mjs";
import { MIN_BODY, MIN_SHORT, trimTail, anchorReader, relevant, PAYWALL_TEXT } from "./bodytext.mjs";

export { trimTail, anchorReader };
const PER_EVENT = 2;

function findArticleBody(o, depth) {
  if (!o || depth > 6) return "";
  if (Array.isArray(o)) { for (const x of o) { const r = findArticleBody(x, depth + 1); if (r) return r; } return ""; }
  if (typeof o === "object") {
    if (typeof o.articleBody === "string" && o.articleBody.length > 0) return o.articleBody;
    for (const v of Object.values(o)) { const r = findArticleBody(v, depth + 1); if (r) return r; }
  }
  return "";
}

/** 验证页 / 反爬拦截页：不是正文，不去绕过，记为 bot_blocked。 */
export const CHALLENGE = /(security verification|verify you are (a )?human|just a moment|checking your browser|captcha|access denied|are you a robot|请完成安全验证|人机验证|访问受限)/i;

const BOILER = /(版权所有|未经授权|责任编辑|扫码|下载.{0,6}APP|关注.{0,8}公众号|Copyright|All rights reserved|Sign up|Subscribe|cookie)/i;

/** 常见的文章正文容器（class 名）。 */
const CONTAINER = /<(div|section|article)\b[^>]*\bclass=["'][^"']*?\b(article-content|article-body|article_content|articleContent|article-text|news-content|news_content|post-content|post_content|entry-content|detail-content|content-detail|art_detail_content|article-detail|article_detail|main-text|rich_media_content|rich_text_content|rich-text-content|art_context)\b[^"']*["'][^>]*>/gi;

/** 从 start 处的开标签取到配对的闭标签（同名标签按深度配对）。 */
function elementAt(s, start, tag) {
  const rx = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
  rx.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = rx.exec(s))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return s.slice(start, rx.lastIndex);
    if (rx.lastIndex - start > 400000) break;
  }
  return s.slice(start, start + 200000);
}

function blockText(block) {
  const paras = (block.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map((p) => clean(p));
  const lines = paras.length ? paras : block.replace(/<(br|\/div|\/section|\/li|\/h\d)\b[^>]*>/gi, "\n").split("\n").map((l) => clean(l));
  const seen = new Set();
  return trimTail(lines.filter((t) => t.length >= 8 && !BOILER.test(t) && (seen.has(t) ? false : seen.add(t))).join("\n"));
}

/** 文章容器里的正文：取最长的那个容器。短讯（一两句话）也算。 */
function containerBody(s) {
  let best = "";
  for (const m of s.matchAll(CONTAINER)) {
    const t = blockText(elementAt(s, m.index, m[1]));
    if (t.length > best.length) best = t;
  }
  return best;
}

/** 从整页 HTML 抽正文。@returns { text, extractor } 或 null */
export function extractBody(html) {
  const s = String(html || "");
  if (CHALLENGE.test(s.slice(0, 20000)) && !/<article[\s>]/i.test(s)) return null;
  const ld = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ld) {
    try {
      const body = trimTail(clean(findArticleBody(JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "")), 0)));
      if (body.length >= MIN_BODY) {
        // 有的站点 JSON-LD 里只放前 N 字：文章容器里更长、开头一样时用容器
        const box = containerBody(s);
        const head = body.replace(/\s/g, "").slice(0, 20);
        if (box.length > body.length * 1.2 && box.replace(/\s/g, "").includes(head)) return { text: box.slice(0, 20000), extractor: "container" };
        return { text: body.slice(0, 20000), extractor: "json-ld" };
      }
    } catch {
      // 坏的 JSON-LD 跳过
    }
  }
  // Next.js 页面（财联社等）：__NEXT_DATA__ 里最长的正文类字段
  const nd = s.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    let best = "";
    const walk = (o, depth) => {
      if (!o || depth > 12) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (typeof o === "object") for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && /^(content|body|articleContent|article_content|text)$/i.test(k)) { const t = clean(v); if (t.length > best.length) best = t; }
        else walk(v, depth + 1);
      }
    };
    try { walk(JSON.parse(nd[1]), 0); } catch { /* 坏的跳过 */ }
    if (best.length >= MIN_BODY) return { text: best.slice(0, 20000), extractor: "next-data" };
  }
  const box = containerBody(s);
  if (box.length >= MIN_BODY) return { text: box.slice(0, 20000), extractor: "container" };
  let scope = s.replace(/<(script|style|noscript|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const art = scope.match(/<article[\s\S]*?<\/article>/i);
  if (art && (art[0].match(/<p[\s>]/gi) || []).length >= 2) scope = art[0];
  const paras = (scope.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map((p) => clean(p)).filter((t) => t.length >= 25 && !BOILER.test(t));
  const seen = new Set();
  const text = trimTail(paras.filter((t) => (seen.has(t) ? false : seen.add(t))).join("\n"));
  if (text.length >= MIN_BODY) return { text: text.slice(0, 20000), extractor: "paragraphs" };
  // 短讯：正文容器里只有一两句话，也是全文
  if (box.length >= MIN_SHORT) return { text: box, extractor: "container" };
  return null;
}

/** Jina 阅读器的 Markdown → 纯文本（去链接、图片、标题行）。 */
export function readerText(md) {
  const body = String(md || "").split(/\nMarkdown Content:\n/)[1] || String(md || "");
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n").map((l) => l.replace(/^#+\s*/, "").trim())
    .filter((l) => l.length >= 8 && !BOILER.test(l))
    .join("\n").slice(0, 20000);
}

/** 本轮该抓正文的条目：重点事件（importance ≥ min）的成员，每个事件最多 PER_EVENT 家，一手源优先，跳过付费墙与已抓过的。 */
export function bodyCandidates(db, o) {
  if (!o.touched.length || !o.budget) return [];
  const rows = db.prepare(`SELECT a.id, a.url, a.source_id, e.event_id, e.importance FROM event_members m
      JOIN events e ON e.event_id = m.event_id JOIN articles a ON a.id = m.article_id
      LEFT JOIN article_bodies b ON b.article_id = a.id
    WHERE e.event_id IN (` + o.touched.map(() => "?").join(",") + `) AND e.importance >= ? AND b.article_id IS NULL AND COALESCE(a.text_len, 0) < ?
    ORDER BY e.importance DESC`).all(...o.touched, o.minImportance || 50, o.minTextLen || 200);
  const perEvent = new Map();
  const out = [];
  const hopeless = new Set(db.prepare(`SELECT a.source_id FROM article_bodies b JOIN articles a ON a.id = b.article_id
    WHERE b.fetched_at >= datetime('now', '-7 days') GROUP BY a.source_id HAVING SUM(b.ok) = 0 AND COUNT(*) >= 3`).all().map((r) => r.source_id));
  const rank = (r) => ((o.sources.get(r.source_id) || {}).tier === "secondary" ? 1 : 0);
  for (const r of rows.sort((a, b) => b.importance - a.importance || rank(a) - rank(b))) {
    const src = o.sources.get(r.source_id) || {};
    // 有按源学到的策略就按它（配置写 list 但列表实际没有正文的也补）；没有时按配置
    const p = o.profiles && o.profiles.get(r.source_id);
    if (p ? ["list", "blocked", "none"].includes(p.mode) : src.paywall || src.body === "list" || src.body === "none" || hopeless.has(r.source_id)) continue;
    const n = perEvent.get(r.event_id) || 0;
    if (n >= PER_EVENT) continue;
    perEvent.set(r.event_id, n + 1);
    out.push(Object.assign({ src }, r));
    if (out.length >= o.budget) break;
  }
  return out;
}

/**
 * 正文不在详情页 HTML 里、而在别处的站点：返回真正的正文地址。
 *   巨潮资讯：详情页是前端模板，公告全文是 static.cninfo.com.cn 上的 PDF
 */
export function bodyUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)cninfo\.com\.cn$/.test(u.hostname) && u.pathname.includes("/disclosure/detail")) {
      const id = u.searchParams.get("announcementId");
      const day = String(u.searchParams.get("announcementTime") || "").slice(0, 10);
      if (/^\d+$/.test(id || "") && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { url: "https://static.cninfo.com.cn/finalpage/" + day + "/" + id + ".PDF", kind: "pdf" };
    }
  } catch { /* 不是合法地址 */ }
  return null;
}

/** 浏览器 article 模式读出的正文（<article> / <main> 的文字）。 */
async function browseBody(url, title, lead) {
  // 浏览器读出的是整页（article / main）文字：要对得上标题才算
  const r = await browseFetch("article", url, 1, { timeoutMs: 45000 });
  if (!r.ok || !r.data) return null;
  if (r.data.paywall) return { paywalled: true };
  if (CHALLENGE.test(String(r.data.text || "").slice(0, 2000))) return { blocked: true };
  const raw = String(r.data.text || "").split("\n").map((l) => l.trim()).filter((l) => l.length >= 8 && !BOILER.test(l)).join("\n");
  if (PAYWALL_TEXT.test(raw.slice(0, 3000))) return { paywalled: true };
  const anchored = anchorReader(raw, title);
  const text = anchored || trimTail(raw);
  // 对上了标题也要看后文：短讯页上标题行就是全文，后面跟的是行情条、别的快讯
  if (title && !relevant(text, title, lead)) return { blocked: false, unrelated: true };
  return text.length >= (anchored ? MIN_SHORT : MIN_BODY) ? { text: text.slice(0, 20000) } : null;
}

/**
 * 抓一篇正文。o.title 给了的话，阅读器 / 浏览器读出的整页文字从标题那行开始取
 * （避免把导航、侧栏里别的新闻当成这篇的正文）；结尾的免责声明、相关新闻列表截掉。
 */
export async function fetchBody(url, o) {
  const opt = o || {};
  const alt = bodyUrl(url);
  if (alt && alt.kind === "pdf") {
    // PDF 交给阅读器转文字
    const j = await jinaFetch(alt.url, { timeoutMs: 45000 });
    if (!j.ok) return { ok: false, error: j.error || "pdf: fetch failed", channel: "agent_reach" };
    const text = trimTail(readerText(j.text));
    if (opt.title && !relevant(text, opt.title, opt.lead)) return { ok: false, error: "pdf: not this article", channel: "agent_reach" };
    return text.length >= MIN_SHORT ? { ok: true, text: text.slice(0, 20000), extractor: "pdf", channel: "agent_reach" } : { ok: false, error: "pdf: too short", channel: "agent_reach" };
  }
  const r = await httpFetch(url, { timeoutMs: opt.timeoutMs || 15000 });
  if (r.ok) {
    if (classify("", r.http_status, r.text).kind === "paywall") return { ok: false, paywalled: true, error: "paywall", channel: "http" };
    const got = extractBody(r.text);
    if (got) return { ok: true, text: got.text, extractor: got.extractor, channel: "http" };
  }
  if (opt.browse && (!r.ok || r.http_status === 401 || r.http_status === 403)) {
    const b = await browseBody(url, opt.title, opt.lead).catch(() => null);
    if (b && b.paywalled) return { ok: false, paywalled: true, error: "paywall", channel: "browse" };
    if (b && b.blocked) return { ok: false, error: "bot_blocked", channel: "browse" };
    if (b && b.unrelated) return { ok: false, error: "browse: not this article", channel: "browse" };
    if (b) return { ok: true, text: b.text, extractor: "browse", channel: "browse" };
  }
  const j = await jinaFetch(url, { timeoutMs: 30000 });
  if (j.ok) {
    const all = readerText(j.text);
    if (CHALLENGE.test(all.slice(0, 2000))) return { ok: false, error: "bot_blocked", channel: "agent_reach" };
    // 对上了标题：从标题行取，短讯也算；对不上：整页文字截掉结尾样板，要够长才算
    if (PAYWALL_TEXT.test(all.slice(0, 3000))) return { ok: false, paywalled: true, error: "paywall", channel: "agent_reach" };
    const anchored = anchorReader(all, opt.title);
    const text = anchored || trimTail(all);
    if (opt.title && !relevant(text, opt.title, opt.lead)) return { ok: false, error: "reader: not this article", channel: "agent_reach" };
    if (text.length >= (anchored ? MIN_SHORT : MIN_BODY)) return { ok: true, text, extractor: "reader", channel: "agent_reach" };
    return { ok: false, error: "reader: too short", channel: "agent_reach" };
  }
  return { ok: false, error: r.ok ? "no body found" : r.error || "http " + r.http_status, channel: r.ok ? "http" : "agent_reach" };
}

/** 抓一批正文并入库；返回 { tried, ok }。 */
export async function fetchBodies(db, list, o) {
  const ins = db.prepare("INSERT OR REPLACE INTO article_bodies (article_id, content, text_len, extractor, channel, paywalled, ok, error, fetched_at, run_id, ms, list_len) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const prior = listInfo(db);
  const up = db.prepare("UPDATE articles SET completeness = 'full', content = ?, text_len = ?, training_ready = CASE WHEN paywalled = 1 THEN 0 ELSE ? END WHERE id = ? AND LENGTH(COALESCE(content, '')) < ?");
  let ok = 0;
  for (const c of list) {
    const s = Date.now();
    const p = prior(c.id);
    const r = await fetchBody(c.url, Object.assign({}, o, { title: c.title || p.title, lead: p.lead }));
    const took = Date.now() - s;
    const now = isoUtc(Date.now());
    if (r.ok) {
      ok++;
      ins.run(c.id, r.text, r.text.length, r.extractor, r.channel, 0, 1, null, now, o.runId, took, p.len);
      up.run(r.text, r.text.length, r.text.length >= (o.minTextLen || 200) ? 1 : 0, c.id, r.text.length);
    } else {
      ins.run(c.id, null, 0, null, r.channel, r.paywalled ? 1 : 0, 0, String(r.error || "").slice(0, 300), now, o.runId, took, p.len);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return { tried: list.length, ok };
}

/** 抓正文前这条在列表里已有的文字长度与标题（用来判断详情页是不是比列表更全）。 */
function listInfo(db) {
  const q = db.prepare("SELECT title, COALESCE(NULLIF(content, ''), summary, '') AS lead, MAX(LENGTH(COALESCE(summary, '')), LENGTH(COALESCE(content, ''))) AS len FROM articles WHERE id = ?");
  return (id) => { const r = q.get(id) || {}; return { title: r.title || "", lead: String(r.lead || "").slice(0, 200), len: r.len || 0 }; };
}

// ------------------------------------------------------------------ 按源学正文策略
/**
 * 每个源该怎么拿正文，按近 7 天的实际情况定（配置只是起点）：
 *   list     列表自带正文（近 24 小时完整的占 ≥ 80%），不必再抓；每轮抽查 1 篇详情页（近 7 天抽满 3 篇为止），
 *            一半以上的详情页明显比列表长，说明列表只是导语，改按抓得到与否定策略
 *   fetch    正文抓得到且便宜（成功率 ≥ 60%、中位耗时 ≤ 4 秒）：新条目逐条补
 *   slow     抓得到但慢（阅读器、浏览器）：只补上版与重点事件的
 *   blocked  近 7 天试过 ≥ 3 次从未成功：跳过，提示换源
 *   probe    还没有记录：每轮试 2 篇来学
 *   none     配置为不抓（付费墙、body=none）
 */
export function bodyProfiles(db, sources) {
  const tries = new Map(db.prepare(`SELECT a.source_id, COUNT(*) n, SUM(b.ok) ok,
      SUM(CASE WHEN b.ok = 1 AND b.channel = 'http' THEN 1 ELSE 0 END) http_ok,
      SUM(CASE WHEN b.ok = 1 AND b.list_len IS NOT NULL THEN 1 ELSE 0 END) checked,
      SUM(CASE WHEN b.ok = 1 AND b.list_len IS NOT NULL AND b.text_len > b.list_len * 1.3 + 80 THEN 1 ELSE 0 END) deeper
    FROM article_bodies b JOIN articles a ON a.id = b.article_id WHERE b.fetched_at >= datetime('now', '-7 days') GROUP BY a.source_id`).all().map((r) => [r.source_id, r]));
  const fill = new Map(db.prepare(`SELECT source_id, COUNT(*) n, SUM(CASE WHEN completeness = 'full' THEN 1 ELSE 0 END) n_full
    FROM articles WHERE first_seen_at >= datetime('now', '-1 day') AND COALESCE(kind, 'news') NOT IN ('promo', 'digest_item') GROUP BY source_id`).all().map((r) => [r.source_id, r]));
  const ms = new Map();
  // 耗时看成功的那次走的通道：有 http 成功的源只看 http（偶尔退到阅读器的慢请求不拖累判断）
  for (const r of db.prepare(`SELECT a.source_id, b.ms, b.channel FROM article_bodies b JOIN articles a ON a.id = b.article_id WHERE b.ok = 1 AND b.ms IS NOT NULL AND b.fetched_at >= datetime('now', '-7 days')
      AND (b.channel = 'http' OR a.source_id NOT IN (SELECT a2.source_id FROM article_bodies b2 JOIN articles a2 ON a2.id = b2.article_id WHERE b2.ok = 1 AND b2.channel = 'http' AND b2.fetched_at >= datetime('now', '-7 days')))`).all()) {
    if (!ms.has(r.source_id)) ms.set(r.source_id, []);
    ms.get(r.source_id).push(r.ms);
  }
  const median = (xs) => { if (!xs || !xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const out = new Map();
  for (const [id, src] of sources) {
    const t = tries.get(id) || { n: 0, ok: 0, http_ok: 0, checked: 0, deeper: 0 };
    const listShort = t.checked >= 2 && t.deeper * 2 >= t.checked;
    const f = fill.get(id) || { n: 0, n_full: 0 };
    const med = median(ms.get(id));
    const rate = t.n ? (t.ok || 0) / t.n : null;
    let mode;
    if (src.paywall || src.body === "none") mode = "none";
    else if (f.n >= 5 && f.n_full / f.n >= 0.8 && !listShort) mode = "list";
    else if (t.n >= 3 && !t.ok) mode = "blocked";
    else if (t.n < 2) mode = "probe";
    else if (rate >= 0.6 && (med == null || med <= 4000)) mode = "fetch";
    else if (rate > 0) mode = "slow";
    else mode = "probe";
    out.set(id, { mode, tried: t.n, ok: t.ok || 0, checked: t.checked || 0, deeper: t.deeper || 0, rate: rate == null ? null : Math.round(rate * 100), median_ms: med, list_full: f.n ? Math.round((f.n_full / f.n) * 100) : null });
  }
  return out;
}

/**
 * 本轮该补正文的新条目（非广告、没抓过的），按源策略挑：
 *   fetch  不全的全补；列表里看着完整但不到 o.shortLen 字的也补（多半只是导语）
 *   probe  每源试 2 篇：先挑不全的；都显得完整时（RSS 摘要常这样）也拿来抽查，否则永远学不到
 *   list   抽查：近 7 天抽查不满 3 篇时，挑本轮列表文字最长的去看详情页是否更全（还没抽查过的 2 篇，之后每轮 1 篇）
 */
export function fillCandidates(db, o) {
  const prof = o.profiles;
  const shortLen = o.shortLen || 300;
  const rows = db.prepare(`SELECT DISTINCT a.id, a.url, a.source_id, a.title, a.completeness,
      MAX(LENGTH(COALESCE(a.summary, '')), LENGTH(COALESCE(a.content, ''))) AS len FROM observations ob JOIN articles a ON a.id = ob.article_id
      LEFT JOIN article_bodies b ON b.article_id = a.id
    WHERE ob.run_id = ? AND b.article_id IS NULL AND COALESCE(a.kind, 'news') IN ('news', 'digest') AND a.paywalled = 0
    ORDER BY len DESC`).all(o.runId);
  const per = new Map();
  const out = [];
  for (const r of rows) {
    const p = prof.get(r.source_id);
    if (!p) continue;
    const n = per.get(r.source_id) || 0;
    const partial = r.completeness !== "full";
    const take = p.mode === "fetch" ? partial || r.len < shortLen
      : p.mode === "probe" ? n < 2 && (partial || (p.checked || 0) < 3)
      : p.mode === "list" ? (p.checked || 0) < 3 && n < ((p.checked || 0) === 0 ? 2 : 1)
      : false;
    if (take) { out.push({ id: r.id, url: r.url, source_id: r.source_id, title: r.title }); per.set(r.source_id, n + 1); }
    if (out.length >= (o.budget || 60)) break;
  }
  return out;
}

/** 并发补正文：同一网站同时最多 2 个请求，总时长有上限。@returns { tried, ok, ms } */
export async function fillBodies(db, list, o) {
  const t0 = Date.now();
  const ins = db.prepare("INSERT OR REPLACE INTO article_bodies (article_id, content, text_len, extractor, channel, paywalled, ok, error, fetched_at, run_id, ms, list_len) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const up = db.prepare("UPDATE articles SET completeness = 'full', content = ?, text_len = ?, training_ready = CASE WHEN paywalled = 1 THEN 0 ELSE ? END WHERE id = ? AND LENGTH(COALESCE(content, '')) < ?");
  const prior = listInfo(db);
  const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
  const busy = new Map();
  const queue = list.slice();
  let ok = 0, tried = 0;
  const worker = async () => {
    while (queue.length && Date.now() - t0 < (o.maxMs || 90000)) {
      const i = queue.findIndex((c) => (busy.get(host(c.url)) || 0) < 2);
      if (i < 0) { await new Promise((r) => setTimeout(r, 100)); continue; }
      const c = queue.splice(i, 1)[0];
      const h = host(c.url);
      busy.set(h, (busy.get(h) || 0) + 1);
      const s = Date.now();
      const p = prior(c.id);
      const r = await (o.fetch || fetchBody)(c.url, Object.assign({}, o, { title: c.title || p.title, lead: p.lead })).catch((e) => ({ ok: false, error: e.message }));
      busy.set(h, busy.get(h) - 1);
      tried++;
      const now = isoUtc(Date.now());
      if (r.ok) {
        ok++;
        ins.run(c.id, r.text, r.text.length, r.extractor, r.channel, 0, 1, null, now, o.runId || null, Date.now() - s, p.len);
        up.run(r.text, r.text.length, r.text.length >= (o.minTextLen || 200) ? 1 : 0, c.id, r.text.length);
      } else {
        ins.run(c.id, null, 0, null, r.channel || null, r.paywalled ? 1 : 0, 0, String(r.error || "").slice(0, 300), now, o.runId || null, Date.now() - s, p.len);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency || 4) }, worker));
  return { tried, ok, ms: Date.now() - t0 };
}
