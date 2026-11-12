/**
 * 版面 · 模型编排：归并、统筹、写稿的提示词，和增量编排的全过程（llmEdition）。
 * 已归入故事线的新闻不再交给模型；只有新增了报道的故事线才重写；写不成的用程序拼的稿；模型稿逐句核对。
 */
import { bigrams, similarity } from "../engine/pipeline/select.mjs";
import { isDigestTitle, markKind } from "../engine/pipeline/quality.mjs";
import { createHash } from "node:crypto";
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { applyFollows, matchList } from "./follows.mjs";
import { historyText, relatedStories } from "./history.mjs";
import { DEFAULT_BLOCKS, DEFAULT_PROFILE, builtinProfiles, profileFor, promptOf, withFocus } from "./profiles.mjs";
import { assemble, assignments, bodiesFor, clip, copyFresh, originCount, copyOf, deferRewrite, feedbackState, finish, gatherItems, inFocus, isBriefWire, materialText, notTrialOnly, pickMaterials, profilesOf, programUpdate, richSpec, ruleCopy, scrubStory, sourceOnly, storyFacts, storyIdFor, storyProfile, storyRows, str, strip, sumChecks, taxonomyIndex, topOf, tz, verifyStory } from "./edition_base.mjs";

// ------------------------------------------------------------------ 模型：提示词
/**
 * 一批新闻的候选已有报道：按相关度（标题字二元组相似度、关键主体是否出现在标题里）取前 n 个，不足的用最重要的补。
 */
export function pickCandidates(groups, batch, n) {
  const bgs = batch.map((it) => bigrams(it.title_zh || it.title || ""));
  const titles = batch.map((it) => String(it.title_zh || "") + " " + String(it.title || ""));
  const scored = groups.map((g) => {
    const gb = bigrams(g.title || "");
    let best = 0;
    for (const b of bgs) { const s0 = similarity(gb, b); if (s0 > best) best = s0; }
    const ents = (g.entities || []).filter((e) => e && titles.some((t) => t.includes(e))).length;
    return { g, score: best + 0.25 * ents };
  });
  const rel = scored.filter((x) => x.score >= 0.12).sort((a, b) => b.score - a.score).slice(0, Math.ceil(n * 0.75)).map((x) => x.g);
  const rest = groups.filter((g) => !rel.includes(g)).sort((a, b) => b.importance - a.importance).slice(0, n - rel.length);
  return rel.concat(rest);
}

/** 提示词的固定部分放前面、材料放后面：生产环境的大模型对相同前缀有缓存，固定部分命中就省 token。 */
/** 重点领域的评分要求（归并时给模型）。 */
/** 文字取自重点领域读法的 rubric.md；reg 是读法表（不给用内置读法）。 */
export function focusRubric(focus, reg) {
  if (!focus || !(focus.labels || []).length) return "";
  const r = withFocus(reg || builtinProfiles(), focus);
  return promptOf(r.list.find((p) => p.focus), "rubric");
}

/**
 * 有评分要求（rubric.md）的其他读法：这一批里有它的源（源声明了它，或在它的 match.sources 里）才告诉模型
 * （重点领域读法已由 focusRubric 给出）。
 */
function otherRubrics(reg, items) {
  const has = (p) => (items || []).some((it) => it.src_profile === p.id || p.match.sources.includes(it.source_id));
  return (reg ? reg.list : []).filter((p) => !p.focus && p.id !== DEFAULT_PROFILE && promptOf(p, "rubric") && has(p)).map((p) => promptOf(p, "rubric"));
}

export function groupPrompt(items, tax, cands, adExamples, focus, reg) {
  const fr = focusRubric(focus, reg);
  const more = otherRubrics(reg, items);
  const lines = items.map((it) => "[" + it.n + "] " + (fr && it.focus ? "★" : "") + (it.source_name || it.source_id) + "｜" + tz(it.published_at || it.first_seen_at) + "｜" + clip(it.title, 100) + (it.summary ? "｜" + clip(it.summary, 90) : "") +
    (it._peers && it._peers.length ? "（同一事件另有 " + it._peers.length + " 篇：" + [...new Set(it._peers.map((x) => x.source_name || x.source_id))].slice(0, 4).join("、") + "）" : ""));
  const known = (cands || []).map((g, i) => "[S" + (i + 1) + "] " + g.section + "｜" + clip(g.title, 50));
  return "任务：把讲同一件事的新闻归为一篇报道（中英文报道同一件事也要归在一起）。不是新闻的条目——广告、营销推广、付费栏目的引流预告（隐去公司名、写「这家公司」并给出看好结论的荐股稿）、栏目导航——编号放进 noise，不要收进报道。新闻合集、要闻汇总、日程预告、行情数据都是新闻，不放进 noise。" +
    "新闻讲的是某篇已有报道（编号 S…）的同一件事（含后续进展）时，填 story 为那篇的编号（如 \"S3\"），不必再给标题等；有重大进展时可给出新的 importance。其余的组成新报道，story 留空。" +
    "每篇新报道给出：\n- title：中文标题，概括这件事（不超过30字）\n- section：一级分类 id；labels：最贴切的 1–2 个二级分类 id" +
    "\n- importance：0–100 的重要度，看影响面、权威性、报道家数与时效（常规公告、个股小事 20–40；全国性政策、重大市场波动 50–70；重大国际事件、突发灾难 70 以上）" +
    (fr ? "\n" + fr + "标 ★ 的是程序按分类认出的这类新闻，没标的也可能是。" : "") +
    more.map((t) => "\n" + t).join("") +
    "\n- entities：这件事的关键主体（公司、机构、人物、产品或技术名，最多 4 个，用最常见的中文名）" +
    '\n只输出一个 JSON 对象：{"stories":[{"items":[编号],"story":"","title":"","section":"","labels":[""],"importance":0,"entities":[""]}],"noise":[编号]}' +
    "\n\n分类表（一级 id 名称：二级 id 名称……）：\n" + tax.text +
    ((adExamples || []).length ? "\n\n读者标记过的非新闻示例（同类的也放进 noise）：\n" + adExamples.map((x) => "- " + clip(x, 60)).join("\n") : "") +
    (known.length ? "\n\n已有报道（编号｜版块｜标题）：\n" + known.join("\n") : "") +
    "\n\n新抓到的新闻（编号｜来源｜时间｜标题｜摘要）：\n" + lines.join("\n");
}

export function planPrompt(stories, layout) {
  const fr = layout.focus && (layout.focus.labels || []).length ? layout.focus : null;
  const focal = fr ? profilesOf(layout).list.find((p) => p.focus) : null;
  const lines = stories.map((s, i) => "[" + (i + 1) + "] " + (fr && inFocus(fr, [s.section].concat(s.labels || [])) ? "★" : "") + s.section + "｜" + s.importance + "｜" + s.source_count + "家｜" + clip(s.title, 60));
  return "任务：给一份新闻版面做统筹。\n1. merge：讲同一件事、应当合并的报道编号组（没有就给空数组）\n2. headline：一句话总括这段时间最重要的事（不超过40字）\n3. front：头版放的 " + layout.front.count + " 篇报道编号，按重要性排序\n4. watch：值得继续关注的 " + Math.max(1, layout.watch.count) + " 件事以内，每件说明原因（不超过50字），附报道编号" +
    (focal && promptOf(focal, "plan") ? "\n" + promptOf(focal, "plan") : "") +
    "\n5. themes：把属于同一条更大的主线、但不是同一件事的报道串起来（如同一场冲突的不同事件、同一家公司接连的动作、同一项技术的多方进展），每条主线给 name（不超过12字）、kind（conflict/company/technology/policy/market/other）和报道编号；没有就给空数组" +
    '\n只输出一个 JSON 对象：{"merge":[[编号]],"headline":"","front":[编号],"watch":[{"text":"","refs":[编号]}],"themes":[{"name":"","kind":"","refs":[编号]}]}' +
    "\n\n这段时间按重要度排列的报道（编号｜版块｜重要度｜报道家数｜标题）：\n" + lines.join("\n");
}

