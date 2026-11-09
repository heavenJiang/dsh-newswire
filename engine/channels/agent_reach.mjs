/**
 * agent_reach 通道：按 agent-reach 当前实际可用的后端取内容。
 *   - RSS 源：agent-reach venv 里的 feedparser（容错解析、独立的网络栈）。
 *   - 其它源：`agent-reach doctor` 报告的 web 后端 —— web-reader MCP（经 mcporter）可用时用它，否则 Jina Reader。
 * 返回与 http 通道同构：{ ok, backend, text?, items?, http_status?, latency_ms, error? }。
 * 补抓搜索（Exa）由断点衔接机制调用。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentReachPython } from "../bins.mjs";
import { httpFetch } from "./http.mjs";

const exec = promisify(execFile);

let BIN = "";
let MCPORTER = "";
let probed = null;

export function configureAgentReach(o) {
  if (o && o.bin && o.bin !== true) BIN = String(o.bin);
  if (o && o.mcporter && o.mcporter !== true) MCPORTER = String(o.mcporter);
  probed = null;
}

export function mcporterBin() { return MCPORTER; }

/** 一轮只探测一次（doctor 约 3 秒）。 */
export async function agentReachProbe() {
  if (probed) return probed;
  if (!BIN) { probed = { ok: false, reason: "agent_reach_not_found" }; return probed; }
  const python = agentReachPython(BIN);
  let web = "jina";
  let webLabel = "Jina Reader";
  try {
    const { stdout } = await exec(BIN, ["doctor", "--json"], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const active = String((j.web && j.web.active_backend) || "");
    if (active) webLabel = active;
    if (/web.?reader/i.test(active) && MCPORTER) web = "web_reader";
  } catch {
    // doctor 失败不致命：web 仍走 Jina Reader
  }
  probed = { ok: true, python, rss: python ? "feedparser" : null, web, web_label: webLabel };
  return probed;
}

const FEEDPARSER = [
  "import sys, json, feedparser",
  "url, mx = sys.argv[1], int(sys.argv[2])",
  "d = feedparser.parse(url, agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')",
  "out = []",
  "for e in d.entries[:mx]:",
  "    c = e.get('content') or [{}]",
  "    out.append({'title': e.get('title', ''), 'link': e.get('link', ''), 'published_at': e.get('published') or e.get('updated') or '', 'summary': (e.get('summary') or '')[:3000], 'content': (c[0].get('value') or '')[:8000]})",
  "print(json.dumps({'status': getattr(d, 'status', None), 'bozo': bool(d.bozo), 'error': str(d.get('bozo_exception', ''))[:300], 'items': out}, ensure_ascii=False))",
].join("\n");

export async function agentReachFetch(src, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const pr = await agentReachProbe();
  if (!pr.ok) return { ok: false, latency_ms: 0, error: pr.reason, backend: null };
  const timeoutMs = Math.min(o.timeoutMs || 30000, 60000);
  if (src.type === "rss" && pr.python) {
    try {
      const { stdout } = await exec(pr.python, ["-I", "-c", FEEDPARSER, src.url, String(o.max || 20)], { timeout: timeoutMs, maxBuffer: 30 * 1024 * 1024 });
      const j = JSON.parse(stdout);
      const latency = Date.now() - t0;
      const status = typeof j.status === "number" ? j.status : null;
      if (status && status >= 400) return { ok: false, backend: "feedparser", http_status: status, latency_ms: latency, error: "HTTP " + status };
      return { ok: true, backend: "feedparser", http_status: status, latency_ms: latency, items: j.items || [], text: "", error: j.items && j.items.length ? "" : j.error || "feed empty" };
    } catch (e) {
      return { ok: false, backend: "feedparser", latency_ms: Date.now() - t0, error: String(e.message).slice(0, 300) };
    }
  }
  if (pr.web === "web_reader") {
    try {
      const { stdout } = await exec(MCPORTER, ["call", "web-reader.webReader", "url=" + src.url], { timeout: timeoutMs, maxBuffer: 30 * 1024 * 1024 });
      return { ok: true, backend: "web_reader", latency_ms: Date.now() - t0, text: stdout };
    } catch (e) {
      return { ok: false, backend: "web_reader", latency_ms: Date.now() - t0, error: String(e.message).slice(0, 300) };
    }
  }
  const r = await httpFetch("https://r.jina.ai/" + src.url, { timeoutMs });
  return Object.assign({}, r, { backend: "jina_reader" });
}
