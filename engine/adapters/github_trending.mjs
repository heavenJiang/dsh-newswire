/**
 * GitHub Trending（https://github.com/trending?since=daily，可加 /<语言>），用 browse 读服务器给的原始 HTML。
 *
 * 每个项目：<article class="Box-row"> 里 h2 > a 的 /owner/repo、p 描述、itemprop="programmingLanguage" 语言、
 * stargazers 链接里的总星数、「N stars today」今日新增。没有发布时间（时间可信度记为 fetched）。
 * 标题写「owner/repo：描述」，热度记今日新增星数。低于 min_stars_today 的不收（默认 100）。
 * 项目说明（README）由正文抓取去项目页取。
 */
import { clean } from "../util/text.mjs";

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const text = (html) => clean(decode(String(html || "").replace(/<[^>]+>/g, " ")));
const num = (s) => Number(String(s || "").replace(/[^\d]/g, "")) || 0;

export function repos(html) {
  const out = [];
  for (const part of String(html).split(/<article class="Box-row/).slice(1)) {
    const a = part.split("</article>")[0];
    const href = (a.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"\/]+\/[^"\/?#]+)"/) || [])[1];
    if (!href) continue;
    const desc = text((a.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    out.push({
      repo: decode(href),
      desc,
      lang: text((a.match(/itemprop="programmingLanguage">([^<]*)</) || [])[1] || ""),
      stars: num(text((a.match(/href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/) || [])[1])),
      today: num((a.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/) || [])[1]),
    });
  }
  return out;
}

export default {
  id: "github_trending",
  browseMode: "html",
  rawHtml: true,
  waitFor: "article.Box-row",
  parse(html, opts) {
    const max = (opts && opts.max) || 25;
    const min = Number((opts && opts.src && opts.src.min_stars_today) ?? 100);
    return repos(html).filter((x) => x.today >= min).slice(0, max).map((x, i) => ({
      title: x.repo + (x.desc ? "：" + (x.desc.length > 100 ? x.desc.slice(0, 99) + "…" : x.desc) : ""),
      link: "https://github.com/" + x.repo,
      published_at: "",
      summary: x.desc,
      content: "",
      signals: { likes: x.today, hot: [], section: x.lang || "trending", rank: i },
      signals_raw: { repo: x.repo, language: x.lang, stars: x.stars, stars_today: x.today },
    }));
  },
};
