/**
 * 数据保留：库里只增不减的几张表定期清理（每天一次，模型和抓取都闲着的时候）。
 *
 *   - 版面（最占地方：每份几百 KB，一天几十份）：近 48 小时的全留；更早的每个主题包每天只留最后一份；超过 30 天的删掉。
 *     每个主题包最新的一份永远留着。版面里每条新闻的归属（edition_items）跟着版面走。
 *   - 模型调用账本、抓取记录、榜单观测：留 30 天。
 *   - 详细报道每条故事线留最近 2 篇，影响分析留最近 3 篇，追踪综述每个对象留最近 5 篇。
 *
 * 文章、故事线、推送记录、读者反馈不清理。删得多了（空页超过两成）顺手收缩文件。
 */
export const RETENTION = { editionKeepAllHours: 48, editionKeepDailyDays: 30, logDays: 30, details: 2, analyses: 3, syntheses: 5 };

const sql = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const has = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

/**
 * @param o { now?: ms, vacuum?: boolean（默认 true）, 以及 RETENTION 里的任一项 }
 * @returns { editions, edition_items, llm_calls, fetch_attempts, observations, story_details, story_analyses, tracker_syntheses, vacuumed }
 */
export function prune(db, o) {
  const R = Object.assign({}, RETENTION, o || {});
  const now = R.now || Date.now();
  const out = { editions: 0, edition_items: 0, llm_calls: 0, fetch_attempts: 0, observations: 0, story_details: 0, story_analyses: 0, tracker_syntheses: 0, vacuumed: false };
  const run = (stmt, ...args) => Number(db.prepare(stmt).run(...args).changes) || 0;

  if (has(db, "editions")) {
    const recent = sql(now - R.editionKeepAllHours * 3600000);
    const oldest = sql(now - R.editionKeepDailyDays * 86400000);
    // 留下的：每个主题包最新的一份；近 48 小时的；30 天内每个主题包每天的最后一份
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _keep_editions (id INTEGER PRIMARY KEY); DELETE FROM _keep_editions;");
    db.prepare("INSERT OR IGNORE INTO _keep_editions SELECT MAX(id) FROM editions GROUP BY pack").run();
    db.prepare("INSERT OR IGNORE INTO _keep_editions SELECT id FROM editions WHERE created_at >= ?").run(recent);
    db.prepare("INSERT OR IGNORE INTO _keep_editions SELECT MAX(id) FROM editions WHERE created_at >= ? GROUP BY pack, substr(created_at, 1, 10)").run(oldest);
    if (has(db, "edition_items")) out.edition_items = run("DELETE FROM edition_items WHERE edition_id NOT IN (SELECT id FROM _keep_editions)");
    out.editions = run("DELETE FROM editions WHERE id NOT IN (SELECT id FROM _keep_editions)");
    db.exec("DROP TABLE _keep_editions");
  }
  const logSince = sql(now - R.logDays * 86400000);
  if (has(db, "llm_calls")) out.llm_calls = run("DELETE FROM llm_calls WHERE at < ?", logSince);
  if (has(db, "fetch_attempts")) out.fetch_attempts = run("DELETE FROM fetch_attempts WHERE attempted_at < ?", logSince);
  if (has(db, "observations")) out.observations = run("DELETE FROM observations WHERE seen_at < ?", logSince);
  // 每个对象只留最近 n 篇
  const keepLast = (table, key, n) => (has(db, table) ? run(`DELETE FROM ${table} WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY id DESC) rn FROM ${table}) WHERE rn > ?)`, n) : 0);
  out.story_details = keepLast("story_details", "story_id", R.details);
  out.story_analyses = keepLast("story_analyses", "story_id", R.analyses);
  out.tracker_syntheses = keepLast("tracker_syntheses", "tracker_id", R.syntheses);

  if (R.vacuum !== false) {
    try {
      const free = Number(db.prepare("PRAGMA freelist_count").get().freelist_count) || 0;
      const pages = Number(db.prepare("PRAGMA page_count").get().page_count) || 1;
      if (free / pages > 0.2) { db.exec("VACUUM"); out.vacuumed = true; }
    } catch { /* 别的连接正在读：下次再收缩 */ }
  }
  return out;
}
