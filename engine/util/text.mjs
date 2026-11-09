import crypto from "node:crypto";

export function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", middot: "·", emsp: " ", ensp: " ", thinsp: " ", zwsp: "", times: "×", yen: "¥", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»" };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (NAMED[n] !== undefined ? NAMED[n] : m));
}
export function stripTags(s) { return String(s).replace(/<[^>]*>/g, " "); }
export function clean(s) { return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim(); }

const TRACK = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "at_medium", "at_campaign", "at_format", "at_customisation", "twclid", "fbclid", "ref", "ref_src", "scid", "wvid", "sessionid", "spM", "spm", "from", "gource", "internalReferrer"];
export function canonicalUrl(u) {
  try {
    const x = new URL(u);
    for (const k of TRACK) x.searchParams.delete(k);
    x.hash = "";
    let s = x.toString();
    if (s.endsWith("/") && x.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch (e) { return String(u); }
}

export function normTitle(t) { return String(t).replace(/[\s\p{P}]+/gu, "").toLowerCase(); }

export function articleKey(url, title) {
  const cu = canonicalUrl(url);
  const t = normTitle(title || "");
  if (t) return sha1(cu + "|" + t);
  const m = String(url).match(/\/(?:detail|story|article|p|newsflashes)\/(\d{4,})/);
  return sha1(cu + "|" + (m ? m[1] : ""));
}

export function contentHash(title, body) { return sha1(normTitle(title) + "|" + String(body || "").toLowerCase().slice(0, 400)); }


export function resolveTime(raw, nowMs) {
  if (!raw) return '';
  const s = String(raw).trim();
  const now = new Date(nowMs || Date.now());
  const off = 8 * 3600 * 1000;
  const local = new Date(now.getTime() + off);
  const mk = (y, mo, d, hh, mi) => {
    const t = Date.UTC(y, mo - 1, d, hh || 0, mi || 0) - off;
    return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  };
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return mk(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  m = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return mk(local.getUTCFullYear(), Number(m[1]), Number(m[2]), 0, 0);
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]), mi = Number(m[2]);
    let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mi) - off;
    if (t > now.getTime() + 3600 * 1000) t -= 24 * 3600 * 1000;
    return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  }
  m = s.match(/(\d+)\s*(分钟前|小时前|天前|mins? ago|hours? ago|days? ago)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = /分钟|min/i.test(m[2]) ? 60000 : /小时|hour/i.test(m[2]) ? 3600000 : 86400000;
    return new Date(now.getTime() - n * unit).toISOString().replace('T', ' ').slice(0, 19);
  }
  if (/刚刚|just now/i.test(s)) return iso0(now);
  return '';
}

function iso0(d) { return new Date(d.getTime() - 0).toISOString().replace('T', ' ').slice(0, 19); }

export function parseDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().replace("T", " ").slice(0, 19);
  return "";
}

/** UTC 时间串 "YYYY-MM-DD HH:MM:SS"（库里统一用这个格式）。 */
export function isoUtc(d) { return new Date(d).toISOString().replace("T", " ").slice(0, 19); }

/** 秒或毫秒时间戳 → isoUtc；非法返回 ""。 */
export function fromEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  return isoUtc(n > 1e12 ? n : n * 1000);
}

/** 数值化：源头常给 "1.2万" / "3,456" / "" 之类。取不到返回 null（不是 0：0 是真实值，null 是没有）。 */
export function toCount(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/[,\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(万|w|k|千|亿)?\+?$/i);
  if (!m) return null;
  const mul = { "万": 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, "千": 1e3, "亿": 1e8 }[m[2] || ""] || 1;
  return Math.round(Number(m[1]) * mul);
}
