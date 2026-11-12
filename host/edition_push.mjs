/**
 * 版面 · 推送：从版面里挑要推的报道、编当天的序号、拼发到手机的消息；行情速览。
 */
import { CRED_RANK, PUB, tz } from "./edition_base.mjs";
import { bigrams } from "../engine/pipeline/select.mjs";

// ------------------------------------------------------------------ 推送
/** 版面里要推的报道：新报道过门槛，或已推过但可信度升级 / 重要度大涨。规则与 select.mjs 一致。
 * o.full：本轮新内容全推——没推过的新报道都推，推过的有新报道加入就推进展；不看门槛和条数上限。 */
export function editionPicks(db, ed, rules, o) {
  const full = Boolean(o.full);
  const now = Date.parse(o.nowIso.replace(" ", "T") + "Z");
  const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const since = iso(now - o.lookbackHours * 3600000);
  const since24 = iso(now - 24 * 3600000);
  const staleBefore = iso(now - o.lookbackHours * 3600000 - 24 * 3600000);
  const req = Array.isArray(rules.require_labels) && rules.require_labels.length ? rules.require_labels : null;
  const picks = [];
  for (const s of Object.values(ed.stories || {}).sort((a, b) => b.importance - a.importance)) {
    const followed = Boolean(s.followed && s.followed.length);
    // 读者对某版块的推送多次说「没用」：这个版块门槛提高（关注的不受影响）
    // 重点领域（AI 与新技术）不看家数：一家报道、有一手原文就够，取两档门槛里低的那个
    const base = s.focal ? Math.min(rules.min_single ?? 36, rules.min_corroborated ?? 50) : s.source_count >= 2 ? rules.min_corroborated : rules.min_single;
    const min = followed ? (rules.min_follow ?? 20) : base + ((o.penalties && o.penalties[s.section]) || 0);
    if (!full && s.importance < min) continue;
    if (req && !followed && !req.some((p) => s.section === p || (s.labels || []).some((l) => l === p || l.startsWith(p + ".")))) continue;
    if (s.published_at && s.published_at < staleBefore) continue;
    // 推过与否按故事线（及其规则事件）判断：同一条故事线不因换了规则事件而重复推
    const evs = (s.event_ids || []).filter(Boolean);
    const last = db.prepare("SELECT * FROM pushes WHERE story_id = ?" + (evs.length ? " OR event_id IN (" + evs.map(() => "?").join(",") + ")" : "") + " ORDER BY id DESC LIMIT 1").get(s.id, ...evs);
    let reason = null;
    if (!last) { if (s.first_seen_at && s.first_seen_at >= since) reason = "new"; }
    else if (s.first_seen_at && s.first_seen_at >= since24) {
      if ((CRED_RANK[s.credibility] ?? 0) > (CRED_RANK[last.credibility] ?? 0)) reason = "upgraded";
      else if (s.importance - (last.score || 0) >= (rules.upgrade_jump || 20)) reason = "jumped";
      // 关注的故事线有新报道加入：再推一次
      else if ((followed || full) && s.updated) reason = "followup";
    }
    if (reason) picks.push(Object.assign({}, s, { reason, heat: heatOf(db, s.article_ids || []), links: linksOf(db, s) }));
    if (!full && picks.length >= (rules.max || 8)) break;
  }
  return picks;
}

