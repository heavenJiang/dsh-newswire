/* 前情与联网：以前的相关故事线进「背景」、只对能依据前情的块放开核对；Bing 结果页解析；搜索结果作分析的背景材料。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../engine/store/schema.mjs";
import { relatedStories } from "../../host/history.mjs";
import { verifyStory, writePrompt, normalizeLayout } from "../../host/edition.mjs";
import { builtinProfiles } from "../../host/profiles.mjs";
import { bingResults, unwrapBing, searchUrl } from "../../engine/parsers/search.mjs";
import { webMaterials, searchQuery, analysisPrompt } from "../../host/analysis.mjs";

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-hist-")), "n.sqlite"));
  const st = db.prepare("INSERT INTO stories (story_id, pack, title, section, labels, importance, status, copy, created_at, updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)");
  st.run("st-old1", "all", "vLLM 发布 0.9 版推测解码提速", "tech", "[]", 50, JSON.stringify({ lead: "vLLM 0.9 把推测解码吞吐提升 2.1 倍。", by: "llm" }), "2026-10-01 08:00:00", "2026-10-01 08:00:00");
  st.run("st-old2", "all", "英伟达发布新显卡", "tech", "[]", 60, JSON.stringify({ lead: "英伟达发布 RTX 6090。", by: "llm" }), "2026-10-05 08:00:00", "2026-10-05 08:00:00");
  st.run("st-notext", "all", "vLLM 推测解码", "tech", "[]", 40, null, "2026-10-06 08:00:00", "2026-10-06 08:00:00");
  st.run("st-later", "all", "vLLM 推测解码再提速", "tech", "[]", 40, JSON.stringify({ lead: "后来的事。", by: "llm" }), "2026-11-20 08:00:00", "2026-11-20 08:00:00");
  db.prepare("INSERT INTO story_entities (story_id, name, at) VALUES (?,?,?)").run("st-old1", "vLLM", "2026-10-01 08:00:00");
  return db;
}

test("前情：按标题相似与共同主体找以前的故事线；没写过稿的、比这篇晚的、同一条的都不要", () => {
  const db = tmpDb();
  const r = relatedStories(db, { id: "st-new", title: "vLLM 推测解码的新做法", entities: ["vLLM"], first_seen_at: "2026-11-10 08:00:00" });
  assert.deepEqual(r.map((x) => [x.ref, x.story_id]), [["H1", "st-old1"]]);
  assert.match(r[0].lead, /2\.1 倍/);
  assert.deepEqual(relatedStories(db, { id: "st-old1", title: "vLLM 发布 0.9 版推测解码提速", first_seen_at: "2026-11-10 08:00:00" }).map((x) => x.story_id), [], "不找自己");
  db.close();
});

test("写稿：技术长文给出前情（H 编号），只许用在「背景」；核对时背景能依据前情，要点不能", () => {
  const layout = normalizeLayout(null);
  const deep = builtinProfiles().get("tech-deep");
  const history = [{ ref: "H1", story_id: "st-old1", title: "vLLM 发布 0.9 版推测解码提速", lead: "vLLM 0.9 把推测解码吞吐提升 2.1 倍。", at: "2026-10-01 08:00:00" }];
  const b = { story: { title: "vLLM 推测解码新做法", section: "tech", labels: [] }, profile: deep, history, mats: [{ id: "a1", source_name: "vLLM Blog", title: "Faster speculative decoding", summary: "We make speculative decoding 3x faster in vLLM 1.0." }], bodies: new Map(), fresh: [], prevLead: "" };
  const p = writePrompt([b], layout);
  assert.match(p, /以前的相关报道（前情，只能用在「背景」里，引用写 H 编号；和这件事没有直接关系就不要用）：\n\[H1\] 2026-10-01｜vLLM 发布 0\.9 版推测解码提速｜vLLM 0\.9 把推测解码吞吐提升 2\.1 倍。/);
  assert.match(p, /background 背景（不超过100字/);

  const db = tmpDb();
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id) VALUES ('a1','https://vllm.ai/x','Faster speculative decoding','We make speculative decoding 3x faster in vLLM 1.0.','vllm_blog')").run();
  const story = { by: "llm", lead: "vLLM 1.0 把推测解码提速 3 倍。", lead_refs: ["a1"], points: [{ text: "上一版提速 2.1 倍", refs: ["a1"] }], views: [], impact: "", history,
    extra: [{ id: "background", name: "背景", kind: "text", text: "上一版 0.9 已把吞吐提升 2.1 倍。", refs: ["h:st-old1"] }] };
  verifyStory(db, story, [{ id: "a1", title: "Faster speculative decoding", summary: "We make speculative decoding 3x faster in vLLM 1.0.", source_id: "vllm_blog", grp: "vllm" }], new Map(), deep.content, deep.blocks);
  assert.equal(story.points.length, 0, "要点里的 2.1 只在前情里：丢掉");
  assert.equal(story.extra[0].text, "上一版 0.9 已把吞吐提升 2.1 倍。", "背景能依据前情");
  assert.deepEqual(story.extra[0].refs, ["h:st-old1"]);
  db.close();
});

test("Bing 结果页：解出真实链接、去掉加粗标签的空格、跳过 Bing 自己的链接", () => {
  const enc = (u) => "https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1" + Buffer.from(u).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "&amp;ntb=1";
  const html = '<ol><li class="b_algo" data-id><h2><a href="' + enc("https://github.com/vllm-project/vllm") + '"><strong>GitHub</strong> - <strong>vllm</strong>-project/vllm</a></h2><div class="b_caption"><p class="b_lineclamp2">A high-throughput <strong>engine</strong> …</p></div></li>' +
    '<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">图片</a></h2></li>' +
    '<li class="b_algo"><h2><a href="https://vllm.ai/">vLLM</a></h2><div class="b_caption"><p class="b_lineclamp3">Fast LLM serving</p></div></li></ol>';
  const r = bingResults(html, 5);
  assert.deepEqual(r.map((x) => [x.site, x.title, x.snippet]), [["github.com", "GitHub - vllm-project/vllm", "A high-throughput engine…"], ["vllm.ai", "vLLM", "Fast LLM serving"]]);
  assert.equal(unwrapBing("https://example.com/a"), "https://example.com/a");
  assert.match(searchUrl("vLLM 推测解码"), /^https:\/\/www\.bing\.com\/search\?q=vLLM%20/);
});

test("影响分析的联网材料：标明是网页搜索，提示词说清只作背景", () => {
  const w = webMaterials([{ title: "T", url: "https://x.com/a", snippet: "S", site: "x.com" }, { title: "", url: "https://y" }]);
  assert.deepEqual(w.map((m) => [m.id, m.source, m.text, m.web]), [["w:https://x.com/a", "网页搜索·x.com", "S", true]]);
  assert.equal(searchQuery("「vLLM」发布：推测解码提速！"), "vLLM 发布 推测解码提速");
  assert.equal(searchQuery("短"), "");
  const p = analysisPrompt({ title: "t" }, [{ source: "s", t: "", title: "x", text: "y" }].concat(w));
  assert.match(p, /来源标「网页搜索」的是搜索结果摘要，只用来了解背景和前因/);
  assert.doesNotMatch(analysisPrompt({ title: "t" }, [{ source: "s", t: "", title: "x", text: "y" }]), /网页搜索/);
  assert.equal(builtinProfiles().get("tech-deep").search.analysis, 1);
  assert.equal(builtinProfiles().get("wire").search.analysis, 0);
});
