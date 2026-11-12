/**
 * 追踪：持续追踪一家公司、一项技术、一个人或一条主线，把它几周来的动态串起来，由模型综合判断趋势与影响。
 *
 *   追踪对象 trackers：name、kind（company / technology / person / theme）、aliases（别名，用来认报道）、ticker（上市公司）
 *   关联 tracker_stories：每份版面出来后自动把相关故事线挂上（关键主体、别名出现在标题里、主线里点名的报道）——不调用模型
 *   综述 tracker_syntheses：模型读这些动态写综述——现状、趋势、关键节点、对股价 / 行业 / 竞争 / 技术趋势的影响、可能走向、
 *     接下来留意什么、和上次相比变了什么。增量：只给上次的综述和之后的新进展，不重读全部历史；新进展够多才重写。
 *   建议「值得追踪」：近 7 天在多篇报道里出现、近 3 天升温的关键主体；统筹时串起来的主线。
 *
 * 数字照旧核对：综述里的数字与外文专名要在这些报道里找得到，找不到的那条删掉。综述是推演，不是事实，不构成投资建议。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { bigrams, similarity } from "../engine/pipeline/select.mjs";

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");
const parseJ = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);
export const KINDS = ["company", "technology", "person", "theme"];
const AREAS = ["股价", "行业", "竞争", "技术趋势", "政策", "市场", "地缘", "供应链"];
const DIRS = ["利好", "利空", "不确定"];
const LEVELS = ["高", "中", "低"];

const idFor = (name) => "tr-" + Buffer.from(String(name)).toString("base64url").slice(0, 24);
const usable = (a) => { const x = String(a || "").trim(); return [...x].length >= 2 && !(/^[A-Za-z .]+$/.test(x) && x.length < 3); };

/** 别名：用户给的 + taxonomy 实体里同一实体的其它写法。 */
export function aliasesFor(name, extra, entities) {
  const out = [];
  const push = (a) => { const x = String(a || "").trim(); if (usable(x) && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x); };
  push(name);
  (extra || []).forEach(push);
  for (const [id, e] of Object.entries(entities || {})) {
    if (id.startsWith("_") || !e || e.weak) continue;
    const al = e.aliases || [];
    if (al.some((a) => out.some((x) => x.toLowerCase() === String(a).toLowerCase()))) al.forEach(push);
  }
  return out.slice(0, 12);
}

/**
 * 一条故事线「最近有动静」的时间：最后一篇报道加入的时间。不用 stories.updated_at——每份版面都会把版上的故事线刷一遍，
 * 用它算「新动态」的话几乎每条都是新的（综述因此每轮都重写、首页的最新动态也不对）。老数据没记加入时间的按故事线建立的时间算。
 */
const LAST_AT = "(SELECT MAX(si.joined_at) FROM story_items si WHERE si.story_id = s.story_id)";

export function listTrackers(db) {
  const rows = db.prepare("SELECT * FROM trackers WHERE status = 'active' ORDER BY created_at DESC").all();
  const cnt = db.prepare("SELECT COUNT(*) n, MAX(linked_at) last FROM tracker_stories WHERE tracker_id = ? AND how != 'banned'");
  const recent = db.prepare(`SELECT COUNT(*) n FROM tracker_stories ts JOIN stories s ON s.story_id = ts.story_id WHERE ts.tracker_id = ? AND ts.how != 'banned' AND COALESCE(${LAST_AT}, s.created_at) >= ?`);
  const syn = db.prepare("SELECT at, content FROM tracker_syntheses WHERE tracker_id = ? ORDER BY id DESC LIMIT 1");
  const top = db.prepare(`SELECT s.story_id, s.title, COALESCE(${LAST_AT}, s.created_at) AS updated_at FROM tracker_stories ts JOIN stories s ON s.story_id = ts.story_id WHERE ts.tracker_id = ? AND ts.how != 'banned' AND s.status = 'active' ORDER BY 3 DESC, s.importance DESC LIMIT 1`);
  return rows.map((r) => {
    const c = cnt.get(r.id);
    const sy = syn.get(r.id);
    const sc = sy ? parseJ(sy.content, {}) : null;
    const latest = top.get(r.id);
    return { id: r.id, name: r.name, kind: r.kind, ticker: r.ticker, aliases: parseJ(r.aliases, []), origin: r.origin, created_at: r.created_at,
      stories: c.n, week: recent.get(r.id, daysAgo(7)).n, latest: latest ? { id: latest.story_id, title: latest.title, at: latest.updated_at } : null,
      synthesis: sc ? { at: sy.at, state: sc.state || "", trend: sc.trend || "", changed: sc.changed || "" } : null,
      fresh: sy ? db.prepare(`SELECT COUNT(*) n FROM tracker_stories ts JOIN stories s ON s.story_id = ts.story_id WHERE ts.tracker_id = ? AND ts.how != 'banned' AND (COALESCE(${LAST_AT}, s.created_at) > ? OR ts.linked_at > ?)`).get(r.id, sy.at, sy.at).n : c.n,
      spark: daily(db, r.id, 30), mentions_week: mentions(db, r, { days: 7, limit: 99 }).length, quiet: c.n ? null : quietReason(db, r) };
  });
}

