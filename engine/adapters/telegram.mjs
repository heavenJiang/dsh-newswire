/**
 * Telegram 公开频道网页预览（https://t.me/s/<频道名>），不用登录。每页约 20 条消息，往前翻用 ?before=<消息id>。
 * 每条消息：data-post="频道/id"、<time datetime>、正文 .js-message_text、阅读数 .tgme_widget_message_views、表情回应。
 *
 * 两种频道都认：
 *   单条快讯：一帖一条，加粗首行是标题；正文末尾的「信源」链接记为原始出处，频道/群推广链接去掉。
 *   分帖汇总：以 [k/n] 开头的连续几帖是同一份汇总（一条可能跨帖），拼起来后按「━━ 栏目 ━━」与「N、标题」拆成单条；
 *            「其他动态」这类一段里串了几件事（每件后面跟（出处））的再按「）；」拆开。
 * 条目链接是消息链接加 ?i=<该消息里第几条>（拆开的再加 .k），与是否拿到整份汇总无关，翻页重复抓到也是同一个键。
 * 置顶提示等服务消息、没有文字的消息跳过。
 */
import { attr } from "./_util.mjs";
import { clean } from "../util/text.mjs";

/** "1.2K" / "3.4M" / "987" → 数字。 */
function count(s) {
  const m = String(s || "").trim().match(/^(\d+(?:\.\d+)?)\s*([KM])?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[String(m[2] || "").toLowerCase()] || 1));
}

/** 整页 → 消息列表（页面顺序：旧 → 新）。 */
export function messages(html) {
  const out = [];
  const parts = String(html).split('<div class="tgme_widget_message_wrap');
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const head = (b.match(/<div class="tgme_widget_message [^"]*"[^>]*>/) || [])[0] || "";
    const post = attr(head, "data-post");
    const pm = post.match(/^([A-Za-z0-9_]+)\/(\d+)$/);
    if (!pm) continue;
    const text = (b.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
    let likes = 0;
    let anyReaction = false;
    const rre = /<span class="tgme_reaction[^"]*">[\s\S]*?<\/i>\s*([\d.]+[KM]?)\s*<\/span>/gi;
    let rm;
    while ((rm = rre.exec(b))) { const c = count(rm[1]); if (c !== null) { likes += c; anyReaction = true; } }
    out.push({
      channel: pm[1],
      id: Number(pm[2]),
      service: /\bservice_message\b/.test(head),
      time: attr((b.match(/<time [^>]*>/) || [])[0] || "", "datetime"),
      views: count((b.match(/class="tgme_widget_message_views">([^<]*)</) || [])[1]),
      likes: anyReaction ? likes : null,
      forwarded: /tgme_widget_message_forwarded_from/.test(b),
      text,
    });
  }
  return out;
}

