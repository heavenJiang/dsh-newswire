/* 归并——按批检索候选（含刚建的报道）、关键主体、主线。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { loadLayout, llmEdition, saveEdition, pickCandidates } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAXL = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8")).labels;
const LAYOUT = Object.assign(loadLayout(null, path.join(CFG, "layout.json")), { min_importance: 10 });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

test("候选：和这一批最像的在前（字面或关键主体），再用最重要的补满", () => {
  const groups = [
    { id: "g1", title: "某市发布暴雨预警", importance: 90, entities: [] },
    { id: "g2", title: "沙特首都遇袭", importance: 30, entities: ["沙特阿美"] },
    { id: "g3", title: "英伟达发布新芯片", importance: 20, entities: ["英伟达"] },
    { id: "g4", title: "无关报道", importance: 10, entities: [] },
  ];
  const c = pickCandidates(groups, [{ title: "沙特首都利雅得再遭袭击" }, { title: "Nvidia 股价下跌", title_zh: "英伟达股价下跌" }], 3);
  assert.deepEqual(c.map((g) => g.id).slice(0, 2).sort(), ["g2", "g3"]);
  assert.equal(c[2].id, "g1", "不足的用最重要的补");
});

function db0() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v31-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  const add = (id, title, msAgo) => { const t = iso(msAgo); db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES (?,?,?,?,?,?,?,?,'core','full')").run(id, "https://x/" + id, title, title, "cls", t, t, t); };
  add("a1", "沙特首都利雅得遇袭", 3000000);
  add("a2", "某地发布暴雨预警", 3100000);
  add("a3", "利雅得再次遭到袭击，沙特称已拦截", 3200000);
  add("a4", "伊朗称油轮在霍尔木兹海峡起火", 3300000);
  return db;
}
function fake() {
  const prompts = [];
  const llm = { stream(o) {
    const p = o.messages[0].content[0].text;
    prompts.push(p);
    let r = "{}";
    if (p.includes("归为一篇报道")) {
      const known = [...p.matchAll(/^\[S(\d+)\] [^｜]*｜(.*)$/gm)].map((m) => ({ s: "S" + m[1], title: m[2] }));
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜([^｜\n]*)/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
      r = JSON.stringify({ stories: lines.map((l) => {
        const k = /利雅得|沙特/.test(l.title) ? known.find((x) => /沙特|利雅得/.test(x.title)) : null;
        return k ? { items: [l.n], story: k.s } : { items: [l.n], title: l.title.slice(0, 12), section: "politics", labels: [], importance: 70, entities: /沙特|利雅得/.test(l.title) ? ["沙特"] : /伊朗/.test(l.title) ? ["伊朗"] : [] };
      }) });
    } else if (p.includes("headline：一句话总括")) {
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜[^｜]*｜(.*)$/gm)];
      const refs = lines.filter((m) => /沙特|利雅得|伊朗/.test(m[2])).map((m) => Number(m[1]));
      r = JSON.stringify({ merge: [], headline: "总括", front: [1], watch: [], themes: [{ name: "海湾局势", kind: "conflict", refs }, { name: "单篇主线", kind: "other", refs: [refs[0]] }] });
    } else if (p.includes("按版式为以下每篇报道写稿")) {
      const k = (p.match(/【报道\d+】/g) || []).length;
      r = JSON.stringify({ stories: Array.from({ length: k }, (_, i) => ({ ref: i + 1, lead: "导语。", lead_refs: ["M1"], points: [], views: [], impact: "" })) });
    }
    return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })();
  } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), prompts };
}

test("同一件事分在两批：后一批能看到前一批刚建的报道并归进去；关键主体存档；主线映射到报道（单篇的不算主线）", async () => {
  const db = db0();
  const { m, prompts } = fake();
  const ed = await llmEdition(db, m, { pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAXL, maxItems: 100, maxStories: 10, budgetMs: 60000, batchSize: 2 });
  const saudi = Object.values(ed.stories).find((s) => (s.article_ids || []).includes("a1"));
  assert.ok(saudi.article_ids.includes("a3"), "第二批的利雅得新闻归进第一批建的报道");
  assert.ok(prompts.filter((p) => p.includes("归为一篇报道")).length >= 2);
  assert.equal(ed.themes.length, 1);
  assert.equal(ed.themes[0].name, "海湾局势");
  assert.equal(ed.themes[0].stories.length, 2);
  saveEdition(db, ed, {});
  assert.deepEqual(db.prepare("SELECT name FROM story_entities WHERE story_id = ?").all(saudi.id).map((r) => r.name), ["沙特"]);
  db.close();
});
