/**
 * 手机上回复序号：推送里每条都有当天唯一的序号，回复「3」看要点、「3 详」要详细报道、「3 有用 / 没用」调整以后推什么、「3 追踪」关注进展。
 * 推送因此可以只发标题和一句话，想看哪条再展开；每次回复也是一条反馈（展开、要详细报道算感兴趣）。
 *
 * 这里只有纯函数：解析回复、拼展开的消息、拼详细报道的消息、当天序号的编排。发消息、写库在 index.js。
 */
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** Markdown 里会被当成格式的字符换成全角（和推送消息一致）。 */
const md = (t) => String(t || "").replace(/[\[\]]/g, (c) => (c === "[" ? "［" : "］")).replace(/\*/g, "＊");

export const REPLY_HELP = "回复序号看要点（如「3」）；「3 详」写详细报道；「3 有用」「3 没用」调整以后推什么；「3 追踪」关注这件事的进展。";

/**
 * 解析一条回复。@returns { n, action: "expand"|"detail"|"up"|"down"|"follow", rest } 或 null（不是序号回复）
 * 「没用」要先于「有用」判断；只有序号就是展开。
 */
export function parseReply(text) {
  const m = /^\s*[#＃第]?\s*(\d{1,3})\s*[条.、:：]?\s*([\s\S]*)$/.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1]);
  const rest = m[2].trim();
  if (!n || rest.length > 12) return null; // 后面跟着一长句的不是序号回复（比如「3 月份的数据怎么样」）
  let action = "expand";
  if (/没用|不想看|不要|少推|别推|踩|👎|down/i.test(rest)) action = "down";
  else if (/有用|不错|喜欢|多推|赞|👍|up/i.test(rest)) action = "up";
  else if (/详|长文|全文|detail/i.test(rest)) action = "detail";
  else if (/追踪|关注|跟进|follow/i.test(rest)) action = "follow";
  else if (rest && !/^(要点|展开|看|more)?$/i.test(rest)) return null;
  return { n, action, rest };
}

/** 北京时间今天 0 点（UTC，库里的时间格式）。 */
export function bjDayStart(now) {
  const bj = new Date((now || Date.now()) + 8 * 3600000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
}

/** 给这一轮要推的报道编当天的序号（接着今天已推的往下编），写在 pick.n 上。picks 要已按消息里的顺序排好。 */
export function numberPicks(db, picks, now) {
  let base = 0;
  try { base = Number(db.prepare("SELECT MAX(n) m FROM pushes WHERE pushed_at >= ?").get(bjDayStart(now)).m) || 0; } catch { base = 0; }
  picks.forEach((p, i) => { p.n = base + i + 1; });
  return picks;
}

/** 序号 → 推过的故事线（最近的那次）。 */
export function storyOfNumber(db, n) {
  try { return db.prepare("SELECT story_id, pushed_at FROM pushes WHERE n = ? AND story_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(n) || null; } catch { return null; }
}

/** 这一轮要推的报道里，哪些挂在读者追踪的对象上：[{ name, stories: [故事线 id] }]，按命中多少排。 */
export function trackedIn(db, storyIds) {
  if (!storyIds.length) return [];
  let rows = [];
  try {
    rows = db.prepare("SELECT t.name, ts.story_id FROM tracker_stories ts JOIN trackers t ON t.id = ts.tracker_id WHERE t.status = 'active' AND ts.how != 'banned' AND ts.story_id IN (" + storyIds.map(() => "?").join(",") + ")").all(...storyIds);
  } catch { return []; }
  const by = new Map();
  for (const r of rows) { if (!by.has(r.name)) by.set(r.name, []); by.get(r.name).push(r.story_id); }
  return [...by].map(([name, stories]) => ({ name, stories })).sort((a, b) => b.stories.length - a.stories.length);
}

const hhmm = (utc) => { try { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(String(utc).replace(" ", "T") + "Z")).replace(/\//g, "-"); } catch { return ""; } };

/**
 * 展开一条：标题、导语、全部要点、各方说法、影响、最近的进展、来源链接。
 * @param d storyDetail() 的结果
 */
export function composeExpand(n, d) {
  const c = d.copy || {};
  const L = ["**" + n + ". " + md(d.title) + "**"];
  if (c.lead) L.push(md(c.lead));
  const pts = (c.points || []).map((p) => (typeof p === "string" ? p : p && p.text) || "").filter(Boolean);
  if (pts.length) { L.push(""); for (const t of pts) L.push("· " + md(t)); }
  const views = (c.views || []).map((v) => (v && v.who && v.says ? v.who + "：" + v.says : (v && v.text) || "")).filter(Boolean);
  if (views.length) { L.push("", "**各方说法**"); for (const t of views) L.push("· " + md(t)); }
  for (const b of c.extra || []) { if (b && b.name && b.text) L.push("", "**" + md(b.name) + "**", md(b.text)); }
  if (c.impact) L.push("", "影响：" + md(c.impact));
  const up = (d.updates || []).slice(-2);
  if (up.length) { L.push("", "**进展**"); for (const u of up) L.push("· " + hhmm(u.at).slice(-5) + " " + md(u.text)); }
  // 没有模型稿时（只有标题）：给最近几篇报道的原文开头
  if (!c.lead) for (const it of (d.items || []).slice(-3)) if (it.text) L.push("", md(clip(it.text, 240)));
  const seen = new Set();
  const links = (d.items || []).slice().reverse().filter((it) => it.url && !seen.has(it.source_id) && seen.add(it.source_id)).slice(0, 4).map((it) => "[" + md(String(it.source_name || it.source_id).replace(/·.*$/, "")) + "](" + it.url + ")");
  L.push("", (d.items || []).length + " 篇报道" + (links.length ? " · " + links.join("、") : ""));
  L.push("回复「" + n + " 详」写详细报道 · 「" + n + " 有用 / 没用」 · 「" + n + " 追踪」");
  return L.join("\n");
}

/** 详细报道发到手机的样子。@param dt latestDetail() 的结果 */
export function composeDetail(n, title, dt) {
  const L = ["📰 **" + (n ? n + ". " : "") + md(title) + "** · 详细报道"];
  const nw = (x) => (x.new ? "🆕 " : "");
  if (dt.since && dt.since.added) L.push("比上一篇新增 " + dt.since.added + " 条（标 🆕）");
  if (dt.overview && dt.overview.text) L.push("", md(dt.overview.text));
  if ((dt.timeline || []).length) { L.push("", "**经过**"); for (const x of dt.timeline) L.push("· " + nw(x) + (x.time ? md(x.time) + " " : "") + md(x.text)); }
  if ((dt.numbers || []).length) { L.push("", "**关键数字**"); for (const x of dt.numbers) L.push("· " + nw(x) + md(x.text)); }
  if ((dt.views || []).length) { L.push("", "**各方说法**"); for (const x of dt.views) L.push("· " + nw(x) + md(x.who) + "：" + md(x.says)); }
  if (dt.background && dt.background.text) L.push("", "**背景**", md(dt.background.text));
  if ((dt.open || []).length) { L.push("", "**说法不一或待确认**"); for (const x of dt.open) L.push("· " + nw(x) + md(x.text)); }
  const ck = dt.check || {};
  L.push("", "由 " + (dt.model || "模型") + " 读 " + ((dt.materials || []).length || dt.items || 0) + " 篇报道写成，逐句与原文核对" + (ck.dropped ? "（" + ck.dropped + " 句核对不上已删去）" : "") + "，可能有误，以原文为准。");
  return L.join("\n");
}
