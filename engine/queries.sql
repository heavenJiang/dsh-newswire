-- 最近 10 次运行
SELECT run_id, started_at, finished_at, sources_ok, sources_failed, items_raw, items_new FROM runs ORDER BY started_at DESC LIMIT 10;
-- 某运行的失败链与处置建议
SELECT source_id, channel, ok, http_status, error_kind, substr(error,1,160) err, hint, latency_ms FROM fetch_attempts WHERE run_id = (SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1) ORDER BY source_id, id;
-- 各源健康度（近 20 次尝试）
SELECT s.id, s.name, COUNT(*) tries, SUM(a.ok) ok, AVG(a.latency_ms) avg_ms, MAX(a.attempted_at) last_try
FROM fetch_attempts a JOIN sources s ON s.id=a.source_id GROUP BY s.id ORDER BY ok*1.0/tries;
-- 可训练语料
SELECT category, COUNT(*) n, SUM(text_len) chars FROM articles WHERE training_ready=1 GROUP BY category;
-- 某源最近条目
SELECT COALESCE(published_at, last_seen_at) t, title, url FROM articles WHERE source_id='cls_telegraph' ORDER BY t DESC LIMIT 20;

-- ---------------------------------------------------------------- 热度信号与观测
-- 各源实际采到的信号
SELECT source_id, group_concat(signal, '/') signals, MAX(last_seen_at) last_seen FROM signal_availability GROUP BY source_id ORDER BY source_id;
-- 某条新闻的热度轨迹（阅读数/排名随轮次变化）
SELECT o.seen_at, o.run_id, o.rank, o.section, o.views, o.comments, o.likes, o.hot, o.level FROM observations o WHERE o.article_id = :id ORDER BY o.seen_at;
-- 最近 24 小时源头标了热门/加红/级别的条目
SELECT a.title, a.source_id, o.hot, o.level, o.views, a.url FROM articles a JOIN observations o ON o.article_id = a.id
WHERE o.seen_at >= datetime('now', '-24 hours') AND (o.hot IS NOT NULL OR o.level IN ('A', 'B', '2')) GROUP BY a.id ORDER BY o.seen_at DESC;
-- 阅读数增长最快（同一条在两轮之间的增量，需至少两次观测）
SELECT a.title, a.source_id, MIN(o.views) v0, MAX(o.views) v1, MAX(o.views) - MIN(o.views) dv, COUNT(*) runs FROM observations o JOIN articles a ON a.id = o.article_id
WHERE o.views IS NOT NULL AND o.seen_at >= datetime('now', '-24 hours') GROUP BY o.article_id HAVING runs >= 2 ORDER BY dv DESC LIMIT 20;
-- 时间可信度分布（fetched = 以抓取时间近似）
SELECT source_id, time_confidence, COUNT(*) n FROM articles GROUP BY 1, 2 ORDER BY 1, 2;
-- 全文检索（trigram，≥3 字）
SELECT a.title, a.url FROM articles_fts f JOIN articles a ON a.rowid = f.rowid WHERE articles_fts MATCH '"存款准备金"' LIMIT 20;
-- 通道与后端成功率
SELECT channel, COALESCE(backend, '-') backend, COUNT(*) n, SUM(ok) ok, ROUND(AVG(latency_ms)) ms FROM fetch_attempts GROUP BY 1, 2 ORDER BY 1, 2;

-- ---------------------------------------------------------------- 断点衔接与推送
-- 最近一轮每源衔接状态
SELECT source_id, status, overlap, pages, backfilled, gap_from, gap_to, note FROM continuity WHERE run_id = (SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1) ORDER BY status, source_id;
-- 各源近 7 天衔接情况
SELECT c.source_id, c.status, COUNT(*) n FROM continuity c JOIN runs r ON r.run_id = c.run_id WHERE r.started_at >= datetime('now', '-7 days') GROUP BY 1, 2 ORDER BY 1, 2;
-- 未补全的缺口
SELECT source_id, gap_from, gap_to, status, method, recovered, run_id FROM coverage_gaps WHERE status <> 'backfilled' ORDER BY id DESC LIMIT 30;
-- 每源断点
SELECT source_id, last_ok_at, head_time, tail_time, max_id, json_array_length(head_keys) keys FROM source_cursors ORDER BY source_id;
-- 最近推送
SELECT p.pushed_at, p.score, p.reason, a.source_id, a.title, a.url FROM pushes p JOIN articles a ON a.id = p.article_id ORDER BY p.id DESC LIMIT 30;

-- ---------------------------------------------------------------- 事件与分类
-- 近 24 小时重点事件
SELECT round(importance) imp, credibility, source_count, title, json_extract(factors, '$') f FROM events WHERE last_seen_at >= datetime('now', '-24 hours') ORDER BY importance DESC LIMIT 30;
-- 某事件的各源报道
SELECT m.source_id, m.method, round(m.similarity, 2) sim, a.published_at, a.title, a.url FROM event_members m JOIN articles a ON a.id = m.article_id WHERE m.event_id = :id ORDER BY a.published_at;
-- 跨语言合并的事件（人工抽检用）
SELECT e.title, a.source_id, a.title FROM event_members m JOIN events e ON e.event_id = m.event_id JOIN articles a ON a.id = m.article_id WHERE m.event_id IN (SELECT event_id FROM event_members WHERE method = 'entity') ORDER BY e.event_id;
-- 可信度分布
SELECT credibility, COUNT(*), ROUND(AVG(importance)) FROM events WHERE last_seen_at >= datetime('now', '-7 days') GROUP BY 1;
-- 标签分布（近 7 天）
SELECT label, COUNT(*) n FROM article_labels l JOIN articles a ON a.id = l.article_id WHERE a.last_seen_at >= datetime('now', '-7 days') GROUP BY 1 ORDER BY n DESC;
-- 存在分歧的事件
SELECT title, dispute FROM events WHERE credibility = 'disputed' ORDER BY last_seen_at DESC;
