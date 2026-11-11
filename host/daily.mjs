/**
 * 日报：把一天（北京时间）里有动静的故事线编成一份回顾——总括、几条主线的「今日脉络」、明日关注、当日数字。
 *
 *   节省 token：总括取前几条标题；脉络 = 当前导语 + 当天最后一次进展；明日关注 = 当天晚些时候仍在发展的故事线。
 *   模型：一次调用写总括、每条脉络与明日关注；脉络与明日关注同样经过事实核对（只认该故事线的导语、进展与当天报道），
 *         不过关的退回程序写的。
 * 每次生成都存一份（digests），面板与工具取当天最新的一份。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { dayRange } from "../engine/query.mjs";
import { applyFollows } from "./follows.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 北京时间的今天。 */
export function todayBj(now) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(now || Date.now()));
}

/** 当天有新报道加入的故事线（按重要度与当天篇数排），附当天报道、进展。 */
export function gatherDay(db, o) {
  const r = dayRange(o.date, 8);
  if (!r) throw new Error("date 需为 YYYY-MM-DD");
  const packWhere = o.pack && o.pack !== "all" ? " AND a.pack = ?" : "";
  const args = [r.from, r.to].concat(o.pack && o.pack !== "all" ? [o.pack] : []);
  const rows = db.prepare(`SELECT i.story_id, a.id, a.title, a.summary, a.url, a.published_at, a.first_seen_at, a.source_id, COALESCE(s.trial, 0) AS trial, s.name AS source_name
    FROM story_items i JOIN articles a ON a.id = i.article_id LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.first_seen_at >= ? AND a.first_seen_at < ? AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker')` + packWhere + " ORDER BY a.first_seen_at").all(...args);
  const by = new Map();
  for (const it of rows) { if (!by.has(it.story_id)) by.set(it.story_id, []); by.get(it.story_id).push(it); }
  const stQ = db.prepare("SELECT * FROM stories WHERE story_id = ? AND status = 'active'");
  const upQ = db.prepare("SELECT at, text FROM story_updates WHERE story_id = ? AND at >= ? AND at < ? ORDER BY at");
  const out = [];
  for (const [id, items] of by) {
    const st = stQ.get(id);
    if (!st) continue;
    if (items.every((x) => x.trial)) continue; // 只有试用源报道的不进日报
    const outlets = [...new Set(items.map((x) => x.source_name || x.source_id))];
    out.push({ id, title: st.title, section: st.section, labels: parseJ(st.labels, []), importance: Math.round(st.importance || 0), copy: parseJ(st.copy, null), items, outlets, updates: upQ.all(id, r.from, r.to), url: items[0].url });
  }
  out.sort((a, b) => b.importance - a.importance || b.items.length - a.items.length);
  const pushes = db.prepare("SELECT COUNT(*) n FROM pushes WHERE pushed_at >= ? AND pushed_at < ? AND COALESCE(reason, '') != 'unlisted'").get(r.from, r.to).n;
  return { range: r, stories: out, stats: { items: rows.length, storylines: out.length, sources: new Set(rows.map((x) => x.source_id)).size, pushes } };
}

/** 一条故事线当天的材料文本（核对用）。 */
const dayText = (s) => [s.title, s.copy && s.copy.lead].concat(s.updates.map((u) => u.text), s.items.map((it) => it.title + "｜" + (it.summary || ""))).filter(Boolean);

function programArc(s) {
  const lead = (s.copy && s.copy.lead) || s.items[0].summary || s.items[0].title;
  const last = s.updates[s.updates.length - 1];
  return clip(lead, 80) + (last ? " 最新：" + clip(last.text, 50) : "");
}

export function dailyPrompt(stories, date) {
  const lines = stories.map((s, i) => "[" + (i + 1) + "] " + s.title + "｜" + s.section + "｜重要度" + s.importance + "｜今日" + s.items.length + "篇（" + s.outlets.slice(0, 4).join("、") + "）" +
    (s.copy && s.copy.lead ? "\n   导语：" + clip(s.copy.lead, 120) : "") +
    (s.updates.length ? "\n   进展：" + s.updates.map((u) => String(u.at).slice(11, 16) + " " + clip(u.text, 60)).join("；") : "") +
    "\n   今日报道：" + s.items.slice(-4).map((it) => clip(it.title, 40)).join("；"));
  return "以下是 " + date + " 这一天有新报道的故事线（按重要度排列）：\n" + lines.join("\n") +
    "\n\n请写一份当天的新闻回顾，只依据给出的内容，不编造。只输出一个 JSON 对象：" +
    '\n{"headline":"一句话总括这一天（不超过40字）","arcs":[{"ref":1,"text":"这条故事线今天的来龙去脉（不超过80字）"}],"tomorrow":[{"text":"明天值得关注的事及原因（不超过50字）","refs":[编号]}]}' +
    "\narcs 写前 8 条以内；tomorrow 1 到 3 条。";
}

/**
 * 编一份日报。@param o { pack, date, names, follows, max（主线条数，默认 8）, model?（LLM 模式时给）}
 */
