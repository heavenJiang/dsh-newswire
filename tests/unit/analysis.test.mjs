/* 影响与走势分析。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { analysisMaterials, analyzeStory, saveAnalysis, latestAnalysis, analysisBrief, autoAnalyzeTargets, analysisPrompt } from "../../host/analysis.mjs";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v28-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  db.prepare("INSERT INTO stories (story_id, title, section, status, copy) VALUES ('st1','胡塞袭击利雅得 阿美大楼受损','politics','active',?)").run(JSON.stringify({ lead: "胡塞武装称对沙特发动4次打击。" }));
  const add = (id, title, summary, msAgo) => {
    db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at) VALUES (?,?,?,?,'cls',?,?,?)").run(id, "https://x/" + id, title, summary, iso(msAgo), iso(msAgo), iso(msAgo));
    db.prepare("INSERT INTO story_items (article_id, story_id) VALUES (?, 'st1')").run(id);
  };
  add("a1", "胡塞武装袭击利雅得", "胡塞武装称对沙特发动4次打击，阿美大楼受损。", 7200000);
  add("a2", "布伦特原油涨2%", "布伦特原油期货盘中涨2%，报97美元/桶。", 3600000);
  return { db, add };
}
const fake = (obj) => {
  const calls = [];
  const llm = { stream(o) { calls.push(o.messages[0].content[0].text); return (async function* () { yield { type: "text-delta", text: JSON.stringify(obj) }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), calls };
};

test("分析：只给这条故事线的报道；数字编出来的条目丢掉；字段规范化；存档与「之后又多了几篇」", async () => {
  const { db, add } = tmpDb();
  const mats = analysisMaterials(db, "st1", null);
  assert.equal(mats.length, 2);
  const { m, calls } = fake({
    summary: "红海与海湾航运风险上升，油价短线承压上行。",
    impacts: [
      { area: "市场", target: "原油", ticker: "", direction: "利好", why: "供应担忧推升油价，布伦特已涨2%", confidence: "中" },
      { area: "公司", target: "沙特阿美", ticker: "2222.SR", direction: "利空", why: "设施受损，短期运营存在不确定性", confidence: "低" },
      { area: "市场", target: "航运股", ticker: "bad ticker!", direction: "大涨", why: "运价将上涨30%", confidence: "很高" },
    ],
    scenarios: [{ name: "升级", likelihood: "中", what: "袭击持续，油价继续上行", signals: "胡塞再次袭击沙特油气设施" }, { name: "缓和", likelihood: "高", what: "冲突降温", signals: "沙特与胡塞恢复谈判" }],
    watch: ["沙特是否反击", "阿美设施恢复情况"], horizon: "短期（几天）",
  });
  const a = await analyzeStory(m, { title: "胡塞袭击利雅得 阿美大楼受损", lead: "胡塞武装称对沙特发动4次打击。" }, mats, {});
  assert.match(calls[0], /\[1\] 财联社｜.*布伦特原油涨2%/);
  assert.deepEqual(a.impacts.map((x) => x.target), ["原油", "沙特阿美"], "「运价将上涨30%」材料里没有，丢掉");
  assert.equal(a.impacts[1].ticker, "2222.SR");
  assert.equal(a.dropped, 1);
  assert.equal(a.horizon, "短期");
  assert.equal(a.scenarios.length, 2);
  saveAnalysis(db, "st1", a, { model: "f/m" });
  assert.equal(latestAnalysis(db, "st1").newer, 0);
  add("a3", "沙特称拦截导弹", "", 600000);
  assert.equal(latestAnalysis(db, "st1").newer, 1);
  assert.equal(analysisBrief(db, ["st1"]).st1.summary, "红海与海湾航运风险上升，油价短线承压上行。");
  db.close();
});

test("什么都没核对过的分析不存；自动分析只挑头版里重要、没分析过或之后又多了 ≥2 篇的", async () => {
  const { db, add } = tmpDb();
  const { m } = fake({ summary: "油价将暴涨50%", impacts: [], scenarios: [] });
  await assert.rejects(analyzeStory(m, { title: "t" }, analysisMaterials(db, "st1", null), {}), /nothing_verified/);
  const ed = { front: ["st1", "st2"], sections: [], stories: { st1: { importance: 80 }, st2: { importance: 40 } } };
  assert.deepEqual(autoAnalyzeTargets(db, ed, {}), ["st1"]);
  saveAnalysis(db, "st1", { summary: "x", impacts: [], scenarios: [] }, {});
  assert.deepEqual(autoAnalyzeTargets(db, ed, {}), [], "分析过、没有新报道的不再分析");
  add("b1", "续报一", "", 1000); add("b2", "续报二", "", 500);
  assert.deepEqual(autoAnalyzeTargets(db, ed, {}), ["st1"]);
  assert.match(analysisPrompt({ title: "t" }, []), /不要编造数字/);
  db.close();
});
