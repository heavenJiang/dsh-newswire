/**
 * 正文文本的清理（不联网，迁移脚本也用）：
 *   trimTail     从结尾样板（免责声明、相关阅读、联系方式、社群链接……）那一行起截掉
 *                阅读器读出的「相关新闻」标题列表（`* ### …`、`1 ### …`）也算结尾
 *   anchorReader 阅读器（整页转文字）的结果：从文章标题那一行开始取，再截掉结尾样板；
 *                页面里找不到标题时返回 ""，由调用方按更严的长度要求处理
 *   relevant     整页读出的文字是不是这篇文章：标题里的关键词（中文按相邻两字、外文按词）在正文里出现得够不够。
 *                门槛按实测定：真文章即便是评论式标题（「马上评｜…何以继？」）也有 ≥ 0.1，行情条、捐款提示、页面模板 ≤ 0.03
 *   PAYWALL_TEXT 付费墙 / 订阅提示页
 */

/** 正文最短长度：整页段落兜底要够长才算；在文章容器里或对上了标题的，短讯也算。 */
export const MIN_BODY = 150;
export const MIN_SHORT = 40;

const FOOTER = /^(免责声明|风险提示[:：]|风险提示及免责|声明[:：]|责任编辑|相关阅读|推荐阅读|相关推荐|热门推荐|热门文章|延伸阅读|猜你喜欢|相关新闻|更多精彩|联系我们|版权声明|原文链接|Telegram\s*订阅|Twitter\s*(官方|英文)?账号|不良信息举报|违法和不良信息|证券投资咨询服务提供|所有评论|全部评论|网友评论|热门评论|本文纯属作者个人观点)/i;

