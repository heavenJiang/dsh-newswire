/**
 * 分类 → 事件聚类 → 事件打分（交叉验证）。每轮入库后对本轮出现的条目执行；也可按时间窗整体重算（reprocess）。
 *
 * 聚类（宁可不合并）：
 *   同语言：标题字符二元组相似度 ≥0.5；或 ≥0.3 且有相同的关键数字，且时间差 ≤6 小时
 *   跨语言：共享 ≥2 个具体实体（taxonomy.entities，非 weak），且（有相同关键数字 或 共享 ≥3 个实体），时间差 ≤6 小时
 * 打分 importance（0–100）与可信度 credibility 见 scoreEvent。
 */
import { createHash } from "node:crypto";
import { classify, numberTokens, unitCounts, countsConflict } from "../taxonomy.mjs";
import { bigrams, similarity, nativeHeat, distributions, markReposts } from "./select.mjs";
import { isNavTitle } from "./normalize.mjs";

const WINDOW_HOURS = 48;
const MAX_DT_MS = 6 * 3600000;
const MEMBER_CAP = 40;

const isZh = (t) => /[一-鿿]/.test(String(t || ""));
const toMs = (iso) => (iso ? Date.parse(String(iso).replace(" ", "T") + (String(iso).includes("T") ? "" : "Z")) : NaN);
/** 聚类用的时间：只信源头给的时间（feed / page_text）；url_date 只有日期，用首见时间。 */
function timeOf(a) { return a.published_at && (a.time_confidence === "feed" || a.time_confidence === "page_text") ? toMs(a.published_at) : toMs(a.first_seen_at); }
function hours(iso, h) { return new Date(toMs(iso) - h * 3600000).toISOString().replace("T", " ").slice(0, 19); }

// ------------------------------------------------------------------ 标签
export function labelArticles(db, tax, rows, sources) {
  const del = db.prepare("DELETE FROM article_labels WHERE article_id = ? AND origin IN ('rule', 'source')");
  const ins = db.prepare("INSERT OR REPLACE INTO article_labels (article_id, label, confidence, origin, rules_version) VALUES (?,?,?,?,?)");
  const out = new Map();
  for (const a of rows) {
    const src = sources.get(a.source_id) || {};
    const c = classify(tax, { title: a.title, summary: a.summary, category: a.category || src.category, region: src.region });
    del.run(a.id);
    for (const l of c.labels) ins.run(a.id, l.label, l.confidence, l.origin, tax.rulesVersion);
    for (const r of c.regions) ins.run(a.id, "region:" + r, 1, "rule", tax.rulesVersion);
    out.set(a.id, c);
  }
  return out;
}

// ------------------------------------------------------------------ 聚类
function memberView(a, tax, cls) {
  // 外文标题有中文译名时按译名比较：外文报道与中文报道才能归到同一件事；实体仍从原标题与译名一起认
  const t = a.title_zh || a.title;
  const c = cls || classify(tax, { title: a.title_zh ? a.title + " " + a.title_zh : a.title, summary: "" });
  return { id: a.id, source_id: a.source_id, zh: isZh(t), bg: bigrams(t), strong: new Set(c.strong), nums: new Set(numberTokens(t)), units: unitCounts(t), t: timeOf(a) };
}

const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

/** @returns { score, method } 或 null */
export function matchMember(x, m) {
  const dt = Math.abs((x.t || 0) - (m.t || 0));
  if (x.zh === m.zh) {
    const sim = similarity(x.bg, m.bg);
    // 同一计数单位给出不同的数（22件 vs 15件、65万亿元 vs 40万亿元）：不是同一件事，除非标题几乎一样
    if (sim < 0.9 && x.units && m.units && countsConflict(x.units, m.units)) return null;
    if (sim >= 0.5) return { score: sim, method: "title" };
    if (sim >= 0.3 && dt <= MAX_DT_MS && shared(x.nums, m.nums) >= 1) return { score: sim + 0.1, method: "title+number" };
    return null;
  }
  const ents = shared(x.strong, m.strong);
  if (dt <= MAX_DT_MS && ents >= 2 && (shared(x.nums, m.nums) >= 1 || ents >= 3)) return { score: 0.45 + 0.05 * Math.min(ents, 4), method: "entity" };
  return null;
}