/** 近 n 天每天新增了几篇相关报道（看热度走势）。 */
export function daily(db, id, n) {
  const rows = db.prepare(`SELECT substr(datetime(a.first_seen_at, '+8 hours'), 1, 10) d, COUNT(*) c FROM tracker_stories ts JOIN story_items si ON si.story_id = ts.story_id JOIN articles a ON a.id = si.article_id
    WHERE ts.tracker_id = ? AND ts.how != 'banned' AND a.first_seen_at >= ? GROUP BY d`).all(id, daysAgo(n));
  const by = new Map(rows.map((r) => [r.d, r.c]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.now() + 8 * 3600000 - i * 86400000).toISOString().slice(0, 10); out.push(by.get(d) || 0); }
  return out;
}

export function addTracker(db, o) {
  const name = str(o.name, 30);
  if (!name) throw new Error("name_required");
  const kind = KINDS.includes(o.kind) ? o.kind : "company";
  const id = o.id || idFor(name);
  const aliases = kind === "theme" ? (o.aliases || []).filter(usable) : aliasesFor(name, o.aliases, o.entities);
  db.prepare(`INSERT INTO trackers (id, name, kind, ticker, aliases, origin, status, created_at) VALUES (?,?,?,?,?,?,'active',?)
    ON CONFLICT(id) DO UPDATE SET status = 'active', kind = excluded.kind, ticker = COALESCE(excluded.ticker, trackers.ticker), aliases = excluded.aliases`)
    .run(id, name, kind, str(o.ticker, 12) || null, JSON.stringify(aliases), o.origin || "manual", nowSql());
  for (const sid of o.stories || []) db.prepare("INSERT OR IGNORE INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?,?,?,?)").run(id, sid, nowSql(), "theme");
  // 主线没给别名的：先从名字里拆出检索关键词，回填时就用得上
  if (kind === "theme") try { ensureThemeKeywords(db, id); } catch { /* 照旧按带进来的报道 */ }
  linkStories(db, id, { days: o.backfillDays ?? 90 });
  return id;
}

/** 删除追踪：对象、挂上的故事线、所有综述一并删掉。@returns 删掉的对象（调用方据此撤掉它加的关注），没有返回 null */
export function removeTracker(db, id) {
  const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(id);
  if (!t) return null;
  const stories = db.prepare("SELECT story_id FROM tracker_stories WHERE tracker_id = ? AND how != 'banned'").all(id).map((r) => r.story_id);
  db.prepare("DELETE FROM tracker_syntheses WHERE tracker_id = ?").run(id);
  db.prepare("DELETE FROM tracker_stories WHERE tracker_id = ?").run(id);
  db.prepare("DELETE FROM trackers WHERE id = ?").run(id);
  return { id, name: t.name, kind: t.kind, aliases: parseJ(t.aliases, []), stories };
}

/** 从追踪对象上摘掉一条挂错的故事线，并记住（之后自动挂的时候跳过）。 */
export function unlinkStory(db, id, storyId) {
  db.prepare("INSERT INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?,?,?, 'banned') ON CONFLICT(tracker_id, story_id) DO UPDATE SET how = 'banned'").run(id, storyId, nowSql());
}

/**
 * 把相关故事线挂到追踪对象上（不调用模型）：关键主体与别名相同、或别名出现在故事线里任一篇的标题 / 中文译名里；
 * 主线（theme）另外认版面里同名或有重叠报道的主线。@returns 新挂上的故事线 id
 */
