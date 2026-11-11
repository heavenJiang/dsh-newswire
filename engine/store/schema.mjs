/**
 * 表结构与迁移。版本号记在 PRAGMA user_version，按序执行未跑过的迁移；每步一个事务。
 * 插件 Host 与引擎子进程都会调 openDb，所以迁移必须幂等且能并发（BEGIN IMMEDIATE + 事务内复查版本）。
 *
 * v1  基础表：sources / runs / articles / fetch_attempts（+ v_failed_sources 视图）
 * v2  articles 增 title_norm/time_confidence/parser_version/pack；sources 增 weight/tier/grp/pack/adapter/removed_at；
 *     fetch_attempts 增 backend/note；新表 observations（每轮每条的位置与热度信号）、signal_availability；
 *     articles_fts（trigram 全文检索）；published_at 空串改 NULL。
 * v3  source_cursors（断点游标）、continuity（每轮每源衔接状态）、coverage_gaps（缺口与补抓结果）、pushes（推送记录）。
 * v4  article_labels（多标签 + 地区）、events / event_members / event_scores（跨源事件、成员、打分轨迹）；pushes 增 credibility。
 * v5  时间线回看用的索引（按轮次取新事件 / 新条目、按日取运行）。
 * v6  article_bodies（重点事件的正文两段式抓取）。
 * v7  runs.pack（主题包：隔夜判断与回看按包计算）。
 * v8  briefings（模型生成的简报）；事件解读写在已有的 events.llm_notes。
 * v9  editions / edition_items（版面，规则或模型编排）。
 * v10 stories / story_items（跨版面延续的故事线）；pushes.story_id。
 * v11 story_updates（故事线进展）、kv（上次查看时间等状态）。
 * v12 digests（日报）、feedback（读者报错）。
 * v22 article_bodies.list_len（判断列表是否全文）；按新规则清理已入库正文、重算完整度。
 * v23 write_cache：模型写好的稿按材料指纹存下来，中断或重启后重编时同样的材料不再让模型重写。
 */
import { completeness } from "../pipeline/quality.mjs";
import { anchorReader, trimTail, relevant, MIN_SHORT } from "../pipeline/bodytext.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { normTitle } from "../util/text.mjs";

const V1 = [
  "CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, name TEXT, category TEXT, region TEXT, lang TEXT, type TEXT, url TEXT, channels TEXT, enabled INTEGER DEFAULT 1, max_items INTEGER, paywall INTEGER DEFAULT 0, note TEXT, updated_at TEXT)",
  "CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, mode TEXT, sources_total INTEGER, sources_ok INTEGER, sources_failed INTEGER, items_raw INTEGER, items_new INTEGER, items_dup INTEGER, notes TEXT)",
  "CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, url TEXT, canonical_url TEXT, title TEXT, summary TEXT, content TEXT, published_at TEXT, fetched_at TEXT, first_seen_at TEXT, last_seen_at TEXT, source_id TEXT, category TEXT, region TEXT, lang TEXT, channel TEXT, paywalled INTEGER DEFAULT 0, metrics TEXT, content_hash TEXT, raw_path TEXT, text_len INTEGER, training_ready INTEGER DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_articles_cat ON articles(category, published_at)",
  "CREATE INDEX IF NOT EXISTS idx_articles_src ON articles(source_id, fetched_at)",
  "CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash)",
  "CREATE TABLE IF NOT EXISTS fetch_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, source_id TEXT, channel TEXT, url TEXT, ok INTEGER, http_status INTEGER, bytes INTEGER, items INTEGER, latency_ms INTEGER, error_kind TEXT, error TEXT, hint TEXT, attempted_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_run ON fetch_attempts(run_id, ok)",
  "CREATE VIEW IF NOT EXISTS v_failed_sources AS SELECT run_id, source_id, group_concat(channel || ':' || COALESCE(error_kind, '?'), ' -> ') AS chain FROM fetch_attempts WHERE ok = 0 GROUP BY run_id, source_id",
];

