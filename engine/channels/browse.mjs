import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

function rssFallback(text, max) {
  const blocks = String(text).match(/<item[\s\S]*?<\/item>/gi) || [];
  const out = [];
  const one = (b, n) => { const m = b.match(new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">", "i")); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : ""; };
  for (const b of blocks.slice(0, max || 20)) {
    const title = one(b, "title").replace(/<[^>]*>/g, "").trim();
    const link = one(b, "link").trim();
    if (!title || !link) continue;
    out.push({ title, link, published_at: one(b, "pubDate").trim(), summary: one(b, "description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200), content: "" });
  }
  return out;
}
/** browse CLI 路径：由调用方用 configureBrowse 注入（插件按 Config 或自动探测），没有就视为通道不可用。 */
let BIN = process.env.BROWSE_BIN || "";
let SESSION = process.env.BROWSE_SESSION || "news-ingest";

export function configureBrowse(o) {
  if (o && o.bin && o.bin !== true) BIN = String(o.bin);
  if (o && o.session) SESSION = String(o.session);
}
const TMP = mkdtempSync(path.join(os.tmpdir(), "news-browse-"));

export function browseBin() { return BIN; }
export function browseSession() { return SESSION; }

function lines(a) { return a.join("\n"); }

function head(url) {
  return [
    "const JOB_URL = " + JSON.stringify(url) + ";",
    "await page.goto(JOB_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });",
    "if (WAITFOR) { try { await page.waitForSelector(WAITFOR, { state: 'attached', timeout: 15000 }); } catch (e) {} }",
    "await new Promise((r) => setTimeout(r, 1800));"
  ];
}

function tail(mode, token) {
  return [
    "const OUT_JSON = JSON.stringify(payload);",
    "const OUT_PATH = await files.write('out-" + token + ".json', OUT_JSON);",
    "return { mode: " + JSON.stringify(mode) + ", page_url: page.url(), doc_title: await page.title(), out_path: OUT_PATH, bytes: OUT_JSON.length, count: (payload.items || []).length, pages: payload.pages === undefined ? null : payload.pages, stop: payload.stop === undefined ? null : payload.stop };"
  ];
}

const RSS_BODY = [
  "const payload = await page.evaluate((max) => {",
  "  const pick = (el, names) => { for (const n of names) { const l = el.getElementsByTagName(n); if (l.length && l[0].textContent.trim()) return l[0].textContent.trim(); } return ''; };",
  "  let list = Array.prototype.slice.call(document.getElementsByTagName('item'));",
  "  if (!list.length) list = Array.prototype.slice.call(document.getElementsByTagName('entry'));",
  "  const items = list.slice(0, max).map((n) => {",
  "    let link = pick(n, ['link']);",
  "    if (!/^https?:/.test(link)) { const g = pick(n, ['guid', 'id']); if (/^https?:/.test(g)) link = g; }",
  "    if (!/^https?:/.test(link)) { const a = n.getElementsByTagName('link')[0]; if (a && a.getAttribute('href')) link = a.getAttribute('href'); }",
  "    const enc = pick(n, ['content:encoded']);",
  "    const desc = pick(n, ['description', 'summary', 'media:description']);",
  "    return { title: pick(n, ['title']), link, published_at: pick(n, ['pubDate', 'published', 'updated', 'date']), summary: String(desc).slice(0, 1200), content: String(enc || desc).slice(0, 6000) };",
  "  }).filter((x) => x.title && x.link);",
  "  return { items, xml_text: (document.body ? document.body.innerText : '').slice(0, 400000) };",
  "}, MAXN);"
];

const INDEX_BODY = [
  "const payload = await page.evaluate((max) => {",
  "  const origin = location.origin; const out = []; const seen = new Set();",
  "  const skip = /(login|register|signup|about|help|service|privacy|terms|download|tag|topic|rss|sitemap|search|\\/page\\/|\\?page=)/i;",
  "  const artish = /(\\d{5,}|\\d{4}-\\d{2}-\\d{2}|[a-f0-9]{16,}|c\\.html$|\\.s?html$|article|news|detail|story|report|live|note|comment|zhengce|politics)/i;",
  "  for (const a of document.querySelectorAll('a[href]')) {",
  "    if (a.closest('nav, header, footer, aside')) continue;",
  "    const title = (a.innerText || '').replace(/\\s+/g, ' ').trim();",
  "    if (title.length < 10 || title.length > 200) continue;",
  "    let abs = a.href || '';",
  "    if (!/^https?:/.test(abs)) continue;",
  "    let u;",
  "    try { u = new URL(abs); } catch (e) { continue; }",
  "    if (u.origin !== origin) continue;",
  "    if (/\\.(pdf|jpg|jpeg|png|gif|mp4|docx?)($|\\?)/i.test(u.pathname)) continue;",
  "    if (skip.test(u.pathname)) continue;",
  "    if (!artish.test(u.pathname)) continue;",
  "    if (seen.has(abs)) continue; seen.add(abs);",
  "    const blk = a.closest('li, article, tr, div');",
  "    const raw = blk ? blk.innerText.replace(/\\s+/g, ' ').trim() : '';",
  "    const hay = raw + ' || ' + (a.parentElement ? a.parentElement.innerText.replace(/\\s+/g, ' ') : '');",
  "    const mt = hay.match(/(\\d{4}-\\d{2}-\\d{2}(?: \\d{1,2}:\\d{2})?|\\d{1,2}月\\d{1,2}日|\\d{1,2}:\\d{2}|\\d+\\s*(分钟前|小时前|天前|days? ago|hours? ago|mins? ago)|刚刚)/i);",
  "    // 链接所在的块里有很多别的链接时，它是一整片列表而不是这一条的摘要：不当摘要",
  "    const nLinks = blk ? blk.querySelectorAll('a[href]').length : 0;",
  "    let summary = nLinks <= 3 ? raw.slice(0, 300) : '';",
  "    if (summary.startsWith(title)) summary = summary.slice(title.length, title.length + 240).trim();",
  "    out.push({ title, link: abs, published_at: '', published_raw: mt ? mt[0] : '', summary, content: '' });",
  "    if (out.length >= max) break;",
  "  }",
  "  return { items: out };",
  "}, MAXN);"
];

const ARTICLE_BODY = [
  "const payload = await page.evaluate(() => {",
"    const meta = (n) => { const sel = 'meta[property=' + JSON.stringify(n) + '], meta[name=' + JSON.stringify(n) + ']'; const e = document.querySelector(sel); return e ? e.content : ''; };",
  "  const cand = document.querySelector('article') || document.querySelector('main') || document.body;",
  "  const text = cand ? cand.innerText.replace(/\\n{2,}/g, '\\n') : '';",
  "  const timeEl = document.querySelector('time[datetime]');",
  "  const ld = Array.from(document.querySelectorAll('script[type=' + JSON.stringify('application/ld+json') + ']')).map((s) => s.textContent.slice(0, 4000));",
  "  return { items: [], text: text.slice(0, 20000), meta: { title: meta('og:title'), desc: meta('og:description'), canonical: meta('og:url'), date: timeEl ? timeEl.getAttribute('datetime') : '' }, ld, paywall: /subscribe|Sign in to continue|订阅|paywall|Start a free trial/i.test((document.body ? document.body.innerText : '').slice(0, 4000)) };",
  "}, MAXN);"
];

// 按解析规则提取（规则通常由模型看过页面结构后生成，见 host/recipe.mjs）：
// extract = { item, link?, title?, time?, summary?, wait_for? }，都是 CSS 选择器；item 选出每一条，其余在每条内部找。
// 没有单独标题的（社交平台的帖子）取正文第一行作标题，全文作摘要。往下滚几屏，让懒加载的列表多出一些。
const SELECT_BODY = [
  "const EX = EXTRACT;",
  "try { await page.waitForSelector(EX.wait_for || EX.item, { state: 'attached', timeout: 15000 }); } catch (e) {}",
  "for (let i = 0; i < 3; i++) { try { await page.mouse.wheel(0, 2200); } catch (e) {} await new Promise((r) => setTimeout(r, 900)); }",
  "const payload = await page.evaluate((a) => {",
  "  const ex = a.ex, max = a.max; const out = []; const seen = new Set();",
  "  const flat = (t) => String(t || '').replace(/\\s+/g, ' ').trim();",
  "  let list = []; try { list = Array.from(document.querySelectorAll(ex.item)); } catch (e) { return { items: [], error: 'bad item selector' }; }",
  "  const q = (el, sel) => { if (!sel) return null; try { return el.matches(sel) ? el : el.querySelector(sel); } catch (e) { return null; } };",
  "  for (const it of list) {",
  "    const lEl = q(it, ex.link) || (it.matches('a[href]') ? it : it.querySelector('a[href]'));",
  "    const link = lEl && lEl.href ? lEl.href.split('#')[0] : '';",
  "    if (!/^https?:/.test(link) || seen.has(link)) continue;",
  "    const tEl = q(it, ex.title) || lEl;",
  "    const raw = tEl ? String(tEl.innerText || tEl.textContent || '').trim() : '';",
  "    const first = flat(raw.split(/\\n+/)[0]);",
  "    if (!first) continue;",
  "    seen.add(link);",
  "    const title = first.length > 120 ? first.slice(0, 100) + '…' : first;",
  "    const sEl = q(it, ex.summary);",
  "    let summary = flat(sEl ? sEl.innerText : raw);",
  "    if (summary === title) summary = '';",
  "    const tm = q(it, ex.time) || it.querySelector('time');",
  "    const iso = tm ? (tm.getAttribute('datetime') || '') : '';",
  "    out.push({ title, link, published_at: iso, published_raw: tm && !iso ? flat(tm.innerText).slice(0, 40) : '', summary: summary.slice(0, 1200), content: '' });",
  "    if (out.length >= max) break;",
  "  }",
  "  return { items: out, found: list.length };",
  "}, { ex: EX, max: MAXN });"
];

// 页面结构概要：给模型看的骨架（标签、id、少量 class、data-* 、链接与时间属性、短文本），
// 只有一个子元素又没有自己文字的层级压成一行，连续相同的兄弟只留前 3 个，总长有上限。
const OUTLINE_BODY = [
  "await new Promise((r) => setTimeout(r, 2500));",
  "for (let i = 0; i < 2; i++) { try { await page.mouse.wheel(0, 1800); } catch (e) {} await new Promise((r) => setTimeout(r, 900)); }",
  "const payload = await page.evaluate(() => {",
  "  const SKIP = new Set(['SCRIPT','STYLE','SVG','NOSCRIPT','IFRAME','PATH','G','LINK','META','TEMPLATE','CANVAS','VIDEO','IMG','PICTURE','SOURCE','BUTTON','INPUT','FORM','NAV','HEADER','FOOTER','ASIDE']);",
  "  const lines = []; let size = 0; const LIMIT = 24000;",
  "  const sig = (el) => {",
  "    let s = el.tagName.toLowerCase();",
  "    if (el.id && !/\\d{4,}/.test(el.id)) s += '#' + el.id;",
  "    const cls = Array.from(el.classList || []).filter((c) => c.length < 30 && !/^css-|^r-|[0-9a-z]{6,}\\d/.test(c)).slice(0, 2);",
  "    if (cls.length) s += '.' + cls.join('.');",
  "    for (const at of el.attributes || []) if (/^data-(testid|id|type|role)$|^role$|^itemprop$/.test(at.name) && at.value.length < 40) s += '[' + at.name + '=' + at.value + ']';",
  "    if (el.tagName === 'A' && el.getAttribute('href')) s += '[href=' + el.getAttribute('href').slice(0, 70) + ']';",
  "    if (el.tagName === 'TIME' && el.getAttribute('datetime')) s += '[datetime=' + el.getAttribute('datetime') + ']';",
  "    return s;",
  "  };",
  "  const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\\s+/g, ' ').trim();",
  "  const walk = (el, depth, prefix) => {",
  "    if (size > LIMIT || depth > 60 || SKIP.has(el.tagName.toUpperCase())) return;",
  "    const kids = Array.from(el.children).filter((c) => !SKIP.has(c.tagName.toUpperCase()));",
  "    const txt = own(el);",
  "    if (kids.length === 1 && !txt && el.tagName !== 'A' && el.tagName !== 'ARTICLE' && el.tagName !== 'LI') { walk(kids[0], depth + 1, prefix + sig(el) + ' > '); return; }",
  "    const line = '  '.repeat(Math.min(depth, 30)) + prefix + sig(el) + (txt ? ' “' + txt.slice(0, 60) + '”' : '');",
  "    lines.push(line); size += line.length + 1;",
  "    let run = 0, last = '';",
  "    for (const c of kids) {",
  "      const k = sig(c);",
  "      run = k === last ? run + 1 : 0; last = k;",
  "      if (run === 3) { const n = kids.filter((x) => sig(x) === k).length; const l2 = '  '.repeat(Math.min(depth + 1, 30)) + '…（同样的 ' + k + ' 共 ' + n + ' 个）'; lines.push(l2); size += l2.length; }",
  "      if (run >= 3) continue;",
  "      walk(c, depth + 1, '');",
  "    }",
  "  };",
  "  const root = document.querySelector('main, [role=main]') || document.body;",
  "  walk(root, 0, '');",
  "  return { items: [], outline: lines.join('\\n').slice(0, LIMIT), truncated: size > LIMIT };",
  "});"
];

// 站点适配器用：把渲染后的整页 HTML 交回 Node 侧，由 engine/adapters/<id>.mjs 解析（与 http 通道共用同一解析器）。
const HTML_BODY = [
  "if (WAITFOR) { try { await page.waitForSelector(WAITFOR, { state: 'attached', timeout: 15000 }); } catch (e) {} } else { await new Promise((r) => setTimeout(r, 1200)); }",
  "const payload = { items: [], html: await page.content() };",
];

const CLS_BODY = [
  "await page.goto('https://www.cls.cn/telegraph', { waitUntil: 'domcontentloaded', timeout: 35000 });",
  "function signOf(p) { const qs = Object.keys(p).sort().map((k) => k + '=' + p[k]).join('&'); return crypto.createHash('md5').update(crypto.createHash('sha1').update(qs).digest('hex')).digest('hex'); }",
  "// 有断点时翻到上一轮最新那条之前 5 分钟（留重叠，判衔接用）；没有断点按时间窗",
  "const CUT = UNTIL ? UNTIL - 300 : Math.floor(Date.now() / 1000) - SINCE * 3600;",
  "const items = new Map(); let lastTime = Math.floor(Date.now() / 1000); let pages = 0; let stop = 'page limit';",
  "while (pages < PAGES) {",
  "  const p = { app: 'CailianpressWeb', last_time: String(lastTime), os: 'web', refresh_type: '1', rn: '20', sv: '8.7.9' };",
  "  if (CATEGORY) p.category = CATEGORY;",
  "  const u = 'https://www.cls.cn/v1/roll/get_roll_list?' + Object.keys(p).sort().map((k) => k + '=' + p[k]).join('&') + '&sign=' + signOf(p);",
  "  const res = await page.evaluate(async (uu) => { const r = await fetch(uu, { headers: { accept: 'application/json' } }); if (r.status !== 200) return { status: r.status, items: [] }; const j = await r.json(); return { status: r.status, errno: j.errno, items: (j.data && j.data.roll_data) || [] }; }, u);",
  "  pages++;",
  "  if (res.status !== 200 || res.errno !== 0) { stop = 'bad api ' + res.status + '/' + res.errno; break; }",
  "  if (!res.items.length) { stop = 'empty page'; break; }",
  "  let oldest = lastTime;",
  "  for (const x of res.items) {",
  "    if (x.ctime < oldest) oldest = x.ctime;",
  "    if (x.ctime >= CUT && !x.is_ad && !x.is_fad) items.set(x.id, { title: (x.title || '').trim(), link: 'https://www.cls.cn/detail/' + x.id, published_at: new Date(x.ctime * 1000).toISOString(), summary: String(x.brief || x.content || '').replace(/\\s+/g, ' ').slice(0, 1200), content: String(x.content || '').replace(/\\s+/g, ' ').slice(0, 6000), metrics: { level: x.level, reading: x.reading_num, share: x.share_num, comments: x.comment_num, subjects: (x.subjects || []).map((s) => s.subject_name) } });",
  "  }",
  "  if (oldest < CUT) { stop = 'reached window cutoff'; break; }",
  "  if (oldest >= lastTime) { stop = 'no progress'; break; }",
  "  lastTime = oldest;",
  "  await new Promise((r) => setTimeout(r, 300));",
  "}",
  "const payload = { items: Array.from(items.values()), pages, stop };"
];

export function renderJob(mode, url, max, opts) {
  const m = opts || {};
  const token = m.token || "x";
  let body = mode === "rss" ? RSS_BODY : mode === "cls_api" ? CLS_BODY : mode === "article" ? ARTICLE_BODY : mode === "html" ? HTML_BODY : mode === "select" ? SELECT_BODY : mode === "outline" ? OUTLINE_BODY : INDEX_BODY;
  const pre = mode === "cls_api" ? [] : head(url);
  const fill = (l) => l.replaceAll("WAITFOR", JSON.stringify(m.waitFor || ""));
  if (mode === "select") body = body.map((l) => l.replaceAll("EXTRACT", JSON.stringify(m.extract || {})));
  const src = pre.map(fill).concat(body.map((l) => l.replaceAll("MAXN", String(max || 20)).replaceAll("SINCE", String(m.sinceHours || 24)).replaceAll("PAGES", String(m.pages || 8)).replaceAll("UNTIL", String(m.until ? Math.floor(Date.parse(String(m.until).replace(" ", "T") + (String(m.until).includes("T") ? "" : "Z")) / 1000) || 0 : 0)).replaceAll("CATEGORY", JSON.stringify(m.category || "")).replaceAll("WAITFOR", JSON.stringify(m.waitFor || "")))).concat(tail(mode, token));
  return "'use strict';\n" + src.join("\n");
}

export async function browseStatus() {
  if (!BIN) return { ok: false, reason: "browse_not_found", detail: "未找到 browse CLI（插件配置 browseBin 或把 browse 放进 PATH）" };
  try {
    const { stdout } = await exec(BIN, ["status", "--json"], { timeout: 30000 });
    const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const b = (j.extension && j.extension.browsers && j.extension.browsers[0]) || null;
    const ok = Boolean(j.relay && j.relay.running && j.extension && j.extension.connected && b);
    let reason = "";
    if (!ok) reason = !j.relay || !j.relay.running ? "relay_down" : !j.extension || !j.extension.connected ? "extension_disconnected" : "no_browser_target";
    return { ok, reason, browser: b ? b.id : null, relay: !!(j.relay && j.relay.running), extension: !!(j.extension && j.extension.connected) };
  } catch (e) {
    return { ok: false, reason: "browse_cli_unreachable", detail: String(e.message).slice(0, 200) };
  }
}

export async function ensureSession() {
  try { await exec(BIN, ["session", "new", SESSION], { timeout: 30000 }); return { ok: true }; }
  catch (e) { return { ok: false, detail: String(e.message).slice(0, 200) }; }
}

export async function browseFetch(mode, url, max, opts) {
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const src = renderJob(mode, url, max, Object.assign({}, opts, { token }));
  const f = path.join(TMP, "job-" + token + ".mjs");
  writeFileSync(f, src);
  const t0 = Date.now();
  const ms = (opts && opts.timeoutMs) || 60000;
  try {
    const { stdout } = await exec(BIN, ["execute", "--session", SESSION, "--json", "--timeout-ms", String(ms), "--file", f], { timeout: ms + 40000, maxBuffer: 60 * 1024 * 1024 });
    const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const latency = Date.now() - t0;
    if (!j.ok) return { ok: false, latency_ms: latency, error: (j.error && j.error.message) || "execute_failed", aftermath: j.aftermath };
    let data = null;
    const outPath = j.value && j.value.out_path;
    if (outPath) {
      try {
        if (existsSync(outPath)) { data = JSON.parse(readFileSync(outPath, "utf8")); }
      } catch (e) {}
    }
    if (data && Array.isArray(data.items) && !data.items.length && data.xml_text) {
      try { data.items = rssFallback(data.xml_text, max); } catch (e) {}
    }
    return { ok: true, latency_ms: latency, value: j.value, data, valueUnavailable: j.valueUnavailable, aftermath: j.aftermath, warnings: j.warnings };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String(e.message).slice(0, 400) };
  } finally {
    try { unlinkSync(f); } catch (e) {}
  }
}
