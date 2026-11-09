/**
 * 解析规则：让模型学会解析一个页面，学会后由程序照着做。
 *
 * 通用解析器认得「标题 + 文章链接」的新闻列表；社交平台的帖子流、结构特别的站点认不出来。
 * 这时把页面骨架（engine --mode outline）交给模型，它指出哪个元素是「一条」、标题 / 链接 / 时间在哪里，
 * 写成 CSS 选择器（extract）。程序马上照着规则试抓一次验证：抓得到几条、标题和链接像不像样；
 * 不过关就把结果告诉模型再改一次。学会的规则存进源的配置，之后每轮都由程序执行，不再调用模型。
 *
 * 不让模型每轮直接读页面：慢（本地模型读一页要一两分钟）、每次结果不完全一样、可能编出不存在的链接和时间。
 */
import { parseJsonLoose } from "./model.mjs";

const SEL_MAX = 200;
const KEYS = ["item", "link", "title", "time", "summary", "wait_for"];

/** 只留认识的键，选择器去掉明显危险或过长的写法。@returns extract 或 null */
export function cleanExtract(x) {
  if (!x || typeof x !== "object") return null;
  const out = {};
  for (const k of KEYS) {
    const v = typeof x[k] === "string" ? x[k].trim() : "";
    if (!v) continue;
    if (v.length > SEL_MAX || /[{};<>`]|javascript:/i.test(v)) continue;
    out[k] = v;
  }
  return out.item ? out : null;
}

export function recipePrompt(o) {
  return "任务：下面是一个网页的简化结构（缩进表示层级，> 表示只有一个子元素的连续层级；方括号里是属性，引号里是文字）。" +
    "这个页面是「" + (o.name || "一个新闻源") + "」的列表页：上面有一条条新闻、快讯或帖子。请找出重复出现的「一条」，写出提取它们的 CSS 选择器。" +
    "\n- item：在整个页面上用 querySelectorAll 能选出每一条的根元素（必填）" +
    "\n- link：在 item 内部，指向这一条详情页的 a 元素（不要选作者主页、话题、图片、统计之类的链接；如果时间元素就在详情链接里，可以写 a:has(time)）" +
    "\n- title：在 item 内部，标题所在的元素；没有单独标题的（如社交平台的帖子），选正文文字所在的元素" +
    "\n- time：在 item 内部，表示发布时间的元素，优先 time[datetime]；没有就留空" +
    "\n- summary：在 item 内部，摘要或正文所在的元素；没有就留空" +
    "\n- wait_for：页面加载时要等它出现的选择器，通常和 item 一样" +
    "\n优先用稳定的写法：data-testid、role、语义标签（article、time、h2）、看起来有意义的 class；不要用像随机生成的 class（如 css-1x2y3z、r-abc12）、不要用 id 里带长数字的、不要用 :nth-child。" +
    (o.feedback ? "\n\n上一次的选择器试抓结果不理想：" + o.feedback + "\n请改正后重新给出。" : "") +
    '\n只输出一个 JSON 对象：{"item":"","link":"","title":"","time":"","summary":"","wait_for":"","note":"一句话说明这个页面每一条长什么样"}' +
    "\n\n页面标题：" + (o.title || "") + "\n地址：" + o.url + "\n\n页面结构：\n" + String(o.outline || "").slice(0, 22000);
}

/** 一次试抓的结果够不够格：至少 3 条，标题不重复、不太短，链接各不相同。 */
export function judgeRecipe(test) {
  const items = (test && test.items) || [];
  const kept = Number((test && test.kept) || 0);
  if (kept > 0 && kept < 3) return { ok: false, why: "只有 " + kept + " 条，多半抓到的是登录页、导航或页面框架，不是一条条的内容" };
  if (!test || !test.ok || kept < 3) return { ok: false, why: "一条都没抓到" + (test && test.attempts && test.attempts[0] && test.attempts[0].error ? "（" + String(test.attempts[0].error).slice(0, 120) + "）" : "") };
  const titles = items.map((x) => String(x.title || ""));
  const uniqT = new Set(titles).size;
  const uniqL = new Set(items.map((x) => x.url)).size;
  const short = titles.filter((t) => [...t].length < 6).length;
  if (uniqL < Math.min(items.length, 3)) return { ok: false, why: "链接大多相同（" + uniqL + " 个不同链接 / " + items.length + " 条），link 选到了不是详情页的链接" };
  if (uniqT < Math.ceil(items.length / 2)) return { ok: false, why: "标题大多相同（" + titles.slice(0, 3).join(" | ") + "），title 选到了作者名之类的固定文字" };
  if (short > items.length / 2) return { ok: false, why: "标题大多太短（" + titles.slice(0, 3).join(" | ") + "），title 可能选到了用户名或按钮" };
  return { ok: true, why: "" };
}

/**
 * 学一个页面的解析规则。
 * @param deps { outline(url) → {ok,title,outline}, test(source) → 试抓结果, model }
 * @returns { ok, extract, test, tries, note, error? }
 */
export async function learnRecipe(deps, src, o) {
  const ol = await deps.outline(src.url);
  if (!ol || !ol.ok || !ol.outline) return { ok: false, error: "outline_failed", detail: (ol && (ol.error || ol.reason)) || "", tries: 0 };
  let feedback = "";
  let last = null;
  const maxTries = (o && o.tries) || 2;
  for (let i = 0; i < maxTries; i++) {
    const text = await deps.model.complete(recipePrompt({ name: src.name, url: src.url, title: ol.title, outline: ol.outline, feedback }), { step: "recipe", maxTokens: 8000, timeoutMs: (o && o.timeoutMs) || 240000 });
    const j = parseJsonLoose(text);
    const extract = cleanExtract(j);
    if (!extract) { feedback = "没有给出可用的 item 选择器。"; last = { ok: false, error: "bad_json", tries: i + 1 }; continue; }
    const test = await deps.test(Object.assign({}, src, { type: "html_index", channels: ["browse"], extract }));
    const verdict = judgeRecipe(test);
    last = { ok: verdict.ok, extract, test, tries: i + 1, note: j && typeof j.note === "string" ? j.note.slice(0, 120) : "", why: verdict.why };
    if (verdict.ok) return last;
    const sample = ((test && test.items) || []).slice(0, 3).map((x) => "「" + String(x.title || "").slice(0, 40) + "」→ " + x.url).join("；");
    feedback = "选择器 " + JSON.stringify(extract) + " 的结果：" + verdict.why + (sample ? "。前几条：" + sample : "");
  }
  return last || { ok: false, error: "no_result", tries: maxTries };
}
