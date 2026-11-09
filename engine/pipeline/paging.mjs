/**
 * 翻页补抓：出现缺口时按源配置的 paging 往前翻，直到重新衔接或到上限（由调用方判断何时停）。
 *   param    列表页 URL 加页码：{ mode: "param", param: "page", start: 2, max_pages: 6 }
 *   cursor   JSON API 游标：{ mode: "cursor", param: "cursor", next: "data.next_cursor", max_pages: 6 }
 *   id_walk  快讯 id 连续的站点逐条取详情页：{ mode: "id_walk", template: ".../newsletter/{id}", id_pattern: "/newsletter/(\\d+)", max_steps: 40 }
 *   native   源自身的抓取脚本已按时间回翻（财联社），这里不做事
 * 都走 http 直取（翻页请求多，不占 browse 标签页）；适配器源用同一个 parse。
 */
import { httpFetch } from "../channels/http.mjs";
import { getAdapter } from "../adapters/index.mjs";
import { getPath } from "../parsers/generic.mjs";
import { parseText } from "./fetch.mjs";

function withParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, String(value));
  return u.toString();
}

/**
 * @param src 源配置；@param o { scale, missingIds, timeoutMs, writeRaw }
 * 逐页产出 { page, url, items, error }。
 */
export async function* morePages(src, o) {
  const pg = src.paging || {};
  const adapter = getAdapter(src.adapter);
  const scale = Math.max(1, o.scale || 1);
  const timeoutMs = Math.min(src.timeout_ms || 20000, 20000);
  if (pg.mode === "param") {
    const start = Number(pg.start || 2);
    const n = Math.min(Number(pg.max_pages || 5) * scale, 30);
    for (let i = 0; i < n; i++) {
      const url = withParam(src.url, pg.param || "page", start + i);
      const r = await httpFetch(url, { timeoutMs });
      if (!r.ok) { yield { page: i + 1, url, items: [], error: r.error }; return; }
      const items = parseText(src, adapter, r.text, 200).items;
      if (o.writeRaw) o.writeRaw(src.id + ".p" + (start + i) + ".html", r.text);
      yield { page: i + 1, url, items };
      if (!items.length) return;
    }
  } else if (pg.mode === "cursor") {
    const n = Math.min(Number(pg.max_pages || 5) * scale, 30);
    let r = await httpFetch(src.url, { timeoutMs });
    for (let i = 0; i < n && r.ok; i++) {
      let next;
      try { next = getPath(JSON.parse(r.text), pg.next || "data.next_cursor"); } catch { next = null; }
      if (!next) return;
      const url = withParam(src.url, pg.param || "cursor", next);
      r = await httpFetch(url, { timeoutMs });
      if (!r.ok) { yield { page: i + 1, url, items: [], error: r.error }; return; }
      const items = parseText(src, null, r.text, 200).items;
      if (o.writeRaw) o.writeRaw(src.id + ".c" + (i + 1) + ".json", r.text);
      yield { page: i + 1, url, items };
      if (!items.length) return;
    }
  } else if (pg.mode === "id_walk") {
    const ids = (o.missingIds || []).slice(0, Math.min(Number(pg.max_steps || 40) * scale, 150));
    let step = 0;
    for (const id of ids) {
      step++;
      const url = String(pg.template).replace("{id}", String(id));
      const r = await httpFetch(url, { timeoutMs });
      if (!r.ok) { yield { page: step, url, items: [], error: r.error }; continue; }
      const all = adapter ? adapter.parse(r.text, { url, max: 200 }) : [];
      const self = all.filter((x) => new RegExp("/" + id + "(?:$|[/?#.])").test(x.link));
      yield { page: step, url, items: self };
    }
  }
}

/** id_walk：上轮 max_id 与本批最小 id 之间缺的 id（新的在前）。 */
export function missingIds(prevMax, presentIds) {
  if (!prevMax || !presentIds.length) return [];
  const have = new Set(presentIds);
  const out = [];
  for (let id = Math.min(...presentIds) - 1; id > prevMax; id--) if (!have.has(id)) out.push(id);
  return out;
}