export function linkStories(db, id, o) {
  const t = db.prepare("SELECT * FROM trackers WHERE id = ? AND status = 'active'").get(id);
  if (!t) return [];
  const since = daysAgo((o && o.days) || 3);
  const aliases = parseJ(t.aliases, []).filter(usable);
  const found = new Map();
  for (const a of aliases) {
    for (const r of db.prepare("SELECT DISTINCT e.story_id FROM story_entities e JOIN stories s ON s.story_id = e.story_id WHERE lower(e.name) = lower(?) AND s.updated_at >= ?").all(a, since)) found.set(r.story_id, "entity");
    // 别名出现在故事线的标题里，或出现在它相当一部分报道的标题里（至少三成；只有一两篇报道的，一篇就算）。
    // 原来只要有一篇报道的标题提到就挂：几十篇报道的大故事线里总有一篇顺带提到某家公司，于是 Anthropic 上市挂到了「英伟达风波」下面
    for (const r of db.prepare(`SELECT si.story_id, COUNT(*) hits,
        (SELECT COUNT(*) FROM story_items x WHERE x.story_id = si.story_id) total,
        (SELECT title FROM stories st WHERE st.story_id = si.story_id) story_title
      FROM story_items si JOIN articles a ON a.id = si.article_id
      WHERE a.first_seen_at >= ? AND (a.title LIKE ? OR COALESCE(a.title_zh, '') LIKE ?) GROUP BY si.story_id LIMIT 400`).all(since, "%" + a + "%", "%" + a + "%")) {
      const inTitle = String(r.story_title || "").toLowerCase().includes(a.toLowerCase());
      if (!inTitle && !(r.total <= 2 || r.hits / r.total >= 0.3)) continue;
      if (!found.has(r.story_id)) found.set(r.story_id, "alias");
    }
  }
  if (t.kind === "theme" && o && Array.isArray(o.themes)) {
    const mine = new Set(db.prepare("SELECT story_id FROM tracker_stories WHERE tracker_id = ? AND how != 'banned'").all(id).map((r) => r.story_id));
    // 版面里的主线：同名的整条认；不同名的要有一半以上（且至少两篇）已经挂在这个对象上才认——
    // 原来只要有一篇重叠就把整条主线挂过来，几轮下来不相干的报道越挂越多
    const nameBg = bigrams(t.name);
    for (const th of o.themes) {
      const ss = th.stories || [];
      const overlap = ss.filter((s) => mine.has(s)).length;
      // 版面每次给主线起的名字不完全一样（「AI与数据中心」/「AI数据中心建设」）：名字相近也算同一条
      const sameName = th.name === t.name || (th.name && similarity(nameBg, bigrams(th.name)) >= 0.5);
      if (sameName || (overlap >= 2 && overlap * 2 >= ss.length)) for (const s of ss) if (!found.has(s)) found.set(s, "theme");
    }
  }
  // 主线的核心主体：已挂的故事线里一半以上（且至少两条）都有的关键主体（如「英伟达风波」里的英伟达），带这个主体的新故事线也挂上
  if (t.kind === "theme") {
    const total = db.prepare("SELECT COUNT(*) n FROM tracker_stories WHERE tracker_id = ? AND how != 'banned'").get(id).n;
    const core = db.prepare(`SELECT lower(e.name) name, COUNT(DISTINCT e.story_id) n FROM tracker_stories ts JOIN story_entities e ON e.story_id = ts.story_id
      WHERE ts.tracker_id = ? AND ts.how != 'banned' GROUP BY lower(e.name) HAVING n >= 2`).all(id).filter((r) => r.n * 2 >= total && usable(r.name)).map((r) => r.name);
    for (const name of core.slice(0, 3)) {
      for (const r of db.prepare("SELECT DISTINCT e.story_id FROM story_entities e JOIN stories s ON s.story_id = e.story_id WHERE lower(e.name) = ? AND s.updated_at >= ? AND s.status = 'active'").all(name, since)) if (!found.has(r.story_id)) found.set(r.story_id, "entity");
    }
  }
  const ins = db.prepare("INSERT OR IGNORE INTO tracker_stories (tracker_id, story_id, linked_at, how) VALUES (?,?,?,?)");
  const added = [];
  for (const [sid, how] of found) if (Number(ins.run(id, sid, nowSql(), how).changes)) added.push(sid);
  return added;
}

/**
 * 一次性修复（1.1.31）：按别名挂上的故事线里，只是某一篇报道顺带提到别名的（标题里没有、提到它的报道不到三成）摘掉。
 * @returns 摘掉的条数
 */
