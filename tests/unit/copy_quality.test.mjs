/* 稿件的信息密度：去掉复述导语的要点和说法、把媒体当表态方的说法、复述事实的影响、开头的日期；一两句的材料只写导语；取材兼顾起因和最新进展。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimCopy, thinMaterial, writePrompt, normalizeLayout, pickMaterials } from "../../host/edition.mjs";
import { builtinProfiles } from "../../host/profiles.mjs";

test("去水：导语去掉开头日期；复述导语的要点、说法、影响去掉；媒体只在数字对不上时算一方说法；「未回应置评」不算说法", () => {
  const c = trimCopy({
    lead: "11月10日，Anthropic表示可向博通发行至多420亿美元票据。",
    points: [{ text: "Anthropic可向博通发行至多420亿美元票据。" }, { text: "博通是其主要芯片供应商之一。" }],
    views: [{ who: "Anthropic", says: "可向博通发行至多420亿美元票据。" }, { who: "财联社电报", says: "Anthropic表示可向博通发行票据" }, { who: "彭博", says: "规模约400亿美元" }, { who: "博通", says: "未立即回应置评请求" }, { who: "分析师", says: "此举将锁定未来算力供应" }],
    impact: "Anthropic可向博通发行至多420亿美元票据",
  });
  assert.equal(c.lead, "Anthropic表示可向博通发行至多420亿美元票据。");
  assert.deepEqual(c.points.map((p) => p.text), ["博通是其主要芯片供应商之一。"]);
  assert.deepEqual(c.views.map((v) => v.who), ["彭博", "分析师"], "彭博给了不同的数字，留着");
  assert.equal(c.impact, "");
  assert.deepEqual(trimCopy({ lead: "DeepMind 发布证明系统", points: [{ text: "官方称详情见 goo.gle/4BLrkbk。" }, { text: "生成 600 万行证明。" }] }).points.map((p) => p.text), ["生成 600 万行证明。"], "只是链接的要点去掉");
  assert.equal(trimCopy({ lead: "11月12日，大涨。" }).lead, "11月12日，大涨。", "去掉日期后太短的不动");
});

test("一两句的材料：提示只写导语；材料够的不提示", () => {
  const layout = normalizeLayout(null);
  const wire = builtinProfiles().get("wire");
  const thin = { story: { title: "Anthropic可向博通发行票据", section: "industry", labels: [] }, profile: wire, mats: [{ id: "a", title: "Anthropic表示可向博通发行至多420亿美元票据", summary: "Anthropic表示可向博通发行至多420亿美元票据。", source_id: "cls" }], bodies: new Map(), fresh: [], prevLead: "" };
  assert.equal(thinMaterial(thin), true);
  assert.match(writePrompt([thin], layout), /（这篇材料只有一两句：只写导语；要点、各方说法、影响没有导语之外的新内容就给空）/);
  const fat = Object.assign({}, thin, { mats: [{ id: "a", title: "t", summary: "这是一段比较完整的报道内容。".repeat(30), source_id: "cls" }] });
  const oneGood = Object.assign({}, thin, { mats: [{ id: "a", title: "t", summary: "讲清来龙去脉的一篇报道。".repeat(20), source_id: "cls" }] });
  assert.equal(thinMaterial(oneGood), false, "只有一篇、但写得完整（240 字）：不算");
  const twice = Object.assign({}, thin, { mats: [thin.mats[0], Object.assign({}, thin.mats[0], { id: "b" })] });
  assert.equal(thinMaterial(twice), true, "同一句被两家转发：还是只有一句");
  assert.equal(thinMaterial(fat), false);
  assert.doesNotMatch(writePrompt([fat], layout), /（这篇材料只有一两句/);
  assert.match(writePrompt([fat], layout), /材料里如果有和这篇报道说的不是同一件事的，忽略它/);
});

test("取材：报道多时留最早的起因，其余取最新的、不同媒体优先，几乎一样的只留长的；按时间先后给模型", () => {
  const it = (id, h, grp, title, summary) => ({ id, grp, title, summary: summary || title, published_at: "2026-11-10 " + String(h).padStart(2, "0") + ":00:00" });
  const items = [
    it("a1", 1, "cls", "沙特首都利雅得传出剧烈爆炸声"),
    it("a2", 2, "jm", "沙特首都传出剧烈爆炸声", "当地时间今天凌晨，沙特首都利雅得传出剧烈爆炸声，当地居民收到防空警报。"),
    it("a3", 3, "cls", "利雅得爆炸声后续"),
    it("a4", 4, "cls", "沙特称拦截多枚导弹"),
    it("a5", 5, "wsj", "沙特外交部谴责袭击"),
    it("a6", 6, "cls", "也门胡塞武装称对沙特目标发动4次打击"),
    it("a7", 7, "cls", "油价盘中拉升"),
    it("a8", 8, "cls", "胡塞称袭击沙特阿美设施"),
  ];
  const m = pickMaterials(items, 5).map((x) => x.id);
  assert.equal(m[0], "a2", "起因：最早的那件事，一样的两篇留长的");
  assert.ok(m.includes("a8") && m.includes("a6"), "最新的进展在里面：" + m.join(","));
  assert.ok(m.includes("a5"), "别家（wsj）的报道在里面");
  assert.deepEqual(m, m.slice().sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))), "按时间先后");
  assert.ok(!m.includes("a3"), "早期的后续让位给最新进展");
  assert.deepEqual(pickMaterials(items.slice(0, 3), 6).map((x) => x.id), ["a1", "a2", "a3"], "不超过上限的全给");
});
