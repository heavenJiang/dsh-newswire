/**
 * 单源抓取：按通道链依次尝试，成功即停；每次尝试（成败）都通过 env.onAttempt 回调交给调用方（入库或试抓回显）。
 * 不碰数据库，因此「试抓」与正式抓取走同一段代码。
 *
 * 通道：browse（真实浏览器）→ agent_reach（feedparser / agent-reach 的 web 后端）→ http（直取）→ jina（r.jina.ai）
 */
import { browseFetch } from "../channels/browse.mjs";
import { agentReachFetch } from "../channels/agent_reach.mjs";
import { httpFetch, jinaFetch } from "../channels/http.mjs";
import { classify, AGENT_REACH_MISSING } from "../channels/classify.mjs";
import { itemsFromText, parseRss } from "../parsers/generic.mjs";
import { getAdapter } from "../adapters/index.mjs";

import { CHANNELS, DEFAULT_CHAIN } from "../constants.mjs";

export { CHANNELS, DEFAULT_CHAIN };

function browseModeOf(src, adapter) {
  if (adapter) return adapter.browseMode || "html";
  if (src.extract && typeof src.extract === "object" && src.extract.item) return "select";
  return src.type === "rss" ? "rss" : src.type === "cls_api" ? "cls_api" : "html_index";
}

function jsonSpec(src) {
  if (!src.json && !src.signals) return src.json;
  return Object.assign({}, src.json || {}, src.signals ? { signals: Object.assign({}, (src.json && src.json.signals) || {}, src.signals) } : {});
}

/** 正文类文本 → 条目：有适配器用适配器，否则按源类型通用解析。 */
export function parseText(src, adapter, text, max) {
  if (adapter) {
    const items = adapter.parse(text, { url: src.url, max });
    if (items.length) return { items, parsed_by: "adapter:" + adapter.id };
  }
  const type = src.type === "adapter" ? "html_index" : src.type;
  return itemsFromText(type, text, src.url, max, jsonSpec(src));
}

/**
 * @param src 源配置（已合并 defaults）
 * @param env {
 *   browse: { ok, reason }   browse 预检结果
 *   windowHours, maxOverride, retries, backoffMs, defaultChain,
 *   writeRaw(name, text) → path|""   保存原始响应（试抓时可为 noop）
 *   onAttempt(attempt)               每次尝试回调
 * }
 * @returns { items, won, parsed_by, raw_path, attempts }
 */
