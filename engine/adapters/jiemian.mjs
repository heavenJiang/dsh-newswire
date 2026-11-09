/**
 * 界面新闻·快讯（jiemian.com/lists/4.html）。服务端渲染列表：
 * <div class="columns-right-center__newsflash-item ..." data-time="秒" data-id="..."> + h4>a 标题 + 摘要。
 * 列表页不给阅读数；信号只有位置（rank）与加红样式（a-item-red → hot「加红」）。
 */
import { attr } from "./_util.mjs";
import { clean, decodeEntities } from "../util/text.mjs";

export default {
  id: "jiemian",
  browseMode: "html",
  /** browse 取整页前等它出现（最多 15 秒）。 */
  waitFor: ".columns-right-center__newsflash-item",
  parse(text, opts) {
    const max = (opts && opts.max) || 40;
    const html = String(text);
    const re = /<div\s+class="columns-right-center__newsflash-item(\s[^"]*)?"([^>]*)>([\s\S]*?)(?=<div\s+class="columns-right-center__newsflash-item[\s"]|<\/ul>)/g;
    const out = [];
    let m;
    while ((m = re.exec(html))) {
      const flags = (m[1] || "").trim();
      const tagAttrs = m[2];
      const body = m[3];
      const a = body.match(/<h4>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const ts = Number(attr(tagAttrs, "data-time"));
      const summaryM = body.match(/newsflash-content__summary">([\s\S]*?)<\/div>/);
      const summary = summaryM ? clean(summaryM[1]) : "";
      // 界面用 a-item-red 标出加红（编辑判定的重要快讯）；其它样式类原样留在 signals_raw.flags
      const hot = /\bred\b|-red\b/.test(flags) ? ["加红"] : [];
      out.push({
        title: clean(a[2]),
        link: decodeEntities(a[1]),
        published_at: ts > 0 ? new Date(ts * 1000).toISOString() : "",
        summary: summary.slice(0, 1200),
        content: summary.slice(0, 6000),
        signals: { rank: out.length, section: "快讯", hot },
        signals_raw: { id: attr(tagAttrs, "data-id"), flags, edit: attr(tagAttrs, "data-edit") },
      });
      if (out.length >= max) break;
    }
    return out;
  },
};
