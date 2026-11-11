/**
 * 插件自己的时钟：直接推送可用时（桥接插件提供 phonePush 服务），定时推送不再经过宿主定时任务里的模型，
 * 由插件按那个任务的 cron 自己到点抓取、编排、推送。这里只放纯函数：解析五段 cron、判断某一分钟是否到点、算下一次。
 *
 * cron 语义同 Vixie cron：分 时 日 月 周（0 和 7 都是周日）；支持 *、n、a-b、*\/s、a-b/s 和逗号列表；
 * 「日」和「周」都不是 * 时，满足其一即可。时间按给定时区的墙上时间算。
 */

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** 一段 → 允许的值集合；写错返回 null。 */
function field(text, [lo, hi]) {
  const out = new Set();
  for (const part of String(text).split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let a = lo, b = hi;
    if (m[1] !== "*") { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : a; }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (!(a >= lo && b <= hi && a <= b && step >= 1)) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** "0 7-21/2 * * *" → { min, hour, dom, mon, dow, domAny, dowAny }；不是合法的五段 cron 返回 null。 */
export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => field(p, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  if (sets[4].has(7)) sets[4].add(0);
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4], domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

const WEEK = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmts = new Map();
/** 某一时刻在时区里的墙上时间。 */
export function wallClock(date, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { min: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), mon: Number(p.month), dow: WEEK[p.weekday], ymd: p.year + "-" + p.month + "-" + p.day };
}

/** 这一分钟（时区里的墙上时间）是否到点。 */
export function cronMatches(cron, date, tz) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  if (!c) return false;
  const w = wallClock(date, tz);
  if (!c.min.has(w.min) || !c.hour.has(w.hour) || !c.mon.has(w.mon)) return false;
  const d = c.dom.has(w.dom), k = c.dow.has(w.dow);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return k;
  if (c.dowAny) return d;
  return d || k;
}

/** 从 from（不含这一分钟）往后最近的一次，最多看 8 天；没有返回 null。 */
export function nextCron(cron, tz, from) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  if (!c) return null;
  let t = Math.floor((from instanceof Date ? from.getTime() : Number(from || Date.now())) / 60000) * 60000 + 60000;
  for (let i = 0; i < 8 * 24 * 60; i++, t += 60000) if (cronMatches(c, new Date(t), tz)) return new Date(t);
  return null;
}

/** 一分钟的键（同一分钟只触发一次）。 */
export const minuteKey = (date) => Math.floor((date instanceof Date ? date.getTime() : Number(date)) / 60000);
