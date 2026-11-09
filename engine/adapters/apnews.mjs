/**
 * 美联社 hub 页（apnews.com/world-news、/business）。需 browse（直取 403）。
 * 卡片 <div class="PagePromo" data-gtm-region="标题" data-posted-date-timestamp="毫秒">；
 * 右栏「Most Read」（排名即热度）、「Most commented」（带评论数 CommentCount-template）。
 */
import { attr } from "./_util.mjs";
import { clean, decodeEntities } from "../util/text.mjs";

/** 主区模块多为 "No Value"；第一块是页面头条区。 */
function sectionName(mod) { return !mod || mod === "no value" ? "list" : mod; }

export default {
  id: "apnews",
  browseMode: "html",
  /** browse 取整页前等它出现（最多 15 秒）。 */
  waitFor: ".PagePromo",
  parse(text, opts) {
    const max = (opts && opts.max) || 40;
    const html = String(text);
    const heads = [];
    // 模块标签上带标题与容量（data-max-number-of-posts）；榜单只取容量以内的卡片，防止把模块后面的卡片算进去
    const hre = /<[^>]*\bdata-gtm-headline="([^"]*)"[^>]*>/g;
    let hm;
    while ((hm = hre.exec(html))) heads.push({ at: hm.index, name: hm[1], max: Number(attr(hm[0], "data-max-number-of-posts")) || 10 });
    const moduleAt = (pos) => { let cur = null; for (const h of heads) { if (h.at > pos) break; cur = h; } return cur; };

    const byUrl = new Map();
    const order = [];
    const pre = /<div class="PagePromo"([^>]*)>/g;
    let m;
    const lists = { "most read": [], "most commented": [] };
    while ((m = pre.exec(html))) {
      const tag = m[1];
      const chunk = html.slice(m.index, m.index + 6000);
      const nextAt = chunk.indexOf('<div class="PagePromo"', 10);
      const body = nextAt > 0 ? chunk.slice(0, nextAt) : chunk;
      const hrefM = body.match(/href="(https:\/\/apnews\.com\/article\/[^"#?]+)/);
      if (!hrefM) continue;
      const url = hrefM[1];
      const title = decodeEntities(attr(tag, "data-gtm-region")) || clean((body.match(/PagePromoContentIcons-text">([\s\S]*?)<\/span>/) || [])[1] || "");
      if (!title || title.length < 8) continue;
      const ts = Number(attr(tag, "data-posted-date-timestamp")) || Number(attr(tag, "data-updated-date-timestamp"));
      const cc = body.match(/CommentCount-template">\s*([\d,]+)\s*</);
      const head = moduleAt(m.index);
      const mod = head ? head.name.toLowerCase() : "";
      if (lists[mod] && lists[mod].length < head.max && !lists[mod].includes(url)) lists[mod].push(url);
      let it = byUrl.get(url);
      if (!it) {
        it = { title, link: url, published_at: ts ? new Date(ts).toISOString() : "", summary: clean((body.match(/PagePromo-description">([\s\S]*?)<\/div>/) || [])[1] || "").slice(0, 1200), content: "", signals: { hot: [], section: lists[mod] ? "" : sectionName(mod) }, signals_raw: {} };
        byUrl.set(url, it);
        order.push(url);
      }
      if (cc) { it.signals.comments = cc[1]; it.signals_raw.comment_count = cc[1]; }
    }
    lists["most read"].forEach((u, i) => { const it = byUrl.get(u); if (it) { it.signals.hot.push("Most Read #" + (i + 1)); it.signals_raw.most_read_rank = i + 1; } });
    lists["most commented"].forEach((u, i) => { const it = byUrl.get(u); if (it) { it.signals.hot.push("Most commented #" + (i + 1)); it.signals_raw.most_commented_rank = i + 1; } });
    const out = [];
    for (const u of order) {
      const it = byUrl.get(u);
      if (!it.signals.section) it.signals.section = "rail";
      it.signals.rank = out.length;
      out.push(it);
      if (out.length >= max) break;
    }
    return out;
  },
};