const V2 = [
  "ALTER TABLE articles ADD COLUMN title_norm TEXT",
  "ALTER TABLE articles ADD COLUMN time_confidence TEXT",
  "ALTER TABLE articles ADD COLUMN parser_version TEXT",
  "ALTER TABLE articles ADD COLUMN pack TEXT",
  "ALTER TABLE sources ADD COLUMN weight REAL",
  "ALTER TABLE sources ADD COLUMN tier TEXT",
  "ALTER TABLE sources ADD COLUMN grp TEXT",
  "ALTER TABLE sources ADD COLUMN pack TEXT",
  "ALTER TABLE sources ADD COLUMN adapter TEXT",
  "ALTER TABLE sources ADD COLUMN removed_at TEXT",
  "ALTER TABLE fetch_attempts ADD COLUMN backend TEXT",
  "ALTER TABLE fetch_attempts ADD COLUMN note TEXT",
  // 每轮每条：在源列表中的位置 + 源头热度信号。同一条新闻在多轮出现 → 热度时间序列。
  "CREATE TABLE IF NOT EXISTS observations (run_id TEXT, source_id TEXT, article_id TEXT, rank INTEGER, page INTEGER DEFAULT 0, section TEXT, views INTEGER, comments INTEGER, likes INTEGER, shares INTEGER, favorites INTEGER, hot TEXT, level TEXT, signals_raw TEXT, channel TEXT, seen_at TEXT, PRIMARY KEY (run_id, source_id, article_id))",
  "CREATE INDEX IF NOT EXISTS idx_obs_article ON observations(article_id, seen_at)",
  "CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source_id, seen_at)",
  "CREATE TABLE IF NOT EXISTS signal_availability (source_id TEXT, signal TEXT, seen_count INTEGER DEFAULT 0, last_seen_at TEXT, PRIMARY KEY (source_id, signal))",
  "CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at)",
  "UPDATE articles SET published_at = NULL WHERE published_at = ''",
  "UPDATE articles SET time_confidence = COALESCE(json_extract(metrics, '$.time_from'), CASE WHEN published_at IS NULL THEN 'fetched' ELSE 'feed' END) WHERE time_confidence IS NULL",
  "UPDATE articles SET pack = 'core' WHERE pack IS NULL",
  "UPDATE articles SET parser_version = '0.2.0/legacy' WHERE parser_version IS NULL",
  "CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(title, summary, content='articles', content_rowid='rowid', tokenize='trigram')",
  "CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON articles BEGIN INSERT INTO articles_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END",
  "CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON articles BEGIN INSERT INTO articles_fts(articles_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary); END",
  "CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE OF title, summary ON articles BEGIN INSERT INTO articles_fts(articles_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary); INSERT INTO articles_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary); END",
  "INSERT INTO articles_fts(articles_fts) VALUES ('rebuild')",
  (db) => {
    const up = db.prepare("UPDATE articles SET title_norm = ? WHERE id = ?");
    for (const r of db.prepare("SELECT id, title FROM articles WHERE title_norm IS NULL").all()) up.run(normTitle(r.title || ""), r.id);
  },
];

const V3 = [
  // 每源断点：上轮成功时间、最新 N 条去重键（键重叠是主判据）、可信时间范围、数字 id 上界（id_walk）、API 游标
  "CREATE TABLE IF NOT EXISTS source_cursors (source_id TEXT PRIMARY KEY, last_ok_run_id TEXT, last_ok_at TEXT, head_keys TEXT, head_time TEXT, tail_time TEXT, max_id INTEGER, page_cursor TEXT, updated_at TEXT)",
  // 每轮每源：first | connected | connected_time | gap_filled | gap_partial | gap_open | snapshot | failed
  "CREATE TABLE IF NOT EXISTS continuity (run_id TEXT, source_id TEXT, status TEXT, overlap INTEGER, pages INTEGER, backfilled INTEGER, gap_from TEXT, gap_to TEXT, note TEXT, PRIMARY KEY (run_id, source_id))",
  "CREATE INDEX IF NOT EXISTS idx_continuity_source ON continuity(source_id, run_id)",
  "CREATE TABLE IF NOT EXISTS coverage_gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, run_id TEXT, gap_from TEXT, gap_to TEXT, status TEXT, method TEXT, recovered INTEGER, note TEXT, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_gaps_source ON coverage_gaps(source_id, gap_from)",
  // 推送记录：早期以条目为单位（article_id），现在以事件为单位（event_id）
  "CREATE TABLE IF NOT EXISTS pushes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, article_id TEXT, event_id TEXT, pack TEXT, score REAL, reason TEXT, pushed_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_pushes_article ON pushes(article_id)",
  "CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode, started_at)",
];

