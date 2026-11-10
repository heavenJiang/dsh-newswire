/* 浏览器半边烟测：假 window.__ModuleLoader__ + 假 React + 假 fetch，验证注册与四个页签组件能构建。 */
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(path.join(PKG, "client.js"), "utf8");

const stats = { nodes: 0, effects: 0 };
const stateQueue = [];
const withStates = (states, fn) => { stateQueue.length = 0; stateQueue.push(...states); try { return fn(); } finally { stateQueue.length = 0; } };
const problems = [];
// 对象字面量里重复的键会被后一个悄悄覆盖（例如「分析影响」的请求会错发到事件解读接口）：接口表与中英文案表不许重复
{
  const src = (await import("node:fs")).readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const block = (start) => { const i = src.indexOf(start); let d = 0, j = src.indexOf("{", i); const k0 = j; for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; } return src.slice(k0, j); };
  const dupes = (text, re) => { const seen = new Set(), out = []; for (const m of text.matchAll(re)) { if (seen.has(m[1])) out.push(m[1]); seen.add(m[1]); } return out; };
  const api = dupes(block("var API = {"), /^\s*([A-Za-z_]+):\s*'/gm);
  const zh = dupes(block("      zh: {"), /'([a-zA-Z][\w.]*)':/g);
  const en = dupes(block("      en: {"), /'([a-zA-Z][\w.]*)':/g);
  if (api.length) problems.push("API 重复键：" + api.join(","));
  if (zh.length) problems.push("中文文案重复键：" + zh.join(","));
  if (en.length) problems.push("英文文案重复键：" + en.join(","));
}


function el(type, props, ...children) {
  stats.nodes += 1;
  return { type, props: props || {}, children: children.flat(Infinity) };
}
const React = {
  createElement: el,
  // stateQueue 不空时按顺序替换 useState 的初值，用来渲染有数据的分支
  useState: (init) => [stateQueue.length ? stateQueue.shift() : init && init.phase === "idle" && "continuity" in init ? ATTEMPTS_STATE() : init, () => {}],
  useEffect: (fn) => { stats.effects += 1; try { fn(); } catch (e) { problems.push("effect: " + e.message); } },
  useCallback: (fn) => fn,
  useMemo: (fn) => { try { return fn(); } catch (e) { problems.push("memo: " + e.message); return null; } },
  useRef: (v) => ({ current: v }),
  Component: class { constructor(props) { this.props = props; this.state = null } setState(s) { this.state = s } },
};

