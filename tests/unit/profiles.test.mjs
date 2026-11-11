/* 读法（profile）：加载与覆盖、版式 focus 兼容、报道选读法、按读法分批、长文截取、写稿时的读法要求。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, builtinProfiles, profileFor, focusOf, withFocus, promptOf, normalizeProfile, BUILTIN_PROFILES_DIR } from "../../host/profiles.mjs";
import { loadLayout, normalizeLayout, writePrompt, batchByProfile, sample, materialText, profilesOf, storyProfile, writeFingerprint } from "../../host/edition.mjs";
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
