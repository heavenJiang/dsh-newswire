/**
 * 内容质量：入库前给每条判定「是什么」和「全不全」。
 *
 *   kind     news（默认）｜ promo（广告、付费栏目引流、营销）｜ ticker（单条行情跳动：指数、汇率、金价、币价…，进「行情速览」不单独成稿）｜ digest（合集：早间精选、要闻汇总……拆成子条目后本身不再参与）
 *            ｜ digest_item（从合集拆出来的一条）
 *   completeness  full ｜ truncated（摘要被截断、以省略号收尾）｜ title_only（只有标题）
 *
 * 噪声规则在 taxonomy.json 的 noise 里，用户可改；每条规则：
 *   { id, name, kind: "promo", source?: 正则（源 id）, title?: 正则, text?: 正则, all?: [正则…]（标题+正文里都要命中）, title_all?: [正则…]（标题里都要命中）, note? }
 * 规则只打标签、不删数据：被过滤的照样入库（训练时就是带标签的负样本），面板里可以恢复。
 */

import { articleKey, contentHash, normTitle } from "../util/text.mjs";

const re = (s) => { try { return s ? new RegExp(s, "i") : null; } catch { return null; } };

/** 编译 noise 规则；坏正则的规则跳过。 */
export function compileNoise(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: String(r.id || ""), name: String(r.name || r.id || ""), kind: ["notice", "ticker"].includes(r.kind) ? r.kind : "promo",
    source: re(r.source), title: re(r.title), text: re(r.text), all: (Array.isArray(r.all) ? r.all : []).map(re), title_all: (Array.isArray(r.title_all) ? r.title_all : []).map(re),
  })).filter((r) => r.id && !r.all.some((x) => !x) && !r.title_all.some((x) => !x) && (r.title || r.text || r.all.length || r.title_all.length));
}

/** 命中的第一条噪声规则，或 null。 */
export function matchNoise(rules, a) {
  const title = String(a.title || "");
  const text = title + "\n" + String(a.summary || "") + "\n" + String(a.content || "").slice(0, 3000);
  for (const r of rules || []) {
    if (r.source && !r.source.test(String(a.source_id || ""))) continue;
    if (r.title && !r.title.test(title)) continue;
    if (r.text && !r.text.test(text)) continue;
    if (r.all.length && !r.all.every((x) => x.test(text))) continue;
    if (r.title_all.length && !r.title_all.every((x) => x.test(title))) continue;
    return r;
  }
  return null;
}

const ELLIPSIS = /(…|\.\.\.|……|\[\.\.\.\]|展开全文|阅读全文|查看全文|点击查看)\s*$/;

/** 只有日期 / 时间的「摘要」（列表里的发布日期被当成了摘要）不算内容。 */
const DATE_ONLY = /^[\s\d\-:/.年月日时分秒T+Z()（）|·]*$/;

/** 内容全不全：只有标题 / 被截断 / 完整。 */
export function completeness(a) {
  const text = (x) => { const t = String(x || "").trim(); return DATE_ONLY.test(t) ? "" : t; };
  const s = text(a.summary);
  const c = text(a.content);
  const best = c.length > s.length ? c : s;
  const title = String(a.title || "").trim();
  // 快讯：标题本身就是一句完整的话（以句号收尾、够长），就是全文。感叹号收尾的多是吸引点击的标题，不算
  if ((!best || best === title) && title.length >= 15 && /。$/.test(title)) return "full";
  if (!best || best === title) return "title_only";
  if (ELLIPSIS.test(best)) return "truncated";
  // 只有摘要、且长度正好卡在列表抓取的截断处（300 / 400 / 1200 字）：多半是被截断的
  if (!c && (s.length >= 290 && s.length <= 300 || s.length === 400 || s.length === 1200)) return "truncated";
  return "full";
}

const DIGEST_TITLE = /(新闻精选|要闻精选|早间精选|晚间精选|早报|晚报|午报|要闻速递|要闻汇总|新闻汇总|一图看懂|周末要闻|隔夜要闻|全球要闻|今日要闻|大事件?盘点|\d+件大事|要闻\d+条|\d+条要闻|新闻联播.{0,6}(要闻|主要内容)|盘前必读|早知道(?!】)|晨报|夜报|周报|一周回顾|大事提醒|投资日历|财经日历|一周前瞻)/;
export const isDigestTitle = (t) => DIGEST_TITLE.test(String(t || ""));

/**
 * 合集拆条：正文里有从 1 开始连续编号（1、2、3… 或 ①②③…）的 ≥3 段，且标题像合集，拆成子条目。
 * @returns [{ n, text }]，不是合集时为 []
 */
export function splitDigest(a) {
  const title = String(a.title || "");
  const body = String(a.content || "").length > String(a.summary || "").length ? String(a.content) : String(a.summary || "");
  if (!DIGEST_TITLE.test(title) || body.length < 60) return [];
  const pick = (rx, num) => {
    const marks = [];
    let want = 1;
    for (const m of body.matchAll(rx)) { if (num(m) === want) { marks.push({ at: m.index, end: m.index + m[0].length }); want++; } }
    return marks;
  };
  let marks = pick(/(?:^|[\s。；;】」\n])(\d{1,2})\s*[、.．]\s*/g, (m) => Number(m[1]));
  if (marks.length < 3) marks = pick(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g, (m) => "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".indexOf(m[0]) + 1);
  if (marks.length < 3) return [];
  return marks.map((m, i) => ({ n: i + 1, text: body.slice(m.end, i + 1 < marks.length ? marks[i + 1].at + 1 : body.length).replace(/^[\s。；;]+|[\s；;]+$/g, "").trim() }))
    .filter((x) => x.text.length >= 6);
}

