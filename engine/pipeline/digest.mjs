/** 每轮汇总 Markdown（按分类 → 按源，每行末尾源头链接）与 JSONL/CSV 导出。 */
import fs from "node:fs";
import path from "node:path";
import { attemptsForRun } from "../store/db.mjs";

const KEY = ["关税", "制裁", "美联储", "降息", "加息", "CPI", "PPI", "央行", "外汇储备", "回购", "增资", "IPO", "AI", "算力", "机器人", "芯片", "数据中心", "中东", "伊朗", "以色列", "乌克兰", "俄罗斯", "选举", "弹劾", "黄金", "原油", "汇率", "并购", "重组", "立案", "银行", "新能源"];

export function zdt(d, tz, withSeconds) {
  const s = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: withSeconds ? "2-digit" : undefined, hour12: false }).format(d);
  return s.replace(/\//g, "-");
}
export function stamp(d, tz) { return zdt(d, tz, false).replace(/[-: ]/g, "").slice(0, 12); }

function fmtCount(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + "万" : String(n); }

/** 本轮观测里的热度标注：「🔥加红 · 阅读 4.2万」。 */
function signalTag(o) {
  if (!o) return "";
  const parts = [];
  const hot = o.hot ? JSON.parse(o.hot) : [];
  if (hot.length) parts.push("🔥" + hot.join("/"));
  if (o.level) parts.push("级别 " + o.level);
  if (o.views != null) parts.push("阅读 " + fmtCount(o.views));
  if (o.comments != null && o.comments > 0) parts.push("评论 " + fmtCount(o.comments));
  if (o.likes != null && o.likes > 0) parts.push("赞 " + fmtCount(o.likes));
  return parts.length ? "〔" + parts.join(" · ") + "〕" : "";
}

