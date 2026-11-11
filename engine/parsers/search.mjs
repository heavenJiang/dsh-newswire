/**
 * 网页搜索结果页解析（Bing）。搜索用 browse 打开结果页、取服务器给的原始 HTML，不用任何收费搜索接口。
 *
 * 每条结果：<li class="b_algo"> 里 h2 > a 的标题与链接、.b_caption 里的摘要（b_lineclamp 段落）。
 * Bing 的链接是跳转地址 bing.com/ck/a?...&u=a1<base64url>，解出真实地址；解不出的保留原链接。
 */
import { clean } from "../util/text.mjs";

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
// 行内标签（Bing 把命中词加粗）直接去掉，不留空格；其余标签换成空格
const text = (html) => clean(decode(String(html || "").replace(/<\/?(strong|b|em|span|mark)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ")));

/** Bing 跳转链接 → 真实地址。 */
export function unwrapBing(href) {
  const h = decode(href);
  const m = h.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!m) return h;
  try {
    const url = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//.test(url) ? url : h;
  } catch { return h; }
}

/** 结果页 HTML → [{ title, url, snippet, site }]（页面顺序，去掉 Bing 自己的链接）。 */
export function bingResults(html, max) {
  const out = [];
  const seen = new Set();
  for (const part of String(html || "").split(/<li class="b_algo"/).slice(1)) {
    const a = part.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = unwrapBing(a[1]);
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(www\.)?bing\.com\//.test(url) || seen.has(url)) continue;
    const cap = part.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) || part.match(/<div class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const title = text(a[2]);
    if (!title) continue;
    seen.add(url);
    let site = "";
    try { site = new URL(url).hostname.replace(/^www\./, ""); } catch { site = ""; }
    out.push({ title, url, snippet: cap ? text(cap[1]).replace(/\s*…$/, "…") : "", site });
    if (out.length >= (max || 6)) break;
  }
  return out;
}

export const searchUrl = (q) => "https://www.bing.com/search?q=" + encodeURIComponent(String(q || "").slice(0, 200)) + "&setlang=zh-Hans";
