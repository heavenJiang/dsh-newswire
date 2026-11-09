/**
 * 分类体系：读 taxonomy.json，给条目打标签（多标签）、地区、实体（跨语言匹配用）、数字（交叉验证与分歧判断用）。
 *
 * 匹配规则：中文关键词按子串；英文关键词按整词、不区分大小写；全大写且 ≤4 个字符的缩写（AI、EV、UN、CPI…）区分大小写。
 * 打分：标题命中 2 分、摘要命中 1 分；≥2 分贴标签，置信度 = min(1, 分/4)。没有任何规则标签时用源所属分类的默认标签（置信度 0.3）。
 */
import fs from "node:fs";

function compileKeyword(kw) {
  const k = String(kw).trim();
  if (!k) return null;
  if (/^[\x20-\x7e]+$/.test(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const acronym = /^[A-Z0-9-]{1,4}$/.test(k);
    // 较长的英文词允许常见词尾（attack → attacks / attacked）
    const tail = !acronym && /[a-z]$/i.test(k) && k.length >= 4 ? "(?:s|es|ed|ing)?" : "";
    const re = new RegExp("(?<![A-Za-z0-9])" + esc + tail + "(?![A-Za-z0-9])", acronym ? "" : "i");
    return (text) => re.test(text);
  }
  return (text) => text.includes(k);
}

function compileList(list) { return (list || []).map(compileKeyword).filter(Boolean); }
const anyHit = (fns, text) => fns.some((f) => f(text));
const countHits = (fns, text) => fns.reduce((n, f) => n + (f(text) ? 1 : 0), 0);

export function loadTaxonomy(file) {
  return compileTaxonomy(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function compileTaxonomy(doc) {
  const leaves = [];
  const names = {};
  for (const top of doc.labels || []) {
    names[top.id] = top.name;
    for (const c of top.children || []) {
      names[c.id] = c.name;
      leaves.push({ id: c.id, parent: top.id, kw: compileList(c.keywords), patterns: (c.patterns || []).map((p) => new RegExp(p, "i")), exclude: compileList(c.exclude) });
    }
  }
  const regions = Object.entries(doc.regions || {}).map(([code, kws]) => ({ code, kw: compileList(kws) }));
  const entities = Object.entries(doc.entities || {}).filter(([id]) => !id.startsWith("_")).map(([id, e]) => ({ id, weak: Boolean(e.weak), kw: compileList(e.aliases) }));
  return {
    rulesVersion: doc.rules_version || "0",
    names,
    leaves,
    regions,
    entities,
    categoryDefaults: doc.category_defaults || {},
    watch: compileList(doc.watch),
    watchWords: doc.watch || [],
    mute: compileList(doc.mute),
    doc,
  };
}

/**
 * @param a { title, summary, category, region }（region 为源的地区码）
 * @returns { labels: [{ label, confidence, origin }], regions: [code], entities: [id], strong: [id], watch: [word], muted }
 */
export function classify(tax, a) {
  const title = String(a.title || "");
  const body = String(a.summary || "").slice(0, 600);
  const labels = [];
  for (const leaf of tax.leaves) {
    const both = title + " " + body;
    if (leaf.exclude.length && anyHit(leaf.exclude, both)) continue;
    let score = 2 * countHits(leaf.kw, title) + countHits(leaf.kw, body);
    for (const re of leaf.patterns) { if (re.test(title)) score += 2; else if (re.test(body)) score += 1; }
    if (score >= 2) labels.push({ label: leaf.id, confidence: Math.min(1, score / 4), origin: "rule" });
  }
  if (!labels.length && a.category && tax.categoryDefaults[a.category]) labels.push({ label: tax.categoryDefaults[a.category], confidence: 0.3, origin: "source" });
  const text = title + " " + body;
  const regions = tax.regions.filter((r) => anyHit(r.kw, text)).map((r) => r.code);
  if (!regions.length && a.region && /^[A-Z]{2,5}$/.test(a.region) && a.region !== "INTL") regions.push(a.region);
  const ents = tax.entities.filter((e) => anyHit(e.kw, title));
  return {
    labels: labels.sort((x, y) => y.confidence - x.confidence),
    regions,
    entities: ents.map((e) => e.id),
    strong: ents.filter((e) => !e.weak).map((e) => e.id),
    watch: tax.watchWords.filter((w, i) => tax.watch[i](text)),
    muted: anyHit(tax.mute, title),
  };
}

const MAG = { "万亿": 1e12, "亿": 1e8, "万": 1e4, "千": 1e3, trillion: 1e12, billion: 1e9, bn: 1e9, million: 1e6, mn: 1e6, m: 1e6, k: 1e3 };

function canon(v) { return Number(Number(v).toPrecision(3)); }

/**
 * 标题里的数字记号（跨中英文可比）：
 *   m:<值>  金额（换算到「个」：34亿美元 → 3.4e9；$3.4 billion → 3.4e9）
 *   p:<值>  百分比 / 百分点
 *   n:<值>  人数（死亡、受伤、被捕……）
 */
export function numberTokens(title) {
  const t = String(title || "").replace(/,(?=\d{3})/g, "");
  const out = new Set();
  let m;
  const money = /(\d+(?:\.\d+)?)\s*(万亿|亿|万|千)?\s*(?:美元|元|人民币|欧元|日元|港元|英镑|澳元)/g;
  while ((m = money.exec(t))) out.add("m:" + canon(Number(m[1]) * (MAG[m[2]] || 1)));
  const moneyEn = /(?:US)?\$\s?(\d+(?:\.\d+)?)\s*(trillion|billion|million|bn|mn|m|k)?\b/gi;
  while ((m = moneyEn.exec(t))) out.add("m:" + canon(Number(m[1]) * (MAG[(m[2] || "").toLowerCase()] || 1)));
  const pct = /(\d+(?:\.\d+)?)\s*(%|％|个百分点|percent|percentage points?)/gi;
  while ((m = pct.exec(t))) out.add("p:" + canon(m[1]));
  const people = /(\d+)\s*(?:人|名)(?:死亡|遇难|丧生|受伤|被捕)?|(\d+)\s+(?:people|killed|dead|injured|wounded)/gi;
  while ((m = people.exec(t))) { const v = m[1] || m[2]; if (Number(v) > 0 && Number(v) < 1e6) out.add("n:" + canon(v)); }
  return Array.from(out);
}

/**
 * 「数字 + 计数单位」（件、家、台、亿元…）：两条标题对同一单位给出不同的数，多半是两件不同的事
 * （「澎湃新闻22件作品获奖」vs「第一财经15件作品获奖」）。人数与百分比不在此列——同一事件各家说法不一正是「存在分歧」。
 * @returns Map 单位 → Set(数值)
 */
export function unitCounts(title) {
  const out = new Map();
  const re = /(\d+(?:\.\d+)?)\s*(万亿|亿|万)?\s*(件|家|台|条|艘|架|枚|项|款|辆|吨|只|座|所|元|美元|港元|欧元)/g;
  let m;
  const t = String(title || "").replace(/,(?=\d{3})/g, "");
  while ((m = re.exec(t))) {
    const unit = (m[2] || "") + m[3];
    if (!out.has(unit)) out.set(unit, new Set());
    out.get(unit).add(Number(m[1]));
  }
  return out;
}

/** 两个标题在某个计数单位上数字完全不交叠 → 矛盾。 */
export function countsConflict(a, b) {
  for (const [u, va] of a) {
    const vb = b.get(u);
    if (!vb) continue;
    let common = false;
    for (const v of va) if (vb.has(v)) { common = true; break; }
    if (!common) return true;
  }
  return false;
}

