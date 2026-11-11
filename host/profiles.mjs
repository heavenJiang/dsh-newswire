/**
 * 读法（profile）：不同类型的报道用不同的写法。参考 Horizon 的 profile，按我们的故事线模型改写：
 * 读法在「报道」层面决定（写稿的单位是故事线），不在单条新闻层面。
 *
 * 每个读法是 engine/config/profiles/<id>/ 下的一个目录：
 *   profile.json  id、名称、版本、优先级、匹配条件（match.labels 分类 / match.sources 源 id）、
 *                 focus（重点领域：挑材料加权、头版留位置……，只认第一个）、content（材料条数与截取方式）、
 *                 blocks（写哪几块，见 BLOCK_KINDS）、prompts（各环节的补充要求，Markdown 文件）
 *   *.md          rubric（归并时的评分要求）/ plan（统筹时的要求）/ write（写稿要求）/ analysis（影响分析的侧重）；
 *                 文字里的 {name} 换成读法名称
 *
 * 数据目录下的 profiles/<id>/ 覆盖内置的同名读法（整个目录替换），也可以新增读法；坏的目录跳过，退回内置。
 * 一篇报道用哪个读法：报道里每条新闻的源都声明了读法（sources.json 的 profile）→ 用声明的；
 * 否则看分类与源命中哪些读法的 match，取优先级最高的；都不命中用默认读法 wire。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_PROFILES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "engine", "config", "profiles");
export const DEFAULT_PROFILE = "wire";

const ID_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const LABEL_RE = /^[a-z_]+(\.[a-z_]+)?$/;
const PROMPT_KEYS = ["rubric", "plan", "write", "analysis"];
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const strs = (xs, re, max) => (Array.isArray(xs) ? xs.filter((x) => typeof x === "string" && re.test(x.trim())).map((x) => x.trim()).slice(0, max) : []);

/**
 * 输出块。lead / points / views / impact 是原有的四块；text 是读法自定义的一段文字，list 是自定义的几条短句。
 * materials：这一块能依据哪些材料——source 只认报道原文，community 也认社区评论，history 也认以前的报道（H 编号）。
 */
export const BLOCK_KINDS = ["lead", "points", "views", "impact", "text", "list"];
export const DEFAULT_BLOCKS = [
  { id: "lead", kind: "lead" },
  { id: "points", kind: "points" },
  { id: "views", kind: "views" },
  { id: "impact", kind: "impact" },
];

function normalizeBlocks(raw) {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_BLOCKS.map((b) => Object.assign({}, b));
  const out = [];
  const seen = new Set();
  for (const b of raw) {
    if (!b || typeof b !== "object") throw new Error("blocks 里每一项需为对象");
    const kind = BLOCK_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) throw new Error("block kind 只能是 " + BLOCK_KINDS.join("/"));
    const id = typeof b.id === "string" && ID_RE.test(b.id) ? b.id : ["lead", "points", "views", "impact"].includes(kind) ? kind : null;
    if (!id) throw new Error("自定义块需要 id（[a-z0-9_-]）");
    if (seen.has(id)) throw new Error("block id 重复：" + id);
    if (["lead", "points", "views", "impact"].includes(kind) && id !== kind) throw new Error(kind + " 块的 id 只能是 " + kind);
    seen.add(id);
    const blk = { id, kind };
    if (typeof b.name === "string" && b.name.trim()) blk.name = b.name.trim().slice(0, 12);
    if (typeof b.ask === "string" && b.ask.trim()) blk.ask = b.ask.trim().slice(0, 200);
    if (b.chars !== undefined) blk.chars = num(b.chars, 10, 400, 80);
    if (b.max !== undefined) blk.max = num(b.max, 1, 6, 3);
    if (b.optional === true) blk.optional = true;
    const mats = strs(b.materials, /^(source|community|history|web)$/, 4);
    blk.materials = mats.length ? mats : ["source"];
    if ((kind === "text" || kind === "list") && !blk.name) throw new Error("自定义块 " + id + " 需要 name（面板上的小标题）");
    out.push(blk);
  }
  if (!out.some((b) => b.kind === "lead")) throw new Error("blocks 必须有 lead（导语）");
  return out;
}

/** profile.json + 提示词 → 规范化的读法；不合格抛错。 */
export function normalizeProfile(json, readPrompt) {
  const j = json && typeof json === "object" ? json : {};
  if (typeof j.id !== "string" || !ID_RE.test(j.id)) throw new Error("id 需为小写字母开头的 2-40 位 [a-z0-9_-]");
  const m = j.match && typeof j.match === "object" ? j.match : {};
  const c = j.content && typeof j.content === "object" ? j.content : {};
  const f = j.focus && typeof j.focus === "object" ? j.focus : null;
  const prompts = {};
  const pj = j.prompts && typeof j.prompts === "object" ? j.prompts : {};
  for (const k of PROMPT_KEYS) {
    if (pj[k] === undefined || pj[k] === null || pj[k] === "") continue;
    if (typeof pj[k] !== "string") throw new Error("prompts." + k + " 需为文件名");
    prompts[k] = String(readPrompt ? readPrompt(pj[k]) : "").trim().slice(0, 4000);
  }
  return {
    id: j.id,
    name: typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 20) : j.id,
    version: num(j.version, 1, 1e6, 1),
    priority: num(j.priority, -100, 100, 0),
    match: { labels: strs(m.labels, LABEL_RE, 12), sources: strs(m.sources, /^[a-z0-9][a-z0-9_-]{1,39}$/, 40) },
    focus: f ? { boost: num(f.boost, 0, 50, 20) } : null,
    // 面板上标在报道标题前的小字（如「长文」「社区」），提醒读者这不是一般新闻；不写就不标
    badge: typeof j.badge === "string" && j.badge.trim() ? j.badge.trim().slice(0, 6) : "",
    content: {
      materials: num(c.materials, 2, 10, 6),
      body_chars: num(c.body_chars, 200, 6000, 900),
      summary_chars: num(c.summary_chars, 80, 1200, 240),
      sampling: c.sampling === "head-middle-tail" ? "head-middle-tail" : "prefix",
      comments: num(c.comments, 0, 3000, 0),
    },
    blocks: normalizeBlocks(j.blocks),
    prompts,
  };
}