/**
 * 把一批条目（rows：id/title/source_id/published_at/time_confidence/first_seen_at/event_id?）归入事件。
 * 已有事件的条目只记为「触及」；其余按时间先后逐条找最相近的近 48 小时事件，找不到就新建。
 * 返回触及的事件 id（新建、加入新成员、或成员被再次看到）。
 */
export function clusterArticles(db, seen, o) {
  const { runId, nowIso, tax, sources, classes } = o;
  const since = hours(nowIso, WINDOW_HOURS);
  const events = new Map();
  const memRows = db.prepare(`SELECT m.event_id, a.id, a.title, a.title_zh, a.link_to, a.source_id, a.published_at, a.time_confidence, a.first_seen_at
    FROM event_members m JOIN events e ON e.event_id = m.event_id JOIN articles a ON a.id = m.article_id
    WHERE e.last_seen_at >= ? ORDER BY m.joined_at DESC`).all(since);
  // 模型判定的同一件事（link_to）：文章 → 所在事件；被指向的文章 → 指向者所在事件（谁先处理都能归到一起）
  const placed = new Map();
  const linkers = new Map();
  for (const r of memRows) {
    placed.set(r.id, r.event_id);
    if (r.link_to) linkers.set(r.link_to, r.event_id);
    if (!events.has(r.event_id)) events.set(r.event_id, []);
    const list = events.get(r.event_id);
    if (list.length < MEMBER_CAP) list.push(memberView(r, tax));
  }
  // 倒排：二元组 / 实体 → 事件，用于召回候选
  const byGram = new Map();
  const byEnt = new Map();
  const index = (eid, m) => {
    for (const g of m.bg) { if (!byGram.has(g)) byGram.set(g, new Set()); byGram.get(g).add(eid); }
    for (const e of m.strong) { if (!byEnt.has(e)) byEnt.set(e, new Set()); byEnt.get(e).add(eid); }
  };
  for (const [eid, list] of events) for (const m of list) index(eid, m);

  const touched = new Set(seen.filter((r) => r.event_id).map((r) => r.event_id));
  const fresh = seen.filter((r) => !r.event_id && !isNavTitle(r.title)).sort((a, b) => (timeOf(a) || 0) - (timeOf(b) || 0));
  const insMember = db.prepare("INSERT OR IGNORE INTO event_members (event_id, article_id, source_id, grp, similarity, method, joined_at, joined_run) VALUES (?,?,?,?,?,?,?,?)");
  const insEvent = db.prepare("INSERT OR IGNORE INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, version, created_run, updated_run, updated_at) VALUES (?,?,?,?,?,?,1,1,1,?,?,?)");
  let merged = 0;
  for (const a of fresh) {
    const x = memberView(a, tax, classes && classes.get(a.id));
    const cand = new Map();
    for (const g of x.bg) for (const eid of byGram.get(g) || []) cand.set(eid, (cand.get(eid) || 0) + 1);
    for (const e of x.strong) for (const eid of byEnt.get(e) || []) cand.set(eid, (cand.get(eid) || 0) + 3);
    let best = null;
    const linked = (a.link_to && placed.get(a.link_to)) || linkers.get(a.id);
    if (linked && events.has(linked)) best = { eid: linked, score: 0.6, method: "llm" };
    else for (const [eid, hits] of cand) {
      if (hits < 3) continue;
      for (const m of events.get(eid) || []) {
        const r = matchMember(x, m);
        if (r && (!best || r.score > best.score)) best = Object.assign({ eid }, r);
      }
    }
    const src = sources.get(a.source_id) || {};
    const grp = src.group || a.source_id;
    let eid;
    if (best) { eid = best.eid; merged++; }
    else {
      eid = "ev-" + createHash("sha1").update(a.id).digest("hex").slice(0, 16);
      const born = o.runFor ? o.runFor(a.id) || runId : runId;
      insEvent.run(eid, src.pack || "core", a.title_zh || a.title, a.id, a.published_at || a.first_seen_at, nowIso, born, runId, nowIso);
      events.set(eid, []);
    }
    insMember.run(eid, a.id, a.source_id, grp, best ? Math.round(best.score * 1000) / 1000 : 1, best ? best.method : "seed", nowIso, runId);
    events.get(eid).push(x);
    placed.set(a.id, eid);
    if (a.link_to) linkers.set(a.link_to, eid);
    index(eid, x);
    touched.add(eid);
  }
  return { touched: Array.from(touched), fresh: fresh.length, merged };
}

