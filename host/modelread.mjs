/**
 * 模型读页面（「不限」档）：网页类的源每轮由模型直接读页面列出一条条内容，不依赖任何解析规则，网站怎么改版都读得出。
 *
 * 防止编造：页面快照里每个链接就地标号【n】、时间标成〈时间 …〉；模型只能用编号指链接，
 * 标题、摘要、时间都要照抄页面。程序逐条核对——编号存在、标题在页面原文里、时间取自页面——不过关的丢掉。
 * 模型没读出来（超时、出错、核对后一条不剩）的源，照常走程序解析。
 */
import { parseJsonLoose } from "./model.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/[\s　，。、：:；;！!？?“”"'‘’《》〈〉【】()（）\[\]·…\-—_|/\\.,]+/g, "");

export function readPrompt(src, snap, max) {
  return "任务：下面是「" + (src.name || src.url) + "」页面上的文字，按页面顺序排列。【n】标出一个链接（编号 n），〈时间 …〉是页面上的时间。" +
    "列出页面上一条条的新闻、快讯或帖子（最多 " + (max || 30) + " 条，按页面顺序），每条三项：" +
    "\n1. 标题：照抄页面文字；没有单独标题的（如帖子）取正文第一句，不超过 60 字；不要改写、不要翻译、不要概括" +
    "\n2. 这一条详情页链接的编号 n（必须是页面里出现过的【n】）；找不到填 0" +
    "\n3. 时间：照抄页面上的写法（〈时间 …〉里的值、06:21、9分钟前、2026-11-09 等）；没有填空字符串" +
    "\n不要列：导航、栏目、标签、分享按钮、广告、作者主页、「关注」之类的界面文字。不用写摘要，程序会从页面上取。" +
    '\n只输出一个 JSON 对象，每条是一个三元数组：{"items":[["标题",12,"06:21"]]}' +
    "\n\n页面标题：" + (snap.title || "") + "\n地址：" + (snap.page_url || src.url) + "\n\n页面文字：\n" + String(snap.text || "").slice(0, 16000);
}

/** 模型的输出 → 条目列表。完整 JSON 解析不了（输出被截断）时，逐条捞出已经完整的三元组。 */
export function parseReadOutput(text) {
  const j = parseJsonLoose(text);
  if (j && Array.isArray(j.items)) return j.items;
  const out = [];
  const re = /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
  let m;
  while ((m = re.exec(String(text || "")))) { try { out.push([JSON.parse('"' + m[1] + '"'), Number(m[2]), JSON.parse('"' + m[3] + '"')]); } catch { /* 这一条坏了 */ } }
  return out.length ? out : null;
}

/** 摘要从页面原文取：标题之后到下一个时间点之前的文字（去掉链接编号），截到最后一个句号。 */
function summaryAfter(text, title) {
  const key = String(title).replace(/…$/, "").slice(0, 16);
  const at = key.length >= 4 ? text.indexOf(key) : -1;
  if (at < 0) return "";
  let seg = text.slice(at + key.length, at + key.length + 700);
  const rest = String(title).replace(/…$/, "").slice(key.length);
  if (rest && seg.startsWith(rest)) seg = seg.slice(rest.length);
  seg = seg.split(/〈时间|\n\s*\d{1,2}:\d{2}\s*\n/)[0].replace(/【\d+】/g, " ").replace(/\s+/g, " ").trim();
  const end = seg.lastIndexOf("。");
  if (end > 20) seg = seg.slice(0, end + 1);
  return seg.length >= 10 ? seg.slice(0, 400) : "";
}

/** 片段是否照抄自页面：取前若干个字（去掉空白与标点）在页面原文里找。 */
function onPage(pageN, s, n) {
  const x = norm(s).slice(0, n || 14);
  return x.length >= 4 && pageN.includes(x);
}

/**
 * 核对模型列出的条目。@returns { items:[{title,link,published_at,published_raw,summary,content}], dropped, why:{} }
 */
