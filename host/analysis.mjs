/**
 * 影响与走势：重要新闻的潜在影响与可能的演变，由模型推演，用户据此决定是否关注后续。
 *
 * 只给模型这条故事线自己的报道（标题与正文）；具体数字只能来自材料，每条再核对数字与外文专名，编出来的整条丢掉。
 * 这是推演，不是事实，也不构成投资建议——面板与消息都这样标明。
 * 存 story_analyses（每次分析一行）；故事线有了新报道才值得重新分析。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { builtinProfiles, promptOf } from "./profiles.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const AREAS = ["市场", "公司", "行业", "科技", "政策", "地缘", "民生", "能源", "金融"];
const DIRS = ["利好", "利空", "不确定"];
const LEVELS = ["高", "中", "低"];

/**
 * 这条故事线的分析侧重：读法的 analysis.md（调用方按读法给出 hint）；
 * 旧写法只给 focus（重点领域名称）时，用内置重点领域读法的侧重。
 */
function hintOf(story) {
  if (typeof story.hint === "string") return story.hint;
  if (!story.focus) return "";
  const p = builtinProfiles().list.find((x) => x.focus);
  return p ? promptOf(Object.assign({}, p, { name: story.focus }), "analysis") : "";
}

export function analysisPrompt(story, mats) {
  return "任务：分析一件正在发生的新闻的潜在影响和可能的演变。依据材料与常识推演；具体数字只能用材料里出现过的，不要编造数字；没有把握的写「不确定」或「低」。" +
    (hintOf(story) ? "\n" + hintOf(story) : "") +
    "\n- summary：一句话说这件事意味着什么（不超过60字）" +
    "\n- impacts：最多 4 条，谁会受影响。area 取 " + AREAS.join("/") + "；target 写受影响的对象（公司、资产、行业或地区）；ticker 若是上市公司写股票代码（不确定就留空）；direction 取 " + DIRS.join("/") + "；why 写传导逻辑（不超过60字）；confidence 取 " + LEVELS.join("/") +
    "\n- scenarios：2 到 3 种可能的走向。name 如 基准/升级/缓和；likelihood 取 " + LEVELS.join("/") + "；what 写会怎样发展（不超过60字）；signals 写看到什么说明正往这个方向走（不超过40字）" +
    "\n- watch：接下来值得留意的 1 到 3 个节点或数据（每条不超过30字）" +
    "\n- horizon：影响主要在 短期（几天）/中期（几周）/长期（几个月以上）" +
    '\n只输出一个 JSON 对象：{"summary":"","impacts":[{"area":"","target":"","ticker":"","direction":"","why":"","confidence":""}],"scenarios":[{"name":"","likelihood":"","what":"","signals":""}],"watch":[""],"horizon":""}' +
    "\n\n新闻：" + story.title + (story.lead ? "\n导语：" + story.lead : "") +
    (mats.some((m) => m.web) ? "\n来源标「网页搜索」的是搜索结果摘要，只用来了解背景和前因，不是这件事的报道，不要把它说的当成这件事的事实。" : "") +
    "\n\n报道材料（编号｜来源｜时间｜标题｜内容）：\n" + mats.map((m, i) => "[" + (i + 1) + "] " + m.source + "｜" + String(m.t || "").slice(0, 16) + "｜" + m.title + "｜" + clip(m.text, 600)).join("\n");
}

/** 网页搜索结果 → 分析材料（标明是搜索结果，不是这件事的报道）。 */
export function webMaterials(results, max) {
  return (results || []).slice(0, max || 4).filter((r) => r && r.title && r.url).map((r) => ({ id: "w:" + r.url, title: r.title, source: "网页搜索·" + (r.site || ""), t: "", url: r.url, text: r.snippet || r.title, web: true }));
}