const HEADLINE_LIST = /^([*+-]\s+(_[^_]*_\s*)?#{1,6}\s|\d+\s+#{1,6}\s)/;
/** 页面上的新闻流：以时间戳开头的行（「11/9 15:26美联储……」「15:26 美股……」） */
const STAMPED = /^(\d{1,2}[/\-月.]\d{1,2}日?\s*)?\d{1,2}:\d{2}(?!\d)/;
/** 开头的发布时间行、分享按钮 */
const HEAD_JUNK = /^([\d\s\-:/.年月日]+|.{0,6}分享(至|到).{0,20}|[\d,.万\s]+人(浏览|阅读|看过)[\d\s\-:/.]*)$/;

/** 页脚：短行里出现备案号、版权、举报方式、站点导航等，从这行起都不是正文。 */
const FOOTER_ANY = /(ICP备|ICP证|公网安备|经营许可证|版权所有|Copyright\s*©|©\s*\d{4}|\d{4}\s*©|举报邮箱|网站举报|关于我们.{0,6}联系我们|SKIP ADVERTISEMENT|Help Centre|Page details)/i;
/** 夹在正文里的推广、订阅、分享、字号按钮：整行去掉。 */
const NOISE_LINE = /(\((AP|AFP|Reuters|Getty|EPA|Xinhua) Photo[^)]*\)\s*$|^\d+ of \d+\s*\|?\s*$|^License this photo|^Updated \d{1,2}:\d{2}\s*[AP]M|^Leer en español$|视觉中国\s*资料图|^图片来源[:：]|界面快报_·_|微博分享|微信分享|听新闻|AI帮你提炼|登录后解锁|智享会员|定位投资机会|每日仅需[\d.]+元|会员积分\+|Can you stand with independent journalism|Make a year-end gift|Try unlimited access|Subscribe to (continue|read|unlock)|Sign up for our|下载客户端|扫一扫|分享到微信|手机继续看|【字体：|字号：\s*大\s*中\s*小|^\*?\s*大\s*中\s*小\s*$)/i;
/** 开头的时间、来源、作者、浏览数一类的信息行。 */
const META_LINE = /^(((发布)?时间|来源|作者|编辑|浏览(次数)?|人气|阅读)[:：]|BY\s+[A-Z][A-Z .,'-]+$)/;

export const PAYWALL_TEXT = /(Try unlimited access|Subscribe to (continue|read|unlock)|to continue reading|already a subscriber|订阅后(可)?阅读|付费(阅读|会员)后|开通会员(后)?(阅读|查看))/i;

export function trimTail(text) {
  let lines = String(text || "").split("\n").map((l) => l.replace(/^\S{1,40} on X: "/, "")).filter((l) => !(l.length <= 200 && NOISE_LINE.test(l.trim())));
  while (lines.length > 1 && (HEAD_JUNK.test(lines[0].trim()) || (lines[0].length <= 120 && META_LINE.test(lines[0].trim())))) lines = lines.slice(1);
  const feed = (k) => STAMPED.test(lines[k].trim()) && STAMPED.test(String(lines[k + 1] || "").trim()) && STAMPED.test(String(lines[k + 2] || "").trim());
  const i = lines.findIndex((l, k) => k > 0 && (FOOTER.test(l.trim()) || HEADLINE_LIST.test(l.trim()) || feed(k) || (l.length <= 200 && FOOTER_ANY.test(l))));
  // 新闻流前面常有一个栏目名（「7x24h 快讯」）
  let end = i > 1 && feed(i) && lines[i - 1].trim().length <= 12 ? i - 1 : i;
  // 截断处之前紧挨着的一串列表链接（相关文章）一起去掉
  if (end > 0) { let k = end; while (k > 1 && /^[*+-]\s/.test(lines[k - 1].trim())) k--; if (end - k >= 3) end = k; }
  return (end > 0 ? lines.slice(0, end) : lines).join("\n").trim();
}

function terms(s) {
  const t = String(s || "").toLowerCase();
  const out = new Set();
  for (const run of t.match(/[\u4e00-\u9fff]+/g) || []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const w of t.match(/[a-z0-9][a-z0-9'-]{3,}/g) || []) out.add(w);
  return out;
}

/**
 * 标题关键词在正文前 4000 字里出现的比例够不够（标题太短不判；空白不计，PDF 抽出的字间常有空格）。
 * lead（列表里这条的文字开头）也可作依据：标题是译名（中文标题、英文原文）时靠它。
 */
export function relevant(text, title, lead, need) {
  // 开头也要沾边：页面上的快讯流、行情条里也会出现这条的标题，但那不是它的正文
  const head = String(text || "").slice(0, 600);
  return near(text, 4000, title, lead, need || 0.1) && near(head, 600, title, lead, 0.08);
}

function near(text, n, title, lead, need) {
  const body = String(text || "").slice(0, n).toLowerCase();
  const flat = body.replace(/\s+/g, "");
  const ok = (s, n) => {
    const ts = terms(s);
    if (ts.size < 4) return null;
    let hit = 0;
    for (const x of ts) if (/[\u4e00-\u9fff]/.test(x) ? flat.includes(x) : body.includes(x)) hit++;
    return hit / ts.size >= n;
  };
  const a = ok(title, need);
  if (a !== false) return true;
  return ok(String(lead || "").slice(0, 200), need) === true;
}

const key = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** @returns 清理后的正文；对不上标题时返回 ""（给了标题才检查）。 */
export function anchorReader(text, title) {
  let lines = String(text || "").split("\n");
  const k = key(title).slice(0, 10);
  if (k.length >= 6) {
    // 标题要在这一行开头（快讯流、行情条会把标题和别的内容挤在同一行里）
    const i = lines.findIndex((l) => { const p = key(l).indexOf(k); return p >= 0 && p <= 30; });
    if (i < 0) return "";
    lines = lines.slice(i);
    // 标题行本身不算正文
    if (key(lines[0]).length <= key(title).length + 6) lines = lines.slice(1);
  }
  return trimTail(lines.join("\n"));
}