const SUMMARY = {
  data_asof: "2026-11-08T08:00:00Z", window_hours: 24, stale: false,
  latest_run: { run_id: "run-x", started_at: "2026-11-08 08:00:00", finished_at: "2026-11-08 08:01:00", sources_ok: 18, sources_failed: 1, items_raw: 400, items_new: 40, items_dup: 360 },
  categories: [{ category: "国际宏观", n: 120 }, { category: "国内财经与公告", n: 88 }],
  keywords: [{ tag: "AI", n: 40 }, { tag: "关税", n: 12 }],
  failed: [{ source_id: "wallstreetcn", channel: "browse", error_kind: "bot_blocked", error: "0 items", hint: "换 http 通道" }],
  digest_path: "/tmp/digest.md", sources_config: "/tmp/sources.json",
  top_events: [
    { event_id: "ev-1", title: "沙特首都金融区遭袭，阿美石油公司大楼受损", importance: 100, credibility: "confirmed", source_count: 6, labels: ["politics.conflict"], outlets: [{ source_id: "cls", name: "财联社电报" }, { source_id: "reuters", name: "路透·World" }], lead_url: "https://www.cls.cn/detail/1", pushed: true },
    { event_id: "ev-2", title: "某公司停牌", importance: 37, credibility: "single", source_count: 1, labels: [], outlets: [{ source_id: "cls", name: "财联社电报" }], lead_url: "https://www.cls.cn/detail/2", pushed: false },
  ],
};
const TAXONOMY = { labels: [{ id: "macro", name: "宏观经济", children: [{ id: "macro.monetary", name: "货币政策" }] }], regions: ["CN", "US"] };
const SOURCES = {
  config_path: "/tmp/sources.json", categories: ["国际宏观", "国内财经与公告"], defaults: {}, version: 1, timezone: "Asia/Shanghai",
  adapters: ["techflow", "jiemian", "thepaper", "apnews"], channel_choices: ["browse", "agent_reach", "http", "jina"],
  sources: [
    { id: "bbc_world", name: "BBC World", category: "国际宏观", type: "rss", url: "https://feeds.bbci.co.uk/news/world/rss.xml", channels: ["browse", "http"], max_items: 20, enabled: true, region: "UK", weight: 0.9, tier: "primary", group: "bbc", health: { tries: 3, ok: 3, avg_latency_ms: 900, last_try: "2026-11-08 08:00:00", last_ok_channel: "browse", signals: [] } },
    { id: "jiemian", name: "界面", category: "国内财经与公告", type: "html_index", adapter: "jiemian", url: "https://www.jiemian.com/lists/4.html", enabled: true, health: { tries: 1, ok: 1, signals: ["hot", "section"] } },
    { id: "old_src", name: "旧源", category: "国际宏观", type: "rss", url: "https://x.example/rss", enabled: false, removed_at: "2026-11-08 08:00:00" },
  ],
};
const TEST_RESULT = { ok: true, source_id: "jiemian", channel: "browse", parsed_by: "adapter:jiemian", parsed: 20, kept: 20, signals: { hot: 1, section: 20 }, time_confidence: { feed: 20 },
  attempts: [{ channel: "browse", ok: true, backend: null }, { channel: "agent_reach", ok: false, backend: "jina_reader", error_kind: "bot_blocked", hint: "改用 browse" }],
  items: [{ title: "样例快讯", url: "https://www.jiemian.com/article/1.html", published_at: "2026-11-08 11:27:38", signals: { hot: ["加红"], views: 12345, rank: 0, section: "快讯" } }] };
const ITEMS = { count: 2, since_iso: "2026-11-07 08:00:00", next_before: "2026-11-08 06:00:00", items: [
  { time: "2026-11-08 07:00:00", time_confidence: "feed", source: "BBC World", category: "国际宏观", title: "A story", summary: "lead", channel: "browse", paywalled: false, url: "https://example.com/a", signals: { hot: [], views: null, rank: 0, section: null } },
  { time: "2026-11-08 06:00:00", time_confidence: "fetched", source: "财联社", category: "国内财经与公告", title: "电报", summary: "", channel: "browse", paywalled: false, url: "https://www.cls.cn/detail/1", signals: { hot: ["加红"], level: "B", views: 41867, comments: 3, rank: 1, section: null } },
] };
const ATTEMPTS = { run_id: "run-x", runs: [{ run_id: "run-x", started_at: "2026-11-08 08:00:00", sources_ok: 18, sources_failed: 1 }], attempts: [{ source_id: "bbc_world", channel: "browse", ok: true, http_status: null, bytes: null, items: 20, latency_ms: 900, error_kind: null, error: "", hint: "" }],
  continuity: [{ source_id: "jiemian", status: "gap_filled", pages: 3, backfilled: 40 }, { source_id: "techflow", status: "gap_open", pages: 17, backfilled: 0 }, { source_id: "thepaper", status: "snapshot", pages: 1, backfilled: 0 }],
  gaps: [{ source_id: "jiemian", gap_from: "2026-11-08 04:05:04", gap_to: "2026-11-08 08:54:22", status: "backfilled", method: "paging", recovered: 40 }],
  pushes: [{ pushed_at: "2026-11-08 12:05:00", title: "央行宣布降准", url: "https://www.cls.cn/detail/1", reason: "级别B,2源" }] };

