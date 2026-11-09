/**
 * 补抓搜索（agent-reach 的搜索后端 Exa，经 mcporter）。没有时间过滤参数，发布日期只到天，
 * 所以只当兜底：结果按源域名过滤、按日期落在缺口区间内筛选，入库时间可信度记为 fetched（不冒充精确时间）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mcporterBin } from "./agent_reach.mjs";

const exec = promisify(execFile);

/** 解析 Exa 文本结果块：Title / URL / Published / Highlights。 */
export function parseExaText(text) {
  const out = [];
  for (const block of String(text).split(/\n(?=Title: )/)) {
    const title = (block.match(/^Title: (.*)$/m) || [])[1];
    const url = (block.match(/^URL: (\S+)/m) || [])[1];
    if (!title || !url) continue;
    const published = (block.match(/^Published: (\S+)/m) || [])[1] || "";
    const hl = (block.match(/^Highlights:\n([\s\S]*)$/m) || [])[1] || "";
    out.push({ title: title.trim(), url, published, highlights: hl.trim().slice(0, 600) });
  }
  return out;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^(www|m)\./, ""); } catch { return ""; } }

/**
 * @returns { ok, items, error, raw }  items 为原始条目（与适配器产出同构）。
 */
export async function exaBackfill(src, o) {
  const bin = mcporterBin();
  if (!bin) return { ok: false, items: [], error: "mcporter_not_found" };
  const domain = hostOf(src.url);
  const from = String(o.gapFrom || "").slice(0, 16);
  const to = String(o.gapTo || "").slice(0, 16) || "现在";
  const query = (src.name || domain) + " " + domain + " 新闻 " + from.slice(0, 10);
  const objective = "只要 " + domain + " 域名下发布于 " + from + " 至 " + to + "（UTC）之间的单篇新闻或快讯页面，排除栏目页、列表页与其它网站；需要标题、链接和发布时间。";
  try {
    const { stdout } = await exec(bin, ["call", "exa.web_search_exa", "query=" + query, "numResults=" + String(o.max || 10), "objective=" + objective, "--output", "json"], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const text = (j.content || []).map((c) => c.text || "").join("\n");
    const fromDay = from.slice(0, 10);
    const toDay = (o.gapTo ? String(o.gapTo) : new Date().toISOString()).slice(0, 10);
    const items = parseExaText(text)
      .filter((r) => hostOf(r.url) === domain || hostOf(r.url).endsWith("." + domain))
      .filter((r) => /\d{4,}/.test(new URL(r.url).pathname))
      .filter((r) => !r.published || (r.published.slice(0, 10) >= fromDay && r.published.slice(0, 10) <= toDay))
      .map((r) => ({ title: r.title.replace(/\s*[|｜_-]\s*[^|｜_-]{1,12}$/, ""), link: r.url, published_at: "", summary: r.highlights.replace(/\s+/g, " ").slice(0, 400), content: "", signals: { section: "backfill" }, signals_raw: { exa_published: r.published } }));
    return { ok: true, items, raw: text };
  } catch (e) {
    return { ok: false, items: [], error: String(e.message).slice(0, 300) };
  }
}
