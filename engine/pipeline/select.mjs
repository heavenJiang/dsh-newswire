/**
 * 推送选择与手机消息（按事件）。
 *
 * 入选：本轮被触及、首次出现在回看范围内的事件；
 *   已印证 / 权威确认 / 存在分歧：importance ≥ min_corroborated（默认 50）
 *   单源：importance ≥ min_single（默认 36，基本只有源头强标记——级别 A/B、加红、最多阅读前列——才够）
 * 再推：已推过的事件只在可信度升级（单源 → 已印证 → 权威确认）或 importance 跃升 ≥ upgrade_jump（默认 20）时再推一次，标「↑」。
 * 源头热度 nativeHeat 只用源头真实给出的信号：加红/热门/榜单等标记、源头级别、阅读或互动在该源近 7 天非零分布里的分位、头条位。
 */
import { zdt } from "./digest.mjs";

const HOT_RULES = [
  [/加红/, 40, "加红"],
  [/^Most Read #([1-3])$/, 35, "最多阅读"],
  [/^Most Read #/, 25, "最多阅读"],
  [/^热门$/, 25, "热门"],
  [/^Most commented/, 20, "热议"],
  [/推送/, 15, "推送"],
  [/日推荐/, 15, "推荐"],
];
/** 源头自己的重要级别：财联社 A/B（B 约占一成），华尔街见闻 score=2。 */
const LEVEL_SCORE = { A: 50, B: 40, "2": 40 };
const MIN_SAMPLES = 30;
export const DEFAULT_RULES = { min_corroborated: 50, min_single: 36, max: 8, upgrade_jump: 20 };

// ------------------------------------------------------------------ 标题相似度（事件聚类也用）
/** 标题字符二元组（去空白标点、小写）。 */
export function bigrams(t) {
  const s = String(t || "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Jaccard；较短标题足够长（≥10 个二元组）时也看包含度（短标题的二元组有多少落在长标题里），
 * 应对「法新社8日援引…消息说，」这类长前缀。
 */
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const small = Math.min(a.size, b.size);
  const containment = small >= 10 ? inter / small : 0;
  return Math.max(jaccard, containment >= 0.7 ? containment * 0.75 : 0);
}

// ------------------------------------------------------------------ 源头热度
function engagement(o) {
  if (o.views != null) return o.views;
  if (o.likes != null || o.comments != null) return (o.likes || 0) + 3 * (o.comments || 0);
  return null;
}

/** 每源近 7 天的非零互动分布（每条取最大值）。零值不计：大多为 0 的信号（如评论数）不参与分位。 */
export function distributions(db) {
  const out = new Map();
  const rows = db.prepare("SELECT source_id, article_id, MAX(COALESCE(views, COALESCE(likes, 0) + 3 * COALESCE(comments, 0))) AS e FROM observations WHERE seen_at >= datetime('now', '-7 days') AND (views IS NOT NULL OR likes IS NOT NULL OR comments IS NOT NULL) GROUP BY source_id, article_id HAVING e > 0").all();
  for (const r of rows) { if (!out.has(r.source_id)) out.set(r.source_id, []); out.get(r.source_id).push(r.e); }
  for (const v of out.values()) v.sort((a, b) => a - b);
  return out;
}

function percentile(sorted, x) {
  if (!sorted || sorted.length < MIN_SAMPLES || x == null || x <= 0) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo / sorted.length;
}

/** 一次观测的源头热度：{ heat, why }。 */
export function nativeHeat(o, dist) {
  let heat = 0;
  const why = [];
  const hot = o.hot ? (Array.isArray(o.hot) ? o.hot : JSON.parse(o.hot)) : [];
  for (const h of hot) {
    const rule = HOT_RULES.find(([re]) => re.test(h));
    if (rule) { heat += rule[1]; if (!why.includes(rule[2])) why.push(rule[2]); }
  }
  if (o.level && LEVEL_SCORE[o.level]) { heat += LEVEL_SCORE[o.level]; why.push("级别" + o.level); }
  const p = percentile(dist.get(o.source_id), engagement(o));
  if (p != null && p >= 0.95) { heat += 30; why.push("互动前5%"); } else if (p != null && p >= 0.85) { heat += 15; why.push("互动前15%"); }
  if (o.section === "头图" || (o.section === "list" && o.rank != null && o.rank < 3)) { heat += 10; why.push("头条位"); }
  return { heat, why };
}

// ------------------------------------------------------------------ 选择
const CRED_RANK = { single: 0, disputed: 1, corroborated: 1, confirmed: 2 };

function eligible(e, rules) {
  // 主题包可要求事件带某类标签（如留学包只推 study.*）：混杂的官方源（教育部、USCIS）里只取对口的
  if (Array.isArray(rules.require_labels) && rules.require_labels.length) {
    const labels = JSON.parse(e.labels || "[]");
    if (!labels.some((l) => rules.require_labels.some((p) => l === p || l.startsWith(p + ".")))) return false;
  }
  return e.credibility === "single" ? e.importance >= rules.min_single : e.importance >= rules.min_corroborated;
}

/** 该事件上次推送（含早期按条目推过的成员）。 */
function lastPush(db, eid) {
  const byEvent = db.prepare("SELECT credibility, score, pushed_at FROM pushes WHERE event_id = ? ORDER BY id DESC LIMIT 1").get(eid);
  if (byEvent) return byEvent;
  const byArticle = db.prepare("SELECT 'single' AS credibility, p.score, p.pushed_at FROM pushes p JOIN event_members m ON m.article_id = p.article_id WHERE m.event_id = ? ORDER BY p.id DESC LIMIT 1").get(eid);
  return byArticle || null;
}

/**
 * @param o { touched: [event_id], nowIso, lookbackHours, rules, dist }
 * @returns 入选事件（含 reason: new | upgraded | jumped），按 importance 降序
 */
export function selectEvents(db, o) {
  const rules = Object.assign({}, DEFAULT_RULES, o.rules || {});
  if (!o.touched.length) return [];
  const since = new Date(Date.parse(o.nowIso.replace(" ", "T") + "Z") - o.lookbackHours * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const since24 = new Date(Date.parse(o.nowIso.replace(" ", "T") + "Z") - 24 * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const evs = db.prepare("SELECT e.*, a.published_at AS lead_published_at FROM events e LEFT JOIN articles a ON a.id = e.lead_article_id WHERE e.event_id IN (" + o.touched.map(() => "?").join(",") + ")").all(...o.touched);
  // 主条目的发布时间（含链接里的日期）早于回看范围一天以上的是旧闻：首次抓到某个源时，列表里的旧条目不该当新事件推
  const staleBefore = new Date(Date.parse(since.replace(" ", "T") + "Z") - 24 * 3600000).toISOString().replace("T", " ").slice(0, 19);
  const picks = [];
  for (const e of evs) {
    if (!eligible(e, rules)) continue;
    if (e.lead_published_at && e.lead_published_at < staleBefore) continue;
    const last = lastPush(db, e.event_id);
    let reason = null;
    if (!last) { if (e.first_seen_at >= since) reason = "new"; }
    else if (e.first_seen_at >= since24) {
      if ((CRED_RANK[e.credibility] ?? 0) > (CRED_RANK[last.credibility] ?? 0)) reason = "upgraded";
      else if (e.importance - (last.score || 0) >= rules.upgrade_jump) reason = "jumped";
    }
    if (reason) picks.push(Object.assign({}, e, { reason, prev: last }));
  }
  picks.sort((a, b) => b.importance - a.importance);
  const dist = o.dist || distributions(db);
  return picks.slice(0, rules.max).map((e) => {
    const lead = db.prepare("SELECT a.id, a.title, a.url, a.published_at, a.time_confidence, a.source_id FROM articles a WHERE a.id = ?").get(e.lead_article_id) || {};
    const obs = db.prepare("SELECT * FROM observations WHERE article_id = ? ORDER BY seen_at DESC LIMIT 1").get(e.lead_article_id);
    return Object.assign(e, { lead, obs: obs || null, heat: obs ? nativeHeat(obs, dist) : { heat: 0, why: [] }, outlets: JSON.parse(e.outlets || "[]"), labels: JSON.parse(e.labels || "[]"), dispute: e.dispute ? JSON.parse(e.dispute) : null });
  });
}

export function recordPushes(db, picks, runId, nowIso) {
  const st = db.prepare("INSERT INTO pushes (run_id, article_id, event_id, pack, score, reason, credibility, pushed_at) VALUES (?,?,?,?,?,?,?,?)");
  for (const p of picks) st.run(runId, p.lead_article_id, p.event_id, p.pack || "core", p.importance, p.reason, p.credibility, nowIso);
}

/** 连续失败的源（最近 n 轮都失败）。 */
export function failingSources(db, n) {
  const runs = db.prepare("SELECT run_id FROM runs WHERE mode IN ('cycle', 'fetch') ORDER BY started_at DESC LIMIT ?").all(n).map((r) => r.run_id);
  if (runs.length < n) return [];
  const rows = db.prepare("SELECT source_id, COUNT(*) n, MAX(note) note FROM continuity WHERE status = 'failed' AND run_id IN (" + runs.map(() => "?").join(",") + ") GROUP BY source_id HAVING n = ?").all(...runs, n);
  return rows.map((r) => ({ source_id: r.source_id, runs: r.n, chain: r.note || "" }));
}

// ------------------------------------------------------------------ 消息
function fmtCount(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n); }
const CRED_TEXT = { corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };

/**
 * 发到手机的消息：有重点时按事件列出；没有时一行简报；末尾附缺口与连续失败提醒。
 * @param o { now, tz, overnight, results, picks, sources, failing, names（标签名）}
 */
export function messageParts(o) {
  const tz = o.tz || "Asia/Shanghai";
  const hhmm = zdt(o.now, tz, false).slice(11, 16);
  const md = zdt(o.now, tz, false).slice(5, 10);
  const ok = o.results.filter((r) => r.ok).length;
  const fresh = o.results.reduce((s, r) => s + (r.fresh || 0), 0);
  const gaps = o.results.filter((r) => r.continuity === "gap_open" || r.continuity === "gap_partial");
  const linked = o.results.filter((r) => r.continuity === "connected" || r.continuity === "connected_time" || r.continuity === "gap_filled").length;
  const contText = gaps.length ? "衔接 ✓" + linked + " ⚠" + gaps.length : "衔接 ✓";
  const stats = "源 " + ok + "/" + o.results.length + "，新增 " + fresh + " 条，" + contText;
  const warnings = [];
  for (const g of gaps) {
    const name = (o.sources.get(g.id) || {}).name || g.id;
    warnings.push("⚠ " + name + " 有缺口未补全（" + (g.continuity === "gap_partial" ? "已补回 " + g.backfilled + " 条" : "未补回") + "）");
  }
  for (const f of o.failing || []) {
    const name = (o.sources.get(f.source_id) || {}).name || f.source_id;
    warnings.push("⚠ " + name + " 连续 " + f.runs + " 轮失败（" + f.chain.split(" -> ").pop() + "）");
  }
  return { hhmm, md, stats, warnings, title: o.title || "要闻", overnight: Boolean(o.overnight) };
}

/** 消息的固定部分（时间、统计、缺口与失败提醒），版面消息也用它。 */
export function composeMessage(o) {
  const tz = o.tz || "Asia/Shanghai";
  // 当天只显示时分，其它日期带月日（回看范围跨天时不至于看错）
  const today = zdt(o.now, tz, false).slice(0, 10);
  const local = (iso) => {
    if (!iso) return "";
    const t = zdt(new Date(String(iso).replace(" ", "T") + (String(iso).includes("T") ? "" : "Z")), tz, false);
    return t.slice(0, 10) === today ? t.slice(11, 16) : t.slice(5, 16);
  };
  const { hhmm, md, stats, warnings } = messageParts(o);
  const short = (id, fallback) => { const x = o.sources.get(id) || {}; return String(x.name || fallback || id || "").replace(/·.*$/, "").replace(/\s.*$/, ""); };
  const L = [];
  if (!o.picks.length) {
    L.push(hhmm + (o.title && o.title !== "要闻" ? " " + o.title : "") + (o.overnight ? " 隔夜" : "") + " 无新重点（" + stats + "）");
  } else {
    const head = o.title || "要闻";
    L.push("📰 " + (o.overnight ? "隔夜" + head : head) + " · " + md + " " + hhmm);
    L.push(stats);
    o.picks.forEach((p, i) => {
      const n = p.source_count;
      const heatTags = (p.heat.why || []).filter((w) => !/头条位|互动前/.test(w)).slice(0, 2);
      const tag = p.credibility === "single"
        ? [short(p.lead.source_id)].concat(heatTags).join("·")
        : [CRED_TEXT[p.credibility], n + "源"].concat(heatTags).join("·");
      const label = p.labels && p.labels[0] && o.names ? " #" + (o.names[p.labels[0]] || p.labels[0]) : "";
      L.push((i + 1) + "." + (p.reason === "upgraded" || p.reason === "jumped" ? "↑" : "") + "【" + tag + "】" + p.title + label);
      const names = p.outlets.map((x) => short(x.source_id, x.name));
      const who = p.credibility === "single" ? "" : names.length > 4 ? names.slice(0, 4).join("/") + " 等 " + names.length + " 家" : names.join("/");
      const obs = p.obs || {};
      const meta = [local(p.first_seen_at), who, obs.views != null ? "阅读 " + fmtCount(obs.views) : "", obs.comments ? "评论 " + fmtCount(obs.comments) : ""].filter(Boolean).join(" · ");
      L.push("   " + meta + " · " + (p.lead.url || ""));
      if (p.dispute) L.push("   分歧（" + p.dispute.kind + "）：" + p.dispute.values.map((v) => short(o.sources.has(v.outlet) ? v.outlet : (p.outlets.find((x) => x.grp === v.outlet) || {}).source_id || v.outlet) + " " + v.value).join(" / "));
    });
  }
  L.push(...warnings);
  if (o.picks.length) L.push(o.title && o.title !== "要闻" ? "依据：多源交叉验证与源头热度。" : "依据：多源交叉验证与源头热度；财经内容非投资建议。");
  return L.join("\n");
}

// ------------------------------------------------------------------ 转载
/**
 * 别家几小时内标题几乎一字不差的稿件算转载（国内快讯源之间常互相转发）：照样列出，但不算独立印证。
 * @param members [{ grp, title, t(ms) }]（会被加上 repost_of = 原发的 grp）
 * @returns 同一个数组
 */
export function markReposts(members, o) {
  const win = (o && o.windowMs) || 3 * 3600000;
  const min = (o && o.similarity) || 0.85;
  const sorted = members.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const bg = new Map(sorted.map((m) => [m, bigrams(m.title || "")]));
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    m.repost_of = null;
    for (let j = 0; j < i; j++) {
      const e = sorted[j];
      if (e.grp === m.grp || e.repost_of) continue;
      if (Math.abs((m.t || 0) - (e.t || 0)) > win) continue;
      if (similarity(bg.get(m), bg.get(e)) >= min) { m.repost_of = e.grp; break; }
    }
  }
  return members;
}
