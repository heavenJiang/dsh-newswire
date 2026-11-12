/**
 * 原始条目 → 入库记录（文章 + 观测信号）。抓取入库与「试抓」共用，保证试抓看到的就是入库会存的。
 */
import { articleKey, canonicalUrl, contentHash, normTitle, parseDate, resolveTime, clean, isoUtc } from "../util/text.mjs";
import { normalizeSignals } from "./signals.mjs";

export const PARSER_VERSION = "0.8.0";

/**
 * 从链接推断发布时间（北京时间）。很多官方站把时间写在链接里：
 *   完整时间戳 /2026101415255489242/（留学服务中心）→ 精确到秒，可信度 page_text
 *   只有日期 t20261107_（教育部）、/20261029/（新华网）、/2026/11-08/（中新网）、/2026-11-08/ → 可信度 url_date
 * url_date 只用于显示与数据集，不参与断点衔接与聚类的时间判断（当天零点会造成误判）。
 */
export function timeFromUrl(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const ok = (y, mo, d, h, mi, se) => {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, se)).toISOString().replace("T", " ").slice(0, 19);
  };
  let m = path.match(/(?:^|\/)(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*(?:\/|$)/);
  if (m) { const t = ok(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]); if (t) return { at: t, precise: true }; }
  m = path.match(/[/_t](20\d{2})(\d{2})(\d{2})(?:[_/]|$)/) || path.match(/\/(20\d{2})[-/](\d{2})[-/](\d{2})(?:[/._-]|$)/);
  if (m) { const t = ok(+m[1], +m[2], +m[3], 0, 0, 0); if (t) return { at: t, precise: false }; }
  return null;
}

function junkTitle(t) {
  const good = (String(t).match(/[A-Za-z一-鿿]/g) || []).length;
  return good < Math.max(6, String(t).length * 0.35) || isNavTitle(t);
}

/**
 * 栏目名、导航链接（「Media & Telecom」「Business」「国际」）不是新闻：英文不足 4 个词、中文不足 6 个汉字；
 * 中英混排（「Stripe完成收购OpenRouter」「XXYY宣布停运」）汉字加英文词不足 5 个。
 */
export function isNavTitle(t) {
  const s = String(t || "").trim();
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const words = (s.match(/[A-Za-z][A-Za-z0-9.'’-]*/g) || []).length;
  if (cjk && words) return cjk + words < 5;
  if (cjk) return cjk < 6;
  return s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length < 4;
}

/**
 * 快讯常只有正文没有标题（财联社电报等）：去掉「财联社11月8日电，」这类电头，取第一句（≤60 字）。
 * 返回 "" 表示取不到。
 */
export function titleFromText(text) {
  const t = String(text || "").replace(/^【[^】]{0,20}】/, "").replace(/^[^，,。]{0,16}?\d{1,2}月\d{1,2}日(?:电|讯|消息)[，,：:\s]*/, "").trim();
  if (!t) return "";
  const m = t.match(/^(.{6,60}?)[。！？!?；;]/);
  return (m ? m[1] : t.slice(0, 60)).trim();
}

function isAdUrl(u) { return /\/(ad\/track|ads?\/|track\.html|banner|redirect)/i.test(u) || /[?&](goto|utm_source)=/i.test(u); }

function unwrapTracking(u) {
  try {
    const x = new URL(u);
    const g = x.searchParams.get("goto") || x.searchParams.get("url") || x.searchParams.get("target") || x.searchParams.get("link");
    if (g && /^[A-Za-z0-9%+\/=_-]{12,}$/.test(g)) {
      if (/^https?:/.test(g)) return g;
      const b = Buffer.from(g.replace(/%3D/g, "="), "base64").toString("utf8");
      if (/^https?:/.test(b)) return b;
    }
  } catch {
    // 不是合法 URL，原样返回
  }
  return u;
}

/**
 * @param it 原始条目（适配器 / 通用解析器产出）
 * @param src 源配置（已合并 defaults）
 * @param o { index, nowMs, minTextLen, parser }
 * @returns 记录，或 { skip: 原因 }
 */
export function toRecord(it, src, o) {
  const url = canonicalUrl(unwrapTracking(String(it.link || "").trim()));
  if (!/^https?:/.test(url)) return { skip: "bad_url" };
  if (isAdUrl(url)) return { skip: "ad_url" };
  if (src.url_include && !new RegExp(src.url_include, "i").test(url)) return { skip: "url_include" };
  if (src.url_exclude && new RegExp(src.url_exclude, "i").test(url)) return { skip: "url_exclude" };
  const body = clean(String(it.content || ""));
  const summary = clean(String(it.summary || "")) || body.slice(0, 400);
  const title = clean(String(it.title || "")).slice(0, 200) || titleFromText(summary || body);
  if (!title || junkTitle(title)) return { skip: "junk_title" };
  const fromFeed = parseDate(it.published_at);
  const fromText = fromFeed ? "" : resolveTime(it.published_raw, o.nowMs);
  const fromUrl = fromFeed || fromText ? null : timeFromUrl(url);
  let published_at = fromFeed || fromText || (fromUrl && fromUrl.at) || null;
  let time_confidence = fromFeed ? "feed" : fromText ? "page_text" : fromUrl ? (fromUrl.precise ? "page_text" : "url_date") : "fetched";
  // 发布时间不可能在将来：「将于11月13日上市」这类正文里的日期被当成了发布时间（会一直排在最前面）。
  // 比抓取时间晚 1 小时以上的不认，按抓取时间算
  if (published_at && o.nowMs && Date.parse(String(published_at).replace(" ", "T") + (String(published_at).includes("T") ? "" : "Z")) > o.nowMs + 3600000) { published_at = null; time_confidence = "fetched"; }
  const textLen = (body || summary).length;
  const paywalled = Boolean(src.paywall) || Boolean(it.paywall);
  return {
    id: articleKey(url, title),
    url,
    canonical_url: url,
    title,
    title_norm: normTitle(title),
    summary,
    content: body,
    // 社区评论（Hacker News 讨论页的顶层评论）：单独存，不混进正文
    comments: it.comments ? String(it.comments).slice(0, 4000) : null,
    published_at,
    time_confidence,
    source_id: src.id,
    category: src.category || "",
    region: src.region || "",
    lang: src.lang || "",
    pack: src.pack || "core",
    paywalled,
    content_hash: contentHash(title, body || summary),
    text_len: textLen,
    // 快讯源（body = "list"）列表里的文字就是全文，天然较短，按 60 字计入训练集
    training_ready: !paywalled && textLen >= (src.body === "list" ? 60 : o.minTextLen || 200),
    parser_version: PARSER_VERSION + "/" + (o.parser || "generic"),
    metrics: { time_from: time_confidence },
    signals: normalizeSignals(it, o.index),
  };
}

export function nowIso() { return isoUtc(Date.now()); }
