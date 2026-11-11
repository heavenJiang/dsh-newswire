/**
 * 推送体验。
 *
 * 宿主的定时任务每次触发，Agent 的回复都会推到手机——没有「这一轮不发」的办法。
 * 所以打扰多少，首先由「什么时候、多久推一次」决定：推送节奏直接改定时任务的时间。
 * 每一轮里：门槛档位（少而精 / 适中 / 多一些）、每轮条数上限、每天条数上限；
 * 读者在面板里对推送点「有用 / 没用」，同一版块近 14 天「没用」比「有用」多 3 次以上，这个版块的门槛自动提高。
 *
 * 推送时机 timing：on_time 到点推（来不及就先推已编好的版面）/ when_ready 到点只抓取，本轮版面写完再推一条。
 * 推送内容 scope：picked 按门槛和上限挑重点 / full 本轮所有新报道和有进展的报道都推（不受门槛和上限限制）。
 *
 * 推送方式 delivery：auto 有桥接插件的 phonePush 服务时由插件直接发到手机（不经过定时任务里的模型），没有时经定时任务 / task 总是经定时任务。
 *
 * 消息长短 format：brief 每条只发标题、一句话和来源，读者回复序号再展开（要点、详细报道、有用没用）/ full 重点带要点和影响。
 *
 * 反馈：点「有用 / 没用」是明确的；在手机上回复序号展开、要详细报道、关注进展，或在面板里打开推过的故事线，算「感兴趣」（半票有用）。
 *
 * 偏好存 dataDir/push.json：{ version, cadence, level, per_round, daily_max, timing, scope, delivery, format }
 */
import fs from "node:fs";

export const CADENCES = {
  every2h: { cron: "0 7-21/2 * * *", label: "每 2 小时（07–21 点）" },
  every4h: { cron: "0 8,12,16,20 * * *", label: "每 4 小时（8、12、16、20 点）" },
  thrice: { cron: "0 8,12,18 * * *", label: "早中晚三次（8、12、18 点）" },
  daily_only: { cron: null, label: "只看晚间日报（不推送每轮要闻）" },
};
export const LEVELS = { fewer: 12, normal: 0, more: -8 };
export const TIMINGS = ["on_time", "when_ready"];
export const SCOPES = ["picked", "full"];
export const DELIVERIES = ["auto", "task"];
export const FORMATS = ["brief", "full"];
export const PUSH_DEFAULTS = { version: 1, cadence: "every2h", level: "normal", per_round: 6, daily_max: 24, timing: "on_time", scope: "picked", delivery: "auto", format: "brief" };

export function normalizePush(p) {
  const x = Object.assign({}, PUSH_DEFAULTS, p && typeof p === "object" ? p : {});
  if (!CADENCES[x.cadence]) x.cadence = PUSH_DEFAULTS.cadence;
  if (!(x.level in LEVELS)) x.level = PUSH_DEFAULTS.level;
  x.per_round = Math.max(1, Math.min(15, Math.round(Number(x.per_round) || PUSH_DEFAULTS.per_round)));
  x.daily_max = Math.max(1, Math.min(100, Math.round(Number(x.daily_max) || PUSH_DEFAULTS.daily_max)));
  if (!TIMINGS.includes(x.timing)) x.timing = PUSH_DEFAULTS.timing;
  if (!SCOPES.includes(x.scope)) x.scope = PUSH_DEFAULTS.scope;
  if (!DELIVERIES.includes(x.delivery)) x.delivery = PUSH_DEFAULTS.delivery;
  if (!FORMATS.includes(x.format)) x.format = PUSH_DEFAULTS.format;
  return { version: 1, cadence: x.cadence, level: x.level, per_round: x.per_round, daily_max: x.daily_max, timing: x.timing, scope: x.scope, delivery: x.delivery, format: x.format };
}

