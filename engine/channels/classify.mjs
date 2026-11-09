/** 抓取失败分类：error_kind + 可直接照做的 hint。所有通道共用。 */
import os from "node:os";

/**
 * 错误原文去本机信息再入库/展示：主目录 → ~，临时目录 → <tmp>；子进程「Command failed: <整条命令>」只留后面的原因。
 */
export function scrub(text) {
  let s = String(text == null ? "" : text);
  const lines = s.split("\n");
  if (/^Command failed:/.test(lines[0]) && lines.length > 1) s = lines.slice(1).join("\n").trim() || "command failed";
  else if (/^Command failed:/.test(lines[0])) s = "command failed";
  const home = os.homedir();
  if (home && home.length > 1) s = s.split(home).join("~");
  s = s.replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, "<tmp>").replace(/\/(?:private\/)?tmp\/[^\s"']+/g, "<tmp>");
  const tmp = os.tmpdir();
  if (tmp && tmp.length > 4) s = s.split(tmp).join("<tmp>");
  return s;
}

export function classify(errText, status, text) {
  const s = String(errText || "").toLowerCase();
  const body = String(text || "").slice(0, 4000).toLowerCase();
  if (/relay_down|extension_disconnected|browse_cli_unreachable|browse_not_found|session not found|no browser target|sessionlocked/.test(s)) return { kind: "browser_unavailable", hint: "browse status 检查 relay 与扩展；必要时让用户在 Chrome 工具栏点 browse 按钮重新连接" };
  if (/enotfound|err_name_not_resolved|nodename nor servname/.test(s)) return { kind: "dns", hint: "域名解析失败：换备用域名或走 browse（浏览器可走系统代理）" };
  if (/econnreset|err_connection|econnrefused|socket hang up/.test(s)) return { kind: "connection_reset", hint: "连接被重置：常见于地域封锁或反爬，改用 browse 或 jina" };
  if (/timed out|timeout|exceeded the configured|etimedout/.test(s)) return { kind: "timeout", hint: "调大 timeout_ms 或降低 max_items；确认站点是否被墙" };
  if (/tls|ssl|certificate|err_ssl/.test(s)) return { kind: "tls", hint: "证书问题：检查代理与系统时间" };
  if (status === 404) return { kind: "http_404", hint: "列表页路径变更：更新 config 中的 url" };
  if (status === 429) return { kind: "rate_limited", hint: "被限流：提高抓取间隔，降低 pages" };
  if (status === 403 || /just a moment|captcha|cf-challenge|are you a robot|access denied|perimeterx|datadome/.test(s) || /just a moment|captcha|challenge\.ss/.test(body)) return { kind: "bot_blocked", hint: "反爬拦截：优先 browse 真实浏览器，仍失败则改 RSS 或 Exa 摘要" };
  if (status === 401 || /subscribe|paywall|sign in to continue|订阅|登录后可/.test(body)) return { kind: "paywall", hint: "需登录/订阅：仅存标题与摘要，正文标记 training_ready=0" };
  if (/unexpected end of json|json\.parse|not valid json|cannot read properties|unmatched paren|unexpected token/.test(s)) return { kind: "parse_error", hint: "解析失败：保存的 raw 文件里核对结构，调整选择器" };
  return { kind: "unknown", hint: "查看 raw 文件与 fetch_attempts.error" };
}

/** agent-reach 不可用（未安装 / venv 缺 python / feedparser 缺失）。 */
export const AGENT_REACH_MISSING = { kind: "channel_unavailable", hint: "agent-reach 未安装或找不到：安装 agent-reach 或在插件配置里填 agentReachBin；该源会继续降级到 http" };
