/**
 * 找原文（一手信息）：AI 与新技术这类新闻，读者要的是第一手——官网公告、论文、官方账号、代码仓库，
 * 不是聚合站、快讯站的转述，也不必等多家媒体印证。
 *
 * 聚合站（AI 热榜、Telegram 频道、链捕手……）的条目页上通常带着出处：「打开原文」「信源」「原文链接」。
 * 这里打开条目页，取出那个外链，再读回原文正文，存进 articles.origin_url / origin_site / origin_text。
 * 写稿时原文作为材料的一部分给模型（核对也认它），版面和推送里把「原文」列在最前面。
 *
 * origin_url：NULL = 还没找过；'' = 找过，页面上没有出处；否则是原文地址。
 */
import { httpFetch } from "../channels/http.mjs";
import { clean, isoUtc } from "../util/text.mjs";
import { fetchBody } from "./bodies.mjs";

/** 指向出处的链接文字。 */
const ORIGIN_TEXT = /^(打开原文|查看原文|阅读原文|原文链接|原文地址|原文|信源|消息来源|来源链接|来源|出处|在\s*X\s*查看原推|查看原推|Source|Original( post| article)?|Read (the )?original)(\s|[:：]|$)/i;
/** 不是出处的外链：分享按钮、备案、站点自己的社交账号与 App 下载。 */
const NOT_ORIGIN = /(\/share|intent\/tweet|service\.weibo\.com|beian\.|miit\.gov\.cn|support\.qq\.com|xhslink\.com|apps\.apple\.com|play\.google\.com|notion\.site)/i;

/**
 * 一手发布方：官网、论文、官方账号与代码仓库所在的站点。原文落在这些站点上的算「一手」；
 * 落在别的媒体上（the-decoder、IT之家）的只是更早一层的报道，照样列出，但不标一手。
 */
const FIRST_HAND = [
  "openai.com", "anthropic.com", "claude.com", "deepmind.google", "blog.google", "ai.google", "ai.google.dev", "research.google", "googleblog.com",
  "ai.meta.com", "about.fb.com", "microsoft.com", "nvidia.com", "nvidianews.nvidia.com", "apple.com", "amazon.science", "aboutamazon.com", "aws.amazon.com",
  "x.ai", "mistral.ai", "cohere.com", "deepseek.com", "qwenlm.github.io", "qwen.ai", "alibabacloud.com", "moonshot.cn", "kimi.com", "zhipuai.cn", "bigmodel.cn",
  "minimaxi.com", "minimax.io", "volcengine.com", "bytedance.com", "seed.bytedance.com", "baidu.com", "tencent.com", "huawei.com", "stepfun.com", "01.ai",
  "arxiv.org", "openreview.net", "nature.com", "science.org", "huggingface.co", "github.com", "github.blog",
  "amd.com", "intel.com", "tsmc.com", "samsung.com", "semiconductor.samsung.com", "skhynix.com", "micron.com", "arm.com", "qualcomm.com", "cerebras.ai", "groq.com",
];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
/**
 * 原文是不是一手：发布方自己的官网、论文、代码站点；或者站点名就是标题里说的那家公司
 * （「Databricks 升级 Genie」→ databricks.com，「腾讯混元 Hy4」→ hy.tencent.ai）。
 * X（推特）上的帖子只有账号就是标题里那家公司或那个人时才算（@GoogleDeepMind 发 DeepMind 的消息）；
 * 评论者、搬运号转述别人的消息（@rohanpaul_ai 发外交部的回应）只是更早一层的转述。
 */