const ATTEMPTS_STATE = () => Object.assign({ phase: "ready" }, ATTEMPTS);
const sandbox = {
  Intl,
  window: { __ModuleLoader__: { load: (m) => { sandbox.__loaded = m; } }, localStorage: { getItem: () => null, setItem: () => {} } },
  document: { getElementById: () => null, createElement: () => ({ id: "", textContent: "" }), head: { appendChild: () => {} } },
  fetch: (url, init) => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(String(url).indexOf("summary") >= 0 ? SUMMARY : String(url).indexOf("sources") >= 0 ? SOURCES : String(url).indexOf("items") >= 0 ? ITEMS : String(url).indexOf("taxonomy") >= 0 ? TAXONOMY : ATTEMPTS),
    text: () => Promise.resolve("# 汇总\n- 样例"),
  }),
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, isFinite, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });

const loaded = sandbox.__loaded;
if (!loaded || loaded.id !== "dsh-newswire") { console.log("FAIL: __ModuleLoader__.load 未被调用或 id 不对"); process.exitCode = 1; }
const requireShim = (name) => (name === "react" ? React : () => null);
const plugin = loaded.factory(requireShim);
if (!plugin || typeof plugin.apply !== "function") { console.log("FAIL: 插件没有 apply"); process.exitCode = 1; }

const registered = [];
const installs = [];
const FAKE_MANAGER = {
  listBundles: () => Promise.resolve({ ok: true, value: [{ name: "dsh-newswire", source: "github:someone/dsh-newswire#abc", updatable: false, installed: true }] }),
  installBundle: (spec, opts) => { installs.push([spec, opts]); return Promise.resolve({ ok: true, value: opts.approvedBuilds ? { application: "applied", version: "0.9.1" } : { application: "skipped", pendingBuilds: ["dsh-newswire"] } }); },
};
const ctx = {
  inject: (deps, fn) => {
    if (deps[0] === "locale") fn({ locale: { register: () => {}, getLocale: () => ({ active: "zh" }) }, on: () => () => {} });
    if (deps[0] === "remote") { registered.push("remote.pluginManager"); fn({ remote: { pluginManager: FAKE_MANAGER } }); }
  },
  slots: {
    inject: (name, fn) => { const d = fn(); registered.push(name); return typeof d === "function" ? d() : undefined; },
    register: (def, comp) => { registered.push(def.name + ":" + (def.id || def.key)); return () => {}; },
  },
};
plugin.apply(ctx);