/** 各家媒体的原文链接（每家取这条故事线里最早的一篇）：推送里媒体名就是链接。 */
function linksOf(db, s) {
  const ids = (s.article_ids || []).slice(0, 60);
  // 原文（一手信息：官网、论文、官方账号）排在最前面
  const origin = s.origin && s.origin.url ? [{ name: "原文（" + s.origin.site + "）", url: s.origin.url, origin: true }] : [];
  if (!ids.length) return origin;
  const rows = db.prepare("SELECT source_id, url FROM articles WHERE id IN (" + ids.map(() => "?").join(",") + ") AND url IS NOT NULL ORDER BY first_seen_at").all(...ids);
  const first = new Map();
  for (const r of rows) if (!first.has(r.source_id)) first.set(r.source_id, r.url);
  const lead = (s.outlets || []).map((o) => ({ name: o.name || o.source_id, url: first.get(o.source_id) || null }));
  if (lead.length && s.url) lead[0].url = s.url;
  // 聚合站转的是同一篇原文：同一个链接只列一次
  lead.unshift(...origin);
  const seen = new Set();
  return lead.filter((x) => !x.url || (!seen.has(x.url) && seen.add(x.url)));
}
/** 推送消息里的源头热度：这条故事线各篇最新一次观测里阅读数最高的那篇（阅读、评论、级别）。 */
function heatOf(db, ids) {
  if (!ids.length) return null;
  const qs = ids.slice(0, 50).map(() => "?").join(",");
  const r = db.prepare("SELECT o.views, o.comments, o.level FROM observations o WHERE o.article_id IN (" + qs + ") ORDER BY COALESCE(o.views, -1) DESC, o.seen_at DESC LIMIT 1").get(...ids.slice(0, 50));
  return r && (r.views != null || r.comments || r.level) ? { views: r.views, comments: r.comments, level: r.level } : null;
}
const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n));

