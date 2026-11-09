/**
 * 源头热度信号归一化。只收源头真实给出的值：取不到就是 null（不是 0）。
 * 标准字段：views / comments / likes / shares / favorites（计数），hot（标记数组，保留源头原文），
 *          level（源头自己的重要级别原值），rank（列表位置，0 起），section（所在区块）。
 */
import { toCount } from "../util/text.mjs";

export const COUNT_FIELDS = ["views", "comments", "likes", "shares", "favorites"];
export const SIGNAL_FIELDS = COUNT_FIELDS.concat(["hot", "level", "rank", "section"]);

/** 早期配置的 metrics 字段名（财联社 browse 采集、旧 json_api 映射）→ 标准字段。 */
const LEGACY = { reading: "views", reading_num: "views", read: "views", share: "shares", share_num: "shares", comments: "comments", comment_num: "comments", likes: "likes", level: "level" };

export function normalizeSignals(item, index) {
  const s = Object.assign({}, item && item.signals);
  const m = (item && item.metrics) || {};
  const raw = Object.assign({}, item && item.signals_raw);
  for (const [k, std] of Object.entries(LEGACY)) {
    if (m[k] !== undefined && m[k] !== null && m[k] !== "" && (s[std] === undefined || s[std] === null)) { s[std] = m[k]; raw[k] = m[k]; }
  }
  if (Array.isArray(m.subjects) && m.subjects.length) raw.subjects = m.subjects;
  const out = { views: null, comments: null, likes: null, shares: null, favorites: null, hot: [], level: null, rank: null, section: null, raw };
  for (const f of COUNT_FIELDS) out[f] = toCount(s[f]);
  if (Array.isArray(s.hot)) out.hot = Array.from(new Set(s.hot.map((x) => String(x).trim()).filter(Boolean)));
  else if (typeof s.hot === "string" && s.hot.trim()) out.hot = [s.hot.trim()];
  else if (s.hot === true) out.hot = ["hot"];
  if (s.level !== undefined && s.level !== null && s.level !== "") out.level = String(s.level);
  const r = Number(s.rank);
  out.rank = Number.isFinite(r) && s.rank !== null && s.rank !== undefined ? r : Number.isFinite(index) ? index : null;
  if (typeof s.section === "string" && s.section.trim()) out.section = s.section.trim();
  return out;
}

/** 该条实际带了哪些信号（写 signal_availability 用）。rank 总是有，不计入。 */
export function presentSignals(sig) {
  const out = [];
  for (const f of COUNT_FIELDS) if (sig[f] !== null) out.push(f);
  if (sig.hot.length) out.push("hot");
  if (sig.level !== null) out.push("level");
  if (sig.section !== null) out.push("section");
  return out;
}