const V4 = [
  // 标签：分类（如 macro.monetary）与地区（region:US）同表；origin = rule | source | llm；rules_version 便于规则升级后重算
  "CREATE TABLE IF NOT EXISTS article_labels (article_id TEXT, label TEXT, confidence REAL, origin TEXT, rules_version TEXT, PRIMARY KEY (article_id, label))",
  "CREATE INDEX IF NOT EXISTS idx_labels_label ON article_labels(label)",
  // 事件：跨源报道同一件事的聚合。credibility = single | corroborated | confirmed | disputed
  "CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, pack TEXT, title TEXT, lead_article_id TEXT, first_seen_at TEXT, last_seen_at TEXT, member_count INTEGER, source_count INTEGER, outlets TEXT, region_mix TEXT, importance REAL, credibility TEXT, labels TEXT, regions TEXT, entities TEXT, factors TEXT, dispute TEXT, llm_notes TEXT, version INTEGER, created_run TEXT, updated_run TEXT, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_events_last ON events(last_seen_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_importance ON events(importance)",
  // 每条文章至多属于一个事件
  "CREATE TABLE IF NOT EXISTS event_members (event_id TEXT, article_id TEXT, source_id TEXT, grp TEXT, similarity REAL, method TEXT, joined_at TEXT, joined_run TEXT, PRIMARY KEY (event_id, article_id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_members_article ON event_members(article_id)",
  "CREATE TABLE IF NOT EXISTS event_scores (event_id TEXT, run_id TEXT, importance REAL, source_count INTEGER, credibility TEXT, factors TEXT, scored_at TEXT, PRIMARY KEY (event_id, run_id))",
  "ALTER TABLE pushes ADD COLUMN credibility TEXT",
  "CREATE INDEX IF NOT EXISTS idx_pushes_event ON pushes(event_id)",
];

const V5 = [
  "CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_run, importance)",
  "CREATE INDEX IF NOT EXISTS idx_articles_first ON articles(first_seen_at)",
  "CREATE INDEX IF NOT EXISTS idx_obs_run ON observations(run_id)",
];

const V6 = [
  // 正文：只为重点事件的成员抓，每轮有预算；extractor 记录用哪种方法抽出（json-ld / paragraphs / reader）
  "CREATE TABLE IF NOT EXISTS article_bodies (article_id TEXT PRIMARY KEY, content TEXT, text_len INTEGER, extractor TEXT, channel TEXT, paywalled INTEGER DEFAULT 0, ok INTEGER DEFAULT 1, error TEXT, fetched_at TEXT, run_id TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_bodies_run ON article_bodies(run_id)",
];

const V7 = [
  "ALTER TABLE runs ADD COLUMN pack TEXT",
  "UPDATE runs SET pack = 'all' WHERE pack IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_runs_pack ON runs(mode, pack, started_at)",
  "CREATE INDEX IF NOT EXISTS idx_events_pack ON events(pack, last_seen_at)",
];

const V8 = [
  // 模型生成的简报：一轮（或手动）一份，content 为 { headline, points:[{text, event_ids}], watch:[{text, event_ids}] }
  "CREATE TABLE IF NOT EXISTS briefings (id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT, run_id TEXT, created_at TEXT, model TEXT, hours INTEGER, headline TEXT, content TEXT, event_ids TEXT, ok INTEGER DEFAULT 1, error TEXT, ms INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_briefings_pack ON briefings(pack, created_at)",
];