const T = plugin.__test;
const EVENT = {
  event_id: "ev-1", title: "沙特首都金融区遭袭，阿美石油公司大楼受损", importance: 100, credibility: "disputed", source_count: 6, member_count: 6,
  first_seen_at: "2026-11-08 06:56:00", last_seen_at: "2026-11-08 12:24:00", labels: ["politics.conflict"], regions: ["ME", "CN"], lead_url: "https://www.cls.cn/detail/1", pushed: true,
  outlets: [{ grp: "cls", source_id: "cls_telegraph", name: "财联社电报" }, { grp: "reuters", source_id: "reuters", name: "路透·World" }],
  factors: { sources: 50, weight: 10, cross_region: 10, authority: 5, native: 20, speed: 5, persistence: 0, watch: 0 },
  dispute: { kind: "人数", values: [{ outlet: "cls", value: 6 }, { outlet: "reuters", value: 8 }] },
  members: [
    { article_id: "a1", source_id: "cls_telegraph", source_name: "财联社电报", method: "seed", title: "法新社8日援引目击者消息说…", url: "https://www.cls.cn/detail/1", published_at: "2026-11-08 06:56:00", time_confidence: "feed", hot: [], level: "B", views: 1078000 },
    { article_id: "a2", source_id: "reuters", source_name: "路透·World", method: "entity", title: "Saudi Aramco building damaged", url: "https://www.reuters.com/x", published_at: null, time_confidence: "fetched", joined_at: "2026-11-08 07:20:00", hot: [] },
  ],
  scores: [{ importance: 60 }, { importance: 85 }, { importance: 100 }],
  heat: [{ article_id: "a1", source_id: "cls_telegraph", views: 400000 }, { article_id: "a1", source_id: "cls_telegraph", views: 1078000 }],
  pushes: [{ pushed_at: "2026-11-08 07:10:00", reason: "new", credibility: "single", score: 37 }, { pushed_at: "2026-11-08 09:10:00", reason: "upgraded", credibility: "confirmed", score: 100 }],
};
const RUNS = [
  { run_id: "c1", started_at: "2026-11-07 23:00:00", mode: "cycle", sources_total: 24, sources_ok: 24, items_new: 310, events_new: 120, events_multi: 30, pushes: 6, gaps: 0, failed: 0, notes: "browse=on scale=4 overnight" },
  { run_id: "c2", started_at: "2026-11-08 01:00:00", mode: "cycle", sources_total: 24, sources_ok: 23, items_new: 90, events_new: 40, events_multi: 8, pushes: 2, gaps: 1, failed: 1, notes: "" },
];
const cases = [
  ["Page", () => T.Page()],
  ["NewsTab", () => T.NewsTab({ names: {}, taxonomy: TAXONOMY, summary: SUMMARY, stamp: 1 })],
  ["NewsTab(packs)", () => T.NewsTab({ names: {}, taxonomy: TAXONOMY, summary: SUMMARY, stamp: 1, packs: { core: { title: "要闻" }, study_abroad: { title: "留学资讯" } } })],
  ["ScheduleCard(packs)", () => T.ScheduleCard({ schedule: { available: true, tasks: [{ pack: "core", task: { status: "active", scheduledAt: "2026-11-09T01:00:00.000Z" } }, { pack: "study_abroad", task: null }] }, packs: { core: { title: "要闻" }, study_abroad: { title: "留学资讯" } } })],
  ["TimelineTab", () => T.TimelineTab({ names: {}, stamp: 1 })],
  ["ItemsTab", () => T.ItemsTab({ sources: SOURCES, taxonomy: TAXONOMY, stamp: 1 })],
  ["SourcesTab", () => T.SourcesTab({ sources: SOURCES, reload: () => Promise.resolve() })],
  ["RunsTab", () => T.RunsTab({ summary: SUMMARY, schedule: { available: true, task: { id: "s", title: "新闻要闻", status: "active", scheduledAt: "2026-11-09T01:00:00.000Z" } }, digest: "# 汇总", stamp: 1 })],
  ["EventCard", () => T.EventCard({ ev: EVENT, names: { "politics.conflict": "冲突与安全" }, active: true, onClick: () => {} })],
  ["EventDetailView", () => { const n = T.EventDetailView({ ev: EVENT, names: { "politics.conflict": "冲突与安全" }, onBack: () => {} }); if (!JSON.stringify(n).includes("nw-warnbox")) throw new Error("没有分歧提示"); return n; }],
  ["EventDetailView(empty)", () => T.EventDetailView({ ev: null })],
  ["EventDetail", () => T.EventDetail({ id: "ev-1", names: {} })],
  ["RunBars", () => T.RunBars({ runs: RUNS, value: "c2", onPick: () => {} })],
  ["ScheduleCard(none)", () => T.ScheduleCard({ schedule: { available: true, task: null } })],
  ["ScheduleCard(nosvc)", () => T.ScheduleCard({ schedule: { available: false } })],
  ["StatusLine", () => T.StatusLine({ summary: SUMMARY, schedule: { task: { status: "active", scheduledAt: "2026-11-09T01:00:00.000Z" } } })],
  ["StatusLine(empty)", () => T.StatusLine({ summary: null })],
  ["Spark", () => T.Spark({ values: [1, 3, 2, 5] })],
  ["PanelIcon", () => T.PanelIcon()],
  ["TestResult", () => T.TestResult(TEST_RESULT)],
  ["TestResult(fail)", () => T.TestResult({ ok: false, error: "invalid_source" })],
  ["SignalChips", () => { const c = T.SignalChips(ITEMS.items[1].signals); if (!c || c.length < 3) throw new Error("信号标签不足"); return c; }],
];
const BRIEF = { phase: "ready", model: { enabled: true, available: true, label: "local/m", busy: null, last: null }, error: null,
  b: { id: 1, pack: "all", created_at: "2026-11-08 08:00:00", model: "local/m", hours: 12, headline: "中东局势升级，油价与避险资产联动",
    content: { headline: "中东局势升级", points: [{ text: "沙特金融区遇袭，多家媒体确认", event_ids: ["ev-1"] }, { text: "无关联要点", event_ids: [] }], watch: [{ text: "油价能否站稳", event_ids: ["ev-1"] }] } } };