/**
 * 输出块 → 版式说明与 JSON 格式。默认四块（导语、要点、各方说法、影响）的说法与原来一字不差。
 * 标准块可以用 chars / max / ask 改字数、条数和要求；自定义块：text 是一段话，list 是几条短句，都要标出处。
 */
export function blockSpec(blocks, S, comments) {
  const desc = [];
  const json = ['"ref":1'];
  const wide = (b) => (comments && (b.materials || []).includes("community") ? "，可以依据【社区评论】" : "");
  for (const b of blocks) {
    if (b.kind === "lead") { desc.push("lead 导语（不超过" + (b.chars || S.lead_chars) + "字，" + (b.ask || "写这件事到现在的最新状态：谁、何事、结果；材料有先后时以最新的为准，前因一笔带过。不要用「11月12日，」这类日期开头，时间要紧时写进句子里") + "）"); json.push('"lead":""', '"lead_refs":["M1"]'); }
    else if (b.kind === "points") { desc.push("points 要点（最多" + (b.max || S.points) + "条，每条不超过" + (b.chars || S.point_chars) + "字，" + (b.ask || "每条都必须是导语里没有的新信息（关键数字、经过、各方动作）；把导语换个说法再写一遍的不要写；没有新信息就少写或给空数组") + wide(b) + "）"); json.push('"points":[{"text":"","refs":["M2"]}]'); }
    else if (b.kind === "views") { desc.push("views " + (b.name || "各方说法") + "（最多" + (b.max || S.views) + "条，{who: " + (wide(b) ? "当事方、官员、机构、分析人士或评论者" : "当事方、官员、机构或分析人士") + ", says: 说法}，" + (b.ask || "只写有人表态、或各家说法不一致的；who 写表态的人或机构；报道它的媒体（财联社、彭博、路透等）只是转述者，只有各家报道的事实或数字对不上时才把媒体写成 who（如 彭博：估值约1.4万亿美元）；says 要是导语和要点里没有的立场、判断或不同的数字；「未回应置评」这类不算说法；没有就给空数组") + wide(b) + "）"); json.push('"views":[{"who":"","says":"","refs":["M1"]}]'); }
    else if (b.kind === "impact") { desc.push("impact 影响（不超过" + (b.chars || S.impact_chars) + "字，" + (b.ask || "这件事会带来什么后果：对谁、在哪方面、往哪个方向；不要复述事实本身；材料里没有依据就给空字符串") + "）"); json.push('"impact":""'); }
    else if (b.kind === "text") { desc.push(b.id + " " + b.name + "（不超过" + (b.chars || 80) + "字，" + (b.ask || "") + wide(b) + "；材料不足就给空字符串）"); json.push('"' + b.id + '":{"text":"","refs":["M1"]}'); }
    else if (b.kind === "list") { desc.push(b.id + " " + b.name + "（最多" + (b.max || 3) + "条，每条不超过" + (b.chars || 40) + "字，" + (b.ask || "") + wide(b) + "；没有就给空数组）"); json.push('"' + b.id + '":[{"text":"","refs":["M1"]}]'); }
  }
  json.push('"update":""', '"title":""');
  return { text: desc.join("；"), json: '{"stories":[{' + json.join(",") + "}]}" };
}

export function writePrompt(batch, layout) {
  const S = layout.story;
  const reg = profilesOf(layout);
  // 每篇的读法：调用方给了就用（entryOf），否则按版块与分类认
  const profs = batch.map((b) => b.profile || profileFor(reg, { section: b.story.section, labels: b.story.labels || [] }));
  // 材料编号 M1…：每句话都要标出依据哪几条材料，程序据此核对
  const blocks = batch.map((b, i) => {
    // 已有故事线有新报道：给出上次的导语，并标出哪些是新材料，让模型写「相比上次的新进展」
    const freshIds = new Set((b.fresh || []).map((it) => it.id));
    const fresh = b.mats.map((it, k) => (freshIds.has(it.id) ? "M" + (k + 1) : null)).filter(Boolean);
    const prev = b.prevLead ? "\n上次导语：" + clip(b.prevLead, 160) + (fresh.length ? "\n本次新增材料：" + fresh.join("、") : "") : "";
    const fbk = (b.errors || []).length ? "\n读者指出这些说法有误，不要再写：" + b.errors.map((e) => "『" + clip(e.text, 60) + "』" + (e.note ? "（" + clip(e.note, 40) + "）" : "")).join("；") : "";
    const p = profs[i];
    const star = p.id !== DEFAULT_PROFILE && promptOf(p, "write") ? "（" + p.name + "）" : "";
    // 前情：以前的相关故事线（H 编号），只能写进读法里能依据以前报道的块
    const hb = p.blocks.filter((x) => (x.materials || []).includes("history")).map((x) => x.name || x.id);
    const hist = (b.history || []).length && hb.length ? "\n以前的相关报道（前情，只能用在「" + hb.join("」「") + "」里，引用写 H 编号；和这件事没有直接关系就不要用）：\n" + b.history.map((h) => "[" + h.ref + "] " + String(h.at || "").slice(0, 10) + "｜" + historyText(h)).join("\n") : "";
    // 材料只有一两句的快讯：只写导语，不硬凑要点、说法和影响
    const thin = !b.rich && thinMaterial(b) ? "\n（这篇材料只有一两句：只写导语；要点、各方说法、影响没有导语之外的新内容就给空）" : "";
    const rich = b.rich ? "\n（这篇材料多：要点最多" + b.rich.points + "条，每条不超过" + b.rich.point_chars + "字，把经过、关键数字、各方动作写全，不要重复导语）" : "";
    return "【报道" + (i + 1) + "】" + star + b.story.title + rich + thin + prev + fbk + "\n材料：\n" + b.mats.map((it, k) => "[M" + (k + 1) + "] " + (it.source_name || it.source_id) + "｜" + tz(it.published_at || it.first_seen_at) + "｜" + materialText(it, b.bodies, p.content)).join("\n") + hist;
  });
  // 版式与输出格式：这一批的读法都一样时按它的输出块，否则用默认的四块
  const spec = blockSpec(profs.every((p) => p.blocks === profs[0].blocks) ? profs[0].blocks : DEFAULT_BLOCKS, S, profs.some((p) => p.content.comments > 0));
  // 这一批里用到的其他读法的写稿要求
  const asks = [...new Set(profs.filter((p) => p.id !== DEFAULT_PROFILE && promptOf(p, "write")))].map((p) => "标了（" + p.name + "）的报道，" + promptOf(p, "write"));
  return "请按版式为以下每篇报道写稿。写作要求：" + layout.style + "每句话只能依据该报道的材料，并在 refs 里标出依据的材料编号；材料里没有的数字、人名、机构名一律不写。" +
    "材料里如果有和这篇报道说的不是同一件事的，忽略它，不要写进稿里。宁缺毋滥：材料只有一两句时，只写导语，其余各块给空。" +
    "\n版式：" + spec.text + "。" +
    asks.join("") + "\n\n" +
    "update：只对给了「上次导语」的报道写，说清相比上次有什么新进展（不超过40字，依据新增材料；没有实质进展给空字符串）。" +
    "\ntitle：只对给了「上次导语」的报道写。事情的走向已经和原标题不符时（原标题说大跌、现在已经反弹；原标题说「将」「拟」、现在已经发生；原标题里的数字已经过时），依据材料给一个符合现状的新标题（不超过20字）；原标题仍然成立就给空字符串。" +
    "\n只输出一个 JSON 对象：" + spec.json +
    "\n\n" + blocks.join("\n\n");
}