// v9：版面。editions 存整份版面（规则或模型编排）；edition_items 记每条新闻在版面里被归到哪个报道、哪个版块、多重要——模型的判断留作训练标签。
const V9 = [
  "CREATE TABLE IF NOT EXISTS editions (id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT, run_id TEXT, created_at TEXT, mode TEXT, model TEXT, layout_version INTEGER, hours REAL, items_read INTEGER, headline TEXT, content TEXT, ok INTEGER DEFAULT 1, error TEXT, ms INTEGER, calls INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_editions_pack ON editions(pack, created_at)",
  "CREATE TABLE IF NOT EXISTS edition_items (edition_id INTEGER, story_id TEXT, article_id TEXT, event_id TEXT, section TEXT, labels TEXT, importance REAL, PRIMARY KEY (edition_id, article_id))",
  "CREATE INDEX IF NOT EXISTS idx_edition_items_article ON edition_items(article_id)",
];
// v10：故事线。stories 是跨版面延续的报道（标题、版块、标签、重要度、模型写的稿及写稿时的条数）；story_items 记每条新闻属于哪条故事线（一条新闻只属于一条）；推送记故事线。
const V10 = [
  "CREATE TABLE IF NOT EXISTS stories (story_id TEXT PRIMARY KEY, pack TEXT, title TEXT, section TEXT, labels TEXT, importance REAL, status TEXT DEFAULT 'active', merged_into TEXT, copy TEXT, created_at TEXT, updated_at TEXT, created_edition INTEGER, updated_edition INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_stories_updated ON stories(updated_at)",
  "CREATE TABLE IF NOT EXISTS story_items (article_id TEXT PRIMARY KEY, story_id TEXT, event_id TEXT, joined_at TEXT, joined_edition INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_story_items_story ON story_items(story_id)",
  "ALTER TABLE pushes ADD COLUMN story_id TEXT",
  "CREATE INDEX IF NOT EXISTS idx_pushes_story ON pushes(story_id)",
];
// v11：故事线进展与查看记录。story_updates 是每份版面里某条故事线「相比上次的新进展」；kv 存简单的状态（如上次查看时间）。
const V11 = [
  "CREATE TABLE IF NOT EXISTS story_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, story_id TEXT, edition_id INTEGER, at TEXT, text TEXT, items INTEGER, by TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_story_updates_story ON story_updates(story_id, at)",
  "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_story_items_joined ON story_items(joined_at)",
];
// v12：日报与读者报错。digests 每天每包一份（可重写，保留历次）；feedback 记读者指出的错句与放错故事线的报道（留作训练标签，也用于下次写稿与归并）。
const V12 = [
  "CREATE TABLE IF NOT EXISTS digests (id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT, date TEXT, created_at TEXT, mode TEXT, model TEXT, headline TEXT, content TEXT, ms INTEGER, calls INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(pack, date)",
  "CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, story_id TEXT, edition_id INTEGER, target TEXT, text TEXT, note TEXT, article_id TEXT, resolved_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_story ON feedback(story_id)",
];
// v13：内容质量。kind 区分正常新闻、广告与付费引流（promo）、合集（digest，拆成 digest_item 后本身不再参与）；
// kind_by 记是谁判的（rule / llm / reader，读者的判断优先）；completeness 记内容全不全（full / truncated / title_only）。
const V13 = [
  "ALTER TABLE articles ADD COLUMN kind TEXT",
  "ALTER TABLE articles ADD COLUMN kind_by TEXT",
  "ALTER TABLE articles ADD COLUMN kind_note TEXT",
  "ALTER TABLE articles ADD COLUMN parent_id TEXT",
  "ALTER TABLE articles ADD COLUMN completeness TEXT",
  "CREATE INDEX IF NOT EXISTS idx_articles_kind ON articles(kind)",
  "CREATE INDEX IF NOT EXISTS idx_articles_parent ON articles(parent_id)",
  (db) => {
    const up = db.prepare("UPDATE articles SET completeness = ? WHERE id = ?");
    for (const a of db.prepare("SELECT id, title, summary, content FROM articles").all()) up.run(completeness(a), a.id);
  },
];
// v14：正文抓取耗时，按源学「怎么拿正文」用（便宜的逐条补，慢的只补重点）。
const V14 = [
  "ALTER TABLE article_bodies ADD COLUMN ms INTEGER",
  // 快讯「标题即全文」改判为完整
  (db) => {
    const up = db.prepare("UPDATE articles SET completeness = ? WHERE id = ?");
    for (const a of db.prepare("SELECT id, title, summary, content FROM articles WHERE completeness = 'title_only'").all()) { const c = completeness(a); if (c !== "title_only") up.run(c, a.id); }
  },
];
// v15：源的「试用」状态——照常抓取、参与印证，但不能单独让一件事上版或推送。
const V15 = ["ALTER TABLE sources ADD COLUMN trial INTEGER DEFAULT 0"];
// v16：外文标题的中文译名（LLM 模式由模型译、经数字与专名核对）。聚类用它，外文报道才能和中文报道归到同一件事；面板显示也用它。
const V16 = [
  "ALTER TABLE articles ADD COLUMN title_zh TEXT",
  // 模型判定的「同一件事」：外文报道 → 那件事的首条报道（文章 id，聚类时据此归并，重算也不丢）
  "ALTER TABLE articles ADD COLUMN link_to TEXT",
];
// v17：转载标记——别家几小时内几乎一字不差的稿件记下原发方，不算独立印证。
const V17 = ["ALTER TABLE event_members ADD COLUMN repost_of TEXT"];
// v18：故事线的影响与走势分析（模型推演，每次一行；auto=版面出来后自动分析的）
const V18 = [
  "CREATE TABLE IF NOT EXISTS story_analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, story_id TEXT, created_at TEXT, model TEXT, items INTEGER, content TEXT, auto INTEGER DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_story_analyses ON story_analyses(story_id, id)",
];
// v19：模型调用账本——每次调用的步骤、模型、耗时、输入 / 输出 / 缓存命中 token；用来测速、按天记账、做预算
const V19 = [
  "CREATE TABLE IF NOT EXISTS llm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, step TEXT, model TEXT, ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_cache INTEGER, estimated INTEGER, ok INTEGER, error TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_llm_calls_at ON llm_calls(at)",
];
// v20：故事线的关键主体（模型归并时顺带给出：公司、机构、人物、产品或技术），检索候选与「追踪」用
const V20 = [
  "CREATE TABLE IF NOT EXISTS story_entities (story_id TEXT, name TEXT, at TEXT, PRIMARY KEY (story_id, name))",
  "CREATE INDEX IF NOT EXISTS idx_story_entities_name ON story_entities(name)",
];
// v21：追踪——追踪对象、它挂上的故事线、模型写的综述（每次一行，增量）
const V21 = [
  "CREATE TABLE IF NOT EXISTS trackers (id TEXT PRIMARY KEY, name TEXT, kind TEXT, ticker TEXT, aliases TEXT, origin TEXT, status TEXT DEFAULT 'active', created_at TEXT)",
  "CREATE TABLE IF NOT EXISTS tracker_stories (tracker_id TEXT, story_id TEXT, linked_at TEXT, how TEXT, PRIMARY KEY (tracker_id, story_id))",
  "CREATE INDEX IF NOT EXISTS idx_tracker_stories_story ON tracker_stories(story_id)",
  "CREATE TABLE IF NOT EXISTS tracker_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, tracker_id TEXT, at TEXT, model TEXT, stories INTEGER, content TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_tracker_syntheses ON tracker_syntheses(tracker_id, id)",
];
// v22：正文抓取时记下列表里原有的文字长度（list_len），用来判断一个源的列表是不是全文；
// 按新规则清理已入库的正文（阅读器读出的侧栏与别的新闻、结尾的免责声明与社群链接；整页读出、对不上标题的作废），并重算完整度。
const V22 = [
  "ALTER TABLE article_bodies ADD COLUMN list_len INTEGER",
  (db) => {
    const bodyUp = db.prepare("UPDATE article_bodies SET content = ?, text_len = ?, ok = ?, error = ? WHERE article_id = ?");
    const artUp = db.prepare("UPDATE articles SET content = ?, text_len = ?, training_ready = CASE WHEN paywalled = 1 THEN 0 WHEN ? >= 200 THEN 1 ELSE 0 END WHERE id = ?");
    for (const r of db.prepare("SELECT b.article_id, b.content, b.extractor, a.title, a.summary, a.content AS art FROM article_bodies b JOIN articles a ON a.id = b.article_id WHERE b.ok = 1").all()) {
      const old = String(r.content || "");
      const loose = r.extractor === "reader" || r.extractor === "browse";
      const text = (loose && anchorReader(old, r.title)) || trimTail(old);
      // 整页读出的：对不上标题的不是这篇（快讯流、行情条、捐款或付费提示）
      const ok = text.length >= MIN_SHORT && (!loose || relevant(text, r.title, r.summary));
      if (ok && text === old) continue;
      bodyUp.run(ok ? text : null, ok ? text.length : 0, ok ? 1 : 0, ok ? null : "cleaned: not this article", r.article_id);
      if (String(r.art || "") === old) {
        const back = ok ? text : String(r.summary || "");
        artUp.run(back, back.length, back.length, r.article_id);
      }
    }
    const up = db.prepare("UPDATE articles SET completeness = ? WHERE id = ?");
    for (const a of db.prepare("SELECT id, title, summary, content, completeness FROM articles").all()) { const c = completeness(a); if (c !== a.completeness) up.run(c, a.id); }
  },
];
// v23：模型写好的稿按材料指纹存下来（fp = 材料、写法与提示词版本的摘要），中断后重编时复用
const V23 = [
  "CREATE TABLE IF NOT EXISTS write_cache (fp TEXT PRIMARY KEY, story_id TEXT, copy TEXT, created_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_write_cache_at ON write_cache(created_at)",
];
export const MIGRATIONS = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17, V18, V19, V20, V21, V22, V23];
export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db) {
  const current = () => Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  if (current() >= SCHEMA_VERSION) return { from: current(), to: current() };
  const from = current();
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (current() > v) { db.exec("COMMIT"); continue; } // 另一个进程刚迁过
      for (const step of MIGRATIONS[v]) {
        if (typeof step === "function") step(db);
        else db.exec(step);
      }
      db.exec("PRAGMA user_version = " + (v + 1));
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      throw new Error("数据库迁移到 v" + (v + 1) + " 失败：" + e.message);
    }
  }
  return { from, to: current() };
}

/** 打开（必要时创建）库并迁移到最新版本。 */
export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