/** 本轮出现的条目归事件。 */
export function clusterRun(db, o) {
  const seen = db.prepare(`SELECT DISTINCT a.id, a.title, a.title_zh, a.link_to, a.source_id, a.published_at, a.time_confidence, a.first_seen_at, m.event_id
    FROM observations ob JOIN articles a ON a.id = ob.article_id LEFT JOIN event_members m ON m.article_id = a.id WHERE ob.run_id = ? AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker')`).all(o.runId);
  return clusterArticles(db, seen, o);
}

// ------------------------------------------------------------------ 打分
const SOURCE_PTS = [0, 10, 30, 40, 46, 50];
/** 独立媒体数折算：一手源记 1 家，转载/聚合（tier=secondary）记半家——同一条交易所公告被多家快讯转发不该算成多家独立印证。 */
function sourcePoints(effective) {
  const x = Math.min(5, Math.max(0, effective));
  const lo = Math.floor(x);
  return lo >= 5 ? SOURCE_PTS[5] : SOURCE_PTS[lo] + (SOURCE_PTS[lo + 1] - SOURCE_PTS[lo]) * (x - lo);
}
const CRED_RANK = { single: 0, disputed: 1, corroborated: 1, confirmed: 2 };
export function credRank(c) { return CRED_RANK[c] ?? 0; }

/** 权威源：一手层级且权重 ≥0.9（官方、通讯社、头部财经媒体）。 */
export function isAuthority(src) { return Boolean(src) && src.tier === "primary" && Number(src.weight || 0) >= 0.9; }

/**
 * 分歧：两家以上不同媒体对同一类数字（人数 n: / 百分比 p:）各只给了一个值，且彼此不同。
 * 金额不参与（总额与分项常常都对）。
 */
export function detectDispute(members) {
  for (const cls of ["n:", "p:"]) {
    const byOutlet = new Map();
    for (const m of members) {
      const vals = m.nums.filter((x) => x.startsWith(cls));
      if (vals.length !== 1) continue;
      if (!byOutlet.has(m.grp)) byOutlet.set(m.grp, new Set());
      byOutlet.get(m.grp).add(vals[0]);
    }
    const singles = Array.from(byOutlet.entries()).filter(([, s]) => s.size === 1).map(([g, s]) => [g, Array.from(s)[0]]);
    const distinct = new Set(singles.map((x) => x[1]));
    if (singles.length >= 2 && distinct.size >= 2) return { kind: cls === "n:" ? "人数" : "百分比", values: singles.map(([g, v]) => ({ outlet: g, value: Number(v.slice(2)) })) };
  }
  return null;
}