export function verifyRead(snap, list, max) {
  const pageN = norm(snap.text);
  const links = new Map((snap.links || []).map((l) => [Number(l.n), l]));
  const times = new Set((snap.times || []).filter(Boolean));
  const self = String(snap.page_url || snap.url || "").split("#")[0];
  const out = [];
  const seen = new Set();
  const why = {};
  const drop = (k) => { why[k] = (why[k] || 0) + 1; };
  for (const raw of Array.isArray(list) ? list : []) {
    const x = Array.isArray(raw) ? { title: raw[0], link: raw[1], time: raw[2] } : raw;
    const title = String((x && x.title) || "").replace(/\s+/g, " ").trim();
    const l = links.get(Number(x && x.link));
    if (!title) { drop("no_title"); continue; }
    if (!l || !/^https?:/.test(l.href) || l.href === self) { drop("bad_link"); continue; }
    if (seen.has(l.href)) { drop("dup_link"); continue; }
    if (!onPage(pageN, title)) { drop("title_not_on_page"); continue; }
    seen.add(l.href);
    const t = String((x && x.time) || "").trim();
    let published_at = "", published_raw = "";
    if (t && times.has(t)) published_at = t;
    else if (t && /^\d{4}-\d{2}-\d{2}T/.test(t)) { /* 页面上没有的 ISO 时间：不用 */ }
    else if (t && onPage(pageN, t, 20)) published_raw = t.slice(0, 40);
    let summary = String((x && x.summary) || "").replace(/\s+/g, " ").trim();
    if (summary && !onPage(pageN, summary)) summary = "";
    if (!summary) summary = summaryAfter(String(snap.text || ""), title);
    out.push({ title: [...title].length > 120 ? [...title].slice(0, 100).join("") + "…" : title, link: l.href, published_at, published_raw, summary: summary.slice(0, 1200), content: "" });
    if (out.length >= (max || 30)) break;
  }
  return { items: out, dropped: Object.values(why).reduce((a, b) => a + b, 0), why };
}

/**
 * 读一个源。@param deps { read(url, waitFor) → 快照, model }
 * @returns { ok, items, dropped, why, ms, error? }
 */
export async function readSource(deps, src, o) {
  const t0 = Date.now();
  const snap = await deps.read(src.url, (src.extract && src.extract.wait_for) || src.wait_for || "");
  if (!snap || !snap.ok || !snap.text) return { ok: false, items: [], error: "snapshot_failed", ms: Date.now() - t0 };
  const max = Math.min(30, Math.max(10, Number(src.max_items) || 20));
  const list = parseReadOutput(await deps.model.complete(readPrompt(src, snap, max), { step: "read", maxTokens: 12000, timeoutMs: (o && o.timeoutMs) || 300000 }));
  if (!list) return { ok: false, items: [], error: "bad_json", ms: Date.now() - t0 };
  const v = verifyRead(snap, list, max);
  return { ok: v.items.length > 0, items: v.items, dropped: v.dropped, why: v.why, listed: list.length, ms: Date.now() - t0 };
}

/** 「不限」档每轮让模型读哪些源：网页类（列表页、学过解析规则的），不含 RSS / 接口 / 专用适配器（它们读的是结构化数据，不受改版影响）。 */
export function readTargets(sources, o) {
  const packs = o && o.packs ? String(o.packs).split(",") : null;
  const only = o && o.sources ? String(o.sources).split(",") : null;
  return (sources || []).filter((s) => s.enabled !== false && !s.removed_at && !s.adapter && (s.type || "html_index") === "html_index"
    && (!only || only.includes(s.id)) && (!packs || packs.includes(s.pack || "core")))
    .sort((a, b) => (b.trial ? 0 : 1) - (a.trial ? 0 : 1) || (Number(b.weight) || 0.5) - (Number(a.weight) || 0.5));
}