/** 搜索词：故事线标题去掉标点，太短的不搜。 */
export function searchQuery(title) {
  const q = String(title || "").replace(/[「」“”"'《》【】（）()：:，,。！？!?]/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= 4 ? q.slice(0, 60) : "";
}

/** 一条故事线的分析材料：最新的几篇报道，正文优先。 */
export function analysisMaterials(db, storyId, bodiesFor) {
  const items = db.prepare(`SELECT a.id, a.title, a.title_zh, a.summary, a.url, a.published_at, a.first_seen_at, s.name AS source_name, a.source_id, a.origin_site, a.origin_text
    FROM story_items i JOIN articles a ON a.id = i.article_id LEFT JOIN sources s ON s.id = a.source_id
    WHERE i.story_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at) DESC LIMIT 8`).all(storyId);
  const bodies = bodiesFor ? bodiesFor(db, items.map((x) => x.id)) : new Map();
  return items.map((it) => ({ id: it.id, title: it.title_zh || it.title, source: it.source_name || it.source_id, t: it.published_at || it.first_seen_at, url: it.url, text: (bodies.get(it.id) || it.summary || it.title) + (it.origin_text ? " 【原文（" + (it.origin_site || "") + "）】" + String(it.origin_text).slice(0, 3000) : "") }));
}

/** 跑一次分析并核对。@returns 分析内容（已核对），或抛错 */
export async function analyzeStory(model, story, mats, o) {
  if (!mats.length) throw new Error("no_materials");
  const j = parseJsonLoose(await model.complete(analysisPrompt(story, mats), { step: "analyze", maxTokens: 8000, timeoutMs: (o && o.timeoutMs) || 240000 }));
  if (!j) throw new Error("bad_json");
  const src = mats.map((m) => m.title + "｜" + m.text).concat([story.title, story.lead || ""]);
  let dropped = 0;
  const ok = (text) => { if (!text) return false; if (checkText(text, src).ok) return true; dropped++; return false; };
  const out = {
    v: 1,
    summary: ok(str(j.summary, 80)) ? str(j.summary, 80) : "",
    impacts: (Array.isArray(j.impacts) ? j.impacts : []).slice(0, 4).map((x) => ({
      area: AREAS.includes(x && x.area) ? x.area : "市场", target: str(x && x.target, 30), ticker: /^[A-Z0-9.]{1,10}$/.test(String((x && x.ticker) || "").trim()) ? String(x.ticker).trim() : "",
      direction: DIRS.includes(x && x.direction) ? x.direction : "不确定", why: str(x && x.why, 80), confidence: LEVELS.includes(x && x.confidence) ? x.confidence : "低",
    })).filter((x) => x.target && x.why && ok(x.target + "：" + x.why)),
    scenarios: (Array.isArray(j.scenarios) ? j.scenarios : []).slice(0, 3).map((x) => ({
      name: str(x && x.name, 10) || "可能", likelihood: LEVELS.includes(x && x.likelihood) ? x.likelihood : "低", what: str(x && x.what, 80), signals: str(x && x.signals, 60),
    })).filter((x) => x.what && ok(x.what + "。" + x.signals)),
    watch: (Array.isArray(j.watch) ? j.watch : []).slice(0, 3).map((x) => str(x, 40)).filter((x) => ok(x)),
    horizon: /长期/.test(String(j.horizon || "")) ? "长期" : /中期/.test(String(j.horizon || "")) ? "中期" : "短期",
    materials: mats.map((m) => ({ id: m.id, title: m.title, source: m.source, t: m.t, url: m.url })),
    dropped,
  };
  if (!out.summary && !out.impacts.length && !out.scenarios.length) throw new Error("nothing_verified");
  return out;
}

export function saveAnalysis(db, storyId, a, meta) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const n = db.prepare("SELECT COUNT(*) n FROM story_items WHERE story_id = ?").get(storyId).n;
  db.prepare("INSERT INTO story_analyses (story_id, created_at, model, items, content, auto) VALUES (?,?,?,?,?,?)").run(storyId, now, meta.model || null, n, JSON.stringify(a), meta.auto ? 1 : 0);
  return Object.assign({ created_at: now, model: meta.model || null, items: n }, a);
}

/** 最新一次分析，以及它之后故事线又多了几篇（多了就提示可以重新分析）。 */
export function latestAnalysis(db, storyId) {
  const r = db.prepare("SELECT * FROM story_analyses WHERE story_id = ? ORDER BY id DESC LIMIT 1").get(storyId);
  if (!r) return null;
  const n = db.prepare("SELECT COUNT(*) n FROM story_items WHERE story_id = ?").get(storyId).n;
  return Object.assign({ created_at: r.created_at, model: r.model, items: r.items, newer: Math.max(0, n - r.items), auto: Boolean(r.auto) }, parseJ(r.content, {}));
}

/** 一批故事线各自最新分析的摘要（版面上用）。 */
export function analysisBrief(db, ids) {
  if (!ids.length) return {};
  const out = {};
  for (const r of db.prepare("SELECT story_id, content, created_at FROM story_analyses WHERE id IN (SELECT MAX(id) FROM story_analyses WHERE story_id IN (" + ids.map(() => "?").join(",") + ") GROUP BY story_id)").all(...ids)) {
    const c = parseJ(r.content, {});
    out[r.story_id] = { summary: c.summary || "", impacts: (c.impacts || []).slice(0, 4), horizon: c.horizon, created_at: r.created_at };
  }
  return out;
}

/** 版面出来后自动分析哪几篇：头版里重要度 ≥ 门槛、还没分析过或分析后又有新报道的，最多 n 篇。 */
export function autoAnalyzeTargets(db, ed, o) {
  const min = (o && o.min) ?? 70;
  const max = (o && o.max) ?? 2;
  const st = (ed && ed.stories) || {};
  // 重点领域（AI 与新技术）的报道门槛低 10 分并排在前面，新技术的影响优先分析
  const focal = (id) => Boolean(o && o.isFocus && o.isFocus(st[id]));
  const ids = [...(ed.front || [])].concat(...(ed.sections || []).map((s) => s.stories))
    .filter((id, i, a) => a.indexOf(id) === i && st[id] && st[id].importance >= (focal(id) ? min - 10 : min))
    .sort((a, b) => Number(focal(b)) - Number(focal(a)));
  const out = [];
  for (const id of ids) {
    const a = latestAnalysis(db, id);
    if (a && a.newer < 2) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}
