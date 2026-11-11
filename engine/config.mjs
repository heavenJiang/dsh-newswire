/**
 * 数据源配置的读取与版本升级。种子在 engine/config/sources.json，运行副本在 dataDir/sources.json。
 * v1 → v2：补齐种子里新增的源与字段（region/weight/tier/group/pack/adapter）、去掉已移除的 exa 通道、更新默认通道链。
 * v2 → v3：补齐断点衔接相关字段（continuity / paging / backfill）。
 * v3 → v4：补齐推送规则 push（按主题包）。
 * v4 → v5：补齐正文抓取方式 body（fetch / list / none）。
 * v5 → v6：留学主题包（新源、packs 增加名称与默认推送时间、push.study_abroad）；packs 与 push 按键合并，用户已有的值优先。
 * v6 → v7：海外技术源（Hacker News、技术博客）。只加种子里标了 added_in: 7 的源，而且一律关闭，在面板里自己打开；
 *          种子里其他用户没有的源（比如以前没加的试用频道）不再借升级加进来。
 * 用户自己改过的值一律保留（种子只填缺失字段）。
 */
import fs from "node:fs";

export const CONFIG_VERSION = 7;
const SEED_FIELDS = ["region", "weight", "tier", "group", "pack", "adapter", "lang", "wait_for", "continuity", "paging", "backfill", "timeout_ms", "body", "profile"];
const KNOWN_CHANNELS = new Set(["browse", "agent_reach", "http", "jina"]);

export function upgradeConfig(doc, seed) {
  const version = Number(doc && doc.version) || 1;
  if (version >= CONFIG_VERSION || !seed) return { doc, changed: false, added: [] };
  const seedById = new Map((seed.sources || []).map((s) => [s.id, s]));
  const have = new Set();
  const sources = (doc.sources || []).map((s) => {
    have.add(s.id);
    const sd = seedById.get(s.id) || {};
    const out = Object.assign({}, s);
    for (const k of SEED_FIELDS) if (out[k] === undefined && sd[k] !== undefined) out[k] = sd[k];
    if (sd.json && sd.json.signals && out.json && !out.json.signals) out.json = Object.assign({}, out.json, { signals: sd.json.signals });
    if (Array.isArray(out.channels)) out.channels = out.channels.filter((c) => KNOWN_CHANNELS.has(c));
    if (!out.pack) out.pack = "core";
    return out;
  });
  const added = [];
  for (const s of seed.sources || []) {
    if (have.has(s.id)) continue;
    const since = Number(s.added_in) || 0;
    // v6 以前的升级照旧补齐种子里的源；之后只补本次升级新增的源，并且先关着
    if (version < 6 && since <= 6) { sources.push(s); added.push(s.id); }
    else if (since > version && since <= CONFIG_VERSION) { sources.push(Object.assign({}, s, { enabled: false })); added.push(s.id); }
  }
  const categories = Array.from(new Set([].concat(doc.categories || [], seed.categories || [])));
  const defaults = Object.assign({}, doc.defaults || {}, { channels: (seed.defaults && seed.defaults.channels) || ["browse", "agent_reach", "http"] });
  return { doc: Object.assign({}, doc, { version: CONFIG_VERSION, defaults, packs: mergeByKey(seed.packs, doc.packs), push: mergeByKey(seed.push, doc.push), categories, sources }), changed: true, added };
}

/** 按键合并两层对象：种子提供缺失的键与字段，用户已有的值不动。 */
function mergeByKey(seed, mine) {
  const out = {};
  for (const k of new Set([...Object.keys(seed || {}), ...Object.keys(mine || {})])) {
    const a = (seed || {})[k], b = (mine || {})[k];
    out[k] = a && b && typeof a === "object" && typeof b === "object" ? Object.assign({}, a, b) : b !== undefined ? b : a;
  }
  return out;
}

/**
 * 分类体系升级：种子的 version 更高时，把种子新增的节点、关键词、地区词、实体别名、关注 / 屏蔽词、源分类默认标签并进用户文件；
 * 用户自己加的保留，删掉的种子关键词会被加回（关键词只增不减）。
 */
export function upgradeTaxonomy(doc, seed) {
  if (!seed || (Number(doc.version) || 1) >= (Number(seed.version) || 1)) return { doc, changed: false };
  const out = JSON.parse(JSON.stringify(doc));
  const tops = new Map((out.labels || []).map((t) => [t.id, t]));
  for (const st of seed.labels || []) {
    const mt = tops.get(st.id);
    if (!mt) { (out.labels = out.labels || []).push(st); continue; }
    const kids = new Map((mt.children || []).map((c) => [c.id, c]));
    for (const sc of st.children || []) {
      const mc = kids.get(sc.id);
      if (!mc) { (mt.children = mt.children || []).push(sc); continue; }
      mc.keywords = Array.from(new Set([].concat(mc.keywords || [], sc.keywords || [])));
    }
  }
  for (const [code, words] of Object.entries(seed.regions || {})) out.regions = Object.assign({}, out.regions, { [code]: Array.from(new Set([].concat((out.regions || {})[code] || [], words))) });
  for (const [id, e] of Object.entries(seed.entities || {})) if (!(out.entities || {})[id]) out.entities = Object.assign({}, out.entities, { [id]: e });
  out.category_defaults = Object.assign({}, seed.category_defaults, out.category_defaults);
  out.watch = Array.from(new Set([].concat(out.watch || [], seed.watch || [])));
  out.mute = Array.from(new Set([].concat(out.mute || [], seed.mute || [])));
  // v3：广告改由 noise 规则按特征识别；「广告」「推广」两个标题词会误伤正常新闻（如「AI+广告平台」），从 mute 里拿掉
  if ((Number(doc.version) || 1) < 3) out.mute = out.mute.filter((w) => w !== "广告" && w !== "推广");
  // 内置规则（id 与种子相同）随种子更新；用户自己加的规则不动
  const seedById = new Map((seed.noise || []).map((r) => [r.id, r]));
  const have = new Set((out.noise || []).map((r) => r.id));
  out.noise = (out.noise || []).map((r) => seedById.get(r.id) || r).concat((seed.noise || []).filter((r) => !have.has(r.id)));
  out.version = seed.version;
  out.rules_version = seed.rules_version;
  return { doc: out, changed: true };
}

/** 读数据目录的 taxonomy.json；种子更新时合并并写回（旧文件留 .v<N>.bak）。 */
export function loadTaxonomyFile(file, seedPath) {
  const doc = readJson(file);
  if (!seedPath || !fs.existsSync(seedPath) || seedPath === file) return doc;
  const up = upgradeTaxonomy(doc, readJson(seedPath));
  if (up.changed) {
    fs.copyFileSync(file, file + ".v" + (Number(doc.version) || 1) + ".bak");
    fs.writeFileSync(file, JSON.stringify(up.doc, null, 2) + "\n");
  }
  return up.doc;
}

export function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

/** 读运行副本；版本落后则升级并写回（旧文件留 .v<N>.bak）。 */
export function loadConfig(cfgPath, seedPath) {
  const doc = readJson(cfgPath);
  if (!seedPath || !fs.existsSync(seedPath) || seedPath === cfgPath) return doc;
  const up = upgradeConfig(doc, readJson(seedPath));
  if (up.changed) {
    fs.copyFileSync(cfgPath, cfgPath + ".v" + (Number(doc.version) || 1) + ".bak");
    fs.writeFileSync(cfgPath, JSON.stringify(up.doc, null, 2) + "\n");
  }
  return up.doc;
}
