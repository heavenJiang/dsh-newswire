/**
 * 正文文本的清理（不联网，迁移脚本也用）：
 *   trimTail     从结尾样板（免责声明、相关阅读、联系方式、社群链接……）那一行起截掉
 *                阅读器读出的「相关新闻」标题列表（`* ### …`、`1 ### …`）也算结尾
 *   anchorReader 阅读器（整页转文字）的结果：从文章标题那一行开始取，再截掉结尾样板；
 *                页面里找不到标题时返回 ""，由调用方按更严的长度要求处理
 */

/** 正文最短长度：整页段落兜底要够长才算；在文章容器里或对上了标题的，短讯也算。 */
export const MIN_BODY = 150;
export const MIN_SHORT = 40;

const FOOTER = /^(免责声明|风险提示[:：]|声明[:：]|责任编辑|相关阅读|推荐阅读|相关推荐|热门推荐|热门文章|延伸阅读|猜你喜欢|相关新闻|更多精彩|联系我们|版权声明|原文链接|Telegram\s*订阅|Twitter\s*(官方|英文)?账号|不良信息举报|违法和不良信息|证券投资咨询服务提供|所有评论|全部评论|网友评论|热门评论|本文纯属作者个人观点)/i;

const HEADLINE_LIST = /^([*+-]\s+(_[^_]*_\s*)?#{1,6}\s|\d+\s+#{1,6}\s)/;
/** 页面上的新闻流：以时间戳开头的行（「11/9 15:26美联储……」「15:26 美股……」） */
const STAMPED = /^(\d{1,2}[/\-月.]\d{1,2}日?\s*)?\d{1,2}:\d{2}(?!\d)/;
/** 开头的发布时间行、分享按钮 */
const HEAD_JUNK = /^([\d\s\-:/.年月日]+|.{0,6}分享(至|到).{0,20}|[\d,.万\s]+人(浏览|阅读|看过)[\d\s\-:/.]*)$/;

export function trimTail(text) {
  let lines = String(text || "").split("\n");
  while (lines.length > 1 && HEAD_JUNK.test(lines[0].trim())) lines = lines.slice(1);
  const feed = (k) => STAMPED.test(lines[k].trim()) && STAMPED.test(String(lines[k + 1] || "").trim()) && STAMPED.test(String(lines[k + 2] || "").trim());
  const i = lines.findIndex((l, k) => k > 0 && (FOOTER.test(l.trim()) || HEADLINE_LIST.test(l.trim()) || feed(k)));
  // 新闻流前面常有一个栏目名（「7x24h 快讯」）
  let end = i > 1 && feed(i) && lines[i - 1].trim().length <= 12 ? i - 1 : i;
  // 截断处之前紧挨着的一串列表链接（相关文章）一起去掉
  if (end > 0) { let k = end; while (k > 1 && /^[*+-]\s/.test(lines[k - 1].trim())) k--; if (end - k >= 3) end = k; }
  return (end > 0 ? lines.slice(0, end) : lines).join("\n").trim();
}

const key = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** @returns 清理后的正文；对不上标题时返回 ""（给了标题才检查）。 */
export function anchorReader(text, title) {
  let lines = String(text || "").split("\n");
  const k = key(title).slice(0, 10);
  if (k.length >= 6) {
    const i = lines.findIndex((l) => key(l).includes(k));
    if (i < 0) return "";
    lines = lines.slice(i);
    // 标题行本身不算正文
    if (key(lines[0]).length <= key(title).length + 6) lines = lines.slice(1);
  }
  return trimTail(lines.join("\n"));
}