export async function fetchSource(src, env) {
  const adapter = getAdapter(src.adapter);
  const max = env.maxOverride || src.max_items || 20;
  const chain = Array.isArray(src.channels) && src.channels.length ? src.channels : env.defaultChain || DEFAULT_CHAIN;
  const retries = Math.max(1, Number(env.retries || 1));
  const timeoutMs = Number(src.timeout_ms || env.timeoutMs || 30000);
  const attempts = [];
  let items = [];
  let won = null;
  let parsedBy = "";
  let rawPath = "";

  const record = (a) => {
    const full = Object.assign({ source_id: src.id, url: src.url, attempted_at: new Date().toISOString() }, a);
    attempts.push(full);
    if (env.onAttempt) env.onAttempt(full);
  };

  for (const ch of chain) {
    if (won) break;
    for (let r = 0; r < retries; r++) {
      const t0 = Date.now();
      let ok = false, err = "", status = null, bytes = null, note = "", backend = null;
      if (ch === "browse") {
        if (!env.browse || !env.browse.ok) {
          const reason = (env.browse && env.browse.reason) || "browser_unavailable";
          record({ channel: ch, ok: false, error: reason, error_kind: "browser_unavailable", hint: reason === "browse_not_found" ? "未找到 browse：运行 curl -fsSL https://raw.githubusercontent.com/heavenJiang/dsh-newswire/main/scripts/setup.sh | bash 一键安装，或在插件设置里填 browseBin" : "browse 扩展没连上：在终端运行 browse install 完成配对，或在 Chrome 工具栏点 browse 按钮重连", latency_ms: 0 });
          break;
        }
        const res = await browseFetch(browseModeOf(src, adapter), src.url, max, { timeoutMs, sinceHours: src.since_hours || env.windowHours || 24, until: src.until || null, pages: Number(src.pages || Math.ceil(max / 20) + 2), category: src.category_src || "", waitFor: (adapter && adapter.waitFor) || src.wait_for || "", extract: src.extract || null });
        if (res.ok) {
          const v = res.value || {};
          const payload = res.data || {};
          if (adapter && typeof payload.html === "string") {
            items = adapter.parse(payload.html, { url: src.url, max });
            parsedBy = "adapter:" + adapter.id;
            rawPath = env.writeRaw(src.id + ".browse.html", payload.html);
          } else {
            items = payload.items || [];
            if (!items.length && payload.xml_text) items = parseRss(payload.xml_text, max);
            parsedBy = "browse:" + (v.mode || "?");
            rawPath = env.writeRaw(src.id + ".browse.json", JSON.stringify({ source: src.id, url: src.url, meta: { page_url: v.page_url, doc_title: v.doc_title, count: v.count, pages: v.pages, stop: v.stop }, payload }, null, 1));
          }
          bytes = v.bytes || null;
          if (items.length) { ok = true; note = "count=" + items.length + (v.pages != null ? " pages=" + v.pages : "") + (v.stop ? " stop=" + v.stop : ""); }
          else err = "0 items parsed via browse (mode=" + (v.mode || "?") + ", bytes=" + (v.bytes || 0) + ")";
        } else {
          err = res.error || "browse execute failed";
          status = res.aftermath && res.aftermath.challenge ? 403 : null;
        }
      } else if (ch === "agent_reach") {
        const res = await agentReachFetch(src, { max, timeoutMs });
        backend = res.backend || null;
        status = res.http_status ?? null;
        bytes = res.bytes ?? null;
        if (!res.ok && (res.error === "agent_reach_not_found")) {
          record({ channel: ch, ok: false, error: res.error, error_kind: AGENT_REACH_MISSING.kind, hint: AGENT_REACH_MISSING.hint, latency_ms: 0 });
          break;
        }
        if (res.ok && Array.isArray(res.items)) {
          items = res.items.slice(0, max);
          parsedBy = "agent_reach:" + backend;
          rawPath = env.writeRaw(src.id + ".agent_reach.json", JSON.stringify({ backend, items: res.items }, null, 1));
          if (items.length) ok = true; else err = res.error || "0 items (" + backend + ")";
        } else if (res.ok) {
          const parsed = parseText(src, null, res.text, max);
          items = parsed.items;
          parsedBy = "agent_reach:" + backend + "/" + parsed.parsed_by;
          rawPath = env.writeRaw(src.id + ".agent_reach.md", res.text);
          if (items.length) ok = true; else err = "0 items parsed (" + backend + ")";
        } else err = res.error;
      } else if (ch === "http") {
        const res = await httpFetch(src.url, { timeoutMs: Math.min(timeoutMs, 20000) });
        status = res.http_status; bytes = res.bytes;
        if (res.ok) {
          const parsed = parseText(src, adapter, res.text, max);
          items = parsed.items;
          parsedBy = parsed.parsed_by;
          rawPath = env.writeRaw(src.id + (src.type === "rss" ? ".xml" : src.type === "json_api" ? ".json" : ".html"), res.text);
          if (items.length) ok = true; else err = "0 items parsed";
        } else err = res.error;
      } else if (ch === "jina") {
        const res = await jinaFetch(src.url, { timeoutMs: Math.min(timeoutMs, 30000) });
        status = res.http_status; bytes = res.bytes;
        if (res.ok) {
          const parsed = parseText(src, null, res.text, max);
          items = parsed.items;
          parsedBy = "jina/" + parsed.parsed_by;
          rawPath = env.writeRaw(src.id + ".jina.md", res.text);
          if (items.length) ok = true; else err = "0 items parsed (jina)";
        } else err = res.error;
      } else {
        err = "channel " + ch + " 未实现";
      }
      const ms = Date.now() - t0;
      if (ok) {
        won = ch;
        record({ channel: ch, ok: true, http_status: status, bytes, items: items.length, latency_ms: ms, backend, note: (parsedBy + " " + note).trim() });
        break;
      }
      const cl = classify(err, status, "");
      record({ channel: ch, ok: false, http_status: status, bytes, error: err, error_kind: cl.kind, hint: cl.hint, latency_ms: ms, backend });
      await new Promise((rr) => setTimeout(rr, Number(env.backoffMs || 800)));
    }
  }
  return { items: won ? items : [], won, parsed_by: parsedBy, raw_path: rawPath, attempts };
}