export function scoreEvent(db, eid, o) {
  const { tax, sources, dist, runId, nowIso } = o;
  const rows = db.prepare(`SELECT m.article_id, m.source_id, m.grp, a.title, a.title_zh, a.url, a.published_at, a.time_confidence, a.first_seen_at, a.last_seen_at, a.pack
    FROM event_members m JOIN articles a ON a.id = m.article_id WHERE m.event_id = ?`).all(eid);
  if (!rows.length) return null;
  const obsQ = db.prepare("SELECT * FROM observations WHERE article_id = ? ORDER BY seen_at DESC LIMIT 1");
  const runsQ = db.prepare("SELECT COUNT(DISTINCT run_id) n FROM observations WHERE article_id = ?");
  const members = rows.map((r) => {
    const obs = obsQ.get(r.article_id);
    return Object.assign({}, r, { t: timeOf(r), nums: numberTokens(r.title), heat: obs ? nativeHeat(obs, dist).heat : 0, obs, runs: runsQ.get(r.article_id).n });
  });
  // 转载：别家几小时内几乎一字不差的稿件不算独立印证，单独列出
  markReposts(members);
  const setRepost = db.prepare("UPDATE event_members SET repost_of = ? WHERE event_id = ? AND article_id = ?");
  for (const m of members) setRepost.run(m.repost_of, eid, m.article_id);
  const reposters = new Map();
  for (const m of members) if (m.repost_of && !reposters.has(m.grp)) reposters.set(m.grp, { grp: m.grp, source_id: m.source_id, name: (sources.get(m.source_id) || {}).name || m.source_id, of: m.repost_of });
  const outlets = new Map();
  for (const m of members) {
    if (m.repost_of) continue;
    const src = sources.get(m.source_id) || {};
    const cur = outlets.get(m.grp);
    if (!cur || (m.t || Infinity) < cur.t) outlets.set(m.grp, { grp: m.grp, source_id: m.source_id, name: src.name || m.source_id, t: m.t, weight: Number(src.weight || 0.7), region: src.region || "", authority: isAuthority(src), secondary: src.tier === "secondary" });
  }
  const outs = Array.from(outlets.values()).sort((a, b) => (a.t || 0) - (b.t || 0));
  const n = outs.length;
  const cn = outs.some((x) => x.region === "CN");
  const intl = outs.some((x) => x.region && x.region !== "CN");
  const authority = outs.some((x) => x.authority);
  const heat = Math.max(0, ...members.map((m) => m.heat));
  const titles = members.map((m) => m.title).join(" ");
  const c = classify(tax, { title: titles, summary: "" });
  const muted = members.every((m) => classify(tax, { title: m.title }).muted);
  const f = {
    sources: Math.round(sourcePoints(outs.reduce((s, x) => s + (x.secondary ? 0.5 : 1), 0)) * 10) / 10,
    weight: Math.round(Math.min(10, outs.reduce((s, x) => s + x.weight, 0) * 3) * 10) / 10,
    cross_region: cn && intl ? 10 : 0,
    authority: authority ? 5 : 0,
    native: Math.round(Math.min(25, heat * 0.5) * 10) / 10,
    speed: n >= 3 && outs[2].t - outs[0].t <= 3600000 ? 5 : 0,
    persistence: Math.max(...members.map((m) => m.runs)) >= 3 ? 5 : 0,
    watch: c.watch.length ? 5 : 0,
  };
  const importance = muted ? 0 : Math.min(100, Math.round(Object.values(f).reduce((s, v) => s + v, 0)));
  const dispute = n >= 2 ? detectDispute(members) : null;
  const credibility = dispute ? "disputed" : n >= 2 ? (authority ? "confirmed" : "corroborated") : "single";
  // 主链接取源头热度最高、其次最早的成员；显示标题：有中文成员时取最短的中文标题（≥8 字，快讯转载最干净），否则用主条目标题
  const primary = (m) => ((sources.get(m.source_id) || {}).tier === "secondary" ? 0 : 1);
  const lead = members.slice().sort((a, b) => primary(b) - primary(a) || b.heat - a.heat || (a.t || 0) - (b.t || 0))[0];
  // 外文报道有中文译名的也算中文标题，事件标题不再是英文
  const zhTitles = members.map((m) => (isZh(m.title) ? m.title : m.title_zh || "")).filter((t) => isZh(t) && t.length >= 8);
  const title = zhTitles.length ? zhTitles.reduce((a, b) => (b.length < a.length ? b : a)) : lead.title;
  // 事件标签只取规则命中的（源分类默认标签太粗，例如财经快讯源里的地缘新闻会被标成「金融市场」）
  const labelRows = db.prepare("SELECT label, MAX(confidence) c, COUNT(*) k, MAX(origin = 'rule') r FROM article_labels WHERE article_id IN (" + members.map(() => "?").join(",") + ") GROUP BY label ORDER BY (label LIKE 'region:%'), k DESC, c DESC").all(...members.map((m) => m.article_id));
  const labels = labelRows.filter((r) => !r.label.startsWith("region:") && r.r === 1).slice(0, 3).map((r) => r.label);
  const regions = labelRows.filter((r) => r.label.startsWith("region:")).map((r) => r.label.slice(7));
  const first = Math.min(...members.map((m) => m.t || Infinity));
  const lastSeen = members.map((m) => m.last_seen_at).sort().pop();
  db.prepare(`UPDATE events SET title=?, lead_article_id=?, first_seen_at=?, last_seen_at=?, member_count=?, source_count=?, outlets=?, region_mix=?, importance=?, credibility=?, labels=?, regions=?, entities=?, factors=?, dispute=?, version=version+1, updated_run=?, updated_at=? WHERE event_id=?`)
    .run(title, lead.article_id, Number.isFinite(first) ? new Date(first).toISOString().replace("T", " ").slice(0, 19) : null, lastSeen, members.length, n,
      JSON.stringify(outs.map((x) => ({ grp: x.grp, source_id: x.source_id, name: x.name, t: x.t ? new Date(x.t).toISOString().replace("T", " ").slice(0, 19) : null })).concat([...reposters.values()].filter((r) => !outlets.has(r.grp)).map((r) => ({ grp: r.grp, source_id: r.source_id, name: r.name, repost_of: r.of })))),
      cn && intl ? "cn+intl" : intl ? "intl" : "cn", importance, credibility, JSON.stringify(labels), JSON.stringify(regions), JSON.stringify(c.strong), JSON.stringify(f), dispute ? JSON.stringify(dispute) : null, runId, nowIso, eid);
  db.prepare("INSERT OR REPLACE INTO event_scores (event_id, run_id, importance, source_count, credibility, factors, scored_at) VALUES (?,?,?,?,?,?,?)").run(eid, runId, importance, n, credibility, JSON.stringify(f), nowIso);
  return { event_id: eid, importance, credibility, source_count: n };
}

