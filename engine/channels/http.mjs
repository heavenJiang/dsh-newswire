/** http 直取与 jina（r.jina.ai 转 Markdown）两个通道。 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** 按响应头或页面 <meta charset> 解码（GBK / GB2312 的中文站不少），默认 UTF-8。 */
export function decodeBody(buf, contentType) {
  let cs = (/charset=["']?([\w-]+)/i.exec(String(contentType || "")) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1")) || [])[1];
  cs = String(cs || "utf-8").toLowerCase();
  if (cs === "gb2312" || cs === "gbk") cs = "gb18030";
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString("utf8"); }
}

export async function httpFetch(url, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs || 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } });
    const text = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type"));
    const latency = Date.now() - t0;
    if (!res.ok) return { ok: false, http_status: res.status, latency_ms: latency, error: "HTTP " + res.status, text: text.slice(0, 4000) };
    return { ok: true, http_status: res.status, latency_ms: latency, bytes: Buffer.byteLength(text), text };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e && e.cause && e.cause.code ? e.cause.code + ": " + e.cause.message : String(e.message), text: "" };
  } finally {
    clearTimeout(timer);
  }
}

export async function jinaFetch(url, opts) {
  const o = opts || {};
  const r = await httpFetch("https://r.jina.ai/" + url, { timeoutMs: o.timeoutMs || 25000 });
  if (r.ok) return { ...r, channel: "jina" };
  return r;
}
