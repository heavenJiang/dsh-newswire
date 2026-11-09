/* 事实核对与出处。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { claims, checkText, verifyCopy } from "../../host/factcheck.mjs";
import { loadLayout, llmEdition, saveEdition, latestEdition, composeEditionMessage, storyIdFor, pickMaterials } from "../../host/edition.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(ROOT, "taxonomy.json"), "utf8")).labels;
const LAYOUT = loadLayout(null, path.join(ROOT, "layout.json"));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

test("可核对成分：跳过日期时间与小整数；带单位的数字、外文专名、引号词", () => {
  const c = claims("11月8日14:56，Anthropic以34亿美元买下1.7吉瓦设备，两艘油轮、3人受伤，涨幅3.6%，《全球能源转型报告》");
  assert.deepEqual(c.nums.map((n) => n.v + n.unit), ["34亿", "1.7", "3.6%"]);
  assert.deepEqual(c.names, ["anthropic"]);
  assert.deepEqual(c.quoted, ["全球能源转型报告"]);
});

test("核对：中英单位换算、千分位、全角数字；编造的数字与专名找不到", () => {
  const src = ["Anthropic agreed to pay $3.4 billion to OnePWR", "贷款超４,８００亿元；截至目前沪市上市公司超2300家", "about 25,000 people evacuated; 1.2 million affected"];
  for (const ok of ["斥资34亿美元", "贷款超4800亿元", "上市公司超2300家", "约2.5万人撤离", "120万人受影响", "OnePWR 供货"]) assert.ok(checkText(ok, src).ok, ok);
  assert.deepEqual(checkText("贷款超5000亿元", src).missing, ["5000亿"]);
  assert.deepEqual(checkText("由 GE Vernova 供货", src).missing, ["vernova"]);
  assert.ok(!checkText("2300亿", src).ok, "数字对上但单位换算后对不上也不算");
});

test("整篇核对：要点与各方说法不过关丢弃，导语标待核，出处改到含该成分的材料", () => {
  const src = ["财联社：埃及列车脱轨，64人受伤", "界面：至少50人受伤"];
  const v = verifyCopy({ lead: "埃及列车脱轨致80人受伤", lead_refs: [0], points: [{ text: "界面称至少50人受伤", refs: [0] }, "司机死亡，120人受伤"], views: [{ who: "财联社", says: "64人受伤", refs: [1] }], impact: "" }, src);
  assert.deepEqual(v.copy.lead_missing, ["80"]);
  assert.deepEqual(v.copy.points, [{ text: "界面称至少50人受伤", refs: [1] }], "出处改到第 2 条");
  assert.deepEqual(v.copy.views[0].refs, [0]);
  assert.deepEqual(v.check, { checked: 4, passed: 2, dropped: 1, flagged: 1, missing: ["80", "120"] });
});

test("材料：不同媒体优先，按时间", () => {
  const it = (id, grp, t) => ({ id, grp, published_at: t });
  assert.deepEqual(pickMaterials([it("c", "cls", "2026-11-08 03:00:00"), it("a", "cls", "2026-11-08 01:00:00"), it("b", "ap", "2026-11-08 02:00:00")]).map((x) => x.id), ["a", "b", "c"]);
});

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v12-")), "n.sqlite"));
  for (const [id, name] of [["cls", "财联社电报"], ["jm", "界面"], ["moe", "教育部"]]) db.prepare("INSERT INTO sources (id, name, grp) VALUES (?,?,?)").run(id, name, id);
  const t = iso(3600000);
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, published_at, first_seen_at, last_seen_at, source_id, pack) VALUES (?,?,?,?,?,?,?,?,?)");
  art.run("a1", "https://x/a1", "埃及列车脱轨", "司机死亡，64人受伤", iso(7200000), t, t, "cls", "core");
  art.run("a2", "https://x/a2", "埃及吉萨列车出轨", "至少50人受伤", t, t, t, "jm", "core");
  art.run("a3", "https://x/a3", "教育部发布留学预警", "提醒注意安全", t, t, t, "moe", "core");
  return db;
}
function model(writeReply) {
  const reply = (p) => {
    if (p.includes("归为一篇报道")) return JSON.stringify({ stories: [{ items: [1, 2], title: "埃及列车脱轨", section: "society", labels: [], importance: 70 }, { items: [3], title: "教育部预警", section: "study", labels: [], importance: 50 }] });
    if (p.includes("headline：一句话总括")) return JSON.stringify({ merge: [], headline: "埃及列车事故", front: [1], watch: [] });
    if (p.includes("按版式为以下每篇报道写稿")) return writeReply(p);
    return "{}";
  };
  const llm = { stream(o) { const r = reply(o.messages[0].content[0].text); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "fake", model: "m" }) }) });
}
const opts = { pack: "core", since: iso(12 * 3600000), hours: 12, layout: Object.assign({}, LAYOUT, { min_importance: 10 }), names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 };

test("版面：材料编号给模型，出处映射到文章；编造的要点丢弃、导语标待核；推送改用原文导语；沿用时再核对", async () => {
  const db = tmpDb();
  let prompt = "";
  const m = model((p) => {
    prompt = p;
    return JSON.stringify({ stories: [
      { ref: 1, lead: "埃及列车脱轨致80人受伤", lead_refs: ["M1"], points: [{ text: "至少50人受伤", refs: ["M1"] }, { text: "死亡人数升至12人", refs: ["M2"] }], views: [{ who: "财联社", says: "64人受伤", refs: ["M1"] }], impact: "" },
      { ref: 2, lead: "教育部发布留学预警，提醒注意安全。", lead_refs: ["M1"], points: [], views: [], impact: "" },
    ] });
  });
  const ed = await llmEdition(db, m, opts);
  assert.match(prompt, /\[M1\] 财联社电报｜[^｜]*｜埃及列车脱轨｜司机死亡，64人受伤/);
  assert.match(prompt, /\[M2\] 界面｜/);
  const s = ed.stories[storyIdFor("a1")];
  assert.deepEqual(s.points, [{ text: "至少50人受伤", refs: ["a2"] }], "编造的丢弃；出处改到界面那篇");
  assert.deepEqual(s.views, [{ who: "财联社", says: "64人受伤", refs: ["a1"] }]);
  assert.deepEqual(s.lead_missing, ["80"]);
  assert.equal(s.push_lead, "司机死亡，64人受伤");
  assert.deepEqual(s.materials.map((x) => x.id), ["a1", "a2"]);
  assert.deepEqual(ed.stats.check, { stories: 2, checked: 4, passed: 2, dropped: 1, flagged: 1 });
  const parts = { hhmm: "09:00", md: "11-09", stats: "源 3/3", warnings: [], title: "要闻" };
  const msg = composeEditionMessage(parts, [Object.assign({ reason: "new" }, s)], ed, {});
  assert.ok(msg.includes("\n司机死亡，64人受伤") && !msg.includes("80人"), "推送不用待核导语");
  saveEdition(db, ed, {});
  // 没有新新闻：沿用稿件，但照样核对（出处是文章 id，材料变了也不错位）
  const ed2 = await llmEdition(db, m, Object.assign({}, opts, { prev: latestEdition(db, "core").content }));
  const s2 = ed2.stories[storyIdFor("a1")];
  assert.equal(s2.reused, true);
  assert.deepEqual(s2.points, [{ text: "至少50人受伤", refs: ["a2"] }]);
  assert.equal(ed2.stats.calls, 0);
  db.close();
});
