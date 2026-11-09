/**
 * 通用解析器：RSS/Atom、HTML 列表页链接、Markdown（jina/agent-reach 读出来的）、JSON API。
 * 输出统一的「原始条目」：{ title, link, published_at, published_raw, summary, content, signals, signals_raw }。
 * signals 只放源头真实给出的字段（见 engine/pipeline/signals.mjs）。
 */
import { clean, decodeEntities } from "../util/text.mjs";

function cdataUnwrap(v) { return String(v).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }

function tagText(block, names) {
  for (const n of names) {
    const re = new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">", "i");
    const m = block.match(re);
    if (m) return cdataUnwrap(m[1]);
  }
  return "";
}

export function parseRss(text, max) {
  const src = String(text);
  let blocks = src.match(/<item[\s\S]*?<\/item>/gi) || [];
  if (!blocks.length) blocks = src.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    if (out.length >= (max || 20)) break;
    const title = clean(tagText(b, ["title"]));
    let link = clean(tagText(b, ["link"]));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = decodeEntities(m[1]); }
    if (!link) { link = clean(tagText(b, ["guid", "id"])); if (!/^https?:/.test(link)) link = ""; }
    const published_at = clean(tagText(b, ["pubDate", "published", "updated", "dc:date", "date"]));
    const summary = clean(tagText(b, ["description", "summary", "media:description"])).slice(0, 1200);
    const content = clean(tagText(b, ["content:encoded", "content"])).slice(0, 6000);
    if (!title || !link) continue;
    out.push({ title, link, published_at, summary, content });
  }
  return out;
}

export function harvestHtmlLinks(html, origin, max) {
  const out = []; const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    if (out.length >= (max || 20)) break;
    const href = decodeEntities(m[1]);
    const title = clean(m[2]);
    if (title.length < 8 || title.length > 140) continue;
    let abs = href;
    try { abs = new URL(href, origin).toString(); } catch (e) { continue; }
    if (!/^https?:/.test(abs)) continue;
    if (origin && new URL(abs).origin !== new URL(origin).origin) continue;
    if (/\.(pdf|jpg|png|gif|mp4)($|\?)/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ title, link: abs, published_at: "", summary: "", content: "" });
  }
  return out;
}

export function harvestMarkdown(md, origin, max) {
  const out = []; const seen = new Set();
  const re = /\[([^\]]{8,140})\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(md)))) {
    if (out.length >= (max || 20)) break;
    const title = clean(m[1]); const link = m[2];
    if (!title || seen.has(link)) continue;
    seen.add(link);
    out.push({ title, link, published_at: "", summary: "", content: "" });
  }
  return out;
}

export function getPath(o, p) { if (!p) return o; return String(p).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), o); }

function cleanHtml(s) { return String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }

/**
 * JSON API 条目映射。spec 例：
 *   { list, title, link, time, summary, content, signals: { views: "pageviews", comments: "comment_count", level: "score" } }
 * 旧字段 comments/likes/reading 仍然认（兼容早期配置）。
 */
export function mapJsonItem(spec) {
  const sig = Object.assign({}, spec.signals || {});
  if (spec.comments && !sig.comments) sig.comments = spec.comments;
  if (spec.likes && !sig.likes) sig.likes = spec.likes;
  if (spec.reading && !sig.views) sig.views = spec.reading;
  return function (x) {
    const g = (k) => (k ? getPath(x, k) : undefined);
    const rawContent = String(g(spec.summary) || g(spec.content) || "");
    const plain = cleanHtml(rawContent);
    const title = String(g(spec.title) || "").trim() || (plain.match(/^【([^】]{4,120})】/) || [null, ""])[1];
    const ts = g(spec.time);
    let published_at = "";
    if (typeof ts === "number" && ts > 1000000000) published_at = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
    else if (ts) published_at = String(ts);
    const signals = {}; const signals_raw = {};
    for (const [k, p] of Object.entries(sig)) { const v = g(p); if (v !== undefined && v !== null && v !== "") { signals[k] = v; signals_raw[p] = v; } }
    return { title: title || plain.slice(0, 80), link: String(g(spec.link) || x.share_url || x.url || ""), published_at, summary: plain.slice(0, 1200), content: plain.slice(0, 6000), signals, signals_raw };
  };
}

/** 按源类型从文本里取条目（http / jina / agent_reach 通道共用）。 */
export function itemsFromText(type, text, url, max, spec) {
  if (type === "json_api") {
    try {
      const j = JSON.parse(text);
      const list = getPath(j, (spec && spec.list) || "items") || [];
      return { items: (Array.isArray(list) ? list : []).slice(0, max).map(mapJsonItem(spec || {})).filter((x) => x.title && /^https?:/.test(x.link)), parsed_by: "json_api" };
    } catch (e) { return { items: [], parsed_by: "json_parse_fail" }; }
  }
  if (type === "rss") {
    const a = parseRss(text, max);
    if (a.length) return { items: a, parsed_by: "rss_xml" };
    const b = harvestMarkdown(text, url, max);
    if (b.length) return { items: b, parsed_by: "rss_markdown_fallback" };
    return { items: [], parsed_by: "none" };
  }
  const direct = harvestMarkdown(text, url, max);
  const html = harvestHtmlLinks(text, url, max);
  return html.length >= direct.length ? { items: html, parsed_by: "html_anchor" } : { items: direct, parsed_by: "markdown_link" };
}
