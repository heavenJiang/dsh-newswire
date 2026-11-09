/**
 * 事实核对：模型写的每句话里，凡是能被程序核对的成分——数字、外文专名、引号里的词——都要在材料里找得到。
 *
 *   数字：忽略日期时间（11月8日、14:56）和小于 10 的整数（「两艘」「3 人」太常见也太容易对上）；
 *         允许中英文单位换算：34亿 ↔ 3.4 billion、2.5万 ↔ 25 thousand / 25,000、120万 ↔ 1.2 million。
 *   专名：拉丁字母开头大写、三个字符以上的词（Aramco、OnePWR、USCIS），不分大小写。
 *   引号：「」“”《》里的 2–20 字。
 *
 * 中文人名、地名等无法可靠核对，不在范围内（文档里写明这一局限）。
 */

const uniq = (xs) => [...new Set(xs)];

export function norm(s) {
  return String(s || "")
    .replace(/[０-９．％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d)[,，](?=\d{3}(?!\d))/g, "$1")
    .toLowerCase();
}

const fmt = (x) => String(Math.round(x * 1000) / 1000);

/** 一句话里可核对的成分。 */
export function claims(text) {
  const t = norm(text);
  const nums = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const v = m[0];
    const end = m.index + v.length;
    const after = t.slice(end, end + 1);
    const before = t.slice(Math.max(0, m.index - 1), m.index);
    if (/[月日时点号:：]/.test(after) || /[:：\-/]/.test(before) || (/^\d{1,2}$/.test(v) && after === "-")) continue; // 日期时间
    if (/^(19|20)\d\d$/.test(v) && after === "年") { nums.push({ v, unit: "" }); continue; }
    const unit = /[万亿%]/.test(after) ? after : "";
    if (!unit && !v.includes(".") && Number(v) < 10) continue;
    nums.push({ v, unit });
  }
  const names = uniq([...String(text).matchAll(/(?<![A-Za-z])[A-Z][A-Za-z0-9&-]{2,}/g)].map((m) => m[0].toLowerCase()));
  const quoted = uniq([...String(text).matchAll(/[「“《]([^」”》]{2,20})[」”》]/g)].map((m) => norm(m[1])));
  const seen = new Set();
  return { nums: nums.filter((n) => { const k = n.v + n.unit; if (seen.has(k)) return false; seen.add(k); return true; }), names, quoted };
}

/** 一个数字在材料里可能的写法（含单位换算）。 */
function numForms(n) {
  const x = Number(n.v);
  // 原样写法要连单位一起对上（2300亿 不能靠「2300家」对上）；% 也可写作 percent
  const out = [n.unit === "%" ? { v: n.v, tail: "\\s*(?:%|percent|个百分点)" } : n.unit ? { v: n.v, tail: "\\s*" + n.unit } : { v: n.v }];
  if (n.unit === "亿") out.push({ v: fmt(x / 10), word: "billion" }, { v: fmt(x * 100), word: "million" }, { v: fmt(x * 1e8) });
  if (n.unit === "万") out.push({ v: fmt(x * 10), word: "thousand" }, { v: fmt(x / 100), word: "million" }, { v: fmt(x * 1e4) });
  return out;
}

function hasNumber(src, n) {
  for (const f of numForms(n)) {
    const re = new RegExp("(?<![\\d.])" + f.v.replace(".", "\\.") + "(?![\\d]|\\.\\d)" + (f.tail || "") + (f.word ? "\\s*(?:" + f.word + "|" + f.word[0] + "\\b)" : ""), "i");
    if (re.test(src)) return true;
  }
  return false;
}

/**
 * 核对一句话。@param sources 材料文本数组（已拼好标题、摘要、正文节选）
 * @returns { ok, missing: [原文片段], hits: Set(材料下标) }
 */
export function checkText(text, sources) {
  const c = claims(text);
  const srcs = sources.map(norm);
  const missing = [];
  const hits = new Set();
  const find = (pred) => { let any = false; srcs.forEach((s, i) => { if (pred(s)) { hits.add(i); any = true; } }); return any; };
  for (const n of c.nums) if (!find((s) => hasNumber(s, n))) missing.push(n.v + n.unit);
  for (const w of c.names) if (!find((s) => s.includes(w))) missing.push(w);
  for (const q of c.quoted) if (!find((s) => s.includes(q))) missing.push(q);
  return { ok: missing.length === 0, missing, hits, claims: c.nums.length + c.names.length + c.quoted.length };
}

/**
 * 核对一篇稿并整理出处：要点与各方说法核对不过的丢弃；导语保留但标出缺失；
 * 出处标在了不含该成分的材料上时改到含它的材料；没有可核对成分的保留模型标的出处。
 * @param copy { lead, lead_refs, points: [string|{text, refs}], views: [{who, says, refs}], impact }
 * @param sources 材料文本数组；refs 为材料下标（0 起）
 * @returns { copy（新结构）, check: { checked, passed, dropped, flagged, missing } }
 */
export function verifyCopy(copy, sources) {
  const n = sources.length;
  const okRefs = (r) => uniq((Array.isArray(r) ? r : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < n));
  const stat = { checked: 0, passed: 0, dropped: 0, flagged: 0, missing: [] };
  const judge = (text, refs) => {
    const r = checkText(text, sources);
    if (r.claims) { stat.checked++; if (r.ok) stat.passed++; }
    const refsOut = r.claims && r.hits.size ? [...r.hits].sort((a, b) => a - b).slice(0, 3) : okRefs(refs);
    return { r, refs: refsOut };
  };
  const out = { lead: copy.lead || "", lead_refs: [], points: [], views: [], impact: "" };
  if (out.lead) {
    const j = judge(out.lead, copy.lead_refs);
    out.lead_refs = j.refs;
    if (!j.r.ok) { out.lead_missing = j.r.missing; stat.flagged++; stat.missing.push(...j.r.missing); }
  }
  for (const p of copy.points || []) {
    const text = typeof p === "string" ? p : p && p.text;
    if (!text) continue;
    const j = judge(text, p && p.refs);
    if (!j.r.ok) { stat.dropped++; stat.missing.push(...j.r.missing); continue; }
    out.points.push({ text, refs: j.refs });
  }
  for (const v of copy.views || []) {
    if (!v || !v.who || !v.says) continue;
    const j = judge(v.says, v.refs);
    if (!j.r.ok) { stat.dropped++; stat.missing.push(...j.r.missing); continue; }
    out.views.push({ who: v.who, says: v.says, refs: j.refs });
  }
  if (copy.impact) {
    const j = judge(copy.impact, []);
    if (j.r.ok) out.impact = copy.impact; else { stat.dropped++; stat.missing.push(...j.r.missing); }
  }
  stat.missing = uniq(stat.missing).slice(0, 8);
  return { copy: out, check: stat };
}