/** 读一个读法目录；提示词路径不能跳出目录。 */
function readProfileDir(dir) {
  const json = JSON.parse(readFileSync(path.join(dir, "profile.json"), "utf8"));
  const root = path.resolve(dir);
  return normalizeProfile(json, (rel) => {
    const p = path.resolve(root, rel);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error("提示词路径跳出了读法目录：" + rel);
    return readFileSync(p, "utf8");
  });
}

function profileDirs(root) {
  if (!root || !existsSync(root)) return [];
  try { return readdirSync(root).sort().map((n) => path.join(root, n)).filter((d) => { try { return statSync(d).isDirectory() && existsSync(path.join(d, "profile.json")); } catch { return false; } }); } catch { return []; }
}

/**
 * 读法表。@param dirs 依次读取的目录（后面的覆盖前面的同名读法）
 * @returns { list（按优先级从高到低）, byId, def（默认读法）, errors }
 */
export function loadProfiles(dirs) {
  const byId = new Map();
  const errors = [];
  for (const root of (dirs || []).filter(Boolean)) {
    for (const d of profileDirs(root)) {
      try { const p = readProfileDir(d); byId.set(p.id, p); } catch (e) { errors.push(path.basename(d) + "：" + String((e && e.message) || e).slice(0, 160)); }
    }
  }
  if (!byId.has(DEFAULT_PROFILE)) byId.set(DEFAULT_PROFILE, normalizeProfile({ id: DEFAULT_PROFILE, name: "新闻" }));
  return registry([...byId.values()], errors);
}

function registry(profiles, errors) {
  const list = profiles.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const byId = new Map(list.map((p) => [p.id, p]));
  return { list, byId, def: byId.get(DEFAULT_PROFILE), errors: errors || [], get: (id) => byId.get(id) || byId.get(DEFAULT_PROFILE) };
}

let BUILTIN = null;
/** 内置读法（只读一次）。 */
export function builtinProfiles() {
  if (!BUILTIN) BUILTIN = loadProfiles([BUILTIN_PROFILES_DIR]);
  return BUILTIN;
}

/**
 * 版式里的 focus（旧写法）覆盖重点领域读法的名称、匹配分类与加权；focus.labels 为空即关闭重点领域。
 * 返回新的读法表（不改传入的）。
 */
export function withFocus(reg, focus) {
  if (!focus) return reg;
  const focal = reg.list.find((p) => p.focus);
  if (!focal) return reg;
  const p = Object.assign({}, focal, {
    name: focus.name || focal.name,
    match: Object.assign({}, focal.match, { labels: Array.isArray(focus.labels) ? focus.labels.slice() : focal.match.labels }),
    focus: Object.assign({}, focal.focus, focus.boost !== undefined ? { boost: focus.boost } : {}),
  });
  return registry(reg.list.map((x) => (x === focal ? p : x)), reg.errors);
}

/** 重点领域（旧的 layout.focus 形状）：第一个带 focus 的读法；没有就是关闭的。 */
export function focusOf(reg) {
  const p = reg && reg.list.find((x) => x.focus);
  if (!p) return { name: "", labels: [], boost: 0 };
  return { name: p.name, labels: p.match.labels.slice(), boost: p.focus.boost, profile: p.id };
}

const labelHit = (want, labels) => want.length > 0 && (labels || []).some((l) => want.some((f) => l === f || String(l).startsWith(f + ".")));

/**
 * 一篇报道用哪个读法。@param s { section, labels, sources: [源 id], declared: [各条新闻的源声明的读法，没声明的为 null] }
 */
export function profileFor(reg, s) {
  const r = reg || builtinProfiles();
  const declared = (s && s.declared) || [];
  if (declared.length && declared.every((x) => x && r.byId.has(x))) {
    const count = new Map();
    for (const x of declared) count.set(x, (count.get(x) || 0) + 1);
    return [...count.entries()].map(([id, n]) => ({ p: r.byId.get(id), n })).sort((a, b) => b.n - a.n || b.p.priority - a.p.priority)[0].p;
  }
  const labels = [s && s.section].concat((s && s.labels) || []).filter(Boolean);
  const sources = (s && s.sources) || [];
  for (const p of r.list) {
    if (p.id === DEFAULT_PROFILE) continue;
    if (labelHit(p.match.labels, labels) || (p.match.sources.length && sources.some((x) => p.match.sources.includes(x)))) return p;
  }
  return r.def;
}

/** 读法的某段补充要求（{name} 换成读法名称）；没有就是空字符串。 */
export function promptOf(p, key) {
  const t = p && p.prompts && p.prompts[key];
  return t ? t.replace(/\{name\}/g, p.name) : "";
}