/** 子条目的标题：第一句（太长截到逗号处）。 */
export function digestItemTitle(text) {
  const first = String(text).split(/[。！？!?]/)[0].trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60).lastIndexOf("，");
  return (cut >= 16 ? first.slice(0, cut) : first.slice(0, 58)) + "…";
}

/**
 * 给一条入库记录定性：噪声 → promo；合集 → digest 并返回拆出的子条目；同时写 completeness。
 * @returns 子条目记录数组（不是合集时为空）
 */
export function assess(r, noise) {
  r.completeness = completeness(r);
  const hit = matchNoise(noise, r);
  if (hit) { r.kind = hit.kind; r.kind_by = "rule"; r.kind_note = hit.name; return []; }
  const parts = splitDigest(r);
  if (!parts.length) { r.kind = "news"; return []; }
  r.kind = "digest"; r.kind_by = "rule"; r.kind_note = parts.length + " 条";
  return parts.map((p) => {
    const title = digestItemTitle(p.text);
    const url = r.url + "#" + p.n;
    return Object.assign({}, r, {
      id: articleKey(url, title), url, canonical_url: url, title, title_norm: normTitle(title), summary: p.text, content: p.text,
      content_hash: contentHash(title, p.text), text_len: p.text.length, training_ready: !r.paywalled && p.text.length >= 60,
      kind: "digest_item", kind_by: "rule", kind_note: r.title.slice(0, 60), parent_id: r.id, completeness: "full",
      signals: Object.assign({}, r.signals, { rank: (r.signals && r.signals.rank != null ? r.signals.rank : 0) }),
    });
  });
}

/**
 * 重新定性窗口内的条目（改了 noise 规则、或升级后第一次）：更新 kind / completeness，合集补拆子条目。
 * 读者或模型判过的（kind_by = reader / llm）不动。@returns { promo, digest, items }
 */
export function reassess(db, o) {
  const rows = o.ids
    ? db.prepare("SELECT * FROM articles WHERE id IN (" + o.ids.map(() => "?").join(",") + ") AND COALESCE(kind_by, '') NOT IN ('reader', 'llm')").all(...o.ids)
    : db.prepare("SELECT * FROM articles WHERE last_seen_at >= ? AND COALESCE(kind, '') != 'digest_item' AND COALESCE(kind_by, '') NOT IN ('reader', 'llm')").all(o.sinceIso);
  const up = db.prepare("UPDATE articles SET kind = ?, kind_by = ?, kind_note = ?, completeness = ? WHERE id = ?");
  const has = db.prepare("SELECT 1 FROM articles WHERE id = ?");
  const obs = db.prepare("SELECT run_id, seen_at, channel FROM observations WHERE article_id = ? ORDER BY seen_at LIMIT 1");
  const out = { promo: 0, digest: 0, items: 0 };
  db.exec("BEGIN");
  try {
    for (const a of rows) {
      const r = Object.assign({}, a, { signals: { rank: 0, hot: [], raw: {} } });
      const kids = assess(r, o.noise);
      up.run(r.kind, r.kind_by || null, r.kind_note || null, a.completeness === "full" ? "full" : r.completeness, a.id);
      if (r.kind === "promo") out.promo++;
      if (r.kind === "digest") out.digest++;
      const first = kids.length ? obs.get(a.id) : null;
      for (const c of kids) {
        if (has.get(c.id)) continue;
        o.upsert(db, Object.assign(c, { metrics: {} }), { nowIso: a.first_seen_at, channel: a.channel, rawPath: a.raw_path });
        db.prepare("UPDATE articles SET first_seen_at = ?, last_seen_at = ? WHERE id = ?").run(a.first_seen_at, a.last_seen_at, c.id);
        if (first) db.prepare("INSERT OR IGNORE INTO observations (run_id, source_id, article_id, rank, page, seen_at, channel) VALUES (?,?,?,?,?,?,?)").run(first.run_id, a.source_id, c.id, 0, 0, first.seen_at, first.channel);
        out.items++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

/** 模型或读者判定：把条目标成 promo（不是新闻）或恢复为 news。读者的判断不被模型覆盖。 */
export function markKind(db, ids, kind, by, note) {
  const st = db.prepare("UPDATE articles SET kind = ?, kind_by = ?, kind_note = ? WHERE id = ? AND (? = 'reader' OR COALESCE(kind_by, '') != 'reader')");
  let n = 0;
  for (const id of ids || []) n += Number(st.run(kind, by, note || null, id, by).changes || 0);
  if (n && kind !== "news") db.prepare("DELETE FROM event_members WHERE article_id IN (" + ids.map(() => "?").join(",") + ")").run(...ids);
  return n;
}
