/** 适配器共用：平衡括号取 JSON 对象、Next.js 数据提取。 */

/** 从 text[start] 处的 "{" 取一个完整 JSON 对象的结束位置（含字符串转义处理），失败返回 -1。 */
export function objectEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 扫描 text 中所有以 marker 开头的 JSON 对象，交给 accept 过滤。 */
export function scanObjects(text, marker, accept) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) break;
    const end = objectEnd(text, at);
    if (end < 0) break;
    let obj = null;
    try { obj = JSON.parse(text.slice(at, end + 1)); } catch { obj = null; }
    if (obj && accept(obj)) { out.push(obj); from = end + 1; } else from = at + marker.length;
  }
  return out;
}

/** Next.js App Router 的 RSC 流：self.__next_f.push([1,"..."]) 拼回原文。 */
export function nextFlightText(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let out = "";
  let m;
  while ((m = re.exec(String(html)))) {
    try { out += JSON.parse('"' + m[1] + '"'); } catch { /* 单块坏了跳过 */ }
  }
  return out;
}

/** Next.js Pages Router 的 __NEXT_DATA__。 */
export function nextData(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function attr(tag, name) {
  const m = String(tag).match(new RegExp("\\b" + name + '="([^"]*)"'));
  return m ? m[1] : "";
}