/**
 * 模型给的新标题能不能用：6–24 个字、和原标题不同、里面的数字和专名在材料里找得到，
 * 而且说的是导语那件事（和新导语有足够的字面重叠）——不然宁可留着原标题。
 */
export function acceptTitle(next, old, lead, sources) {
  const t = String(next || "").replace(/\s+/g, " ").trim().replace(/[。.]$/, "");
  const n = [...t].length;
  if (n < 6 || n > 24 || t === String(old || "").trim()) return "";
  if (!checkText(t, sources).ok) return "";
  const tb = bigrams(t);
  const lb = bigrams(String(lead || ""));
  let hit = 0;
  for (const g of tb) if (lb.has(g)) hit++;
  return tb.size && hit / tb.size >= 0.3 ? t : "";
}

// ------------------------------------------------------------------ 模型编排（增量）
/**
 * 增量编排：已归入故事线的新闻不再交给模型归并；新新闻由模型归入已有故事线或另起；只有新增了报道的故事线才重写稿；
 * 没有新新闻时沿用上一份版面的统筹（总括、头版、值得关注）。
 * @param o { pack, since, hours, layout, names, taxonomy, maxItems, maxStories, batchSize, budgetMs, callTimeoutMs, prev（上一份版面内容）}
 * @returns 版面；材料太少时 { fallback: "too_few_items" }
 */
/** 按顺序分批，每批 n 篇、同一个读法：取下一篇，再从后面按顺序找同读法的凑满。 */
export function batchByProfile(list, n) {
  const rest = list.slice();
  const out = [];
  while (rest.length) {
    const head = rest.shift();
    const b = [head];
    for (let i = 0; i < rest.length && b.length < n; ) { if ((rest[i].profile || DEFAULT_PROFILE) === (head.profile || DEFAULT_PROFILE)) b.push(rest.splice(i, 1)[0]); else i++; }
    out.push(b);
  }
  return out;
}

/**
 * 模型写的一篇稿 → 报道字段，按读法的输出块取：读法里没有的块不收；自定义块收进 extra。
 * @param ids 把「M2」一类的材料编号换成文章 id
 */
/**
 * 材料只有一两句：每篇原文都不超过 120 字，合起来不到 200 字（同一句快讯被几家转发也算）。
 * 实测 300 字的门槛太高：一篇 286 字、讲清了来龙去脉的报道也被当成「只写导语」，丢了有用的要点。
 */
export function thinMaterial(b) {
  const lens = (b.mats || []).map((it) => String((b.bodies && b.bodies.get && b.bodies.get(it.id)) || it.summary || "").length);
  return lens.length > 0 && Math.max(...lens) <= 120 && lens.reduce((x, y) => x + y, 0) < 200;
}

/** 两段话的字面重合（a 的二元组有多少在 b 里）。 */
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}
/** 「未回应置评」之类：不是说法。 */
const NO_COMMENT = /^(暂)?未(立即)?(回应|置评|回复)|拒绝置评|不予置评|未予置评|尚未回应/;
/** 报道这件事的媒体、通讯社：只是转述者；只有各家说法对不上时才算「各方说法」。 */
const MEDIA_WHO = /财联社|彭博|路透|华尔街见闻|同花顺|界面|新华社|央视|CCTV|中新社|媒体|报道|电报|快讯|通讯社|^据|Bloomberg|Reuters|CNBC|WSJ|华尔街日报|金融时报|FT$|链捕手|深潮|ChainCatcher|动察|数字生命卡兹克/i;
/**
 * 写稿结果的「去水」：模型偶尔不照要求做，程序再筛一遍——
 * 导语去掉开头的「11月12日，」；和导语几乎一样的要点不要；表态方是媒体的、或说的和导语一样的「说法」不要；复述事实的「影响」不要。
 */
export function trimCopy(c) {
  const lead = String(c.lead || "").replace(/^(\d{4}年)?\d{1,2}月\d{1,2}日(凌晨|早间|上午|中午|下午|傍晚|晚间|晚)?[，,]\s*/, "");
  if (lead.length >= 10) c.lead = lead;
  const L = c.lead || "";
  // 只是链接、「详情见…」「点击查看」的不算信息
  const linkOnly = (t) => /详情(见|请见|可见)|点击(查看|阅读)|原文链接|阅读原文|goo\.gl|bit\.ly|t\.co\/|https?:\/\/|\b[a-z0-9-]+\.(com|gle|ly|io|cn)\/\S+/i.test(String(t));
  c.points = (c.points || []).filter((p) => overlap(p.text, L) < 0.6 && !linkOnly(p.text));
  // 媒体只是转述者：说的和导语差不多就不算一方说法（各家数字对不上时，媒体的说法和导语不同，留着）
  // 带导语里没有的数字的（各家数字对不上：财联社 64 人受伤、导语 80 人）一定留
  const newNumber = (t) => (String(t).match(/\d+(\.\d+)?/g) || []).some((n) => !L.includes(n));
  c.views = (c.views || []).filter((v) => !NO_COMMENT.test(v.says) && (newNumber(v.says) || (overlap(v.says, L) < (MEDIA_WHO.test(v.who) ? 0.4 : 0.6) && !c.points.some((p) => overlap(v.says, p.text) >= 0.75))));
  if (c.impact && overlap(c.impact, L) >= 0.5) c.impact = "";
  return c;
}

export function parseCopy(w, blocks, S, ids, rich) {
  const has = (k) => blocks.find((b) => b.kind === k);
  const P = has("points"), V = has("views"), I = has("impact"), L = has("lead");
  const line = (x, n) => (typeof x === "string" ? { text: str(x, n), refs: [] } : { text: str(x && x.text, n), refs: ids(x && x.refs) });
  const out = {
    lead: str(w.lead, ((L && L.chars) || S.lead_chars) + 20), lead_refs: ids(w.lead_refs),
    points: P ? (Array.isArray(w.points) ? w.points : []).map((x) => line(x, ((rich && rich.point_chars) || P.chars || S.point_chars) + 20)).filter((x) => x.text).slice(0, (rich && rich.points) || P.max || S.points) : [],
    views: V ? (Array.isArray(w.views) ? w.views : []).map((v) => ({ who: str(v && v.who, 20), says: str(v && v.says, 80), refs: ids(v && v.refs) })).filter((v) => v.who && v.says).slice(0, V.max || S.views) : [],
    impact: I ? str(w.impact, (I.chars || S.impact_chars) + 20) : "", by: "llm",
  };
  const extra = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      const x = line(w[b.id], (b.chars || 80) + 20);
      if (x.text) extra.push({ id: b.id, name: b.name, kind: "text", text: x.text, refs: x.refs });
    } else if (b.kind === "list") {
      const items = (Array.isArray(w[b.id]) ? w[b.id] : []).map((x) => line(x, (b.chars || 40) + 20)).filter((x) => x.text).slice(0, b.max || 3);
      if (items.length) extra.push({ id: b.id, name: b.name, kind: "list", items });
    }
  }
  if (extra.length) out.extra = extra;
  return trimCopy(out);
}