export function repairAliasLinks(db) {
  let removed = 0;
  const hitQ = (n) => "SELECT COUNT(*) n FROM story_items si JOIN articles a ON a.id = si.article_id WHERE si.story_id = ? AND (" + Array.from({ length: n }, () => "a.title LIKE ? OR COALESCE(a.title_zh, '') LIKE ?").join(" OR ") + ")";
  for (const t of db.prepare("SELECT id, aliases FROM trackers").all()) {
    const aliases = parseJ(t.aliases, []).filter(usable);
    if (!aliases.length) continue;
    const rows = db.prepare(`SELECT ts.story_id, s.title, (SELECT COUNT(*) FROM story_items x WHERE x.story_id = ts.story_id) total
      FROM tracker_stories ts JOIN stories s ON s.story_id = ts.story_id WHERE ts.tracker_id = ? AND ts.how = 'alias'`).all(t.id);
    for (const r of rows) {
      if (r.total <= 2 || aliases.some((a) => String(r.title || "").toLowerCase().includes(a.toLowerCase()))) continue;
      const hits = db.prepare(hitQ(aliases.length)).get(r.story_id, ...aliases.flatMap((a) => ["%" + a + "%", "%" + a + "%"])).n;
      if (hits / r.total >= 0.3) continue;
      removed += Number(db.prepare("DELETE FROM tracker_stories WHERE tracker_id = ? AND story_id = ? AND how = 'alias'").run(t.id, r.story_id).changes) || 0;
    }
  }
  return removed;
}

// ------------------------------------------------------------------ 主线的检索关键词
// 主线（「英伟达风波」「AI与数据中心」）不像公司有现成的别名：没有关键词就只能靠版面里同名的主线带新报道，很容易断档。
// 关键词从名字里拆（「英伟达风波」→ 英伟达，「AI与数据中心」→ 数据中心），要够具体：近 7 天的故事线标题里出现它的不超过 6%。
// 试过让模型读已有报道的标题来给关键词：它会把碰巧同现的词也给出来（给「特朗普」加「伊朗」、给「英伟达风波」加「外交部」），
// 带进来一堆不相干的报道，所以不用。读者可以自己给主线加别名。
const GENERIC = new Set(["ai", "人工智能", "科技", "技术", "市场", "股市", "公司", "企业", "行业", "产业", "经济", "政策", "新闻", "美国", "中国", "全球", "国际", "进展", "动态", "风波", "局势", "趋势", "影响"]);
const NAME_TAIL = /(风波|进展|动态|扩张|波动|局势|趋势|博弈|之争|竞争|危机|事件|问题|热潮|浪潮|行情|走势|变局|升级|降温)$/;