const link = (m, i) => "https://t.me/" + m.channel + "/" + m.id + (i ? "?i=" + i : "");
const lines = (h) => String(h).replace(/<br\s*\/?>/gi, "\n").split("\n");
const anchors = (h) => {
  const out = [];
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(h))) out.push({ name: clean(m[2]), url: m[1].replace(/&amp;/g, "&") });
  return out;
};
/** 汉字加英文词太少，看不出说的是什么（「Solana与MegaETH」「AI 与安全事件」）。 */
function vague(s) {
  const t = String(s);
  return (t.match(/[一-鿿]/g) || []).length + (t.match(/[A-Za-z][A-Za-z0-9.'’-]*/g) || []).length < 8;
}

/** 太长的首句截成标题：到第一个句号/分号/逗号，最多 80 字。 */
function headline(s) {
  const t = String(s).trim();
  if (t.length <= 80) return t;
  const cut = t.slice(0, 80).search(/[。；;！!？?]/);
  return (cut >= 12 ? t.slice(0, cut) : t.slice(0, 80)).trim();
}

const ORIGIN = /^(信源|来源|原文|原文链接|source|via)$/i;

/** 单条快讯：加粗首行为标题；从「信源」链接起截掉（推广链接也在那之后）。 */
function single(m) {
  const html = m.text;
  let body = html;
  let origin = "";
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let a;
  while ((a = re.exec(html))) {
    if (ORIGIN.test(clean(a[2]))) { origin = a[1].replace(/&amp;/g, "&"); body = html.slice(0, a.index); break; }
  }
  // 末尾只剩 t.me 链接（频道/群推广）的行去掉
  const ls = lines(body);
  while (ls.length && (!clean(ls[ls.length - 1]) || /^(?:\s*<a\s[^>]*href="https?:\/\/t\.me\/[^"]*"[^>]*>[\s\S]*?<\/a>\s*[·|]?\s*)+$/.test(ls[ls.length - 1]))) ls.pop();
  const bold = ls.length ? (ls[0].trim().match(/^<b>([\s\S]*?)<\/b>\s*$/) || [])[1] : null;
  let title;
  let rest;
  if (bold && clean(bold)) { title = clean(bold); rest = ls.slice(1); }
  else { const first = clean(ls[0] || ""); title = headline(first); rest = title.length < first.length ? ls : ls.slice(1); }
  const content = clean(rest.join(" "));
  if (!title) return null;
  return {
    title,
    link: link(m),
    published_at: m.time,
    summary: content.slice(0, 1200),
    content: content.slice(0, 6000),
    signals: { views: m.views, likes: m.likes, hot: [], section: m.forwarded ? "转发" : "频道" },
    signals_raw: { message_id: m.id, views: m.views, reactions: m.likes, origin_url: origin, forwarded: m.forwarded },
  };
}

const PART = /^\s*\[(\d+)\/(\d+)\]\s*(?:<br\s*\/?>)?/;

/** 把 [k/n] 连续几帖拼成一份：k 依次 +1、n 相同、消息 id 递增且相隔不远。缺头的（翻页边界）也照样拆。 */
function digestGroups(msgs) {
  const groups = [];
  let cur = null;
  for (const m of msgs) {
    const pm = m.text.match(PART);
    if (!pm) { cur = null; continue; }
    const k = Number(pm[1]);
    const n = Number(pm[2]);
    const prev = cur && cur.parts[cur.parts.length - 1];
    if (cur && k === prev.k + 1 && n === cur.n && m.id > prev.m.id && m.id - prev.m.id <= 5) cur.parts.push({ k, m, html: m.text.replace(PART, "") });
    else { cur = { n, parts: [{ k, m, html: m.text.replace(PART, "") }] }; groups.push(cur); }
  }
  return groups;
}

const SECTION = /^━+\s*(.+?)\s*━+$/;
const ITEM = /^(\d{1,2})、\s*/;

/** 一份汇总 → 条目。 */
function digestItems(g) {
  const items = [];
  let section = null;
  let it = null;
  const flush = () => { if (it) items.push(it); it = null; };
  for (const p of g.parts) {
    let ord = 0;
    for (const line of lines(p.html)) {
      const plain = clean(line);
      if (!plain) continue;
      const sm = plain.match(SECTION);
      if (sm) { flush(); section = sm[1]; continue; }
      if (/^【[^】]*】/.test(plain) && !it) continue; // 汇总抬头
      if (ITEM.test(plain)) { flush(); ord++; it = { m: p.m, ord, section, html: [line.replace(/^\s*\d{1,2}、\s*/, "")] }; continue; }
      if (it) it.html.push(line); // 上一条的续行（可能在下一帖开头）
    }
  }
  flush();
  const out = [];
  for (const x of items) {
    const first = x.html[0].trim();
    const bold = (first.match(/^<b>([\s\S]*?)<\/b>/) || [])[1];
    const label = bold ? clean(bold) : "";
    const bodyHtml = bold ? [first.replace(/^<b>[\s\S]*?<\/b>/, "")].concat(x.html.slice(1)).join("\n") : x.html.join("\n");
    const body = clean(bodyHtml);
    const base = { published_at: x.m.time, views: x.m.views, likes: x.m.likes };
    // 一段串了几件事 →逐件拆开：「- 甲。（出处）」逐行列出，或「甲（出处）；乙（出处）。」写在一段里
    const bodyLines = bodyHtml.split("\n").map(clean).filter(Boolean);
    const bullets = bodyLines.filter((l) => /^[-•·]\s*/.test(l));
    const clauses = (bullets.length >= 2 ? bullets.map((l) => l.replace(/^[-•·]\s*/, "")) : body.split(/(?<=）)\s*[；;]\s*/))
      .map((s) => s.replace(/[。.]\s*$/, "").trim()).filter(Boolean);
    if (clauses.length >= 2 && clauses.every((c) => /（[^（）]+）$/.test(c))) {
      const bodyAnchors = anchors(bodyHtml);
      clauses.forEach((c, k) => {
        const text = c.replace(/\s*（[^（）]+）$/, "").replace(/[。.]\s*$/, "").trim();
        const names = (c.match(/（([^（）]+)）$/) || [])[1] || "";
        const srcs = names.split("|").map((s) => s.trim()).filter(Boolean).map((n) => bodyAnchors.find((a) => a.name === n) || { name: n, url: "" });
        out.push(row(x, (x.ord) + "." + (k + 1), headline(text), c, label, srcs, base));
      });
      continue;
    }
    // 只有一个笼统的标签（如「Aave」「Solana与MegaETH」）时把正文首句接上，读者才知道说的是什么
    let title = label;
    if (!title) title = headline(body.replace(/\s*（[^（）]+）\s*$/, ""));
    else if (vague(title)) title = title + "：" + headline(body.replace(/\s*（[^（）]+）[\s\S]*$/, "")).replace(/^(.{40}).+$/, "$1…");
    out.push(row(x, String(x.ord), title, body, label, anchors(bodyHtml), base));
  }
  return out;
}

function row(x, idx, title, content, label, sources, base) {
  return {
    title,
    link: link(x.m, idx),
    published_at: base.published_at,
    summary: content.slice(0, 1200),
    content: content.slice(0, 6000),
    signals: { views: base.views, likes: base.likes, hot: [], section: x.section || "汇总" },
    signals_raw: { message_id: x.m.id, item: idx, label, views: base.views, reactions: base.likes, sources: sources.slice(0, 8), origin_url: (sources.find((s) => s.url) || {}).url || "" },
  };
}

export default {
  id: "telegram",
  browseMode: "html",
  /** browse 取整页前等它出现（最多 15 秒）。 */
  waitFor: ".tgme_widget_message",
  parse(text, opts) {
    const max = (opts && opts.max) || 40;
    const msgs = messages(text).filter((m) => !m.service && clean(m.text));
    const inDigest = new Set();
    const out = [];
    for (const g of digestGroups(msgs)) {
      const rows = digestItems(g);
      if (!rows.length) continue;
      for (const p of g.parts) inDigest.add(p.m.id);
      out.push(...rows);
    }
    for (const m of msgs) {
      if (inDigest.has(m.id)) continue;
      const it = single(m);
      if (it) out.push(it);
    }
    // 新的在前；同一时刻（同一份汇总）保持原顺序
    const order = new Map(out.map((x, i) => [x, i]));
    out.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || "") || (b.signals_raw.message_id - a.signals_raw.message_id) || order.get(a) - order.get(b));
    const res = out.slice(0, max);
    res.forEach((x, i) => { x.signals.rank = i; });
    return res;
  },
};
