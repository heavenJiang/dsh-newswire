/**
 * Hacker News 首页（https://news.ycombinator.com/，或 /best、/front?day=…）。用 browse 读整页，不用 API key。
 *
 * 每条帖子：<tr class="athing submission" id="…"> 里 .titleline 的链接与标题、.sitestr 站点；下一行 .subline 里
 * .score「N points」、.age 的 title（UTC 时间）、「N comments」。
 * 条目链接用帖子指向的原文（别家报道了同一篇时能归到一起）；Ask HN / Show HN 这类没有外链的用讨论页。
 * 低于 min_points 分的不收（默认 100）。
 *
 * enrich：分数最高的几条（comment_items，默认 8）再读讨论页，取前几条顶层评论（HN 已按质量排序）存为 comments，
 * Ask HN 等的正文（.toptext）存为摘要。评论是社区意见，不混进正文；「社区讨论」读法写「社区观点」时才用。
 */
import { clean } from "../util/text.mjs";

const BASE = "https://news.ycombinator.com/";
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const abs = (href) => { const h = decode(href); return /^https?:\/\//i.test(h) ? h : BASE + h.replace(/^\//, ""); };
const num = (s) => { const m = String(s || "").match(/(\d+)/); return m ? Number(m[1]) : 0; };

/** 首页 → 帖子列表（页面顺序）。 */
export function stories(html) {
  const out = [];
  const parts = String(html).split(/<tr class="athing submission" id="/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const id = (b.match(/^(\d+)"/) || [])[1];
    if (!id) continue;
    const tl = (b.match(/<span class="titleline"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || []);
    if (!tl[1]) continue;
    const rank = num((b.match(/<span class="rank">(\d+)\./) || [])[1]);
    const site = clean(decode((b.match(/<span class="sitestr">([^<]*)<\/span>/) || [])[1] || ""));
    const points = num((b.match(/<span class="score"[^>]*>(\d+)\s*points?<\/span>/) || [])[1]);
    const age = ((b.match(/<span class="age" title="([^"]+)"/) || [])[1] || "").split(" ")[0];
    const comments = num((b.match(/item\?id=\d+">(\d+)(?:&nbsp;|\s)comments?<\/a>/) || [])[1]);
    const user = (b.match(/class="hnuser">([^<]+)</) || [])[1] || "";
    out.push({ id, rank, title: clean(decode(tl[2].replace(/<[^>]+>/g, ""))), link: abs(tl[1]), site, points, comments, user, time: age ? age.replace(/Z?$/, "Z") : "", discussion: BASE + "item?id=" + id });
  }
  return out;
}

/** 讨论页 → { text（Ask HN 等的正文）, comments: [{ text, replies }] }（顶层评论，页面顺序）。 */
export function discussion(html, max) {
  const s = String(html);
  const top = (s.match(/<div class="toptext">([\s\S]*?)<\/div>/) || [])[1] || "";
  const out = [];
  const parts = s.split(/<tr class="athing comtr" id="/);
  for (let i = 1; i < parts.length && out.length < (max || 8); i++) {
    const b = parts[i];
    if (!/<td class="ind" indent="0">/.test(b)) continue;
    const body = (b.match(/<div class="commtext[^"]*">([\s\S]*?)<\/div>/) || [])[1];
    if (!body) continue;
    const text = clean(decode(body.replace(/<p>/g, " ").replace(/<[^>]+>/g, "")));
    if (text.length < 20) continue;
    out.push({ text, replies: num((b.match(/class="togg clicky"[^>]* n="(\d+)"/) || [])[1]) });
  }
  return { text: clean(decode(top.replace(/<p>/g, " ").replace(/<[^>]+>/g, ""))), comments: out };
}

/** 评论 → 存进 comments 字段的文字：每条前标回复数，超长截断。 */
export function commentsText(list, per) {
  return list.map((c) => "· " + (c.replies ? "（" + c.replies + " 条回复）" : "") + (c.text.length > (per || 400) ? c.text.slice(0, (per || 400) - 1) + "…" : c.text)).join("\n");
}

export default {
  id: "hackernews",
  browseMode: "html",
  // 读服务器给的原始 HTML：浏览器自动翻译会往 DOM 里插中文译文、打乱评论的标签
  rawHtml: true,
  waitFor: "tr.athing",
  parse(text, opts) {
    const max = (opts && opts.max) || 30;
    const min = Number((opts && opts.src && opts.src.min_points) ?? 100);
    return stories(text).filter((x) => x.points >= min).slice(0, max).map((x, i) => ({
      title: x.title,
      link: x.link,
      published_at: x.time,
      summary: "Hacker News 讨论：" + x.points + " 分，" + x.comments + " 条评论" + (x.site ? "（" + x.site + "）" : ""),
      content: "",
      signals: { likes: x.points, comments: x.comments, hot: [], section: "首页", rank: i },
      signals_raw: { hn_id: x.id, site: x.site, points: x.points, comments: x.comments, discussion: x.discussion, rank: x.rank },
    }));
  },
  /**
   * 读讨论页补评论。@param ctx { fetchHtml(url) → html|null, src, deadline（毫秒时间戳） }
   */
  async enrich(items, ctx) {
    const n = Number((ctx.src && ctx.src.comment_items) ?? 8);
    const per = 400;
    const picks = items.slice().sort((a, b) => (b.signals_raw.points || 0) - (a.signals_raw.points || 0)).slice(0, n);
    let ok = 0;
    for (const it of picks) {
      if (ctx.deadline && Date.now() > ctx.deadline) break;
      let html = null;
      try { html = await ctx.fetchHtml(it.signals_raw.discussion); } catch { html = null; }
      if (!html) continue;
      const d = discussion(html, 8);
      if (d.comments.length) { it.comments = commentsText(d.comments, per); ok++; }
      if (d.text && it.link === it.signals_raw.discussion) { it.summary = d.text.slice(0, 1200); it.content = d.text.slice(0, 6000); }
    }
    return { tried: picks.length, ok };
  },
};