/** 名字里拆出的候选词：按「与、和、及、顿号、斜杠、空格」分开，去掉「风波」「进展」这类尾巴。 */
export function nameKeywords(name) {
  const out = [];
  for (const part of String(name || "").split(/[与和及、/／·\s]+/)) {
    const x = part.replace(NAME_TAIL, "").trim();
    if (usable(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

/** 这个词够不够具体：不是泛词，2–12 个字，近 7 天的故事线标题里出现它的不超过 6%（且总数够多时才按比例卡）。 */
export function keywordOk(db, kw) {
  const x = String(kw || "").trim();
  if (!usable(x) || [...x].length > 12 || GENERIC.has(x.toLowerCase())) return false;
  const since = daysAgo(7);
  const total = db.prepare("SELECT COUNT(*) n FROM stories WHERE updated_at >= ?").get(since).n;
  const hit = db.prepare("SELECT COUNT(*) n FROM stories WHERE updated_at >= ? AND title LIKE ?").get(since, "%" + x + "%").n;
  return total < 50 || hit / total <= 0.06;
}

function addAliases(db, t, words) {
  const cur = parseJ(t.aliases, []);
  const next = cur.slice();
  for (const w of words) if (!next.some((x) => x.toLowerCase() === w.toLowerCase())) next.push(w);
  if (next.length === cur.length) return [];
  db.prepare("UPDATE trackers SET aliases = ? WHERE id = ?").run(JSON.stringify(next.slice(0, 12)), t.id);
  return next.slice(cur.length, 12);
}

/** 没有关键词的主线：从名字里拆（不调用模型）。@returns 新加的关键词 */
export function ensureThemeKeywords(db, id) {
  const t = db.prepare("SELECT * FROM trackers WHERE id = ? AND kind = 'theme' AND status = 'active'").get(id);
  if (!t || parseJ(t.aliases, []).length) return [];
  return addAliases(db, t, nameKeywords(t.name).filter((w) => keywordOk(db, w)).slice(0, 3));
}

/**
 * 一次性修复（1.1.24）：以前主线只要和版面里的某条主线重叠一篇，就把那条主线的报道全挂过来，
 * 几天下来每个主线对象都挂了一百多条、互相几乎一样。这里把这样挂上的（how = 'theme'、不是建立时带进来的）摘掉；
 * 建立对象时带的那几篇、按别名和关键主体认的、读者摘掉的记录都不动。之后按新的规则（同名或过半重叠）重新挂。
 * @returns 摘掉的条数
 */
export function repairThemeLinks(db) {
  let removed = 0;
  for (const t of db.prepare("SELECT id, created_at FROM trackers WHERE kind = 'theme'").all()) {
    removed += Number(db.prepare("DELETE FROM tracker_stories WHERE tracker_id = ? AND how = 'theme' AND linked_at > datetime(?, '+1 minute')").run(t.id, t.created_at).changes) || 0;
  }
  return removed;
}

/** 每份版面出来后：所有追踪对象各自挂新的故事线。@returns { [trackerId]: [新挂上的故事线] } */
export function linkAll(db, themes) {
  const out = {};
  for (const t of db.prepare("SELECT id FROM trackers WHERE status = 'active'").all()) {
    try { ensureThemeKeywords(db, t.id); } catch { /* 没有关键词照旧按主线名和核心主体挂 */ }
    const a = linkStories(db, t.id, { days: 2, themes });
    if (a.length) out[t.id] = a;
  }
  return out;
}

/** 追踪对象的时间轴：挂上的故事线按时间（首报），附最新进展。 */
export function timeline(db, id, limit) {
  return db.prepare(`SELECT s.story_id, s.title, s.section, s.importance, COALESCE(${LAST_AT}, s.created_at) AS updated_at, s.copy, ts.linked_at,
      (SELECT MIN(COALESCE(a.published_at, a.first_seen_at)) FROM story_items si JOIN articles a ON a.id = si.article_id WHERE si.story_id = s.story_id) first_at,
      (SELECT COUNT(*) FROM story_items si WHERE si.story_id = s.story_id) n,
      (SELECT text FROM story_updates u WHERE u.story_id = s.story_id ORDER BY u.at DESC LIMIT 1) update_text
    FROM tracker_stories ts JOIN stories s ON s.story_id = ts.story_id WHERE ts.tracker_id = ? AND ts.how != 'banned' AND s.status = 'active'
    ORDER BY first_at DESC LIMIT ?`).all(id, limit || 60).map((r) => ({ id: r.story_id, title: r.title, section: r.section, importance: Math.round(r.importance || 0), first_at: r.first_at,
      // 「新」= 综述之后有了新报道、或综述之后才挂上的
      updated_at: r.linked_at > r.updated_at ? r.linked_at : r.updated_at, n: r.n,
      lead: (parseJ(r.copy, null) || {}).lead || "", update: r.update_text || "" }));
}

/**
 * 提到它、但没归进任何一条故事线的单篇报道（标题里有别名）：版面只收重要的新闻进故事线，
 * 一家公司的公告、小消息常常只有一篇、进不了版面，追踪里却应该看得到。按时间倒排。
 */
export function mentions(db, t, o) {
  // 主线的关键词很宽（「英伟达」一周上百篇），单篇报道只会淹没时间轴；主线只看挂上的故事线
  if (t.kind === "theme") return [];
  const aliases = parseJ(t.aliases, []).filter(usable);
  if (!aliases.length) return [];
  const since = daysAgo((o && o.days) || 30);
  const cond = aliases.map(() => "(a.title LIKE ? OR COALESCE(a.title_zh, '') LIKE ?)").join(" OR ");
  return db.prepare(`SELECT a.id, COALESCE(NULLIF(a.title_zh, ''), a.title) title, a.url, a.source_id, COALESCE(s.name, a.source_id) source, COALESCE(a.published_at, a.first_seen_at) at
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.first_seen_at >= ? AND COALESCE(a.kind, 'news') NOT IN ('promo', 'ticker', 'digest') AND (${cond})
      AND NOT EXISTS (SELECT 1 FROM story_items si JOIN tracker_stories ts ON ts.story_id = si.story_id AND ts.tracker_id = ? AND ts.how != 'banned' WHERE si.article_id = a.id)
    ORDER BY at DESC LIMIT ?`).all(since, ...aliases.flatMap((x) => ["%" + x + "%", "%" + x + "%"]), t.id, (o && o.limit) || 40);
}

/**
 * 为什么没有动静：现在开着的源里多少天没提到它、最后一次是什么时候在哪个源（那个源现在开没开）。
 * @returns null（两天内有动静）或 { days_quiet, last: { at, source, source_on } | null, sources_on }
 */
export function quietReason(db, t) {
  const aliases = parseJ(t.aliases, []).filter(usable);
  if (!aliases.length) return null;
  const cond = aliases.map(() => "(a.title LIKE ? OR COALESCE(a.title_zh, '') LIKE ?)").join(" OR ");
  const args = aliases.flatMap((x) => ["%" + x + "%", "%" + x + "%"]);
  const last = db.prepare(`SELECT COALESCE(a.published_at, a.first_seen_at) at, a.source_id, COALESCE(s.name, a.source_id) source, COALESCE(s.enabled, 0) on_, s.removed_at
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id WHERE COALESCE(a.kind, 'news') != 'promo' AND (${cond}) ORDER BY a.first_seen_at DESC LIMIT 1`).get(...args);
  // 两天内有提到就算有动静；一家公司两天没有任何消息，读者就会觉得「怎么一直没更新」，要说明原因
  const recent = last && last.at >= daysAgo(2);
  if (recent) return null;
  return { days_quiet: last ? Math.floor((Date.now() - Date.parse(String(last.at).replace(" ", "T") + "Z")) / 86400000) : null,
    last: last ? { at: last.at, source: last.source, source_id: last.source_id, source_on: Boolean(last.on_ && !last.removed_at) } : null,
    sources_on: db.prepare("SELECT name FROM sources WHERE enabled = 1 AND removed_at IS NULL").all().map((r) => r.name) };
}

export function trackerDetail(db, id) {
  const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(id);
  if (!t) return null;
  const sy = db.prepare("SELECT * FROM tracker_syntheses WHERE tracker_id = ? ORDER BY id DESC LIMIT 1").get(id);
  const tl = timeline(db, id, 80);
  return { id: t.id, name: t.name, kind: t.kind, ticker: t.ticker, aliases: parseJ(t.aliases, []), origin: t.origin, created_at: t.created_at, status: t.status,
    mentions: mentions(db, t), quiet: quietReason(db, t),
    synthesis: sy ? Object.assign({ at: sy.at, model: sy.model, stories: sy.stories }, parseJ(sy.content, {})) : null,
    fresh: sy ? tl.filter((x) => x.updated_at > sy.at).length : tl.length, timeline: tl, spark: daily(db, id, 30) };
}

// ------------------------------------------------------------------ 综述（模型）
export function synthPrompt(t, prev, items, older) {
  return "任务：你是一名长期跟踪「" + t.name + "」（" + ({ company: "公司", technology: "技术", person: "人物", theme: "主线" }[t.kind] || "对象") + (t.ticker ? "，股票代码 " + t.ticker : "") + "）的分析员。根据它近来的动态写一份追踪综述。" +
    "依据材料与常识推演；具体数字只能用材料里出现过的，不要编造；没有把握的写「不确定」或「低」。" +
    "\n- state：现状一句话（不超过60字）" +
    "\n- trend：趋势判断——它正在往哪个方向走，是否在持续发布新技术、新产品，冲突在升级还是缓和（不超过80字）" +
    "\n- milestones：最关键的 3 到 6 个节点，按时间先后，{date: 月-日, text: 不超过40字}" +
    "\n- implications：最多 5 条影响。area 取 " + AREAS.join("/") + "；target 写受影响的对象（它自己的股价、同行、上下游、行业、技术路线）；ticker 若是上市公司写股票代码（不确定留空）；direction 取 " + DIRS.join("/") + "；why 写理由（不超过60字）；confidence 取 " + LEVELS.join("/") +
    "\n- outlook：2 到 3 种可能的走向，{name, likelihood（" + LEVELS.join("/") + "）, what（不超过60字）, signals（看到什么说明正往这走，不超过40字）}" +
    "\n- watch：接下来值得留意的 1 到 3 个节点或数据（每条不超过30字）" +
    "\n- changed：和上次综述相比，最重要的新变化（不超过60字；没有上次就写「首次综述」）" +
    '\n只输出一个 JSON 对象：{"state":"","trend":"","milestones":[{"date":"","text":""}],"implications":[{"area":"","target":"","ticker":"","direction":"","why":"","confidence":""}],"outlook":[{"name":"","likelihood":"","what":"","signals":""}],"watch":[""],"changed":""}' +
    (prev ? "\n\n上次综述（" + String(prev.at || "").slice(0, 10) + "）：现状：" + (prev.state || "") + "；趋势：" + (prev.trend || "") + "；关键节点：" + (prev.milestones || []).map((m) => m.date + " " + m.text).join("；") : "") +
    (older.length ? "\n\n更早的动态（只列标题）：\n" + older.map((x) => "- " + String(x.first_at || "").slice(5, 10) + " " + clip(x.title, 40)).join("\n") : "") +
    "\n\n" + (prev ? "上次综述之后的新动态" : "近来的动态") + "（编号｜日期｜标题｜导语｜最新进展）：\n" +
    items.map((x, i) => "[" + (i + 1) + "] " + String(x.first_at || "").slice(5, 16) + "｜" + x.title + "｜" + clip(x.lead, 200) + (x.update ? "｜进展：" + clip(x.update, 80) : "")).join("\n");
}

/** 自动重写综述的最短间隔（小时）：大主线（特朗普、AI）几乎每轮都有两三篇新报道，每轮都重写既占模型又看不出差别。 */
export const SYNTH_GAP_HOURS = 6;
/**
 * 该不该重写综述：没有综述 → 要；离上次不到 2 小时 → 不；不到间隔（gapHours）→ 只有出了重要度 ≥ 80 的新动态才写；
 * 过了间隔 → 之后新挂上的故事线 ≥ 2 篇、或有重要度 ≥ 70 的新动态。
 * @returns 0（不用）或新动态的篇数
 */
export function needsSynthesis(db, id, o) {
  const tl = timeline(db, id, 80);
  if (!tl.length) return 0;
  const sy = db.prepare("SELECT at FROM tracker_syntheses WHERE tracker_id = ? ORDER BY id DESC LIMIT 1").get(id);
  if (!sy) return tl.length;
  const fresh = tl.filter((x) => x.updated_at > sy.at);
  if (!fresh.length) return 0;
  const hours = (((o && o.now) || Date.now()) - Date.parse(String(sy.at).replace(" ", "T") + "Z")) / 3600000;
  const gap = o && Number.isFinite(o.gapHours) ? o.gapHours : SYNTH_GAP_HOURS;
  if (hours < Math.min(2, gap)) return 0;
  if (hours < gap) return fresh.some((x) => x.importance >= 80) ? fresh.length : 0;
  return fresh.length >= 2 || fresh.some((x) => x.importance >= 70) ? fresh.length : 0;
}

/** 写一份综述（增量），核对后存档。 */
export async function synthesize(db, model, id, o) {
  const t = db.prepare("SELECT * FROM trackers WHERE id = ?").get(id);
  if (!t) throw new Error("not_found");
  const tl = timeline(db, id, 80);
  if (!tl.length) throw new Error("no_stories");
  const prevRow = db.prepare("SELECT * FROM tracker_syntheses WHERE tracker_id = ? ORDER BY id DESC LIMIT 1").get(id);
  const prev = prevRow ? Object.assign({ at: prevRow.at }, parseJ(prevRow.content, {})) : null;
  // 增量：有上次综述就只给之后的新动态（最多 15 篇）+ 更早动态的标题；没有就给最近 15 篇
  const fresh = prev ? tl.filter((x) => x.updated_at > prev.at) : tl;
  const items = (fresh.length ? fresh : tl).slice(0, 15);
  const older = tl.filter((x) => !items.includes(x)).slice(0, 20);
  const j = parseJsonLoose(await model.complete(synthPrompt({ name: t.name, kind: t.kind, ticker: t.ticker }, prev, items, older), { step: "track", maxTokens: 9000, timeoutMs: (o && o.timeoutMs) || 300000 }));
  if (!j) throw new Error("bad_json");
  const src = tl.map((x) => x.title + "｜" + x.lead + "｜" + x.update).concat(prev ? [prev.state || "", prev.trend || "", (prev.milestones || []).map((m) => m.text).join("；")] : []);
  let dropped = 0;
  const ok = (text) => { if (!text) return false; if (checkText(text, src).ok) return true; dropped++; return false; };
  const out = {
    v: 1,
    state: ok(str(j.state, 80)) ? str(j.state, 80) : "",
    trend: ok(str(j.trend, 100)) ? str(j.trend, 100) : "",
    milestones: (Array.isArray(j.milestones) ? j.milestones : []).slice(0, 6).map((m) => ({ date: str(m && m.date, 8), text: str(m && m.text, 50) })).filter((m) => m.text && ok(m.text)),
    implications: (Array.isArray(j.implications) ? j.implications : []).slice(0, 5).map((x) => ({
      area: AREAS.includes(x && x.area) ? x.area : "行业", target: str(x && x.target, 30), ticker: /^[A-Z0-9.]{1,10}$/.test(String((x && x.ticker) || "").trim()) ? String(x.ticker).trim() : "",
      direction: DIRS.includes(x && x.direction) ? x.direction : "不确定", why: str(x && x.why, 80), confidence: LEVELS.includes(x && x.confidence) ? x.confidence : "低",
    })).filter((x) => x.target && x.why && ok(x.target + "：" + x.why)),
    outlook: (Array.isArray(j.outlook) ? j.outlook : []).slice(0, 3).map((x) => ({ name: str(x && x.name, 10) || "可能", likelihood: LEVELS.includes(x && x.likelihood) ? x.likelihood : "低", what: str(x && x.what, 80), signals: str(x && x.signals, 60) })).filter((x) => x.what && ok(x.what + "。" + x.signals)),
    watch: (Array.isArray(j.watch) ? j.watch : []).slice(0, 3).map((x) => str(x, 40)).filter((x) => ok(x)),
    changed: prev ? (ok(str(j.changed, 80)) ? str(j.changed, 80) : "") : "首次综述",
    dropped, items: items.length, incremental: Boolean(prev),
  };
  if (!out.state && !out.trend && !out.implications.length) throw new Error("nothing_verified");
  db.prepare("INSERT INTO tracker_syntheses (tracker_id, at, model, stories, content) VALUES (?,?,?,?,?)").run(id, nowSql(), (o && o.model) || null, tl.length, JSON.stringify(out));
  return Object.assign({ at: nowSql() }, out);
}

// ------------------------------------------------------------------ 建议「值得追踪」
/**
 * 关键主体：近 7 天出现在 ≥3 条故事线里，且近 3 天不少于此前 4 天（在升温）或其中有重要度 ≥ 60 的；
 * 主线：最新版面里串起 ≥2 篇报道的。已追踪的不再建议。
 */
export function suggestions(db, o) {
  const tracked = new Set(db.prepare("SELECT lower(name) n FROM trackers WHERE status = 'active'").all().map((r) => r.n));
  const aliasTracked = new Set(db.prepare("SELECT aliases FROM trackers WHERE status = 'active'").all().flatMap((r) => parseJ(r.aliases, [])).map((x) => String(x).toLowerCase()));
  const rows = db.prepare(`SELECT e.name, COUNT(DISTINCT e.story_id) n, SUM(CASE WHEN s.updated_at >= ? THEN 1 ELSE 0 END) recent, MAX(s.importance) imp
    FROM story_entities e JOIN stories s ON s.story_id = e.story_id WHERE s.updated_at >= ? GROUP BY e.name HAVING n >= 3 ORDER BY n DESC LIMIT 40`).all(daysAgo(3), daysAgo(7));
  // 太泛的不建议：taxonomy 里标为 weak 的实体（中国、美国……）
  const weak = new Set(Object.values((o && o.entities) || {}).filter((e) => e && e.weak).flatMap((e) => e.aliases || []).map((x) => String(x).toLowerCase()));
  const regionWords = new Set(Object.values((o && o.regions) || {}).flat().map((x) => String(x).toLowerCase()));
  const out = [];
  for (const r of rows) {
    const k = String(r.name).toLowerCase();
    if (tracked.has(k) || aliasTracked.has(k) || weak.has(k)) continue;
    const rising = r.recent >= r.n - r.recent;
    if (!rising && r.imp < 60) continue;
    // 国家、地区（taxonomy 的地区词）建议按主线追踪，其余按公司 / 机构
    out.push({ name: r.name, kind: "entity", track_kind: regionWords.has(k) ? "theme" : "company", stories: r.n, recent: r.recent, rising, importance: Math.round(r.imp || 0) });
    if (out.length >= ((o && o.max) || 8)) break;
  }
  for (const th of (o && o.themes) || []) {
    if (tracked.has(String(th.name).toLowerCase())) continue;
    out.push({ name: th.name, kind: "theme", theme_kind: th.kind, stories: (th.stories || []).length, story_ids: th.stories || [] });
  }
  return out;
}

/** 版面出来后自动重写综述的对象：需要重写的里面，新动态最多的前 n 个。 */
export function synthTargets(db, n, o) {
  if (!n) return [];
  return db.prepare("SELECT id FROM trackers WHERE status = 'active'").all().map((r) => ({ id: r.id, fresh: needsSynthesis(db, r.id, o) })).filter((x) => x.fresh > 0).sort((a, b) => b.fresh - a.fresh).slice(0, n).map((x) => x.id);
}