/** 本轮：给本轮条目打标签 → 聚类 → 给触及的事件打分。 */
export function processEvents(db, o) {
  const rows = db.prepare("SELECT DISTINCT a.id, a.title, a.summary, a.category, a.source_id FROM observations ob JOIN articles a ON a.id = ob.article_id WHERE ob.run_id = ? AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker')").all(o.runId);
  db.exec("BEGIN");
  try {
    const classes = labelArticles(db, o.tax, rows, o.sources);
    const cl = clusterRun(db, Object.assign({}, o, { classes }));
    const dist = distributions(db);
    const scored = cl.touched.map((eid) => scoreEvent(db, eid, Object.assign({}, o, { dist }))).filter(Boolean);
    db.exec("COMMIT");
    return { labelled: rows.length, fresh: cl.fresh, merged: cl.merged, touched: cl.touched, scored };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 重算（分类规则或聚类逻辑改了之后）：时间窗内的条目重新打标签；stage 含 events 时拆掉这些条目的事件归属后按时间顺序重新聚类并打分。
 * 推送记录保留（事件 id 由首条成员决定，重算后大多不变）。
 */
export function reprocess(db, o) {
  const rows = db.prepare("SELECT a.id, a.title, a.title_zh, a.link_to, a.summary, a.category, a.source_id, a.published_at, a.time_confidence, a.first_seen_at FROM articles a WHERE a.last_seen_at >= ? AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker')").all(o.sinceIso);
  // 广告与合集不进事件：先把它们从事件里摘掉（规则或读者刚把它们判出来时）
  const off = db.prepare("SELECT a.id FROM articles a JOIN event_members m ON m.article_id = a.id WHERE a.last_seen_at >= ? AND NOT (COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker'))").all(o.sinceIso).map((r) => r.id);
  db.exec("BEGIN");
  try {
    const classes = labelArticles(db, o.tax, rows, o.sources);
    let cl = { touched: [], fresh: 0, merged: 0 };
    let scored = [];
    if (o.stage !== "labels") {
      const ids = rows.map((r) => r.id).concat(off);
      const evIds = new Set();
      const q = db.prepare("SELECT event_id FROM event_members WHERE article_id = ?");
      for (const id of ids) { const r = q.get(id); if (r) evIds.add(r.event_id); }
      const delM = db.prepare("DELETE FROM event_members WHERE article_id = ?");
      for (const id of ids) delM.run(id);
      for (const eid of evIds) {
        if (!db.prepare("SELECT 1 FROM event_members WHERE event_id = ? LIMIT 1").get(eid)) {
          db.prepare("DELETE FROM events WHERE event_id = ?").run(eid);
          db.prepare("DELETE FROM event_scores WHERE event_id = ?").run(eid);
        }
      }
      // 事件的 created_run 记成首条成员第一次被看到的那一轮（时间线按轮回看依赖它），而不是这次重算
      const firstRun = db.prepare("SELECT run_id FROM observations WHERE article_id = ? ORDER BY seen_at LIMIT 1");
      cl = clusterArticles(db, rows.map((r) => Object.assign({}, r, { event_id: null })), Object.assign({}, o, { classes, runFor: (id) => (firstRun.get(id) || {}).run_id }));
      const dist = distributions(db);
      scored = cl.touched.map((eid) => scoreEvent(db, eid, Object.assign({}, o, { dist }))).filter(Boolean);
    }
    db.exec("COMMIT");
    return { articles: rows.length, events: scored.length, merged: cl.merged };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
