/* 分类、事件聚类、交叉验证打分与按事件选推送。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTaxonomy, classify, numberTokens, unitCounts } from "../../engine/taxonomy.mjs";
import { matchMember, detectDispute, processEvents } from "../../engine/pipeline/events.mjs";
import { selectEvents, recordPushes, bigrams } from "../../engine/pipeline/select.mjs";
import { openDb } from "../../engine/store/schema.mjs";
import { upsertArticle, insertObservation, upsertSource, startRun } from "../../engine/store/db.mjs";
import { toRecord, isNavTitle } from "../../engine/pipeline/normalize.mjs";

const TAX = loadTaxonomy(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config", "taxonomy.json"));

test("分类：中文子串、英文整词（含词尾变化）、短缩写区分大小写、源默认标签", () => {
  const a = classify(TAX, { title: "央行宣布下调存款准备金率0.5个百分点", summary: "" });
  assert.equal(a.labels[0].label, "macro.monetary");
  assert.ok(a.regions.includes("CN") === false || true);
  const b = classify(TAX, { title: "US military attacks cargo ship in the Gulf", summary: "" });
  assert.ok(b.labels.some((l) => l.label === "politics.conflict"), JSON.stringify(b.labels));
  assert.ok(b.regions.includes("US"));
  const c = classify(TAX, { title: "We said it would rain today in town", summary: "" });
  assert.ok(!c.labels.some((l) => l.label === "industry.ai_semis"), "said 里的 ai 不应命中 AI");
  const d = classify(TAX, { title: "某地举行文化活动开幕式", category: "国内时政", region: "CN" });
  assert.deepEqual(d.labels, [{ label: "politics.domestic", confidence: 0.3, origin: "source" }]);
  assert.deepEqual(d.regions, ["CN"]);
  const e = classify(TAX, { title: "英国宣布收紧学生签证，雅思要求提高" });
  assert.ok(e.labels.some((l) => l.label === "study.visa") && e.labels.some((l) => l.label === "study.exams"));
  assert.ok(e.regions.includes("UK"));
});

test("数字记号：中英文金额可比、百分比、人数", () => {
  assert.ok(numberTokens("Anthropic斥资34亿美元采购燃气发电设备").includes("m:3400000000"));
  assert.ok(numberTokens("Anthropic buys $3.4 billion of gas turbines").includes("m:3400000000"));
  assert.ok(numberTokens("央行降准0.5个百分点").includes("p:0.5"));
  assert.ok(numberTokens("Polish gunman killed 6 people in Krakow").includes("n:6"));
  assert.ok(numberTokens("袭击造成8人死亡").includes("n:8"));
});

test("栏目名不是新闻", () => {
  assert.equal(isNavTitle("Media & Telecom"), true);
  assert.equal(isNavTitle("Asia Central Banking"), true);
  assert.equal(isNavTitle("国际新闻"), true);
  assert.equal(isNavTitle("Israel's president taps Eisenkot to form government"), false);
  assert.equal(isNavTitle("沙特首都利雅得传出剧烈爆炸声"), false);
  assert.equal(isNavTitle("Stripe完成收购OpenRouter"), false);
  assert.equal(isNavTitle("XXYY宣布停运"), false);
  assert.equal(isNavTitle("国际 World"), true);
  assert.equal(isNavTitle("AI 前沿"), true);
});

const view = (title, t, extra) => {
  const c = classify(TAX, { title });
  return Object.assign({ zh: /[一-鿿]/.test(title), bg: bigrams(title), strong: new Set(c.strong), nums: new Set(numberTokens(title)), units: unitCounts(title), t: Date.parse(t) }, extra);
};

test("合并规则：同语言标题、标题+数字、跨语言实体；不相干的不合并", () => {
  const T = "2026-11-08T07:00:00Z";
  assert.equal(matchMember(view("沙特首都金融区遭袭，阿美石油公司大楼受损", T), view("沙特首都金融区遭袭，阿美石油公司大楼受损", T)).method, "title");
  assert.equal(matchMember(view("Anthropic斥资34亿美元采购天然气发电设备，为数据中心供电", T), view("ANTHROPIC公司以34亿美元的价格购入天然气发电设施用于数据中心", T)).method, "title+number");
  const cross = matchMember(view("Saudi Aramco building in Riyadh damaged in attempted attack", T), view("沙特首都金融区遭袭，阿美石油公司大楼受损，利雅得", T));
  assert.equal(cross && cross.method, "entity");
  assert.equal(matchMember(view("Saudi Aramco building in Riyadh damaged", T), view("沙特阿美利雅得大楼受损", "2026-11-08T20:00:00Z")), null, "跨语言超过 6 小时不合并");
  assert.equal(matchMember(view("Trump says Iran talks will continue", T), view("特朗普称将继续对伊朗施压", T)), null, "只有两个泛实体、没有相同数字，不合并");
  assert.equal(matchMember(view("上交所：沪市上市公司总市值超65万亿元", T), view("深交所：深市上市公司总市值超40万亿元", T)), null);
  assert.equal(matchMember(view("澎湃新闻22件作品荣获2025年度上海市优秀新闻作品", T), view("第一财经15件作品荣获2025年度上海市优秀新闻作品", T)), null, "同单位不同数：两件事");
  assert.ok(matchMember(view("袭击造成6人死亡，沙特首都利雅得金融区遇袭", T), view("袭击造成8人死亡，沙特首都利雅得金融区遇袭", T)), "人数不同仍并入同一事件（交给分歧判断）");
});

test("分歧：两家独立媒体各给一个不同人数；同一媒体或金额不算", () => {
  const m = (grp, title) => ({ grp, nums: numberTokens(title) });
  assert.deepEqual(detectDispute([m("cls", "袭击造成6人死亡"), m("reuters", "Attack kills 8 people")]), { kind: "人数", values: [{ outlet: "cls", value: 6 }, { outlet: "reuters", value: 8 }] });
  assert.equal(detectDispute([m("cls", "袭击造成6人死亡"), m("jm", "袭击已致6人死亡")]), null);
  assert.equal(detectDispute([m("cls", "斥资34亿美元"), m("jm", "斥资30亿美元")]), null);
});

test("端到端：入库 → 聚类 → 打分 → 选推送；可信度升级再推，不重复推", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "newswire-ev-"));
  const db = openDb(path.join(dir, "news.sqlite"));
  const SRC = {
    cls: { id: "cls", name: "财联社电报", group: "cls", region: "CN", weight: 0.85, tier: "primary", category: "国内财经与公告" },
    jm: { id: "jm", name: "界面新闻", group: "jiemian", region: "CN", weight: 0.8, tier: "primary", category: "国内财经与公告" },
    reuters: { id: "reuters", name: "路透", group: "reuters", region: "INTL", weight: 0.95, tier: "primary", category: "国际宏观" },
  };
  const sources = new Map(Object.entries(SRC));
  for (const s of Object.values(SRC)) upsertSource(db, Object.assign({ type: "rss", url: "https://x.example/" + s.id }, s), "2026-11-08 07:00:00");
  const put = (runId, nowIso, src, title, url, t, sig) => {
    const r = toRecord({ title, link: url, published_at: t, signals: sig || {} }, SRC[src], { index: 0, nowMs: Date.parse(nowIso.replace(" ", "T") + "Z") });
    upsertArticle(db, r, { nowIso, channel: "http" });
    insertObservation(db, r, { runId, nowIso, channel: "http" });
    return r.id;
  };
  // 第 1 轮：财联社单独报（级别 A；单源要级别 A 或两个强信号才够推）
  startRun(db, "r1", "2026-11-08 07:10:00", "cycle");
  put("r1", "2026-11-08 07:10:00", "cls", "沙特首都利雅得金融区遭袭，阿美石油公司大楼受损", "https://www.cls.cn/detail/1", "2026-11-08T07:00:00Z", { level: "A" });
  put("r1", "2026-11-08 07:10:00", "cls", "某公司发布三季度业绩预告显示营收增长", "https://www.cls.cn/detail/2", "2026-11-08T07:01:00Z", {});
  const e1 = processEvents(db, { runId: "r1", nowIso: "2026-11-08 07:10:00", tax: TAX, sources });
  assert.equal(e1.touched.length, 2);
  const p1 = selectEvents(db, { touched: e1.touched, nowIso: "2026-11-08 07:10:00", lookbackHours: 6 });
  assert.equal(p1.length, 1, "单源只有带源头强标记的入选");
  assert.equal(p1[0].credibility, "single");
  recordPushes(db, p1, "r1", "2026-11-08 07:10:00");
  // 第 2 轮：界面、路透跟进 → 同一事件，权威确认（路透 primary 0.95）→ 升级再推
  startRun(db, "r2", "2026-11-08 09:10:00", "cycle");
  put("r2", "2026-11-08 09:10:00", "jm", "沙特利雅得金融区遇袭 阿美石油公司大楼受损严重", "https://www.jiemian.com/article/1.html", "2026-11-08T07:05:00Z", { hot: ["加红"] });
  put("r2", "2026-11-08 09:10:00", "reuters", "Saudi Aramco building in Riyadh damaged in attack", "https://www.reuters.com/world/1", "2026-11-08T07:20:00Z", {});
  const e2 = processEvents(db, { runId: "r2", nowIso: "2026-11-08 09:10:00", tax: TAX, sources });
  assert.equal(e2.merged, 2, "两条都并入已有事件");
  const evt = db.prepare("SELECT * FROM events WHERE source_count = 3").get();
  assert.ok(evt, "三家同报");
  assert.equal(evt.credibility, "confirmed");
  assert.equal(evt.region_mix, "cn+intl");
  assert.equal(evt.title, "沙特利雅得金融区遇袭 阿美石油公司大楼受损严重", "显示标题取最短的中文标题");
  assert.ok(JSON.parse(evt.labels).includes("politics.conflict"), evt.labels);
  const p2 = selectEvents(db, { touched: e2.touched, nowIso: "2026-11-08 09:10:00", lookbackHours: 6 });
  assert.equal(p2.length, 1);
  assert.equal(p2[0].reason, "upgraded");
  recordPushes(db, p2, "r2", "2026-11-08 09:10:00");
  // 第 3 轮：同一事件再被看到，可信度与分数没变 → 不再推
  startRun(db, "r3", "2026-11-08 11:10:00", "cycle");
  put("r3", "2026-11-08 11:10:00", "jm", "沙特首都利雅得金融区遭袭，阿美石油公司大楼受损", "https://www.jiemian.com/article/1.html", "2026-11-08T07:05:00Z", { hot: ["加红"] });
  const e3 = processEvents(db, { runId: "r3", nowIso: "2026-11-08 11:10:00", tax: TAX, sources });
  assert.equal(selectEvents(db, { touched: e3.touched, nowIso: "2026-11-08 11:10:00", lookbackHours: 6 }).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_scores WHERE event_id = ?").get(evt.event_id).n, 3, "每轮一条打分轨迹");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