export function loadPush(file) {
  try { return normalizePush(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return normalizePush(null); }
}
export function savePush(file, p) {
  const x = normalizePush(p);
  fs.writeFileSync(file, JSON.stringify(x, null, 2) + "\n");
  return x;
}

/** 北京时间今天 0 点（UTC，库里的时间格式）。 */
export function bjMidnightUtc(now) {
  const d = new Date(now || Date.now());
  const bj = new Date(d.getTime() + 8 * 3600000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}

/** 算「感兴趣」的行为：回复序号展开、要详细报道、关注进展、在面板里打开推过的故事线。 */
export const INTEREST_KINDS = ["push_open", "push_detail", "push_follow", "open"];
/**
 * 各版块按读者反馈调的门槛：近 14 天「没用」比「有用」多 ≥3 次 +10，≥6 次 +20。
 * 「感兴趣」的行为每次算半票有用：常点开看的版块不会因为偶尔几个「没用」被调高门槛。
 */
export function sectionPenalties(db) {
  const rows = db.prepare(`SELECT note AS section, SUM(CASE WHEN kind = 'push_down' THEN 1 ELSE 0 END) down, SUM(CASE WHEN kind = 'push_up' THEN 1 ELSE 0 END) up,
      SUM(CASE WHEN kind IN (${INTEREST_KINDS.map((k) => "'" + k + "'").join(",")}) THEN 1 ELSE 0 END) interest
    FROM feedback WHERE kind IN ('push_up', 'push_down', ${INTEREST_KINDS.map((k) => "'" + k + "'").join(",")}) AND at >= datetime('now', '-14 days') AND note IS NOT NULL GROUP BY note`).all();
  const out = {};
  for (const r of rows) { const net = r.down - r.up - r.interest * 0.5; if (net >= 6) out[r.section] = 20; else if (net >= 3) out[r.section] = 10; }
  return out;
}

/** 记一次「感兴趣」：同一条故事线同一种行为一天只记一次。@returns 记了没有 */
export function noteInterest(db, kind, storyId, now) {
  if (!INTEREST_KINDS.includes(kind) || !storyId) return false;
  const at = new Date(now || Date.now()).toISOString().replace("T", " ").slice(0, 19);
  if (db.prepare("SELECT 1 FROM feedback WHERE kind = ? AND story_id = ? AND at >= datetime(?, '-1 day')").get(kind, storyId, at)) return false;
  const st = db.prepare("SELECT section FROM stories WHERE story_id = ?").get(storyId);
  db.prepare("INSERT INTO feedback (at, kind, story_id, note) VALUES (?,?,?,?)").run(at, kind, storyId, st ? st.section : null);
  return true;
}

/** 近 14 天的反馈统计（面板显示用）：明确的有用 / 没用、感兴趣的次数、推了多少条。 */
export function feedbackStats(db) {
  const r = db.prepare(`SELECT SUM(kind = 'push_up') up, SUM(kind = 'push_down') down, SUM(kind IN (${INTEREST_KINDS.map((k) => "'" + k + "'").join(",")})) interest FROM feedback WHERE at >= datetime('now', '-14 days')`).get() || {};
  const p = db.prepare("SELECT COUNT(*) n FROM pushes WHERE pushed_at >= datetime('now', '-14 days')").get();
  return { up: r.up || 0, down: r.down || 0, interest: r.interest || 0, pushed: p.n || 0 };
}

/** 按档位调门槛（关注的门槛不动）。 */
export function rulesFor(rules, prefs) {
  const d = LEVELS[prefs.level] || 0;
  return Object.assign({}, rules, {
    min_corroborated: Math.max(10, (rules.min_corroborated ?? 50) + d),
    min_single: Math.max(10, (rules.min_single ?? 36) + d),
    max: Math.min(rules.max || 8, prefs.per_round),
  });
}

/** 每天上限：今天已推的条数之外还能推几条。@returns { send, held } */
export function applyDailyCap(db, picks, prefs, now) {
  const today = db.prepare("SELECT COUNT(*) n FROM pushes WHERE pushed_at >= ?").get(bjMidnightUtc(now)).n;
  const left = Math.max(0, prefs.daily_max - today);
  // 关注的优先留下
  const ordered = picks.slice().sort((a, b) => (b.followed && b.followed.length ? 1 : 0) - (a.followed && a.followed.length ? 1 : 0));
  const send = ordered.slice(0, left);
  return { send: picks.filter((p) => send.includes(p)), held: picks.length - send.length, today };
}

/** 面板「推送记录」：最近推过的，带读者反馈。 */
export function recentPushes(db, limit) {
  const rows = db.prepare(`SELECT p.id, p.pushed_at, p.reason, p.score, p.story_id, COALESCE(st.title, a.title) AS title, st.section, a.url
    FROM pushes p LEFT JOIN stories st ON st.story_id = p.story_id LEFT JOIN articles a ON a.id = p.article_id ORDER BY p.id DESC LIMIT ?`).all(limit || 40);
  const fb = db.prepare("SELECT kind FROM feedback WHERE kind IN ('push_up', 'push_down') AND story_id = ? ORDER BY id DESC LIMIT 1");
  return rows.map((r) => Object.assign({}, r, { vote: r.story_id ? ((fb.get(r.story_id) || {}).kind || null) : null }));
}
