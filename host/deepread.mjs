/**
 * 深读：要上版写稿的报道，材料只有标题或摘要被截断时，先去原文抓正文。
 *
 * 用引擎的正文抽取（http → JSON-LD / 段落；不行用阅读器），抓到的写进 article_bodies 并回填 articles.content。
 * 有总预算（篇数、时间）；付费墙源、近 7 天正文一直抓不到的源跳过，把预算留给抓得到的。
 * 结果按源记下来：一个源的正文长期抓不到，质量面板会提示。
 */
import { fetchBodies } from "../engine/pipeline/bodies.mjs";
import { isDigestTitle } from "../engine/pipeline/quality.mjs";
import { upsertArticle } from "../engine/store/db.mjs";
import { articleKey, contentHash, normTitle } from "../engine/util/text.mjs";
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";

export function makeDeepRead(db, o) {
  const opt = Object.assign({ budget: 8, ms: 120000, timeoutMs: 15000 }, o || {});
  return async function deepRead(items) {
    const t0 = Date.now();
    const hopeless = new Set(db.prepare(`SELECT a.source_id FROM article_bodies b JOIN articles a ON a.id = b.article_id
      WHERE b.fetched_at >= datetime('now', '-7 days') GROUP BY a.source_id HAVING SUM(b.ok) = 0 AND COUNT(*) >= 3`).all().map((r) => r.source_id));
    const tried = new Set(db.prepare("SELECT article_id FROM article_bodies WHERE fetched_at >= datetime('now', '-1 day')").all().map((r) => r.article_id));
    const paywalled = (sid) => Boolean((opt.sources && opt.sources.get && (opt.sources.get(sid) || {}).paywall));
    const list = (items || []).filter((it) => it.url && !tried.has(it.id) && !hopeless.has(it.source_id) && !paywalled(it.source_id)).slice(0, opt.budget);
    let ok = 0;
    let done = 0;
    for (const it of list) {
      if (Date.now() - t0 > opt.ms) break;
      const r = await fetchBodies(db, [{ id: it.id, url: String(it.url).replace(/#\d+$/, "") }], { runId: opt.runId || null, minTextLen: 200, timeoutMs: opt.timeoutMs });
      ok += r.ok;
      done++;
    }
    return { wanted: (items || []).length, tried: done, ok, skipped: (items || []).length - list.length, ms: Date.now() - t0 };
  };
}

// ------------------------------------------------------------------ 模型拆合集

export function splitPrompt(title, text) {
  return "下面是一篇新闻合集（把多条新闻汇在一起的稿件）。\n标题：" + title + "\n全文：\n" + String(text).slice(0, 9000) +
    "\n\n任务：把它拆成独立的新闻条目（栏目小标题、导语、免责声明不算）。每条给出：\n- title：这条新闻的中文标题（不超过25字）\n- text：原文里讲这条新闻最关键的一两句，原文照录，不超过80字" +
    '\n只输出一个 JSON 对象：{"items":[{"title":"","text":""}]}';
}

/**
 * 规则拆不开的合集（没有 1、2、3 编号，按小标题分段的那种）交给模型拆。
 * 每条拆出的内容都要在原文里找得到（数字、专名逐一核对），找不到的丢掉。@returns { tried, items }
 */
export async function modelSplitDigests(db, model, o) {
  const rows = db.prepare(`SELECT a.*, b.content AS body FROM articles a LEFT JOIN article_bodies b ON b.article_id = a.id AND b.ok = 1
    WHERE a.first_seen_at >= ? AND COALESCE(a.kind, 'news') = 'news' AND a.parent_id IS NULL`).all(o.since)
    .filter((a) => isDigestTitle(a.title))
    .map((a) => Object.assign(a, { text: [a.body, a.content, a.summary].map((x) => String(x || "")).sort((x, y) => y.length - x.length)[0] }))
    .filter((a) => a.text.length >= 600)
    .slice(0, o.max || 2);
  const out = { tried: 0, items: 0 };
  for (const a of rows) {
    out.tried++;
    let j = null;
    let raw = "";
    try { raw = await model.complete(splitPrompt(a.title, a.text), { step: "split", maxTokens: 12000, timeoutMs: Math.max(o.timeoutMs || 0, 300000) }); j = parseJsonLoose(raw); } catch { j = null; }
    // 推理模型输出被截断时，把已经完整的条目捞回来
    if (!j && raw) j = { items: [...raw.matchAll(/\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)].map((m) => ({ title: JSON.parse('"' + m[1] + '"'), text: JSON.parse('"' + m[2] + '"') })) };
    const items = (j && Array.isArray(j.items) ? j.items : []).map((x) => ({ title: String((x && x.title) || "").trim().slice(0, 60), text: String((x && x.text) || "").trim().slice(0, 400) }))
      .filter((x) => x.title && x.text.length >= 10 && checkText(x.title + "。" + x.text, [a.text]).ok);
    if (items.length < 3) continue;
    db.exec("BEGIN");
    try {
      items.forEach((x, i) => {
        const url = a.url + "#" + (i + 1);
        upsertArticle(db, {
          id: articleKey(url, x.title), url, canonical_url: url, title: x.title, title_norm: normTitle(x.title), summary: x.text, content: x.text,
          published_at: a.published_at, time_confidence: a.time_confidence, source_id: a.source_id, category: a.category, region: a.region, lang: a.lang, pack: a.pack,
          paywalled: Boolean(a.paywalled), metrics: {}, content_hash: contentHash(x.title, x.text), text_len: x.text.length, training_ready: x.text.length >= 60,
          parser_version: "model-split", kind: "digest_item", kind_by: "llm", kind_note: a.title.slice(0, 60), parent_id: a.id, completeness: "full",
        }, { nowIso: a.first_seen_at, channel: a.channel, rawPath: a.raw_path });
      });
      db.prepare("UPDATE articles SET first_seen_at = ?, last_seen_at = ? WHERE parent_id = ?").run(a.first_seen_at, a.last_seen_at, a.id);
      db.prepare("UPDATE articles SET kind = 'digest', kind_by = 'llm', kind_note = ? WHERE id = ?").run(items.length + " 条（模型拆分）", a.id);
      db.prepare("DELETE FROM event_members WHERE article_id = ?").run(a.id);
      db.exec("COMMIT");
      out.items += items.length;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return out;
}