/** 模型服务断连一类的错误：值得等一会儿重试。 */
const CONN_ERR = /connection error|econnreset|econnrefused|fetch failed|socket hang up|network|terminated/i;
/** 写稿缓存的版本：写稿提示词或写法改了就加一，旧缓存自然失效。 */
const WRITE_V = 2;
/** 一篇稿的材料指纹：材料、上次导语、读者报错、写法、重点领域标记与提示词版本都一样，才算同一份稿。 */
export function writeFingerprint(entry, layout) {
  const p = entry.profile || storyProfile(layout, entry.story, entry.items);
  // 读法的写法（名称、版本、写稿要求、材料设置、输出块）改了，旧稿就不能沿用
  const f = p.id === DEFAULT_PROFILE && !promptOf(p, "write") ? "" : [p.id, p.version, p.name, promptOf(p, "write"), JSON.stringify(p.content), JSON.stringify(p.blocks)].join("|");
  const h = (entry.history || []).map((x) => x.story_id);
  return createHash("sha1").update(JSON.stringify(Object.assign({ v: WRITE_V, t: entry.story.title, m: entry.mats.map((it) => it.id), o: entry.mats.filter((it) => it.origin_text).map((it) => it.id), p: entry.prevLead || "", r: entry.rich || null, e: (entry.errors || []).map((x) => x.text), s: layout.story, y: layout.style, f }, h.length ? { h } : {}))).digest("hex");
}
const COPY_KEYS = ["lead", "lead_refs", "points", "views", "impact", "extra", "history", "update_text", "update_by", "title", "retitled"];
function cacheGet(db, fp) {
  try { const r = db.prepare("SELECT copy FROM write_cache WHERE fp = ? AND created_at >= datetime('now', '-3 days')").get(fp); return r ? JSON.parse(r.copy) : null; } catch { return null; }
}
function cachePut(db, fp, story) {
  try {
    const copy = Object.fromEntries(COPY_KEYS.filter((k) => story[k] !== undefined).map((k) => [k, story[k]]));
    db.prepare("INSERT INTO write_cache (fp, story_id, copy, created_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(fp) DO UPDATE SET story_id = excluded.story_id, copy = excluded.copy, created_at = excluded.created_at").run(fp, story.id || null, JSON.stringify(copy));
  } catch { /* 存不下不影响这一版 */ }
}

