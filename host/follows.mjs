/**
 * 关注与屏蔽：存 dataDir/follows.json。
 *
 *   kind     value                         匹配
 *   story    故事线 id                     就是这条故事线
 *   keyword  「英伟达|NVIDIA」（| 分隔别名） 标题、各家报道标题与摘要里出现任一写法（不分大小写）
 *   topic    分类 id（如 study、macro.fx）  故事线的版块或标签等于它或以它开头
 *   source   源 id                          有这个源的报道（屏蔽时：这个源的新闻不进版面）
 *
 * 关注：版面里单列「我的关注」（不受上版门槛限制），推送门槛降到 min_follow，关注的故事线有新报道时再推一次。
 * 屏蔽：版面与推送里都不出现（屏蔽优先于关注）。
 */
import { readFileSync, existsSync } from "node:fs";

export const KINDS = ["story", "keyword", "topic", "source"];

export function emptyFollows() { return { version: 1, follow: [], mute: [] }; }

export function normalizeFollows(raw) {
  const out = emptyFollows();
  const r = raw && typeof raw === "object" ? raw : {};
  for (const list of ["follow", "mute"]) {
    const seen = new Set();
    for (const x of Array.isArray(r[list]) ? r[list] : []) {
      if (!x || !KINDS.includes(x.kind) || typeof x.value !== "string" || !x.value.trim()) continue;
      const value = x.value.trim().slice(0, 200);
      const key = x.kind + ":" + value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out[list].push(Object.assign({ kind: x.kind, value }, typeof x.name === "string" && x.name.trim() ? { name: x.name.trim().slice(0, 80) } : {}, x.added_at ? { added_at: String(x.added_at) } : {}));
    }
  }
  return out;
}

export function loadFollows(file) {
  if (!file || !existsSync(file)) return emptyFollows();
  try { return normalizeFollows(JSON.parse(readFileSync(file, "utf8"))); } catch { return emptyFollows(); }
}

/** 增删一项。@returns 新的 follows */
export function updateFollows(f, action, kind, value, name) {
  const cur = normalizeFollows(f);
  if (!KINDS.includes(kind) || typeof value !== "string" || !value.trim()) throw new Error("follow_invalid");
  const list = action === "follow" || action === "unfollow" ? "follow" : "mute";
  const other = list === "follow" ? "mute" : "follow";
  const same = (x) => x.kind === kind && x.value.toLowerCase() === value.trim().toLowerCase();
  cur[list] = cur[list].filter((x) => !same(x));
  if (action === "follow" || action === "mute") {
    cur[list].push(Object.assign({ kind, value: value.trim() }, name ? { name: String(name).slice(0, 80) } : {}, { added_at: new Date().toISOString() }));
    cur[other] = cur[other].filter((x) => !same(x)); // 关注与屏蔽互斥
  }
  return cur;
}

function hay(story, items) {
  return [story.title].concat((items || []).flatMap((it) => [it.title, it.summary])).filter(Boolean).join("\n").toLowerCase();
}

/** 一篇报道命中哪些项。@returns 命中的项（数组） */
export function matchList(list, story, items) {
  let text = null;
  const hits = [];
  for (const x of list || []) {
    let ok = false;
    if (x.kind === "story") ok = story.id === x.value;
    else if (x.kind === "topic") ok = [story.section].concat(story.labels || []).some((l) => l === x.value || String(l).startsWith(x.value + "."));
    else if (x.kind === "source") ok = (items || []).some((it) => it.source_id === x.value) || (story.outlets || []).some((o) => o.source_id === x.value);
    else if (x.kind === "keyword") { text = text || hay(story, items); ok = x.value.split("|").map((w) => w.trim().toLowerCase()).filter(Boolean).some((w) => text.includes(w)); }
    if (ok) hits.push(x);
  }
  return hits;
}

/**
 * 给报道标上关注（followed: 命中项的显示名）并去掉屏蔽的。
 * @param stories 带 _g.items 的报道；@returns 留下的报道
 */
export function applyFollows(stories, f) {
  if (!f || (!f.follow.length && !f.mute.length)) return stories;
  const muteSources = new Set(f.mute.filter((x) => x.kind === "source").map((x) => x.value));
  return stories.filter((s) => {
    const items = (s._g && s._g.items) || [];
    // 屏蔽某个源：只由这个源报道的故事线不出现
    const otherMutes = f.mute.filter((x) => x.kind !== "source");
    if (matchList(otherMutes, s, items).length) return false;
    if (muteSources.size && items.length && items.every((it) => muteSources.has(it.source_id))) return false;
    const hits = matchList(f.follow, s, items);
    if (hits.length) s.followed = hits.map((x) => x.name || (x.kind === "story" ? s.title : x.value.split("|")[0]));
    else delete s.followed;
    return true;
  });
}