export async function buildDaily(db, o) {
  const t0 = Date.now();
  const day = gatherDay(db, o);
  const all = applyFollows(day.stories.map((s) => Object.assign(s, { _g: { items: s.items } })), o.follows);
  const top = all.slice(0, o.max || 8);
  const check = { checked: 0, passed: 0, dropped: 0 };
  let headline = top.slice(0, 3).map((s) => clip(s.title, 20)).join("；");
  let tomorrow = [];
  let mode = "rules";
  let calls = 0;
  let error = null;
  const arcs = new Map();
  if (o.model && o.model.available() && top.length >= 2) {
    try {
      calls++;
      const j = parseJsonLoose(await o.model.complete(dailyPrompt(top, o.date), { step: "daily", maxTokens: 7000, timeoutMs: o.timeoutMs || 300000 }));
      if (!j) throw new Error("bad_json");
      mode = "llm";
      if (str(j.headline, 60)) headline = str(j.headline, 60);
      for (const a of Array.isArray(j.arcs) ? j.arcs : []) {
        const s = top[Number(a && a.ref) - 1];
        const text = str(a && a.text, 100);
        if (!s || !text) continue;
        const r = checkText(text, dayText(s));
        if (r.claims) { check.checked++; if (r.ok) check.passed++; }
        if (r.ok) arcs.set(s.id, text); else check.dropped++;
      }
      for (const w of Array.isArray(j.tomorrow) ? j.tomorrow : []) {
        const refs = (Array.isArray(w && w.refs) ? w.refs : []).map((n) => top[Number(n) - 1]).filter(Boolean);
        const text = str(w && w.text, 70);
        if (!text) continue;
        const r = checkText(text, refs.length ? refs.flatMap(dayText) : top.flatMap(dayText));
        if (r.claims) { check.checked++; if (r.ok) check.passed++; }
        if (r.ok) tomorrow.push({ text, stories: refs.map((s) => s.id) }); else check.dropped++;
      }
    } catch (err) {
      error = String(err && err.message ? err.message : err).slice(0, 160);
    }
  }
  if (!tomorrow.length) {
    // 程序：当天晚些时候仍在发展（最后一篇在当天后 6 小时内）的重要故事线
    const late = new Date(Date.parse(day.range.to.replace(" ", "T") + "Z") - 6 * 3600000).toISOString().replace("T", " ").slice(0, 19);
    tomorrow = top.filter((s) => s.items[s.items.length - 1].first_seen_at >= late && s.importance >= 40).slice(0, 3).map((s) => ({ text: s.title + "：今天晚些时候仍有新报道", stories: [s.id] }));
  }
  const stories = top.map((s) => ({
    id: s.id, title: s.title, section: s.section, importance: s.importance, items_today: s.items.length, outlets: s.outlets.slice(0, 6), url: s.url,
    arc: arcs.get(s.id) || programArc(s), arc_by: arcs.has(s.id) ? "llm" : "rules", updates: s.updates.length, followed: s.followed || null,
  }));
  return { v: 1, date: o.date, pack: o.pack || "all", mode, model: mode === "llm" ? o.model.label() : null, headline, stories, tomorrow, stats: Object.assign({}, day.stats, { check, calls, ms: Date.now() - t0 }), error };
}

export function saveDaily(db, d) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const r = db.prepare("INSERT INTO digests (pack, date, created_at, mode, model, headline, content, ms, calls) VALUES (?,?,?,?,?,?,?,?,?)").run(d.pack, d.date, now, d.mode, d.model, d.headline, JSON.stringify(d), d.stats.ms, d.stats.calls);
  return Object.assign({ id: Number(r.lastInsertRowid), created_at: now }, d);
}

export function latestDaily(db, pack, date) {
  const r = date
    ? db.prepare("SELECT * FROM digests WHERE pack = ? AND date = ? ORDER BY id DESC LIMIT 1").get(pack || "all", date)
    : db.prepare("SELECT * FROM digests WHERE pack = ? ORDER BY id DESC LIMIT 1").get(pack || "all");
  return r ? Object.assign({ id: r.id, created_at: r.created_at }, parseJ(r.content, {})) : null;
}

export function dailyDates(db, pack, limit) {
  return db.prepare("SELECT date, MAX(id) id, MAX(created_at) created_at, MAX(headline) headline FROM digests WHERE pack = ? GROUP BY date ORDER BY date DESC LIMIT ?").all(pack || "all", limit || 30);
}

/** 发到手机的日报。 */
export function composeDailyMessage(d, names) {
  const wd = WEEK[new Date(d.date + "T12:00:00+08:00").getUTCDay()];
  const [, m, dd] = d.date.split("-").map(Number);
  const L = ["🌙 今日回顾 · " + m + "月" + dd + "日 " + wd];
  if (!d.stories.length) return L[0] + "\n今天没有新的故事线。";
  if (d.headline) L.push(d.headline);
  d.stories.forEach((s, i) => {
    const sec = names && names[s.section];
    L.push("", (i + 1) + ". " + s.title + (s.followed ? " ★" : ""), clip(s.arc, 110), [sec, "当天 " + s.items_today + " 篇", (s.outlets || []).slice(0, 3).join("、")].filter(Boolean).join(" · "));
  });
  if (d.tomorrow.length) { L.push("", "明天值得留意："); for (const w of d.tomorrow) L.push("· " + w.text); }
  L.push("", "今天共收录新闻 " + d.stats.items + " 条，归为 " + d.stats.storylines + " 件事" + (d.mode === "llm" ? "；由 " + d.model + " 编写，以原文为准" : "") + "。");
  return L.join("\n");
}