export function recordEditionPushes(db, picks, runId, nowIso, pack) {
  // n：当天的序号（消息里每条前面的数字，读者回复它来展开、反馈）；没编号的记空
  const st = db.prepare("INSERT INTO pushes (run_id, article_id, event_id, pack, score, reason, credibility, pushed_at, story_id, n) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const p of picks) st.run(runId, p.lead_article_id, p.lead_event_id, pack && pack !== "all" ? pack : "core", p.importance, p.reason, p.credibility, nowIso, p.id, Number.isInteger(p.n) ? p.n : null);
}

/**
 * 这一句值不值得放在标题下面：几乎就是把标题再说一遍的不放；大半是外文的（没译过的原文摘要）不放。
 * 短消息里每一行都占读者的时间，宁可只有标题。
 */
export function worthSaying(line, title) {
  const t = String(line || "").replace(/^进展：/, "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (latin > cjk * 2 && latin > 20) return false;
  const a = bigrams(t), b = bigrams(title);
  if (!a.size || !b.size) return Boolean(t);
  let hit = 0;
  for (const g of b) if (a.has(g)) hit++;
  // 标题的字几乎都在这句里，而这句也没比标题长多少：只是复述
  return !(hit / b.size >= 0.8 && [...t].length <= [...String(title)].length + 8);
}

/** 只留第一句（n 字内；第一句太短、不到 12 个字时留到 n 字内的完整句子）。 */
export function oneSentence(text, n) {
  const t = sentences(text, n);
  const m = /^[^。！？!?]{11,}?[。！？!?]/.exec(t);
  return m ? m[0] : t;
}
/**
 * 一条推送最多写多少：前 detail 条带一句话和来源，再 titles 条只列标题，其余只报个数（在面板里看）。
 * 隔夜或「全推」时一轮可能有上百条：全列出来是一万多字，手机上会变成文件附件，等于没法读。
 */
export const PUSH_TIERS = { detail: 12, titles: 18 };

/**
 * 把要推的报道分成三档：detail（一句话）、titles（只列标题）、rest（不列，只报个数）。
 * 排序：按重要度，读者关注的加 10 分。总数只比 detail 多一点（不超过 4 条）时全部写一句话，不留一条小尾巴。
 */
export function tierPicks(picks, o) {
  const T = Object.assign({}, PUSH_TIERS, o || {});
  // 关注的加 10 分，不是无条件排最前：关注的词一多，琐碎的关注项会把真正的大事挤到后面
  const rank = (s) => (s.importance || 0) + (s.followed && s.followed.length ? 10 : 0);
  const ranked = picks.slice().sort((a, b) => rank(b) - rank(a));
  if (ranked.length <= T.detail + 4) return { detail: ranked, titles: [], rest: [] };
  return { detail: ranked.slice(0, T.detail), titles: ranked.slice(T.detail, T.detail + T.titles), rest: ranked.slice(T.detail + T.titles) };
}

/** 没列出来的那些按领域数一数：[{ title, n }]。 */
export function restGroups(rest) {
  return orderPicks(rest.map((s) => Object.assign({}, s, { importance: 0 }))).map((g) => ({ title: g.title.replace(/^\S+\s/, ""), n: g.items.length }));
}

/** 推送消息里的顺序：重点在前，其余按领域分组。编序号和拼消息都按它。 */
export function orderPicks(picks) {
  const keys = picks.filter(isKeyStory);
  const rest = picks.filter((s) => !isKeyStory(s));
  const groups = [];
  if (keys.length) groups.push({ title: "🔴 重点", key: true, items: keys });
  const placed = new Set();
  for (const g of PUSH_GROUPS) {
    const xs = rest.filter((s) => !placed.has(s.id) && (!g.sections || g.sections.includes(s.section)));
    if (!xs.length) continue;
    xs.forEach((s) => placed.add(s.id));
    groups.push({ title: g.title, key: false, items: xs });
  }
  return groups;
}

/** 推送消息分组：重点在前，其余按领域。 */
export const PUSH_GROUPS = [
  { id: "tech", title: "💻 科技与产业", sections: ["tech", "industry"] },
  { id: "markets", title: "📈 市场与宏观", sections: ["markets", "macro"] },
  { id: "politics", title: "🌐 时政与国际", sections: ["politics"] },
  { id: "other", title: "📌 其他", sections: null },
];
/** 重点：模型给的重要度 60 以上（不按领域加减，轻重交给模型判断）。 */
export function isKeyStory(s) {
  return s.importance >= 60;
}
// 导语开头的「11月10日，」在推送里是多余的（标题行已有日期）
// 还有快讯原文常带的「17:49 」「ChainCatcher 消息，」
const dropDate = (t) => {
  let x = String(t || "").replace(/\s+/g, " ").trim();
  for (let k = 0; k < 3; k++) {
    const y = x.replace(/^\d{1,2}:\d{2}\s*/, "").replace(/^[A-Za-z][\w ]{1,20}\s*消息[，,]\s*/, "").replace(/^(\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日(凌晨|早间|早上|上午|中午|午间|下午|傍晚|晚间|晚|夜间)?[，,]\s*/, "");
    if (y === x) break;
    x = y;
  }
  return x;
};
/** 按句截：n 字以内取完整的句子；第一句就超长时在逗号处截断。 */
export function sentences(text, n) {
  const t = dropDate(text);
  if (t.length <= n) return t;
  const parts = t.match(/[^。！？；!?;]+[。！？；!?;]?/g) || [t];
  let out = "";
  for (const p of parts) { if ((out + p).length > n) break; out += p; }
  if (out) return out;
  const cut = t.slice(0, n);
  const k = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf(","));
  return (k > n * 0.5 ? cut.slice(0, k) : cut.slice(0, n - 1)) + "…";
}
const mdText = (t) => String(t || "").replace(/[\[\]]/g, (c) => (c === "[" ? "［" : "］")).replace(/\*/g, "＊");
const same = (x) => String(x || "").replace(/[\s，。、：:,.!！?？“”"'‘’《》（）()]/g, "");

/** 版面模式的推送消息（Markdown，手机端渲染）：汇总时段与统计、总括；重点详写，其余按领域简写；来源名即链接。 */
export function composeEditionMessage(parts, picks, ed, names) {
  const title = parts.title || "要闻";
  const head = parts.overnight ? "隔夜" + title : title;
  const nWarn = (parts.warnings || []).length;
  const warn = nWarn ? "⚠ 有 " + nWarn + " 处数据源异常，详见新闻面板「运行」" : null;
  if (!picks.length) return [parts.hhmm + " " + head + "：暂无新的重点"].concat(warn ? [warn] : []).join("\n");
  const md = String(parts.md || "").split("-").map(Number);
  const L = ["📰 **" + head + "** · " + (md.length === 2 && md[0] ? md[0] + "月" + md[1] + "日 " : "") + parts.hhmm];
  // 总数按这一轮全部要推的算（含没列出来的）
  const tot = parts.totals || { all: picks.length, fresh: picks.filter((x) => x.reason === "new").length };
  const nNew = tot.fresh;
  const span = parts.from ? "汇总 " + parts.from + "–" + parts.hhmm + " · " : "";
  L.push(span + "新报道 " + nNew + " 件" + (tot.all > nNew ? " · 有进展 " + (tot.all - nNew) + " 件" : ""));
  if (ed.headline) L.push("> " + mdText(ed.headline));
  // 读者追踪的对象里哪些有动静：放在最前面说
  const tracked = (parts.tracked || []).filter((t) => t && t.name && (t.stories || []).length);
  const trackOf = new Map();
  // 每条后面标追踪对象：只标命中不多的（一个大主线命中十来条时，条条都标等于没标）
  for (const t of tracked) if (t.stories.length <= 3) for (const sid of t.stories) if (!trackOf.has(sid)) trackOf.set(sid, t.name);
  if (tracked.length) L.push("🔭 你追踪的有动静：" + tracked.slice(0, 4).map((t) => mdText(t.name) + (t.stories.length > 1 ? "（" + t.stories.length + " 条）" : "")).join("、"));
  // 短消息（parts.format = "brief"）：每条只有标题、一句话和来源，想看哪条回复序号展开
  const brief = parts.format === "brief";
  let markets = false;
  let i = 0;
  const item = (s, detailed) => {
    i++;
    const again = s.reason !== "new";
    const tag = s.reason === "followup" ? "【进展】" : s.reason === "upgraded" || s.reason === "jumped" ? "【升级】" : "";
    L.push("", "**" + (Number.isInteger(s.n) ? s.n : i) + ". " + tag + mdText(s.title) + "**" + (s.followed && s.followed.length ? " ★" : "") + (trackOf.has(s.id) ? " 🔭" + mdText(trackOf.get(s.id)) : ""));
    const lead = s.push_lead || s.lead;
    if (brief) {
      const one = again && s.update_text ? "进展：" + oneSentence(s.update_text, 70) : lead && same(lead) !== same(s.title) ? oneSentence(lead, 70) : "";
      if (one && worthSaying(one, s.title)) L.push(mdText(one));
    } else if (again && s.update_text) {
      L.push("进展：" + mdText(sentences(s.update_text, detailed ? 160 : 90)));
      if (detailed && lead && same(lead) !== same(s.title)) L.push("背景：" + mdText(sentences(lead, 100)));
    } else if (lead && same(lead) !== same(s.title)) L.push(mdText(sentences(lead, detailed ? 200 : 90)));
    if (detailed) {
      const leadKey = same(lead);
      const pts = (s.points || []).map((p) => (typeof p === "string" ? p : p && p.text) || "").filter((t) => t && !leadKey.includes(same(t))).slice(0, 2);
      for (const t of pts) L.push("· " + mdText(sentences(t, 70)));
      if (s.impact) L.push("影响：" + mdText(sentences(s.impact, 80)));
    }
    // 来源：媒体名就是链接（手机上点名字跳原文），最多列 3 家
    const links = (s.links && s.links.length ? s.links : [{ name: (s.outlets[0] || {}).name || (s.outlets[0] || {}).source_id, url: s.url }]).filter((x) => x && x.name);
    const shown = links.slice(0, brief ? 1 : 3).map((x) => { const n = mdText(String(x.name).replace(/·.*$/, "")); return x.url ? "[" + n + "](" + x.url + ")" : n; });
    const h = s.heat || {};
    const shownMedia = links.slice(0, brief ? 1 : 3).filter((x) => !x.origin).length;
    L.push([shown.join("、") + (s.outlets.length > shownMedia && s.outlets.length > 1 ? " 等 " + s.outlets.length + " 家" : ""), tz(s.published_at || s.first_seen_at).slice(-5),
      s.credibility === "confirmed" ? "权威确认" : s.credibility === "disputed" ? "说法有分歧" : "", !brief && h.views != null ? "阅读 " + fmtN(h.views) : ""].filter(Boolean).join(" · "));
    if (/^markets|^macro/.test(s.section || "")) markets = true;
  };
  for (const g of orderPicks(picks.filter((s) => !s.title_only))) { L.push("", "**" + g.title + "**"); for (const s of g.items) item(s, g.key && !brief); }
  // 第二档：只列标题（一行一条）
  const titled = picks.filter((s) => s.title_only);
  if (titled.length) {
    L.push("", "**还有这些**");
    for (const s of titled) { i++; const tag = s.reason === "followup" ? "【进展】" : s.reason === "upgraded" || s.reason === "jumped" ? "【升级】" : ""; L.push((Number.isInteger(s.n) ? s.n : i) + ". " + tag + mdText(s.title) + (s.followed && s.followed.length ? " ★" : "")); if (/^markets|^macro/.test(s.section || "")) markets = true; }
  }
  // 第三档：不列，只报个数
  const restN = (parts.rest || []).reduce((n, g) => n + g.n, 0);
  if (restN) L.push("", "另有 " + restN + " 条没有列出（" + parts.rest.map((g) => g.title + " " + g.n).join("、") + "），在面板「今日」里看。");
  L.push("");
  if (warn) L.push(warn);
  // 编了当天序号的（记了推送的）才能回复
  if (picks.some((s) => Number.isInteger(s.n))) { const eg = picks.find((s) => Number.isInteger(s.n)).n; L.push("回复序号看要点（如「" + eg + "」）；「" + eg + " 详」写详细报道；「" + eg + " 有用 / 没用」调整以后推什么。"); }
  L.push((ed.mode === "llm" ? "由 " + ed.model + " 阅读 " + ed.items_read + " 条新闻后编写，可能有误，以原文为准" : "按规则摘编自各家报道") + (markets ? "；财经内容非投资建议" : "") + "。");
  return L.join("\n");
}

// ------------------------------------------------------------------ 行情速览
const INSTRUMENT_CUT = /(高开|低开|平开|开盘|早盘|盘初|午盘|尾盘|日内|盘中|向上|向下|扭转|扩大|突破|跌破|上涨|下跌|大涨|大跌|暴涨|暴跌|拉升|走高|走低|收涨|收跌|收报|现涨|现跌|涨|跌|上行|下行|上升|下降|报|在上一)/;
/** 一条行情跳动属于哪个品种（「日经225指数期货早盘上涨1.1%」→「日经225指数期货」）。 */
function splitTick(title) {
  const t = String(title || "").replace(/^(美股|港股|A股|亚太|欧股)/, "").trim();
  const m = INSTRUMENT_CUT.exec(t);
  const raw = (m && m.index >= 2 ? t.slice(0, m.index) : t.slice(0, 8)).replace(/[，,:：\s]+$/, "").trim();
  return { raw, rest: t.slice(t.indexOf(raw) + raw.length).replace(/^[，,:：\s]+/, "").replace(/。$/, "") };
}
export function instrumentOf(title) {
  const k = splitTick(title).raw;
  // 同一品种的不同叫法归一
  return k.replace(/^香港恒生指数$|^恒指$/, "恒生指数").replace(/^台湾证交所/, "台交所").replace(/^纽约期金$/, "COMEX黄金").replace(/^美股/, "");
}

/** 时段内的行情跳动：每个品种只留最新一条，最多 n 条。 */
export function tickerBoard(db, o) {
  const where = ["a.kind = 'ticker'", "a.first_seen_at >= ?"];
  const args = [o.since];
  if (o.pack && o.pack !== "all") { where.push("a.pack = ?"); args.push(o.pack); }
  const rows = db.prepare(`SELECT a.id, a.title, a.url, a.first_seen_at, ${PUB} AS published_at, a.source_id, s.name AS source_name FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE ${where.join(" AND ")} ORDER BY COALESCE(a.published_at, a.first_seen_at) DESC`).all(...args);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = instrumentOf(r.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ instrument: k, text: r.title.replace(/。$/, ""), rest: splitTick(r.title).rest || r.title, t: r.published_at || r.first_seen_at, source: r.source_name || r.source_id, url: r.url });
    if (out.length >= (o.max || 12)) break;
  }
  return out;
}
