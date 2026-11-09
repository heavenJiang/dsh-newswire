/**
 * 深潮 TechFlow 快讯（techflowpost.com/newsletter）。
 * 页面是 Next.js App Router，条目数据在 RSC 流里：view_count / visit_count / shared_count /
 * user_favorite_count / is_hot / is_push / is_day_recommend / created_at。
 */
import { nextFlightText, scanObjects } from "./_util.mjs";

const ORIGIN = "https://www.techflowpost.com";

export default {
  id: "techflow",
  browseMode: "html",
  /** browse 取整页前等它出现（最多 15 秒）。 */
  waitFor: "a[href^=\"/newsletter/\"]",
  parse(text, opts) {
    const max = (opts && opts.max) || 40;
    const flight = nextFlightText(text);
    const rows = scanObjects(flight || String(text), '{"id":', (o) => typeof o.title === "string" && o.title !== "" && "view_count" in o && o.created_at);
    const seen = new Set();
    const out = [];
    for (const o of rows) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      if (o.is_visible === false) continue;
      const hot = [];
      if (o.is_hot) hot.push("热门");
      if (o.is_day_recommend) hot.push("日推荐");
      if (o.is_push) hot.push("推送");
      const link = o.is_article && o.article_id ? ORIGIN + "/article/" + o.article_id : ORIGIN + "/newsletter/" + o.id;
      out.push({
        title: o.title.trim(),
        link,
        published_at: String(o.created_at),
        summary: String(o.abstract || "").slice(0, 1200),
        content: String(o.abstract || "").slice(0, 6000),
        signals: { views: o.view_count, shares: o.shared_count, favorites: o.user_favorite_count, hot, rank: out.length, section: o.is_article ? "文章" : "快讯" },
        signals_raw: { id: o.id, view_count: o.view_count, visit_count: o.visit_count, shared_count: o.shared_count, user_favorite_count: o.user_favorite_count, is_hot: o.is_hot, is_push: o.is_push, is_pr: o.is_pr, is_day_recommend: o.is_day_recommend, content_categories: o.content_categories, original_url: o.url || "" },
      });
      if (out.length >= max) break;
    }
    return out;
  },
};
