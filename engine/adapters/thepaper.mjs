/**
 * 澎湃新闻首页（thepaper.cn）。Next.js Pages Router，__NEXT_DATA__ 里的推荐位：
 *   recommendImg（头图）/ recommendTxt（要闻）/ recommendChannels[].contentList（频道）。
 * 每条带 praiseTimes（点赞）、interactionNum（互动/评论）、pubTimeLong（毫秒）。
 */
import { nextData } from "./_util.mjs";

const SECTION = { recommendImg: "头图", recommendTxt: "要闻", contentList: "频道" };

export default {
  id: "thepaper",
  browseMode: "html",
  /** browse 取整页前等它出现（最多 15 秒）。 */
  waitFor: "#__NEXT_DATA__",
  parse(text, opts) {
    const max = (opts && opts.max) || 60;
    const d = nextData(text);
    const data = d && d.props && d.props.pageProps && d.props.pageProps.data;
    if (!data) return [];
    const out = [];
    const seen = new Set();
    const visit = (o, section) => {
      if (out.length >= max || o === null || typeof o !== "object") return;
      if (Array.isArray(o)) { for (const x of o) visit(x, section); return; }
      if (o.contId && o.name) {
        if (seen.has(o.contId)) return;
        seen.add(o.contId);
        const link = typeof o.link === "string" && /^https?:/.test(o.link) ? o.link : "https://www.thepaper.cn/newsDetail_forward_" + o.contId;
        out.push({
          title: String(o.name).trim(),
          link,
          published_at: o.pubTimeLong ? new Date(Number(o.pubTimeLong)).toISOString() : "",
          published_raw: o.pubTime || "",
          summary: String(o.summary || "").slice(0, 1200),
          content: "",
          signals: { likes: o.praiseTimes, comments: o.interactionNum, rank: out.length, section, hot: o.closePraise === "1" ? [] : undefined },
          signals_raw: { contId: o.contId, praiseTimes: o.praiseTimes, interactionNum: o.interactionNum, nodeId: o.nodeId, cardMode: o.cardMode, nodeName: o.nodeInfo && o.nodeInfo.name },
        });
        return;
      }
      for (const [k, v] of Object.entries(o)) {
        const sec = SECTION[k] ? (k === "contentList" && o.nodeName ? "频道·" + o.nodeName : SECTION[k]) : section;
        visit(v, sec);
      }
    };
    for (const key of ["recommendImg", "recommendTxt", "recommendChannels"]) visit(data[key], SECTION[key] || "频道");
    return out;
  },
};