const STORY = { id: "s1", title: "沙特利雅得金融区遇袭", section: "politics", labels: ["politics.conflict"], importance: 85, credibility: "corroborated", source_count: 2, outlets: [{ source_id: "cls", name: "财联社电报" }, { source_id: "reuters", name: "路透·World" }],
  lead_event_id: "ev-1", url: "https://www.cls.cn/detail/1", published_at: "2026-11-08 06:56:00", lead: "模型导语：利雅得金融区周六遇袭。", points: ["要点甲"], views: [{ who: "路透", says: "导弹被拦截" }], impact: "牵动油价", by: "llm" };
const EDITION_STATE = { phase: "ready", busy: false, error: null, model: { mode: "llm", ready: true },
  ed: { id: 1, created_at: "2026-11-08 08:00:00", mode: "llm", model: "local/iq", content: { headline: "中东局势升级", hours: 12, items_read: 120, front: ["s1"], sections: [{ id: "politics", name: "时政与地缘", stories: ["s1", "s2"] }],
    watch: [{ text: "沙特官方后续通报", stories: ["s1"] }], verify: [{ text: "教育部预警：仅教育部报道", stories: ["s2"] }],
    stories: { s1: STORY, s2: Object.assign({}, STORY, { id: "s2", title: "教育部发布留学预警", credibility: "single", source_count: 1, by: "rules", views: [] }) } } } };
const CHECK = { installed: "0.9.0", source: { kind: "github", owner: "someone", repo: "dsh-newswire" }, newer: true, checkedAt: Date.now(), hostUpdates: false,
  latest: { version: "0.9.1", commit: "abc", summary: "fix", url: "https://github.com/someone/dsh-newswire/commits/abc", spec: "github:someone/dsh-newswire#abc" } };