export function isFirstHand(url, title) {
  const h = hostOf(url);
  if (!h) return false;
  const t = titleKeys(title);
  const x = /^(?:x|twitter)\.com$/.test(h) && /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\//.exec(String(url));
  if (/^(?:x|twitter)\.com$/.test(h)) return Boolean(x) && handleMatches(x[1], t);
  if (FIRST_HAND.some((d) => h === d || h.endsWith("." + d))) return true;
  if (MEDIA.test(h)) return false;
  const parts = h.split(".");
  const name = parts.length >= 2 ? parts[parts.length - 2] : "";
  return name.length >= 4 && (t.flat.includes(name) || t.words.some((w) => w === name));
}
/** 中文名 → 外文名，标题里写中文名时也认得出官网和官方账号。 */
const ALIASES = { 谷歌: "google", 微软: "microsoft", 英伟达: "nvidia", 苹果: "apple", 亚马逊: "amazon", 腾讯: "tencent", 混元: "hunyuan", 阿里: "alibaba", 通义: "qwen", 千问: "qwen",
  字节: "bytedance", 豆包: "doubao", 百度: "baidu", 文心: "ernie", 智谱: "zhipu", 月之暗面: "moonshot", 深度求索: "deepseek", 阶跃: "stepfun", 华为: "huawei", 小米: "xiaomi",
  三星: "samsung", 台积电: "tsmc", 英特尔: "intel", 高通: "qualcomm", 美光: "micron", 海力士: "skhynix", 特斯拉: "tesla", 马斯克: "elonmusk", 奥特曼: "sama", 黄仁勋: "nvidia" };
/** 标题里认公司与人名用的词：外文词、相邻两个外文词连写（Jim Fan → jimfan）、中文名换成外文名。 */
function titleKeys(title) {
  let s = String(title || "");
  for (const [zh, en] of Object.entries(ALIASES)) if (s.includes(zh)) s += " " + en;
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const pairs = words.slice(1).map((w, i) => words[i] + w);
  return { words: words.concat(pairs).filter((w) => w.length >= 4), flat: s.toLowerCase().replace(/[^a-z0-9]+/g, "") };
}
/** X 账号和标题里的公司或人对得上：账号去掉 _ 与常见后缀后够长、出现在标题里；或标题里的词出现在账号里。 */
function handleMatches(handle, t) {
  const hd = String(handle || "").toLowerCase().replace(/_/g, "");
  const stem = hd.replace(/(official|ai|hq|news|labs?|team|inc|global)$/g, "");
  if (stem.length >= 4 && t.flat.includes(stem)) return true;
  return t.words.some((w) => !/^\d+$/.test(w) && hd.includes(w));
}
/** 媒体与聚合站：站点名出现在标题里（「据 TechCrunch」）也不算发布方自己。 */
const MEDIA = /(techcrunch|theverge|reuters|bloomberg|wsj|nytimes|ft\.com|cnbc|forbes|wired|engadget|ithome|36kr|the-decoder|venturebeat|theinformation|businessinsider|semianalysis|tomshardware|anandtech|theblockbeats|odaily|chaincatcher|techflow|cls\.cn|wallstreetcn|jiemian|thepaper|sina|qq\.com|163\.com|sohu|latent\.space|substack|medium\.com|beehiiv|newsletter|weixin)/i;

/** 读者看到的站点名：X（推特）上的写成「X @账号」，看得出是谁发的。 */
export function siteOf(url) {
  const h = hostOf(url);
  const m = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\/status\//.exec(String(url || ""));
  return m ? "X @" + m[1] : h;
}

/** 原文正文的清理：X 的页面读出来还带着回复，只留原帖那一段。 */
export function originText(url, text) {
  const t = String(text || "");
  if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//.test(String(url || ""))) {
    const m = /on X: "([\s\S]*?)"\s*(\n|\/\s*Conversation|$)/.exec(t);
    if (m) return m[1].trim();
    return t.split(/\n\s*Conversation\b|\/\s*Conversation\b/)[0].trim();
  }
  return t;
}
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/");

/**
 * 条目页 HTML 里的出处链接：链接文字像「打开原文」「信源」、指向别的站点、不是分享按钮。
 * 几个都像时，取指向一手站点的；再按出现次数（同一出处常在页上出现多次）。
 * @returns 原文地址，找不到返回 ""
 */
