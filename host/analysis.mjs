/**
 * 影响与走势：重要新闻的潜在影响与可能的演变，由模型推演，用户据此决定是否关注后续。
 *
 * 只给模型这条故事线自己的报道（标题与正文）。读者要的是有深度的判断：不停在表面的直接后果，往下推两三层，
 * 重点讲对产业链和对中国的影响，点名具体公司（含股票代码）和产品、说清利好还是利空——公司、产品、产业链知识可以用模型自己的，
 * 不限于材料里出现的；只有具体数字必须来自材料，每条核对数字，编出来的整条丢掉（外文专名不再要求出现在材料里）。
 * 这是推演，不是事实，也不构成投资建议——面板与消息都这样标明。
 * 存 story_analyses（每次分析一行）；故事线有了新报道才值得重新分析。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { builtinProfiles, promptOf } from "./profiles.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const AREAS = ["公司", "产业链", "中国", "市场", "行业", "科技", "政策", "地缘", "民生", "能源", "金融"];
const MARKETS = ["A股", "港股", "美股", "其他"];
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
  return "任务：你是资深的产业与市场分析师，深入分析这条新闻的影响和可能的演变，写给关心产业和投资的中国读者。" +
    "\n要求：" +
    "\n1. 不要停在新闻表面的直接后果（比如「这条路线断了」「某公司受影响」），要往下推两三层：它会迫使谁改变做法、资金和订单会流向哪里、产业格局会不会因此重塑、长期会催生或淘汰什么。" +
    "\n2. 重点讲两件事：对产业的影响（按这条新闻所在的产业，分到产业链的具体环节，如设计、制造、设备、材料、封测、算力、云、终端、应用）；对中国的影响（中国企业、国产替代、国内产能与产业布局、政策可能的应对、中国市场与消费者）。" +
    "\n3. 点名具体的公司和产品：A股、港股、美股都可以，写股票代码；说清是利好还是利空、通过什么传导、影响的是哪项产品或业务。可以用你掌握的行业知识和公司情况，不限于材料里出现的公司。" +
    "\n4. 直接给出你的判断，不要因为话题敏感、涉及政策或怕说错而回避、含糊其辞、只写「不确定」；有分歧的就写清两种可能和各自成立的条件，把握程度用 confidence 标。" +
    "\n5. 具体数字（金额、比例、股价、产量）只能用材料里出现过的，不要编造数字；没有数字就用定性的说法。" +
    (hintOf(story) ? "\n" + hintOf(story) : "") +
    "\n\n输出字段：" +
    "\n- summary：核心判断，这件事真正意味着什么（不超过100字）" +
    "\n- deep：深层影响 2 到 4 条，每条 {title: 一句话结论（不超过20字）, text: 推演过程（不超过160字）}，写表面之下的二阶、三阶影响" +
    "\n- china：对中国的影响（不超过220字），讲产业、企业、国产替代、政策应对；和中国关系不大就写清楚为什么、可以短" +
    "\n- impacts：受影响的公司、产业链环节和市场，4 到 10 条，最重要的在前。area 取 " + AREAS.join("/") + "；target 写公司名、产业链环节或资产；ticker 只在 target 是一家上市公司时写它的股票代码（如 688981、0981.HK、NVDA），产业链环节、行业、资产留空——环节里的代表公司另列一条公司；market 取 " + MARKETS.join("/") + "（不是上市公司留空）；product 写受影响的产品或业务（没有就留空）；direction 取 " + DIRS.join("/") + "；why 写传导逻辑（不超过100字）；confidence 取 " + LEVELS.join("/") +
    "\n- scenarios：2 到 3 种可能的走向。name 如 基准/升级/缓和；likelihood 取 " + LEVELS.join("/") + "；what 写会怎样发展（不超过80字）；signals 写看到什么说明正往这个方向走（不超过40字）" +
    "\n- watch：接下来值得留意的 1 到 3 个节点或数据（每条不超过30字）" +
    "\n- horizon：影响主要在 短期（几天）/中期（几周）/长期（几个月以上）" +
    '\n只输出一个 JSON 对象：{"summary":"","deep":[{"title":"","text":""}],"china":"","impacts":[{"area":"","target":"","ticker":"","market":"","product":"","direction":"","why":"","confidence":""}],"scenarios":[{"name":"","likelihood":"","what":"","signals":""}],"watch":[""],"horizon":""}' +
    "\n\n新闻：" + story.title + (story.lead ? "\n导语：" + story.lead : "") +
    (mats.some((m) => m.web) ? "\n来源标「网页搜索」的是搜索结果摘要，只用来了解背景和前因，不是这件事的报道，不要把它说的当成这件事的事实。" : "") +
    "\n\n报道材料（编号｜来源｜时间｜标题｜内容）：\n" + mats.map((m, i) => "[" + (i + 1) + "] " + m.source + "｜" + String(m.t || "").slice(0, 16) + "｜" + m.title + "｜" + clip(m.text, m.web ? 600 : 1500)).join("\n");
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
  const j = parseJsonLoose(await model.complete(analysisPrompt(story, mats), { step: "analyze", maxTokens: 12000, timeoutMs: (o && o.timeoutMs) || 300000 }));
  if (!j) throw new Error("bad_json");
  const src = mats.map((m) => m.title + "｜" + m.text).concat([story.title, story.lead || ""]);
  let dropped = 0;
  // 只核对数字：公司、产品、外文专名可以来自模型的行业知识；数字（金额、比例、股价）必须在材料里
  const ok = (text) => { if (!text) return false; const r = checkText(text, src); if (r.ok || !r.missing.some((x) => /\d/.test(x))) return true; dropped++; return false; };
  const out = {
    v: 2,
    summary: ok(str(j.summary, 120)) ? str(j.summary, 120) : "",
    deep: (Array.isArray(j.deep) ? j.deep : []).slice(0, 4).map((x) => ({ title: str(x && x.title, 30), text: str(x && x.text, 200) })).filter((x) => x.text && ok(x.title + "：" + x.text)),
    china: ok(str(j.china, 260)) ? str(j.china, 260) : "",
    impacts: (Array.isArray(j.impacts) ? j.impacts : []).slice(0, 10).map((x) => ({
      area: AREAS.includes(x && x.area) ? x.area : "市场", target: str(x && x.target, 30), ticker: ["产业链", "行业"].includes(x && x.area) ? "" : /^[A-Za-z0-9.]{1,12}$/.test(String((x && x.ticker) || "").trim()) ? String(x.ticker).trim().toUpperCase() : "",
      market: !["产业链", "行业"].includes(x && x.area) && MARKETS.includes(x && x.market) ? x.market : "", product: str(x && x.product, 30),
      direction: DIRS.includes(x && x.direction) ? x.direction : "不确定", why: str(x && x.why, 120), confidence: LEVELS.includes(x && x.confidence) ? x.confidence : "低",
    })).filter((x) => x.target && x.why && ok(x.target + "：" + x.why)),
    scenarios: (Array.isArray(j.scenarios) ? j.scenarios : []).slice(0, 3).map((x) => ({
      name: str(x && x.name, 10) || "可能", likelihood: LEVELS.includes(x && x.likelihood) ? x.likelihood : "低", what: str(x && x.what, 100), signals: str(x && x.signals, 60),
    })).filter((x) => x.what && ok(x.what + "。" + x.signals)),
    watch: (Array.isArray(j.watch) ? j.watch : []).slice(0, 3).map((x) => str(x, 40)).filter((x) => ok(x)),
    horizon: /长期/.test(String(j.horizon || "")) ? "长期" : /中期/.test(String(j.horizon || "")) ? "中期" : "短期",
    materials: mats.map((m) => ({ id: m.id, title: m.title, source: m.source, t: m.t, url: m.url })),
    dropped,
  };
  if (!out.summary && !out.impacts.length && !out.scenarios.length && !out.deep.length) throw new Error("nothing_verified");
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
    out[r.story_id] = { summary: c.summary || "", china: c.china || "", impacts: (c.impacts || []).slice(0, 4), horizon: c.horizon, created_at: r.created_at };
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