const NOTES = { summary: "沙特首都金融区遇袭，阿美大楼受损，各家伤亡数字不一", why: "牵动油价与地区安全", watch: "沙特官方通报与油价走势", model: "local/m", at: "2026-11-08T08:00:00Z" };
cases.push(
  ["EditionView", () => { const n = withStates([EDITION_STATE], () => T.EditionView({ pack: "all", stamp: 1, names: { politics: "时政与地缘", "politics.conflict": "冲突与安全" }, onOpen: () => {} })); const j = JSON.stringify(n); for (const k of ["中东局势升级", "nw-mast", "nw-front", "nw-rail", "沙特官方后续通报", "教育部预警", T.t("rd.about")]) if (!j.includes(k)) throw new Error("版面缺 " + k); for (const k of ["nw-chip", T.t("ck.hint")]) if (j.includes(k)) throw new Error("正文不该再有 " + k); return n; }],
  ["EditionView(fellback)", () => { const st = Object.assign({}, EDITION_STATE, { ed: Object.assign({}, EDITION_STATE.ed, { mode: "rules", error: "budget_exceeded" }) }); const n = withStates([st], () => T.EditionView({ pack: "all", stamp: 1, names: {}, onOpen: () => {} })); if (!JSON.stringify(n).includes("budget_exceeded")) throw new Error("没提示退回"); return n; }],
  ["EditionView(none)", () => withStates([{ phase: "ready", ed: null, model: null, error: null, busy: false }], () => T.EditionView({ pack: "all", stamp: 1, onOpen: () => {} }))],
  ["ReadStory(more)", () => { const n = withStates([true, null], () => T.ReadStory({ story: Object.assign({}, STORY, { by: "rules" }), mode: "llm", names: {}, onOpen: () => {} })); const j = JSON.stringify(n); if (!j.includes("导弹被拦截") || !j.includes(T.t("rd.less"))) throw new Error("展开后缺各方说法"); return n; }],
  ["ReadStory(folded)", () => { const n = withStates([false, null], () => T.ReadStory({ story: STORY, mode: "llm", names: {}, onOpen: () => {} })); const j = JSON.stringify(n); if (j.includes("nw-rs-views") || !j.includes(T.t("rd.more"))) throw new Error("默认应折叠各方说法"); return n; }],
  ["ReadStory(refs)", () => { const n = withStates([true, null], () => T.ReadStory({ story: Object.assign({}, STORY, { points: [{ text: "64人受伤", refs: ["m1"] }], views: [{ who: "界面", says: "至少50人", refs: ["m2"] }], lead_refs: ["m1"], lead_missing: ["80"], materials: [{ id: "m1", name: "财联社电报", url: "https://www.cls.cn/detail/9", t: "2026-11-08 06:00:00" }, { id: "m2", name: "界面", url: "https://www.jiemian.com/a/1", t: "2026-11-08 07:00:00" }] }), mode: "llm", names: {}, onOpen: () => {} })); const j = JSON.stringify(n); for (const k of ["64人受伤", "至少50人", "https://www.cls.cn/detail/9", T.t("ck.unverified")]) if (!j.includes(k)) throw new Error("缺 " + k); return n; }],
  ["FollowsView", () => { const n = withStates([{ version: 1, follow: [{ kind: "keyword", value: "英伟达|NVIDIA" }, { kind: "topic", value: "macro" }], mute: [{ kind: "source", value: "bbc_world" }] }, "topic", "", ""], () => T.FollowsView({ stamp: 1, taxonomy: TAXONOMY, names: { macro: "宏观经济" }, sources: SOURCES })); const j = JSON.stringify(n); if (!j.includes("宏观经济") || !j.includes("货币政策")) throw new Error("关注页不全"); return n; }],
  ["ReadStory(follow)", () => { const n = T.ReadStory({ story: Object.assign({}, STORY, { followed: ["英伟达"] }), mode: "llm", names: {}, onOpen: () => {}, onFollow: () => {}, followed: true }); const j = JSON.stringify(n); if (!j.includes("英伟达") || !j.includes("★") || !j.includes(T.t("fl.following"))) throw new Error("关注标记缺失"); return n; }],
  ["EditionView(since)", () => { const n = withStates([EDITION_STATE, null, "", { at: "2026-11-08 06:00:00", stories: { s1: { added: 2 }, s2: { new: true } } }], () => T.EditionView({ pack: "all", stamp: 1, names: {}, onOpen: () => {} })); const j = JSON.stringify(n); if (!j.includes("nw-since") || !j.includes(T.t("rd.sinceDev", { n: 1 })) || !j.includes(T.t("rd.sinceNew", { n: 1 }))) throw new Error("没有自上次查看"); return n; }],
  ["StoryDetail", () => { const st = { id: "st-1", title: "沙特遇袭", section: "politics", labels: [], importance: 80, created_at: "2026-11-08 06:00:00", copy: { lead: "导语", lead_refs: ["a1"], points: [{ text: "要点", refs: ["a2"] }] },
      items: [{ id: "a1", title: "首报", url: "https://x/1", published_at: "2026-11-08 06:00:00", source_id: "cls", source_name: "财联社电报" }, { id: "a2", title: "续报", url: "https://x/2", published_at: "2026-11-08 08:00:00", source_id: "ap", source_name: "美联社" }],
      updates: [{ at: "2026-11-08 08:05:00", text: "沙特称已摧毁发射装置", items: 1, by: "llm" }], pushes: [{ pushed_at: "2026-11-08 08:06:00", reason: "jumped" }], merged: [] };
    const n = withStates([{ phase: "ready", st, error: null }], () => T.StoryDetail({ id: "st-1", names: {}, onBack: () => {}, onFollow: () => {}, followed: false })); const j = JSON.stringify(n); for (const k of ["沙特称已摧毁发射装置", "https://x/2", "nw-tl2-u", "nw-tl2-p", "nw-tl-dh"]) if (!j.includes(k)) throw new Error("详情缺 " + k); return n; }],
  ["DailyView", () => { const daily = { date: "2026-11-09", mode: "llm", model: "local/iq", headline: "沙特遇袭牵动局势", created_at: "2026-11-09 13:30:00", stories: [{ id: "s1", title: "沙特遇袭", section: "politics", importance: 80, items_today: 5, outlets: ["财联社"], arc: "利雅得遇袭后沙特称摧毁发射装置", arc_by: "llm" }], tomorrow: [{ text: "沙特后续行动", stories: ["s1"] }], stats: { items: 120, storylines: 30, sources: 12, pushes: 6 } };
    const n = withStates([{ date: "2026-11-09", d: daily, dates: [{ date: "2026-11-09" }, { date: "2026-11-08" }], busy: false, phase: "ready", error: null }], () => T.DailyView({ pack: "all", stamp: 1, names: {}, onOpen: () => {} })); const j = JSON.stringify(n); for (const k of ["沙特遇袭牵动局势", "利雅得遇袭后沙特称摧毁发射装置", "沙特后续行动", "nw-daynav"]) if (!j.includes(k)) throw new Error("日报缺 " + k); return n; }],
  ["QualityCard", () => { const n = withStates([{ editions: [{ id: 2, created_at: "2026-11-09 08:00:00", mode: "llm", model: "local/iq", ms: 68000, calls: 2, fresh: 2, reused: 18, check: { checked: 40, passed: 40 }, fallbacks: 0, reported: 1 }, { id: 1, created_at: "2026-11-09 06:00:00", mode: "rules", ms: 300, calls: 0, fallbacks: 1, reported: 0, reassembled: true }], feedback: [{ kind: "error", n: 2, resolved: 1 }] }], () => T.QualityCard({ stamp: 1 })); const j = JSON.stringify(n); if (!j.includes("40/40") || !j.includes("68s")) throw new Error("质量面板不全"); return n; }],
  ["ReadStory(report)", () => { const n = withStates([false, { note: "" }], () => T.ReadStory({ story: Object.assign({}, STORY, { points: [{ text: "64人受伤", refs: [] }] }), mode: "llm", names: {}, onOpen: () => {}, onFollow: () => {}, editionId: 3 })); const j = JSON.stringify(n); if (!j.includes("nw-report") || !j.includes(T.t("fb.wrong"))) throw new Error("报错面板缺失"); return n; }],
  ["ModelCard", () => { const n = withStates([{ phase: "ready", model: { mode: "llm", ready: true, service: true, label: "local/iq", pinned: { provider: "local", model: "iq" }, default: { provider: "local", model: "iq" }, last: { at: "2026-11-08T08:00:00Z", model: "local/iq", items_read: 120, calls: 9, ms: 240000 } }, providers: [{ id: "local", name: "本地", models: [{ id: "iq", name: "iq" }, { id: "big", name: "big" }] }], note: "", error: null }], () => T.ModelCard({ stamp: 1 })); const j = JSON.stringify(n); if (!j.includes("optgroup") || !j.includes(T.t("model.calls", { n: 9 }))) throw new Error("模型卡片不全"); return n; }],
  ["ModelCard(economy)", () => withStates([{ phase: "ready", model: { mode: "economy", ready: false, service: true, label: null, pinned: null, default: null, last: null }, providers: [], note: "", error: null }], () => T.ModelCard({ stamp: 1 }))],
  ["Topics", () => { const n = T.Topics({ events: [EVENT, Object.assign({}, EVENT, { event_id: "e2", labels: ["macro.monetary"], importance: 30 })], names: { politics: "政治", macro: "宏观经济" }, active: "", onPick: () => {} }); if (!JSON.stringify(n).includes("宏观经济")) throw new Error("主题没渲染"); return n; }],
  ["NotesBox", () => { const n = T.NotesBox({ notes: NOTES, model: { ready: true }, analyze: () => {}, phase: "idle" }); if (!JSON.stringify(n).includes("牵动油价")) throw new Error("解读没渲染"); return n; }],
  ["NotesBox(empty)", () => T.NotesBox({ notes: null, model: { ready: true }, analyze: () => {}, phase: "idle" })],
  ["EventCard(notes)", () => { const n = T.EventCard({ ev: Object.assign({}, EVENT, { notes: NOTES }), names: {}, onClick: () => {} }); if (!JSON.stringify(n).includes("nw-evsum")) throw new Error("卡片没有摘要"); return n; }],
  ["VersionSection(new)", () => { const n = withStates([CHECK, null, { kind: "idle" }], () => T.VersionSection()); if (!JSON.stringify(n).includes("0.9.1")) throw new Error("没显示新版本"); return n; }],
  ["VersionSection(approval)", () => withStates([CHECK, null, { kind: "approval", builds: ["dsh-newswire"] }], () => T.VersionSection())],
  ["VersionSection(checking)", () => T.VersionSection()],
  ["UpdateBanner", () => { const n = withStates([CHECK], () => T.UpdateBanner({ onGo: () => {} })); if (!n) throw new Error("没有新版本提示"); return n; }],
);
T.setLang("en");
cases.push(["NewsTab(en)", () => T.NewsTab({ names: {}, taxonomy: TAXONOMY, summary: SUMMARY, stamp: 1 })]);
cases.push(["EventDetailView(en)", () => T.EventDetailView({ ev: EVENT, names: {} })]);
for (const [name, fn] of cases) {
  try {
    const node = fn();
    if (!node || typeof node !== "object") problems.push(name + " 返回空");
    else console.log("OK   " + name + " 节点 ok");
  } catch (e) {
    problems.push(name + ": " + e.message);
    console.log("FAIL " + name + ": " + e.message);
  }
}
// 只用宿主真实存在的主题变量
const KNOWN = ["bg-layer-1", "bg-layer-2", "border-l1", "border-l2", "interactive-bg-hover", "interactive-bg-active", "label-primary", "label-secondary", "label-tertiary", "state-business-primary", "state-business-tertiary", "state-success-primary", "state-success-tertiary", "state-warn-primary", "state-warn-tertiary", "state-error-primary", "state-idle-primary", "link"];
for (const v of new Set((T.CSS.match(/--dsw-alias-[a-z0-9-]+/g) || []).map((x) => x.slice(12)))) if (!KNOWN.includes(v)) problems.push("未知主题变量 --dsw-alias-" + v);
if (typeof T.CSS !== "string" || T.CSS.length < 500) problems.push("CSS 缺失");

// 更新流程：先要求授权构建，授权后装上
const first = await T.applyUpdate(CHECK);
if (first.kind !== "approval") problems.push("applyUpdate 应先要求授权构建，得到 " + JSON.stringify(first));
const second = await T.applyUpdate(CHECK, first.builds);
if (second.kind !== "applied" || second.version !== "0.9.1") problems.push("applyUpdate 授权后应 applied，得到 " + JSON.stringify(second));
if (!installs.length || installs[0][0] !== CHECK.latest.spec || installs[0][1].enabled !== true) problems.push("installBundle 参数不对");
if (!registered.includes("remote.pluginManager")) problems.push("没有注入插件管理器");
console.log("registered:", registered.join(", "));
console.log("nodes:", stats.nodes, "effects:", stats.effects, "css bytes:", (T.CSS || "").length);
console.log("CLIENT SMOKE " + (problems.length === 0 ? "PASS" : "FAIL " + JSON.stringify(problems)));
process.exitCode = problems.length === 0 ? 0 : 1;