export function originLink(html, pageUrl) {
  const page = hostOf(pageUrl);
  const score = new Map();
  for (const m of String(html || "").matchAll(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const url = decode(m[1]).replace(/#.*$/, "");
    const h = hostOf(url);
    if (!h || h === page || h.endsWith("." + page) || page.endsWith("." + h) || NOT_ORIGIN.test(url)) continue;
    const text = clean(m[2]).replace(/\s+/g, " ").trim();
    if (text.length > 30 || !ORIGIN_TEXT.test(text)) continue;
    score.set(url, (score.get(url) || 0) + 1 + (isFirstHand(url) ? 10 : 0));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

/** 打开条目页用的地址：Telegram 单条消息页要 ?embed=1 才是静态 HTML。 */
export function pageUrlFor(url) {
  const u = String(url || "");
  if (/^https:\/\/t\.me\/[\w]+\/\d+/.test(u) && !/[?&]embed=1/.test(u)) return u.replace(/\?.*$/, "") + "?embed=1";
  return u;
}

/**
 * 本轮该找原文的条目：本轮出现的、属于重点领域（labels）、来自非一手源（聚合、快讯、没标层级的自加源）、没找过的。
 * 自己就在一手站点上的（OpenAI News 这类官方源）不用找。
 */
export function originCandidates(db, o) {
  const labels = (o.labels || []).filter(Boolean);
  if (!labels.length || !o.budget) return [];
  const hit = labels.map(() => "(l.label = ? OR l.label LIKE ?)").join(" OR ");
  const rows = db.prepare(`SELECT DISTINCT a.id, a.url, a.title, a.source_id, COALESCE(e.importance, 0) AS importance FROM observations ob JOIN articles a ON a.id = ob.article_id
      LEFT JOIN sources s ON s.id = a.source_id LEFT JOIN event_members m ON m.article_id = a.id LEFT JOIN events e ON e.event_id = m.event_id
    WHERE ob.run_id = ? AND a.origin_url IS NULL AND COALESCE(a.kind, 'news') NOT IN ('promo', 'digest', 'ticker') AND COALESCE(s.tier, '') != 'community'
      AND EXISTS (SELECT 1 FROM article_labels l WHERE l.article_id = a.id AND (${hit}))
    ORDER BY importance DESC`).all(o.runId, ...labels.flatMap((x) => [x, x + ".%"]));
  return rows.filter((r) => /^https?:\/\//.test(r.url || "") && !isFirstHand(r.url)).slice(0, o.budget);
}

/**
 * 给一批条目找原文并读回正文；并发、同一网站最多 2 个请求、总时长有上限。
 * @returns { tried, found, first_hand, read, ms }
 */
export async function findOrigins(db, list, o) {
  const t0 = Date.now();
  const opt = o || {};
  const up = db.prepare("UPDATE articles SET origin_url = ?, origin_site = ?, origin_text = ?, origin_at = ? WHERE id = ?");
  const queue = list.slice();
  const busy = new Map();
  const st = { tried: 0, found: 0, first_hand: 0, read: 0 };
  const getPage = opt.fetchPage || ((u) => httpFetch(u, { timeoutMs: 15000 }));
  const getBody = opt.fetchBody || ((u) => fetchBody(u, { browse: opt.browse, timeoutMs: 15000 }));
  const worker = async () => {
    while (queue.length && Date.now() - t0 < (opt.maxMs || 75000)) {
      const i = queue.findIndex((c) => (busy.get(hostOf(c.url)) || 0) < 2);
      if (i < 0) { await new Promise((r) => setTimeout(r, 100)); continue; }
      const c = queue.splice(i, 1)[0];
      const h = hostOf(c.url);
      busy.set(h, (busy.get(h) || 0) + 1);
      try {
        st.tried++;
        const p = await getPage(pageUrlFor(c.url)).catch(() => ({ ok: false }));
        // 条目页打不开：这次不记，下一轮出现时再试
        if (!p.ok) continue;
        const url = originLink(p.text, c.url);
        if (!url) { up.run("", null, null, isoUtc(Date.now()), c.id); continue; }
        st.found++;
        if (isFirstHand(url, c.title)) st.first_hand++;
        // 原文正文：读不到也记下链接（读者点得到原文）
        const b = await getBody(url).catch(() => ({ ok: false }));
        const text = b && b.ok ? originText(url, b.text).slice(0, 6000) || null : null;
        if (text) st.read++;
        up.run(url, siteOf(url), text, isoUtc(Date.now()), c.id);
      } finally {
        busy.set(h, busy.get(h) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opt.concurrency || 4) }, worker));
  return Object.assign(st, { ms: Date.now() - t0 });
}
