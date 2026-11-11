/* 读法（profile）：加载与覆盖、版式 focus 兼容、报道选读法、按读法分批、长文截取、写稿时的读法要求。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, builtinProfiles, profileFor, focusOf, withFocus, promptOf, normalizeProfile, BUILTIN_PROFILES_DIR } from "../../host/profiles.mjs";
import { loadLayout, normalizeLayout, writePrompt, batchByProfile, sample, materialText, profilesOf, storyProfile, writeFingerprint, blockSpec, parseCopy } from "../../host/edition.mjs";
import { verifyCopy } from "../../host/factcheck.mjs";
import { analysisPrompt } from "../../host/analysis.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "nw-prof-")); }
function writeProfile(root, id, json, files) {
  const d = path.join(root, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "profile.json"), JSON.stringify(Object.assign({ id }, json)));
  for (const [k, v] of Object.entries(files || {})) fs.writeFileSync(path.join(d, k), v);
}

test("内置读法：wire（默认）与 tech-frontier（重点领域）", () => {
  const r = builtinProfiles();
  assert.equal(r.def.id, "wire");
  assert.ok(r.byId.has("tech-frontier"));
  const f = focusOf(r);
  assert.deepEqual(f.labels, ["tech", "industry.ai_semis"]);
  assert.equal(f.name, "AI 与新技术");
  assert.match(promptOf(r.get("tech-frontier"), "analysis"), /^这是一条AI 与新技术新闻/);
  assert.equal(r.errors.length, 0);
});

test("数据目录的读法覆盖内置同名读法，也能新增；坏目录跳过并记下原因", () => {
  const dir = tmpDir();
  writeProfile(dir, "tech-frontier", { name: "前沿科技", priority: 10, match: { labels: ["tech"] }, focus: { boost: 30 }, prompts: { write: "w.md" } }, { "w.md": "写{name}的要点" });
  writeProfile(dir, "deep", { name: "长文", priority: 5, match: { sources: ["simonw"] } });
  writeProfile(dir, "bad", { prompts: { write: "../../etc/passwd" } });
  fs.mkdirSync(path.join(dir, "broken"));
  fs.writeFileSync(path.join(dir, "broken", "profile.json"), "{ not json");
  const r = loadProfiles([BUILTIN_PROFILES_DIR, dir]);
  assert.equal(r.get("tech-frontier").name, "前沿科技");
  assert.equal(promptOf(r.get("tech-frontier"), "write"), "写前沿科技的要点");
  assert.equal(promptOf(r.get("tech-frontier"), "rubric"), "", "整个目录替换，不和内置的混");
  assert.ok(r.byId.has("deep"));
  assert.ok(!r.byId.has("bad") && !r.byId.has("broken"));
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join(" "), /跳出了读法目录/);
});

test("读法校验：id 格式、自定义块要有名称、必须有导语块", () => {
  assert.throws(() => normalizeProfile({ id: "Bad Id" }), /id/);
  assert.throws(() => normalizeProfile({ id: "x1", blocks: [{ kind: "points" }] }), /lead/);
  assert.throws(() => normalizeProfile({ id: "x1", blocks: [{ kind: "lead" }, { kind: "text", id: "bg" }] }), /name/);
  const p = normalizeProfile({ id: "x1", blocks: [{ kind: "lead" }, { kind: "text", id: "bg", name: "背景", chars: 100, materials: ["source", "history", "evil"] }] });
  assert.deepEqual(p.blocks[1], { id: "bg", kind: "text", name: "背景", chars: 100, materials: ["source", "history"] });
  assert.equal(normalizeProfile({ id: "x1" }).blocks.length, 4, "不写 blocks 就是原来的四块");
});

test("版式 focus 覆盖重点领域读法；focus.labels 为 [] 关闭；没写 focus 用读法自己的", () => {
  const dir = tmpDir();
  const f = path.join(dir, "layout.json");
  fs.writeFileSync(f, JSON.stringify({ focus: { name: "芯片", labels: ["industry.ai_semis"], boost: 10 } }));
  let l = loadLayout(f, path.join(CFG, "layout.json"));
  assert.deepEqual(l.focus, { name: "芯片", labels: ["industry.ai_semis"], boost: 10 });
  assert.equal(storyProfile(l, { section: "tech", labels: ["tech.frontier"] }).id, "wire", "tech 不再是重点领域");
  assert.equal(storyProfile(l, { section: "industry", labels: ["industry.ai_semis"] }).id, "tech-frontier");
  fs.writeFileSync(f, JSON.stringify({ focus: { labels: [] } }));
  l = loadLayout(f, path.join(CFG, "layout.json"));
  assert.deepEqual(l.focus.labels, []);
  assert.equal(storyProfile(l, { section: "tech", labels: [] }).id, "wire");
  fs.writeFileSync(f, JSON.stringify({ sections: [{ id: "tech", max: 2 }] }));
  l = loadLayout(f, path.join(CFG, "layout.json"));
  assert.deepEqual(l.focus.labels, ["tech", "industry.ai_semis"]);
  assert.equal(JSON.stringify(l).includes("profiles"), false, "读法表不参与序列化");
});

test("报道选读法：每条的源都声明了用声明的；混着的看分类与源；都不命中用默认", () => {
  const dir = tmpDir();
  writeProfile(dir, "community", { name: "社区讨论", priority: 5 });
  writeProfile(dir, "deep", { name: "长文", priority: 3, match: { sources: ["simonw"] } });
  const r = loadProfiles([BUILTIN_PROFILES_DIR, dir]);
  assert.equal(profileFor(r, { section: "tech", labels: [], declared: ["community", "community"] }).id, "community");
  assert.equal(profileFor(r, { section: "tech", labels: [], declared: ["community", null] }).id, "tech-frontier", "混着别家报道：按分类");
  assert.equal(profileFor(r, { section: "politics", labels: [], sources: ["simonw"], declared: [null] }).id, "deep");
  assert.equal(profileFor(r, { section: "tech", labels: [], sources: ["simonw"] }).id, "tech-frontier", "优先级高的先");
  assert.equal(profileFor(r, { section: "politics", labels: ["politics.domestic"] }).id, "wire");
  assert.equal(profileFor(r, { section: "politics", declared: ["nope"] }).id, "wire", "声明了不存在的读法：当没声明");
});

test("按读法分批：按顺序取，同读法的往前凑，每批不超过 n 篇", () => {
  const xs = [["a", "wire"], ["b", "tech"], ["c", "wire"], ["d", "tech"], ["e", "wire"], ["f", "wire"]].map(([id, profile]) => ({ id, profile }));
  assert.deepEqual(batchByProfile(xs, 3).map((b) => b.map((x) => x.id).join("")), ["ace", "bd", "f"]);
});

test("长文截取：head-middle-tail 留开头、中段、结尾；prefix 只取开头；材料文本按读法截", () => {
  const t = "开" + "a".repeat(2000) + "中" + "b".repeat(2000) + "尾";
  const s = sample(t, 300, "head-middle-tail");
  assert.ok(s.length <= 300 && s.startsWith("开") && s.endsWith("尾") && s.split("……").length === 3);
  assert.ok(sample(t, 300, "prefix").startsWith("开") && !sample(t, 300, "prefix").endsWith("尾"));
  const bodies = new Map([["x", t]]);
  assert.ok(materialText({ id: "x", title: "T" }, bodies, { body_chars: 300, sampling: "head-middle-tail" }).endsWith("尾"));
  assert.equal(materialText({ id: "x", title: "T" }, bodies).length, "T｜".length + 900, "不给读法设置：和原来一样截 900 字");
});

test("写稿提示词：标出读法名称，附上这一批用到的读法的写稿要求；指纹随读法变", () => {
  const dir = tmpDir();
  writeProfile(dir, "deep", { name: "长文", priority: 3, match: { labels: ["study"] }, prompts: { write: "w.md" }, content: { body_chars: 2000, sampling: "head-middle-tail" } }, { "w.md": "points 写可借鉴的做法。" });
  const layout = normalizeLayout(null);
  Object.defineProperty(layout, "profiles", { value: loadProfiles([BUILTIN_PROFILES_DIR, dir]) });
  const mk = (title, section) => ({ story: { title, section, labels: [] }, mats: [{ id: title, source_name: "S", title, summary: "摘要" }], bodies: new Map(), fresh: [], prevLead: "" });
  const p = writePrompt([mk("留学新政", "study"), mk("国务院", "politics")], layout);
  assert.match(p, /【报道1】（长文）留学新政/);
  assert.match(p, /【报道2】国务院/);
  assert.match(p, /标了（长文）的报道，points 写可借鉴的做法。/);
  assert.doesNotMatch(p, /标了（AI 与新技术）/, "这一批没有的读法不写它的要求");
  const e = mk("留学新政", "study");
  const fp1 = writeFingerprint(Object.assign({}, e, { profile: profilesOf(layout).get("deep") }), layout);
  const fp2 = writeFingerprint(Object.assign({}, e, { profile: profilesOf(layout).get("wire") }), layout);
  assert.notEqual(fp1, fp2);
});

test("影响分析：侧重取读法的 analysis.md；旧写法只给 focus 名称也照旧", () => {
  const mats = [{ source: "s", t: "2026-11-10", title: "x", text: "y" }];
  assert.match(analysisPrompt({ title: "t", hint: "着重分析对开发者的影响。" }, mats), /\n着重分析对开发者的影响。/);
  assert.match(analysisPrompt({ title: "t", focus: "AI 与新技术" }, mats), /这是一条AI 与新技术新闻：着重分析这项技术/);
  assert.doesNotMatch(analysisPrompt({ title: "t" }, mats), /这是一条/);
  assert.equal(withFocus(builtinProfiles(), null), builtinProfiles());
});

test("内置读法：技术长文与社区讨论都有自定义块，由源声明", () => {
  const r = builtinProfiles();
  const deep = r.get("tech-deep"), com = r.get("community");
  assert.deepEqual(deep.blocks.map((b) => b.id), ["lead", "points", "background", "takeaways"]);
  assert.equal(deep.content.sampling, "head-middle-tail");
  assert.deepEqual(com.blocks.find((b) => b.id === "debate").materials, ["community"]);
  assert.ok(com.content.comments > 0);
  assert.equal(com.badge, "社区");
  assert.equal(profileFor(r, { section: "tech", labels: ["tech.frontier"] }).id, "tech-frontier", "没声明的不会被分到这两种");
  assert.equal(profileFor(r, { section: "tech", declared: ["community", "tech-deep"] }).id, "community", "一样多时取优先级高的");
});

test("输出块 → 版式说明与 JSON：默认四块与原来一字不差；自定义块按 text / list 写", () => {
  const S = normalizeLayout(null).story;
  const def = blockSpec(builtinProfiles().def.blocks, S, false);
  assert.match(def.text, /^lead 导语（不超过120字，说清谁、何时、何事）；points 要点（最多3条/);
  assert.equal(def.json, '{"stories":[{"ref":1,"lead":"","lead_refs":["M1"],"points":[{"text":"","refs":["M2"]}],"views":[{"who":"","says":"","refs":["M1"]}],"impact":"","update":"","title":""}]}');
  const com = blockSpec(builtinProfiles().get("community").blocks, S, true);
  assert.match(com.text, /debate 社区观点（最多4条，每条不超过60字，评论区的主要看法与分歧[^）]*可以依据【社区评论】；没有就给空数组）/);
  assert.doesNotMatch(com.text, /impact|views/);
  assert.match(com.json, /"debate":\[\{"text":"","refs":\["M1"\]\}\]/);
  const deep = blockSpec(builtinProfiles().get("tech-deep").blocks, S, false);
  assert.match(deep.text, /background 背景（不超过100字，这个问题为什么重要/);
  assert.match(deep.json, /"background":\{"text":"","refs":\["M1"\]\}/);
});

test("模型稿 → 报道：只收读法里有的块，自定义块进 extra，条数字数按块截", () => {
  const S = normalizeLayout(null).story;
  const ids = (r) => (Array.isArray(r) ? r : [r]).map((x) => String(x || "").replace(/^M/, "a")).filter((x) => x !== "a");
  const w = { lead: "导语", lead_refs: ["M1"], points: ["p1", { text: "p2", refs: ["M2"] }], views: [{ who: "x", says: "y" }], impact: "影响", debate: [{ text: "有评论认为太贵", refs: ["M1"] }, "也有人指出好用", "c", "d", "e"], junk: "x" };
  const out = parseCopy(w, builtinProfiles().get("community").blocks, S, ids);
  assert.deepEqual(out.views, [], "社区读法没有各方说法块");
  assert.equal(out.impact, "");
  assert.equal(out.extra[0].id, "debate");
  assert.equal(out.extra[0].items.length, 4);
  assert.deepEqual(out.extra[0].items[0], { text: "有评论认为太贵", refs: ["a1"] });
  const plain = parseCopy(w, builtinProfiles().def.blocks, S, ids);
  assert.equal(plain.impact, "影响");
  assert.equal(plain.extra, undefined);
});

test("社区评论：读法要看评论才附上；导语只能依据原文，社区观点可以依据评论", () => {
  const it = { id: "h1", title: "Show HN: Foo 2.0", summary: "Foo is a database with 3x faster writes", comments: "One commenter says it costs $500 per month" };
  const com = builtinProfiles().get("community");
  assert.doesNotMatch(materialText(it, new Map()), /社区评论/);
  assert.match(materialText(it, new Map(), com.content), /｜【社区评论】One commenter says it costs \$500/);
  const src = [materialText(it, new Map(), { comments: 0 })];
  const wide = [materialText(it, new Map(), com.content)];
  const v = verifyCopy({ lead: "Foo 每月 500 美元", lead_refs: [0], points: ["月费 500 美元"], extra: [{ id: "debate", name: "社区观点", kind: "list", items: [{ text: "有评论认为每月 500 美元太贵", refs: [0] }, { text: "有人说要 900 美元", refs: [0] }] }] }, src, { wide, wideBlocks: ["debate"] });
  assert.ok(v.copy.lead_missing, "导语里的 500 只在评论里：标待核");
  assert.equal(v.copy.points.length, 0, "要点只认原文");
  assert.deepEqual(v.copy.extra[0].items.map((x) => x.text), ["有评论认为每月 500 美元太贵"], "评论里有的留下，编的丢掉");
});
