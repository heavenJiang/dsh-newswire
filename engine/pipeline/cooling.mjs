/**
 * 连续失败的源降频：一个源连续几轮都抓不到（超时、被墙、页面改版），每轮照抓只是白等——一次超时 30 秒起，还每轮提醒一遍。
 * 连续失败 FAILS 轮后进入「降频」：平时跳过，每 PROBE_HOURS 小时试一次；试成功就恢复照常抓取。
 * 指名抓某个源（--sources、面板里的「试抓」）不受影响。状态不另存，全由 continuity 表里这个源最近几次的结果算出来。
 */
export const COOLING = { fails: 3, probeHours: 6 };

const toMs = (t) => Date.parse(String(t || "").replace(" ", "T") + "Z");

/**
 * 一个源现在的状态。@returns null（正常）或 { fails: 连续失败的轮数, since: 第一次失败的时间, last: 最近一次尝试的时间, reason, probe_due: 现在该不该试一次, next_probe }
 */
export function coolingOf(db, sourceId, o) {
  const C = Object.assign({}, COOLING, o || {});
  const now = (o && o.now) || Date.now();
  const rows = db.prepare(`SELECT c.status, c.note, r.started_at FROM continuity c JOIN runs r ON r.run_id = c.run_id
    WHERE c.source_id = ? ORDER BY r.started_at DESC LIMIT 30`).all(sourceId);
  let fails = 0;
  for (const r of rows) { if (r.status !== "failed") break; fails++; }
  if (fails < C.fails) return null;
  const last = rows[0].started_at;
  const next = toMs(last) + C.probeHours * 3600000;
  return { fails, since: rows[fails - 1].started_at, last, reason: String(rows[0].note || "").split(" -> ").pop() || "", probe_due: now >= next, next_probe: new Date(next).toISOString().replace("T", " ").slice(0, 19) };
}

/** 一批源里正在降频的：id → 状态。 */
export function coolingMap(db, ids, o) {
  const out = new Map();
  for (const id of ids) { const c = coolingOf(db, id, o); if (c) out.set(id, c); }
  return out;
}
