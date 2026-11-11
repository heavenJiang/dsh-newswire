/**
 * Reddit 版块（old.reddit.com/r/<版块>/top/?t=day 或 /hot/），用 browse 读服务器给的原始 HTML，不用 API key。
 *
 * 每条帖子：<div class="... thing ..." data-type="link"> 的 data-* 属性（data-score、data-comments-count、
 * data-timestamp（毫秒）、data-url、data-permalink、data-domain、data-promoted）与 a.title 的标题。
 * 条目链接用帖子指向的原文；图片、视频和文字帖（i.redd.it / v.redd.it / self.*）用帖子页。广告帖不收；低于 min_points 分的不收（默认 50）。
 *
 * enrich：分数最高的几条（comment_items，默认 6）读帖子页（?depth=1&sort=top，只要顶层评论），评论存为 comments，
 * 文字帖的正文存为摘要。机器人（AutoModerator）的评论不要。
 */
import { clean } from "../util/text.mjs";

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#32;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const attr = (tag, name) => decode((tag.match(new RegExp("\\s" + name + '="([^"]*)"')) || [])[1] || "");
const text = (html) => clean(decode(String(html || "").replace(/<\/p>|<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")));
const SELF = /^(self\.|i\.redd\.it$|v\.redd\.it$|reddit\.com$|www\.reddit\.com$|old\.reddit\.com$|preview\.redd\.it$)/i;

/** 版块列表页 → 帖子（页面顺序）。 */
export function posts(html) {
  const out = [];
  const re = /<div class="[^"]*\bthing\b[^"]*"[^>]*data-type="link"[^>]*>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const tag = m[0];
    if (attr(tag, "data-promoted") === "true") continue;
    const permalink = attr(tag, "data-permalink");
    if (!permalink) continue;
    const rest = String(html).slice(m.index, m.index + 6000);
    const title = text((rest.match(/<a class="title[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
    if (!title) continue;
    const domain = attr(tag, "data-domain");
    const url = attr(tag, "data-url");
    const post = "https://www.reddit.com" + permalink;
    const ts = Number(attr(tag, "data-timestamp"));
    out.push({
      title, domain, sub: attr(tag, "data-subreddit"), author: attr(tag, "data-author"),
      link: !url || SELF.test(domain) || url.startsWith("/") ? post : url,
      post, discussion: "https://old.reddit.com" + permalink,
      points: Number(attr(tag, "data-score")) || 0, comments: Number(attr(tag, "data-comments-count")) || 0,
      time: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : "",
    });
  }
  return out;
}

/** 帖子页 → { text（文字帖正文）, comments: [{ text, points }] }（顶层评论，页面顺序）。 */
export function thread(html, max) {
  const s = String(html);
  const site = s.indexOf('<div class="sitetable linklisting"');
  const head = site >= 0 ? s.slice(site, site + 40000) : "";
  const self = (head.match(/<div class="expando[^"]*"[\s\S]*?<div class="md">([\s\S]*?)<\/div>/) || [])[1] || "";
  const out = [];
  const re = /<div class="[^"]*\bthing\b[^"]*\bcomment\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(s)) && out.length < (max || 8)) {
    const tag = m[0];
    if (/AutoModerator/i.test(attr(tag, "data-author")) || /\bstickied\b/.test(tag)) continue;
    const seg = s.slice(m.index, m.index + 20000);
    const body = (seg.match(/<div class="usertext-body[^"]*"[^>]*><div class="md">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1];
    if (!body) continue;
    const t = text(body);
    if (t.length < 20) continue;
    out.push({ text: t, points: Number((seg.match(/<span class="score unvoted" title="(-?\d+)"/) || [])[1]) || 0 });
  }
  return { text: text(self), comments: out };
}

export function commentsText(list, per) {
  return list.map((c) => "· " + (c.points ? "（" + c.points + " 赞）" : "") + (c.text.length > (per || 400) ? c.text.slice(0, (per || 400) - 1) + "…" : c.text)).join("\n");
}

export default {
  id: "reddit",
  browseMode: "html",
  rawHtml: true,
  waitFor: "div.thing",
  parse(html, opts) {
    const max = (opts && opts.max) || 25;
    const min = Number((opts && opts.src && opts.src.min_points) ?? 50);
    return posts(html).filter((x) => x.points >= min).slice(0, max).map((x, i) => ({
      title: x.title,
      link: x.link,
      published_at: x.time,
      summary: "",
      content: "",
      signals: { likes: x.points, comments: x.comments, hot: [], section: "r/" + x.sub, rank: i },
      signals_raw: { subreddit: x.sub, domain: x.domain, points: x.points, comments: x.comments, discussion: x.discussion, post: x.post },
    }));
  },
  async enrich(items, ctx) {
    const n = Number((ctx.src && ctx.src.comment_items) ?? 6);
    const picks = items.slice().sort((a, b) => (b.signals_raw.points || 0) - (a.signals_raw.points || 0)).slice(0, n);
    let ok = 0;
    for (const it of picks) {
      if (ctx.deadline && Date.now() > ctx.deadline) break;
      let html = null;
      try { html = await ctx.fetchHtml(it.signals_raw.discussion + "?depth=1&sort=top&limit=12"); } catch { html = null; }
      if (!html) continue;
      const d = thread(html, 8);
      if (d.comments.length) { it.comments = commentsText(d.comments, 400); ok++; }
      if (d.text && it.link === it.signals_raw.post) { it.summary = d.text.slice(0, 1200); it.content = d.text.slice(0, 6000); }
    }
    return { tried: picks.length, ok };
  },
};
