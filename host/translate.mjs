/**
 * 外文标题译成中文（LLM 模式）。
 *
 * 为什么：外文报道（BBC、NYT、半岛、美联社……）和中文报道讲同一件事，按标题字面比不上，
 * 结果同一件事在版面和事件列表里中文一条、英文一条；读者也要读一堆英文标题。
 * 译名存 articles.title_zh：聚类按它比较（外文报道归入中文报道的同一件事），面板显示也用它（原文保留）。
 * 每条译名都核对：原标题里的数字与外文专名，译名里要么照写、要么不提——编出原文没有的数字就不收。
 */
import { parseJsonLoose } from "./model.mjs";
import { checkText } from "./factcheck.mjs";
import { bigrams, similarity } from "../engine/pipeline/select.mjs";

const isZh = (t) => /[一-鿿]/.test(String(t || ""));
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function translatePrompt(items, events) {
  const evs = (events || []).map((e, i) => "E" + (i + 1) + " " + clip(e.title, 50)).join("\n");
  return "任务：把外文新闻标题译成简洁、地道的中文新闻标题（不超过30字）。人名、地名、机构名用通行的中文译名；数字照原文；不要添加原文没有的信息。" +
    "如果某条外文新闻讲的就是「中文媒体报道过的事」里的某一件（同一事件，含其后续），在 same 里填那个编号，否则留空。" +
    '\n只输出一个 JSON 对象：{"titles":[{"n":1,"zh":"","same":""}]}' +
    (evs ? "\n\n近一天中文媒体报道过的事（编号 E…）：\n" + evs : "") +
    "\n\n外文新闻标题：\n" + items.map((it, i) => "[" + (i + 1) + "] " + clip(it.title, 160) + (it.summary ? "（摘要：" + clip(it.summary, 120) + "）" : "")).join("\n");
}

const nums = (t) => new Set((String(t).match(/\d+(\.\d+)?/g) || []).filter((x) => x.length >= 2 || Number(x) >= 3));
/** 模型说「同一件事」时程序再看一眼：译名与那件事的标题要有一点字面重合或相同的数字，免得牵强附会。 */
export function plausibleLink(zh, eventTitle) {
  if (similarity(bigrams(zh), bigrams(eventTitle)) >= 0.12) return true;
  const a = nums(zh);
  for (const x of nums(eventTitle)) if (a.has(x)) return true;
  return false;
}

/**
 * 译时段内还没译过的外文标题（新闻、合集拆出的条目）。译不成或核对不过的记为空串，不再重试。
 * @returns { tried, ok, rejected, calls }
 */
export async function translateTitles(db, model, o) {
  const rows = db.prepare(`SELECT id, title, summary FROM articles WHERE first_seen_at >= ? AND title_zh IS NULL AND COALESCE(kind, 'news') IN ('news', 'digest_item')
    ORDER BY first_seen_at DESC LIMIT ?`).all(o.since, (o.max || 80) * 3).filter((r) => !isZh(r.title)).slice(0, o.max || 80);
  const up = db.prepare("UPDATE articles SET title_zh = ? WHERE id = ?");
  const link = db.prepare("UPDATE articles SET link_to = ? WHERE id = ?");
  // 候选：近一天有中文报道的事（重要的在前），给模型判断外文新闻是不是其中一件
  const events = db.prepare(`SELECT e.title, e.lead_article_id FROM events e JOIN articles a ON a.id = e.lead_article_id
    WHERE e.last_seen_at >= ? ORDER BY e.importance DESC LIMIT 200`).all(o.since).filter((e) => isZh(e.title)).slice(0, o.events || 60);
  const out = { tried: 0, ok: 0, rejected: 0, calls: 0, linked: 0 };
  for (let i = 0; i < rows.length; i += 30) {
    if (o.deadline && Date.now() > o.deadline) break;
    const batch = rows.slice(i, i + 30);
    let j = null;
    out.calls++;
    try { j = parseJsonLoose(await model.complete(translatePrompt(batch, events), { step: "translate", maxTokens: 3000 + 120 * batch.length, timeoutMs: o.timeoutMs || 180000 })); } catch { j = null; }
    if (!j || !Array.isArray(j.titles)) continue; // 这一批下次再试
    const got = new Map(j.titles.map((x) => [Number(x && x.n), String((x && x.zh) || "").trim()]));
    const same = new Map(j.titles.map((x) => [Number(x && x.n), String((x && x.same) || "").trim()]));
    batch.forEach((it, k) => {
      out.tried++;
      const zh = clip(got.get(k + 1) || "", 40);
      // 核对：译名里的数字与外文专名要在原标题或摘要里找得到
      if (zh && isZh(zh) && checkText(zh, [it.title + " " + (it.summary || "")]).ok) {
        up.run(zh, it.id); out.ok++;
        const m = /^E(\d+)$/i.exec(same.get(k + 1) || "");
        const ev = m ? events[Number(m[1]) - 1] : null;
        if (ev && ev.lead_article_id !== it.id && plausibleLink(zh, ev.title)) { link.run(ev.lead_article_id, it.id); out.linked++; }
      }
      else { up.run("", it.id); out.rejected++; }
    });
  }
  return out;
}