export async function llmEdition(db, model, o) {
  const layout = o.layout;
  const reg = profilesOf(layout);
  const contentOf = (s) => reg.get(s.profile).content;
  const t0 = Date.now();
  const deadline = t0 + (o.budgetMs || 600000);
  const left = () => deadline - Date.now();
  // errors：每次失败的调用（含随后重试成功的）；fallbacks：真正退回规则结果的步骤
  const stats = { calls: 0, failed: 0, errors: [], fallbacks: [], steps: {} };
  const adExamples = db.prepare("SELECT title FROM articles WHERE kind = 'promo' AND kind_by = 'reader' ORDER BY first_seen_at DESC LIMIT 6").all().map((r) => r.title);
  const call = async (step, prompt, maxTokens, minTimeout) => {
    if (left() < 15000) { stats.errors.push(step + ": budget_exceeded"); throw new Error("budget_exceeded"); }
    stats.calls++;
    const t = Date.now();
    try {
      // 推理模型的推理也占 token：上限留足；解析不了重试一次
      // 本地模型服务偶尔断连（Connection error）：等一会儿重试一次，不直接退回程序稿
      const once = async () => {
        try { return await model.complete(prompt, { step, maxTokens, timeoutMs: Math.min(left(), Math.max(o.callTimeoutMs || 180000, minTimeout || 0)) }); } catch (err) {
          if (!CONN_ERR.test(String(err && err.message ? err.message : err)) || left() < (o.retryWaitMs ?? 20000) + 30000) throw err;
          stats.errors.push(step + ": " + String(err.message || err).slice(0, 80) + "（重试）");
          stats.calls++;
          await new Promise((r) => setTimeout(r, o.retryWaitMs ?? 20000));
          return await model.complete(prompt, { step, maxTokens, timeoutMs: Math.min(left(), Math.max(o.callTimeoutMs || 180000, minTimeout || 0)) });
        }
      };
      for (let k = 0; k < 2; k++) {
        const j = parseJsonLoose(await once());
        if (j) return j;
        if (k === 0) stats.calls++;
      }
      throw new Error("bad_json");
    } catch (err) {
      stats.failed++;
      stats.errors.push(step + ": " + String(err && err.message ? err.message : err).slice(0, 120));
      throw err;
    } finally {
      stats.steps[step] = (stats.steps[step] || 0) + (Date.now() - t);
    }
  };
  const tax = taxonomyIndex(o.taxonomy);
  const items = gatherItems(db, { pack: o.pack, since: o.since, limit: o.maxItems || 150, focus: layout.focus });
  if (items.length < 3) return { fallback: "too_few_items" };
  const byN = new Map(items.map((it) => [it.n, it]));

  // 0. 已归入故事线的新闻直接接上
  const fb = feedbackState(db);
  const asg = assignments(db, items.map((it) => it.id));
  const rows = storyRows(db, [...new Set(asg.values())]);
  const groups = [];
  const byId = new Map();
  for (const it of items) {
    const sid = asg.get(it.id);
    const row = sid && rows.get(sid);
    if (!row) continue;
    if (!byId.has(sid)) { const g = { id: sid, row, items: [], fresh: [], title: row.title, section: row.section, labels: row.labels, importance: Math.round(row.importance || 0), by: "llm", entities: row.entities || [] }; byId.set(sid, g); groups.push(g); }
    byId.get(sid).items.push(it);
  }
  let fresh = items.filter((it) => !byId.has(asg.get(it.id)));
  stats.fresh_items = fresh.length;
  // 规则事件已有成员归入某条故事线的，直接接上（规则聚类合并时是精确的），不必再问模型
  const evIds = [...new Set(fresh.map((it) => it.event_id).filter(Boolean))];
  const evStory = new Map();
  for (let i = 0; i < evIds.length; i += 400) {
    const chunk = evIds.slice(i, i + 400);
    for (const r of db.prepare("SELECT event_id, story_id, COUNT(*) n FROM story_items WHERE event_id IN (" + chunk.map(() => "?").join(",") + ") GROUP BY event_id, story_id ORDER BY n DESC").all(...chunk)) if (!evStory.has(r.event_id)) evStory.set(r.event_id, r.story_id);
  }
  const extraRows = storyRows(db, [...new Set(evStory.values())].filter((sid) => !byId.has(sid)));
  let auto = 0;
  fresh = fresh.filter((it) => {
    const sid = it.event_id && evStory.get(it.event_id);
    if (!sid || fb.banned(it.id, sid)) return true;
    let g = byId.get(sid);
    if (!g) {
      const row = extraRows.get(sid);
      if (!row || row.status !== "active") return true;
      g = { id: sid, row, items: [], fresh: [], title: row.title, section: row.section, labels: row.labels, importance: Math.round(row.importance || 0), by: "llm", entities: row.entities || [] };
      byId.set(sid, g);
      groups.push(g);
    }
    g.items.push(it);
    g.fresh.push(it);
    auto++;
    return false;
  });
  stats.auto_attached = auto;
  // 分诊：规则打分很低、又只有一家报道的新闻几乎不会上版——不交给模型，按规则事件归并；关注命中的照样交给模型
  const followList = (o.follows && o.follows.follow) || [];
  // 重点领域（AI 与新技术）的不分诊，全交给模型看，免得漏掉只有一家报道的新技术
  // 源声明了读法的（技术博客、Hacker News）也不分诊：它们多半只有一家、规则打分低，重要度交给模型按读法的评分要求判断
  const lowly = (it) => !it.focus && !(it.src_profile && it.src_profile !== DEFAULT_PROFILE) && it.event_id && it.ev_importance != null && it.ev_importance < (o.triageBelow ?? 18) && (!it.ev_cred || it.ev_cred === "single") &&
    !(followList.length && matchList(followList, { id: "", title: it.title, section: "", labels: it.labels || [], outlets: [{ source_id: it.source_id }] }, [it]).length);
  const triaged = o.triageBelow === 0 ? [] : fresh.filter(lowly);
  if (triaged.length) {
    const tset = new Set(triaged);
    fresh = fresh.filter((it) => !tset.has(it));
    for (const it of triaged) {
      const home = it.event_id ? groups.find((g) => g.triage && g.items.some((x) => x.event_id === it.event_id)) : null;
      if (home) { home.items.push(it); home.fresh.push(it); }
      else groups.push({ id: null, items: [it], fresh: [it], title: clip(it.title, 40), section: topOf(it.labels[0]) || "other", labels: it.labels.slice(0, 2), importance: Math.round(it.ev_importance || 0), by: "rules", triage: true });
    }
  }
  stats.triaged = triaged.length;

  // 1. 归并新新闻：归入已有故事线或另起；失败的批先拆半重试，仍失败按规则事件归并
  // 候选的已有报道按批检索：和这一批新闻最像的（标题字面、关键主体）在前，再补最重要的；
  // 前面几批刚建的报道也在候选里——原来候选只取一次（重要度前 40），不够重要的已有报道和刚建的报道都看不到，同一件事会被拆成两篇
  const candidatesFor = (batch) => pickCandidates(groups.filter((g) => !g.triage), batch, o.candidates || 30);
  // 实测（本地推理模型）：真实的一批每个事件约用 430 个输出 token、5 秒；40 个一批要 197 秒、1.7 万 token。
  // 一批 24 个（约 2 分钟），上限按每个 500 token 给足，超时放宽到 5 分钟——原来上限 3000+150×40 必然截断
  const size = o.batchSize || 24;
  // 按规则事件折叠：规则聚类的精确率实测 100%，同一事件的几篇只给模型看一行（附另有几家），归并完再展开——
  // 送给模型的行数少一大截，冷启动的归并时间与 JSON 被截断的次数都跟着降
  const peersOf = new Map();
  const repOfEvent = new Map();
  const units = [];
  for (const it of fresh) {
    const rep = it.event_id && repOfEvent.get(it.event_id);
    if (rep) { peersOf.get(rep).push(it); continue; }
    units.push(it);
    peersOf.set(it, []);
    if (it.event_id) repOfEvent.set(it.event_id, it);
  }
  for (const it of units) it._peers = peersOf.get(it);
  const expand = (its) => its.flatMap((it) => [it].concat(peersOf.get(it) || []));
  stats.units = units.length;
  const queue = [];
  for (let i = 0; i < units.length; i += size) queue.push(units.slice(i, i + size));
  // 流程进度（面板的流程图）：o.onStage(步骤, start|update|done|skip, { done, total, detail })
  const stage = (id, act, patch) => { try { if (o.onStage) o.onStage(id, act, patch || {}); } catch { /* 只是进度 */ } };
  const gCount = { done: 0, total: queue.length };
  const pre = [auto ? auto + " 条直接接上已有故事线" : "", triaged.length ? triaged.length + " 条分数低的按规则归并" : ""].filter(Boolean).join("，");
  if (queue.length) stage("group", "start", { done: 0, total: queue.length, detail: units.length + " 条新新闻分 " + queue.length + " 批交给模型" + (pre ? "（" + pre + "）" : "") });
  else stage("group", "done", { detail: "没有要模型归并的新新闻" + (pre ? "（" + pre + "）" : "") });
  // 归并最多用预算的 60%，留时间给统筹和写稿；超出后剩下的新闻按规则事件归并
  const groupDeadline = t0 + (o.budgetMs || 600000) * 0.6;
  const attach = (g, its) => { g.items.push(...its); g.fresh.push(...its); };
  // 服务端能并行时几批同时归并；本地单卡 concurrency=1 就是原来的一批一批
  const groupWorker = async () => {
    let first = true;
    while (queue.length) {
    if (!first) { gCount.done++; stage("group", "update", { done: gCount.done, total: gCount.total }); }
    first = false;
    const batch = queue.shift();
    stage("group", "update", { detail: "正在归并第 " + Math.min(gCount.total, gCount.done + 1) + "/" + gCount.total + " 批（" + batch.length + " 条）" });
    const inBatch = new Set(batch.map((it) => it.n));
    const cands = candidatesFor(batch);
    let got = null;
    try {
      if (Date.now() > groupDeadline) throw new Error("group_budget");
      const j = await call("group", groupPrompt(batch, tax, cands, adExamples, layout.focus, profilesOf(layout)), 2000 + 500 * batch.length, 300000);
      if (Array.isArray(j.stories)) got = j.stories;
      // 模型判为非新闻的：标成 promo（读者判过的不动），之后不再进版面
      const nz = (Array.isArray(j.noise) ? j.noise : []).map(Number).filter((n) => inBatch.has(n) && !["corroborated", "confirmed", "disputed"].includes(byN.get(n).ev_cred) && !isDigestTitle(byN.get(n).title) && byN.get(n).kind !== "digest_item" && !(got || []).some((g) => (g.items || []).map(Number).includes(n)));
      if (nz.length) { stats.noise = (stats.noise || 0) + markKind(db, nz.map((n) => byN.get(n).id), "promo", "llm", "模型判定"); nz.forEach((n) => inBatch.delete(n)); }
    } catch { got = null; }
    if (!got && batch.length > 12 && !batch._split && Date.now() < groupDeadline) {
      const half = Math.ceil(batch.length / 2);
      const a = batch.slice(0, half), b = batch.slice(half);
      a._split = b._split = true;
      queue.unshift(a, b);
      gCount.total += 1;
      stage("group", "update", { total: gCount.total, detail: "有一批没归并成，拆成两半重试" });
      continue;
    }
    if (got) {
      const taken = new Set();
      for (const g of got) {
        const ns = (Array.isArray(g && g.items) ? g.items : []).map(Number).filter((n) => inBatch.has(n) && !taken.has(n));
        if (!ns.length) continue;
        ns.forEach((n) => taken.add(n));
        const its = expand(ns.map((n) => byN.get(n)));
        const imp = Number(g.importance);
        const m = /^S(\d+)$/i.exec(String(g.story || "").trim());
        const target = m ? cands[Number(m[1]) - 1] : null;
        // 读者指出不属于那条故事线的，不再归回去
        if (target && its.some((it) => fb.banned(it.id, target.id))) {
          const keep = its.filter((it) => !fb.banned(it.id, target.id));
          const out = its.filter((it) => fb.banned(it.id, target.id));
          if (keep.length) attach(target, keep);
          groups.push({ id: null, items: out, fresh: out.slice(), title: clip(out[0].title, 40), section: target.section, labels: target.labels, importance: Math.round(Math.max(...out.map((x) => x.ev_importance || 0))), by: "llm" });
          continue;
        }
        if (target) {
          attach(target, its);
          if (Number.isFinite(imp) && imp > 0) target.importance = Math.round(Math.min(100, Math.max(0, imp)));
          continue;
        }
        const labels = (Array.isArray(g.labels) ? g.labels : []).map(String).filter((l) => tax.all.has(l)).slice(0, 2);
        let section = tax.tops.has(String(g.section)) ? String(g.section) : topOf(labels[0]);
        if (!tax.tops.has(section)) section = topOf(its[0].labels[0]) || "other";
        groups.push({ id: null, items: its.slice(), fresh: its.slice(), title: str(g.title, 40) || clip(its[0].title, 40), section, labels: labels.length ? labels : its[0].labels.slice(0, 2), importance: Number.isFinite(imp) ? Math.round(Math.min(100, Math.max(0, imp))) : Math.round(Math.max(...its.map((x) => x.ev_importance || 0))), by: "llm",
          entities: (Array.isArray(g.entities) ? g.entities : []).map((x) => str(x, 20)).filter(Boolean).slice(0, 4) });
      }
    } else {
      stats.fallbacks.push("group:" + batch.length);
      for (const it of expand(batch)) {
        const home = it.event_id ? groups.find((g) => g.items.some((x) => x.event_id === it.event_id)) : null;
        if (home) attach(home, [it]);
        else groups.push({ id: null, items: [it], fresh: [it], title: clip(it.title, 40), section: topOf(it.labels[0]) || "other", labels: it.labels.slice(0, 2), importance: Math.round(it.ev_importance || 0), by: "rules" });
      }
    }
  }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency || 1) }, groupWorker));
  if (queue.length === 0 && gCount.total) { const gf = stats.fallbacks.filter((x) => x.startsWith("group")).length; stage("group", "done", { done: gCount.total - gf, total: gCount.total, warn: gf > 0, detail: "归成 " + groups.length + " 条故事线" + (gf ? "（" + gf + " 批没归并成，按规则归并）" : "") }); }
  for (const g of groups) if (!g.id) { g.id = storyIdFor(g.items[0].id); g.isNew = true; }
  if (!groups.length) return { fallback: "no_stories" };
  groups.sort((a, b) => b.importance - a.importance);

  // 2. 统筹：有新新闻才调用；否则沿用上一份版面的总括、头版、值得关注
  const top = groups.slice(0, 80).map((g) => Object.assign(g, storyFacts(g.items)));
  const merged = new Map(); // 被并入者下标（1 起） → 并入目标下标
  let plan = null;
  const ids = new Set(groups.map((g) => g.id));
  const byIdAll = (id) => groups.find((g) => g.id === id);
  const prevPlanOk = o.prev && o.prev.headline && !((o.prev.stats && o.prev.stats.fallbacks) || []).includes("plan");
  // 变化小也沿用：头版的故事线没有新报道，有变化的故事线都排不进头版（重要度低于头版里最低的），条数不多，上次统筹还不旧
  const prevFront = prevPlanOk ? (o.prev.front || []).filter((i) => ids.has(i)) : [];
  const frontFloor = prevFront.length ? Math.min(...prevFront.map((i) => byIdAll(i).importance)) : -1;
  const changed = groups.filter((g) => g.isNew || g.fresh.length);
  const planAt = prevPlanOk && o.prev.stats && o.prev.stats.plan_at ? o.prev.stats.plan_at : null;
  const PL = layout.plan || { reuse_hours: 0, reuse_changes: 0 };
  const minor = Boolean(prevPlanOk && fresh.length && PL.reuse_hours > 0 && planAt && Date.now() - Date.parse(planAt) < PL.reuse_hours * 3600000 && prevFront.length
    && changed.filter((g) => !g.triage).length <= PL.reuse_changes && changed.every((g) => g.importance < frontFloor && !prevFront.includes(g.id)));
  if ((!fresh.length || minor) && prevPlanOk) {
    stage("plan", "done", { detail: minor ? "变化小（" + changed.length + " 条都排不进头版），沿用上次的头版和总括" : "没有新新闻，沿用上次的头版和总括" });
    if (minor) stats.plan_minor = changed.length;
    if (planAt) stats.plan_at = planAt;
    plan = { reuse: true, headline: o.prev.headline, frontIds: (o.prev.front || []).filter((i) => ids.has(i)), watch: (o.prev.watch || []).map((w) => ({ text: w.text, stories: (w.stories || []).filter((i) => ids.has(i)) })), themesKept: (o.prev.themes || []).map((t) => Object.assign({}, t, { stories: (t.stories || []).filter((i) => ids.has(i)) })).filter((t) => t.stories.length >= 2) };
    stats.plan_reused = true;
  } else {
    stage("plan", "start", { detail: "从 " + top.length + " 条故事线里排头版、写总括、挑值得关注的" });
    try { plan = await call("plan", planPrompt(top, layout), 6000); stats.plan_at = new Date().toISOString(); stage("plan", "done", { detail: "头版 " + (Array.isArray(plan.front) ? plan.front.length : 0) + " 条" + (plan.headline ? "：" + String(plan.headline).slice(0, 30) : "") }); } catch { plan = {}; stats.fallbacks.push("plan"); stage("plan", "done", { warn: true, detail: "模型没排成，按重要度排头版" }); }
    for (const m of Array.isArray(plan.merge) ? plan.merge : []) {
      const ks = (Array.isArray(m) ? m : []).map(Number).filter((k) => k >= 1 && k <= top.length && !merged.has(k));
      if (ks.length < 2) continue;
      // 并入已有的故事线（保住它的 id 和历史），没有已有的就并入第一个
      const head = ks.find((k) => !top[k - 1].isNew) || ks[0];
      for (const k of ks) {
        if (k === head) continue;
        const h = top[head - 1], src = top[k - 1];
        h.items.push(...src.items);
        h.fresh.push(...(src.isNew ? src.items : src.fresh));
        h.importance = Math.max(h.importance, src.importance);
        if (!src.isNew) (h.absorbed = h.absorbed || []).push(src.id);
        merged.set(k, head);
      }
    }
    if (!plan.merge) {
      const seen = new Map();
      top.forEach((g, i) => { const ev = g.event_ids[0]; if (!ev) return; if (seen.has(ev)) { const h = top[seen.get(ev)]; h.items.push(...g.items); h.fresh.push(...(g.isNew ? g.items : g.fresh)); if (!g.isNew) (h.absorbed = h.absorbed || []).push(g.id); merged.set(i + 1, seen.get(ev) + 1); } else seen.set(ev, i); });
    }
  }
  const finalGroups = top.filter((_, i) => !merged.has(i + 1)).concat(groups.slice(80));
  const allStories = finalGroups.map((g) => {
    const facts = storyFacts(g.items);
    const total = (g.row ? g.row.total : 0) + g.fresh.length;
    const prof = storyProfile(layout, g, g.items);
    return Object.assign({ id: g.id, title: g.title, section: g.section, labels: g.labels, importance: g.importance, profile: prof.id, ...(prof.badge ? { badge: prof.badge } : {}), by: g.by, is_new: Boolean(g.isNew), updated: !g.isNew && g.fresh.length > 0, _g: g, _total: total, _k: top.indexOf(g) + 1 }, facts);
  });
  // 关注与屏蔽：屏蔽的不上版、不写稿（但照样登记故事线，免得每轮再交给模型）
  const stories = applyFollows(allStories.slice(), o.follows).filter(notTrialOnly);
  const sid = (k) => { const n = Number(k); const target = merged.get(n) || n; const s = stories.find((x) => x._k === target); return s ? s.id : null; };
  const uniq = (xs) => [...new Set(xs)];
  const front = plan.reuse ? plan.frontIds : uniq((Array.isArray(plan.front) ? plan.front : []).map(sid).filter(Boolean));
  // 主线：同一条更大线索下、但不是同一件事的几篇报道（同一场冲突、同一家公司接连的动作、同一项技术的多方进展）
  const THEME_KINDS = ["conflict", "company", "technology", "policy", "market", "other"];
  const themes = plan.reuse ? plan.themesKept || [] : (Array.isArray(plan.themes) ? plan.themes : []).map((t) => ({ name: str(t && t.name, 16), kind: THEME_KINDS.includes(t && t.kind) ? t.kind : "other", stories: uniq((Array.isArray(t && t.refs) ? t.refs : []).map(sid).filter(Boolean)) })).filter((t) => t.name && t.stories.length >= 2).slice(0, 8);
  const watch = plan.reuse ? plan.watch.filter((w) => w.text) : (Array.isArray(plan.watch) ? plan.watch : []).map((w) => ({ text: str(w && w.text, 70), stories: uniq((Array.isArray(w && w.refs) ? w.refs : []).map(sid).filter(Boolean)) })).filter((w) => w.text);
  const parts = assemble(stories, layout, o.names || {}, { front, watch, headline: str(plan.headline, 60) });

  // 3. 写稿：上版的故事线里，没有稿或写稿后有新报道加入的才写；其余沿用；写不成的用程序拼的稿
  const placed = new Set(parts.placed);
  let reused = 0;
  const toWrite = [];
  const frontSet = new Set(parts.front || []);
  const SW = layout.story;
  stats.deferred = 0;
  stats.brief = 0;
  for (const s of stories) {
    const g = s._g;
    // 有读者报错未处理的，重写
    if (!g.absorbed && copyFresh(g.row, s._total, originCount(g.items)) && !fb.errors.has(s.id)) { Object.assign(s, copyOf(g.row.copy), { by: "llm", reused: true }); reused++; }
    else if (!placed.has(s.id)) continue;
    // 小进展：已有模型稿、不在头版、不算重要、新报道还少——先沿用旧稿（「进展」一行由程序标出新增了什么），攒够了再重写
    else if (!g.absorbed && !fb.errors.has(s.id) && !frontSet.has(s.id) && deferRewrite(g.row, s, SW)) { Object.assign(s, copyOf(g.row.copy), { by: "llm", reused: true, deferred: s._total - g.row.copy.items }); reused++; stats.deferred++; }
    // 一句话快讯：只有一篇、原文很短，模型改写出来还是那句话——用程序稿（就是原文）
    else if (!frontSet.has(s.id) && isBriefWire(g, s, SW, reg.get(s.profile))) stats.brief++;
    else toWrite.push(s);
  }
  // 头版先写（读者最先看到），再按重要度
  const frontRank = new Map((parts.front || []).map((id, i) => [id, i]));
  toWrite.sort((a, b) => (frontRank.has(a.id) ? frontRank.get(a.id) : 99) - (frontRank.has(b.id) ? frontRank.get(b.id) : 99) || b.importance - a.importance).splice(o.maxStories || 16);
  // 边写边出：归并与统筹完成就先出一版（没写的用程序稿），之后每写完一批更新一次
  const progress = (bodiesNow) => {
    if (!o.onProgress) return;
    try {
      const pb = bodiesFor(db, stories.flatMap((s) => s._g.items.map((it) => it.id)));
      const snap = stories.map((s) => {
        const c = Object.assign({}, s, { points: JSON.parse(JSON.stringify(s.points || [])), views: JSON.parse(JSON.stringify(s.views || [])) });
        if (!written.has(s.id) && !s.reused) {
          const rc = ruleCopy(s._g.items, s, layout, {}, pb);
          Object.assign(c, { lead: rc.lead, lead_refs: rc.lead_refs, points: rc.points, views: rc.views, impact: rc.impact, by: s.by === "llm" ? "llm-group" : "rules" });
        }
        verifyStory(db, c, s._g.items, bodiesNow || pb, contentOf(s), reg.get(s.profile).blocks);
        return strip(c);
      });
      o.onProgress(finish(o, snap, parts, { mode: "llm", model: model.label(), items_read: items.length, stats: Object.assign({}, stats, { partial: true, written: written.size, to_write: toWrite.length }) }));
    } catch { /* 进度版出不来不影响正式版 */ }
  };
  const written = new Set();
  const skipped = [reused ? reused + " 篇沿用旧稿" : "", stats.deferred ? stats.deferred + " 篇新报道少、先不重写" : "", stats.brief ? stats.brief + " 条快讯用原文" : ""].filter(Boolean).join("，");
  if (toWrite.length) stage("write", "start", { done: 0, total: toWrite.length, detail: "要写 " + toWrite.length + " 篇（头版先写）" + (skipped ? "；" + skipped : "") });
  else stage("write", "done", { done: 0, total: 0, detail: "没有要重写的稿" + (skipped ? "（" + skipped + "）" : "") });
  progress();
  // 深读：要写的报道里，只有标题或摘要被截断的材料先去原文抓正文（有预算），模型才有东西可写
  if (o.deepRead) {
    const have = bodiesFor(db, toWrite.flatMap((s) => s._g.items.map((it) => it.id)));
    const need = [];
    // 读法要长材料的（技术长文、开源项目：正文 2000 字以上）：列表里的一两句说明也算不上正文，同样去原文抓
    const wantsBody = (s) => reg.get(s.profile).content.body_chars >= 2000;
    for (const s of toWrite) for (const it of pickMaterials(s._g.items, 4)) if ((it.completeness !== "full" || wantsBody(s)) && !have.has(it.id) && !need.some((x) => x.id === it.id)) need.push(it);
    if (need.length) stage("write", "update", { detail: "先去原文抓 " + need.length + " 篇正文，模型才有东西可写" });
    try { stats.deep = await o.deepRead(need); } catch (e) { stats.deep = { tried: 0, ok: 0, error: String(e.message || e).slice(0, 120) }; }
  }
  const bodies = bodiesFor(db, toWrite.flatMap((s) => s._g.items.map((it) => it.id)));
  // 写稿：一批 3 篇；服务端能并行处理时多批同时写（生产环境的大模型），本地单卡就一批一批写。
  // 并发数：o.concurrency 给了就用；o.probe 为真时先拿前两批并行试一次，比较「两批各自耗时之和 / 实际总耗时」，
  // 接近 2 说明服务端真在并行（之后用 3），接近 1 说明在排队（之后用 1），结果交给 o.onProbe 记住
  const entryOf = (story) => {
    const g = story._g;
    const profile = reg.get(story.profile);
    // 材料多的（多篇报道、合起来够长）：多读几篇、要点放宽，只算一次
    if (story.rich === undefined) story.rich = richSpec(g.items, bodies, layout.story, profile);
    const M = (story.rich && story.rich.materials) || profile.content.materials;
    const prevLead = !g.isNew && g.row && g.row.copy && g.row.copy.lead && g.fresh.length ? g.row.copy.lead : "";
    // 有进展的故事线：新材料优先放进去，模型才看得到新进展
    let mats = pickMaterials(g.items, M);
    if (prevLead) { const nf = pickMaterials(g.fresh, Math.min(3, M)); mats = nf.concat(pickMaterials(g.items.filter((it) => !nf.includes(it)), M - nf.length)); }
    // 读法有能依据以前报道的块（如「背景」）：找以前的相关故事线当前情（H 编号），只找一次
    if (story.history === undefined) story.history = profile.blocks.some((b) => (b.materials || []).includes("history")) ? relatedStories(db, { id: story.id, title: story.title, entities: g.entities || [], first_seen_at: story.first_seen_at }) : [];
    return { story, items: g.items, bodies, mats, fresh: g.fresh, prevLead, profile, history: story.history, rich: story.rich, errors: fb.errors.get(story.id) || [] };
  };
  // 断点续写：上一次（中断、重启或超时前）已经写好的同一份材料，直接用写好的稿
  try { db.prepare("DELETE FROM write_cache WHERE created_at < datetime('now', '-3 days')").run(); } catch { /* 旧库没有这张表 */ }
  stats.cached = 0;
  for (let i = toWrite.length - 1; i >= 0; i--) {
    const s = toWrite[i];
    const hit = cacheGet(db, writeFingerprint(entryOf(s), layout));
    if (!hit || !hit.lead) continue;
    Object.assign(s, hit, { by: "llm" });
    written.add(s.id);
    toWrite.splice(i, 1);
    stats.cached++;
  }
  if (stats.cached) { progress(bodies); stage("write", "update", { done: written.size, detail: stats.cached + " 篇上次已写好，直接用" }); }
  const writeBatch = async (group) => {
      const batch = group.map(entryOf);
      stage("write", "update", { detail: "正在写：" + group.map((s) => s.title).join("、").slice(0, 60) });
      try {
        // 材料是正文，推理更长：上限按篇数给足（实测 3 篇约 6400 个输出 token），超时放宽到 5 分钟
        const j = await call("write", writePrompt(batch, layout), 4000 + 3000 * batch.length, 300000);
        for (const w of Array.isArray(j.stories) ? j.stories : []) {
          const b = batch[Number(w && w.ref) - 1];
          if (!b || !str(w.lead, 10)) continue;
          const S = layout.story;
          // 「M2」→ 文章 id
          const ids = (r) => (Array.isArray(r) ? r : [r]).map((x) => {
            const t = String(x || "").trim();
            const h = /^H(\d+)$/i.exec(t);
            if (h) { const x2 = (b.history || [])[Number(h[1]) - 1]; return x2 ? "h:" + x2.story_id : null; }
            const m = /^M?(\d+)$/i.exec(t);
            const it = m && b.mats[Number(m[1]) - 1];
            return it ? it.id : null;
          }).filter(Boolean);
          Object.assign(b.story, parseCopy(w, b.profile.blocks, S, ids, b.rich));
          // 新进展同样要经得起核对（只认给模型看的报道原文）
          const up = b.prevLead ? str(w.update, 60) : "";
          const srcText = b.mats.map((m) => materialText(m, b.bodies, sourceOnly(b.profile.content)));
          if (up && checkText(up, srcText).ok) Object.assign(b.story, { update_text: up, update_by: "llm" });
          // 事情的走向变了：标题跟着改（原标题记在 retitled 里），免得标题说大跌、导语说反弹
          const nt = b.prevLead ? acceptTitle(w.title, b.story.title, b.story.lead, srcText) : "";
          if (nt) { b.story.retitled = b.story.title; b.story.title = nt; stats.retitled = (stats.retitled || 0) + 1; }
          written.add(b.story.id);
          cachePut(db, writeFingerprint(b, layout), b.story);
          stage("write", "update", { done: written.size });
        }
      } catch { stats.fallbacks.push("write:" + batch.length); /* 这一批用程序拼的稿 */ }
  };
  const groupsOf3 = [];
  // 一批里的报道用同一个读法（提示词的固定部分相同，生产环境的前缀缓存才命中）；按写稿顺序取，同读法的往前凑
  for (const b of batchByProfile(toWrite, 3)) groupsOf3.push(b);
  let conc = Math.max(1, o.concurrency || 1);
  let next = 0;
  if (o.probe && groupsOf3.length >= 2) {
    const t = Date.now();
    const d = await Promise.all([0, 1].map(async (k) => { const s0 = Date.now(); await writeBatch(groupsOf3[k]); return Date.now() - s0; }));
    const eff = (d[0] + d[1]) / Math.max(1, Date.now() - t);
    conc = eff >= 1.6 ? 3 : 1;
    stats.probe = { efficiency: Math.round(eff * 100) / 100, concurrency: conc };
    if (o.onProbe) try { o.onProbe(stats.probe); } catch { /* 记不住下次再试 */ }
    next = 2;
    progress(bodies);
  }
  const worker = async () => {
    while (next < groupsOf3.length) {
      const k = next++;
      if (k > 0 && conc === 1) progress(bodies);
      await writeBatch(groupsOf3[k]);
      if (conc > 1) progress(bodies);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, groupsOf3.length - next)) }, worker));
  stats.concurrency = conc;
  const restBodies = bodiesFor(db, stories.filter((s) => !written.has(s.id) && !s.reused).flatMap((s) => s._g.items.map((it) => it.id)));
  for (const s of stories) {
    if (written.has(s.id) || s.reused) continue;
    const copy = ruleCopy(s._g.items, s, layout, {}, restBodies);
    Object.assign(s, { lead: copy.lead, lead_refs: copy.lead_refs, points: copy.points, views: copy.views, impact: copy.impact, by: s.by === "llm" ? "llm-group" : "rules" });
  }
  for (const s of stories) if (s.updated && !s.update_text) Object.assign(s, programUpdate(s._g.fresh));
  const wf = stats.fallbacks.filter((x) => x.startsWith("write"));
  const why = [...new Set(stats.errors.filter((e) => e.startsWith("write")).map((e) => (/timeout|aborted/i.test(e) ? "超时" : /budget/.test(e) ? "超出时间预算" : /bad_json/.test(e) ? "模型输出格式不对" : "出错")))].join("、");
  stage("write", "done", { done: written.size, total: toWrite.length + (stats.cached || 0), warn: wf.length > 0, detail: "写了 " + written.size + " 篇" + (wf.length ? "；" + wf.length + " 批没写成（" + (why || "出错") + "），这几篇先用程序稿，下一轮再写" : "") + (stats.retitled ? "，" + stats.retitled + " 条换了标题" : "") });
  stage("check", "start", { detail: "逐句核对数字、专名、引语是否在原文里" });
  // 4. 核对：模型稿（新写的与沿用的）逐句核对，整理出处
  const allBodies = bodiesFor(db, stories.filter((s) => s.by === "llm" && !written.has(s.id)).flatMap((s) => s._g.items.map((it) => it.id)));
  for (const [k, v] of bodies) allBodies.set(k, v);
  for (const s of stories) { verifyStory(db, s, s._g.items, allBodies, contentOf(s), reg.get(s.profile).blocks); if (!written.has(s.id)) scrubStory(s, fb.errors.get(s.id)); }
  stats.check = sumChecks(stories);
  stage("check", "done", { detail: "核对 " + (stats.check.checked || 0) + " 句，" + (stats.check.dropped ? "删掉 " + stats.check.dropped + " 句" : "全部通过") + (stats.check.flagged ? "，" + stats.check.flagged + " 条导语标「待核」" : "") });
  Object.assign(stats, { written: written.size, reused, groups: groups.length, ms: Date.now() - t0 });
  const out = finish(o, stories.map(strip), parts, { mode: "llm", model: model.label(), items_read: items.length, stats });
  out.themes = themes;
  out._items = new Map(allStories.flatMap((s) => s._g.items.map((it) => [it.id, { story: s.id, event_id: it.event_id || null, section: s.section, labels: s.labels, importance: s.importance }])));
  const at = new Date().toISOString();
  // 模型失败时按规则临时归并出的新故事线不登记：下一轮这些新闻再交给模型
  out._persist = allStories.filter((s) => !(s._g.isNew && s._g.by === "rules")).map((s) => ({
    id: s.id, isNew: s.is_new, title: s.title, section: s.section, labels: s.labels, importance: s.importance, profile: s.profile, absorbed: s._g.absorbed || [], entities: s._g.entities || [],
    copy: written.has(s.id) ? Object.assign({ lead: s.lead, lead_refs: s.lead_refs, points: s.points, views: s.views, impact: s.impact, by: "llm", model: model.label(), at, items: s._total, origins: originCount(s._g.items) }, s.extra && s.extra.length ? { extra: s.extra } : {}, s.history && s.history.length ? { history: s.history } : {}) : null,
    update: s.updated && s.update_text ? { text: s.update_text, by: s.update_by, items: s._g.fresh.length } : null,
    resolve: written.has(s.id) && fb.errors.has(s.id),
    items: s._g.fresh.map((it) => ({ article_id: it.id, event_id: it.event_id || null })),
  }));
  return out;
}