export function writeDigest(db, o) {
  const { runId, now, results, browse, windowHours, categories, outDir, perSource, tz, totals } = o;
  const failed = results.filter((x) => !x.ok);
  const winStart = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare("SELECT a.*, s.name AS source_name FROM articles a LEFT JOIN sources s ON s.id = a.source_id WHERE COALESCE(a.published_at, a.last_seen_at) >= ? AND a.source_id IN (SELECT DISTINCT source_id FROM fetch_attempts WHERE run_id = ? AND ok = 1) GROUP BY a.id ORDER BY a.category, COALESCE(a.published_at, a.last_seen_at) DESC").all(winStart, runId);
  const obs = new Map(db.prepare("SELECT article_id, hot, level, views, comments, likes FROM observations WHERE run_id = ?").all(runId).map((r) => [r.article_id, r]));
  const att = attemptsForRun(db, runId);
  const zh = (t) => { if (!t) return ""; const d = new Date(t.includes("T") ? t : t.replace(" ", "T") + "Z"); return isNaN(d.getTime()) ? "" : zdt(d, tz, false).slice(5, 16); };
  const cats = categories && categories.length ? categories : Array.from(new Set(rows.map((r) => r.category)));
  const L = [];
  L.push("# 新闻汇总 " + zdt(now, tz, false) + " " + tz, "");
  L.push("运行 " + runId + " ｜ 抓取窗口 近 " + windowHours + " 小时 ｜ 源 " + results.length + "（成功 " + (results.length - failed.length) + "，失败 " + failed.length + "）｜ 条目 抓 " + totals.raw + " 新增 " + totals.fresh + " 重复 " + totals.dup);
  L.push("通道：" + Object.entries(results.reduce((m, r) => (r.ok && (m[r.channel] = (m[r.channel] || 0) + 1), m), {})).map((e) => e[0] + " " + e[1] + "源").join(" ｜ ") + " ｜ browse 预检 " + (browse.ok ? "OK(" + browse.browser + ")" : "不可用:" + browse.reason), "");
  if (o.events && o.events.length) {
    const CRED = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };
    L.push("## 重点事件（本轮触及，按重要度）");
    for (const e of o.events) {
      const outs = JSON.parse(e.outlets || "[]").map((x) => x.name).join("、");
      const labels = JSON.parse(e.labels || "[]").map((x) => (o.names && o.names[x]) || x).join("/");
      L.push("- [" + Math.round(e.importance) + "] 【" + (CRED[e.credibility] || e.credibility) + "·" + e.source_count + "源】" + e.title + (labels ? " #" + labels : "") + " ｜ " + outs);
    }
    L.push("");
  }
  L.push("## 分类条数");
  for (const c of cats) L.push("- " + c + "：" + rows.filter((r) => r.category === c).length);
  L.push("");
  const kc = {};
  for (const r of rows) { const hay = (r.title + " " + (r.summary || "")).toLowerCase(); for (const k of KEY) if (hay.includes(k.toLowerCase())) kc[k] = (kc[k] || 0) + 1; }
  L.push("## 热点关键词", Object.entries(kc).sort((a, b) => b[1] - a[1]).slice(0, 14).map((e) => e[0] + " " + e[1]).join(" ｜ ") || "（无明显聚集）", "");
  for (const c of cats) {
    const rr = rows.filter((r) => r.category === c);
    if (!rr.length) continue;
    L.push("## " + c + "（" + rr.length + " 条）");
    const bySrc = {};
    for (const r of rr) { const k = r.source_name || r.source_id; (bySrc[k] = bySrc[k] || []).push(r); }
    for (const nm of Object.keys(bySrc)) {
      const list = bySrc[nm];
      L.push("### " + nm + "（" + list.length + (list.length > perSource ? "，显示最近 " + perSource : "") + "）");
      for (const r of list.slice(0, perSource)) {
        const s = (r.summary || "").replace(/\s+/g, " ").slice(0, 170);
        const tm = r.time_confidence === "fetched" ? "~" + zh(r.last_seen_at) : r.time_confidence === "url_date" ? zh(r.published_at).slice(0, 5) : zh(r.published_at || r.last_seen_at);
        L.push("- " + tm + " " + r.title + " " + signalTag(obs.get(r.id)) + " ｜ " + s + " ｜ " + r.url);
      }
    }
    L.push("");
  }
  L.push("## 抓取失败与降级（排查用）");
  if (!failed.length) L.push("- 全部成功");
  for (const f of failed) {
    const seq = att.filter((x) => x.source_id === f.id);
    L.push("- " + f.name + "（" + f.id + "，" + f.category + "）：尝试 " + seq.map((x) => x.channel + "=" + x.error_kind + (x.http_status ? "/" + x.http_status : "")).join(" → "));
    for (const x of seq) if (x.hint) L.push("    - " + x.channel + " hint: " + x.hint);
  }
  L.push("", "> 说明：标题/摘要来自各源列表页或 feed，未逐条核原文；「~」表示源头未给发布时间、以抓取时间近似；〔〕内为源头给出的热度信号。财经内容非投资建议。");
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, "digest-" + stamp(now, tz).slice(0, 8) + ".md");
  fs.writeFileSync(p, L.join("\n"));
  return { path: p, rows };
}

export function exportFiles(rows, o) {
  const out = [];
  const day = stamp(o.now, o.tz).slice(0, 8);
  if (o.kinds.includes("jsonl")) {
    const p = path.join(o.outDir, "train-" + day + ".jsonl");
    fs.writeFileSync(p, rows.filter((r) => r.training_ready).map((r) => JSON.stringify({ id: r.id, url: r.url, title: r.title, summary: r.summary, content: r.content, published_at: r.published_at, time_confidence: r.time_confidence, source: r.source_name, source_id: r.source_id, category: r.category, pack: r.pack, lang: r.lang, channel: r.channel, content_hash: r.content_hash, parser_version: r.parser_version })).join("\n") + "\n");
    out.push(p);
  }
  if (o.kinds.includes("csv")) {
    const p = path.join(o.outDir, "articles-" + day + ".csv");
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    fs.writeFileSync(p, "id,published_at,time_confidence,category,source,title,url,training_ready\n" + rows.map((r) => [r.id, r.published_at || r.fetched_at, r.time_confidence, r.category, r.source_name, r.title, r.url, r.training_ready].map(esc).join(",")).join("\n") + "\n");
    out.push(p);
  }
  return out;
}
