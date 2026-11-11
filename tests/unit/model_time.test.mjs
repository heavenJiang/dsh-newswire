/* 省模型时间：一句话快讯不交给模型写；已有稿的故事线新报道少时先沿用旧稿，攒够再重写；变化小时沿用上次的统筹。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { createModel } from "../../host/model.mjs";
import { loadLayout, llmEdition, saveEdition, latestEdition, deferRewrite, isBriefWire, normalizeLayout } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAX = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8")).labels;
const L0 = loadLayout(null, path.join(CFG, "layout.json"));
const LAYOUT = Object.assign(L0, { min_importance: 10, sections: L0.sections.map((x) => Object.assign({}, x, { max: 10 })) });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
const LONG = "这是一段写得比较完整的报道内容，交代了时间、地点、当事各方的动作以及后续安排。".repeat(6);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-mt-")), "n.sqlite"));
  db.prepare("INSERT INTO sources (id, name, grp) VALUES ('cls','财联社','cls')").run();
  return db;
}
/** 加一篇报道；ev 给了就并进那个规则事件（同一件事的后续）。 */
function add(db, id, title, imp, summary, ev) {
  const t = iso(3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, pack, completeness) VALUES (?,?,?,?,?,?,?,?,'core','full')").run(id, "https://x/" + id, title, summary, "cls", t, t, t);
  if (!ev) db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, outlets) VALUES (?,?,?,?,?,?,1,1,?,'single',?,?)").run("e" + id, "core", title, id, t, t, imp, JSON.stringify(["politics"]), JSON.stringify(["cls"]));
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, method) VALUES (?,?,?,?,?)").run(ev || "e" + id, id, "cls", "cls", ev ? "title" : "seed");
}
function fake() {
  const log = { group: 0, plan: 0, write: [] };
  const llm = { stream(o) {
    const p = o.messages[0].content[0].text;
    let r = "{}";
    if (p.includes("归为一篇报道")) {
      log.group++;
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜([^｜\n]*)/gm)];
      r = JSON.stringify({ stories: lines.map((m) => ({ items: [Number(m[1])], title: m[2].slice(0, 20), section: "politics", labels: [], importance: m[2].includes("头条") ? 90 : m[2].includes("要闻") ? 70 : m[2].includes("快讯") ? 40 : 50 })) });
    } else if (p.includes("headline：一句话总括")) {
      log.plan++;
      const lines = [...p.matchAll(/^\[(\d+)\] [^｜]*｜[^｜]*｜[^｜]*｜(.*)$/gm)];
      const top = lines.find((m) => m[2].includes("头条"));
      r = JSON.stringify({ merge: [], headline: "总括", front: top ? [Number(top[1])] : [], watch: [] });
    } else if (p.includes("按版式为以下每篇报道写稿")) {
      log.write.push(p);
      const n = (p.match(/【报道\d+】/g) || []).length;
      r = JSON.stringify({ stories: Array.from({ length: n }, (_, i) => ({ ref: i + 1, lead: "这是一段写得比较完整的报道内容。", lead_refs: ["M1"], points: [], views: [], impact: "" })) });
    }
    return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })();
  } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), log };
}
const opts = (extra) => Object.assign({ pack: "core", since: iso(12 * 3600000), hours: 12, layout: LAYOUT, names: {}, taxonomy: TAX, maxItems: 100, maxStories: 10, budgetMs: 60000 }, extra || {});
const round = async (db, m, extra) => { const ed = await llmEdition(db, m, opts(extra)); saveEdition(db, ed, {}); return ed; };
const byTitle = (ed, re) => Object.values(ed.stories).find((s) => re.test(s.title));

test("判断：先不重写（新报道少、不重要、有模型稿）；一句话快讯（单篇、短、不重要、不是长材料读法）", () => {
  const S = normalizeLayout(null).story;
  assert.deepEqual([S.rewrite_min, S.rewrite_ratio, S.brief_chars], [2, 0.25, 160]);
  const row = (items) => ({ copy: { by: "llm", lead: "导语", items } });
  assert.equal(deferRewrite(row(4), { _total: 5, importance: 50 }, S), true, "多 1 篇：先不重写");
  assert.equal(deferRewrite(row(4), { _total: 6, importance: 50 }, S), false, "多 2 篇、超过四分之一：重写");
  assert.equal(deferRewrite(row(20), { _total: 23, importance: 50 }, S), true, "20 篇的大故事线多 3 篇（不到四分之一）：先不重写");
  assert.equal(deferRewrite(row(20), { _total: 25, importance: 50 }, S), false);
  assert.equal(deferRewrite(row(4), { _total: 5, importance: 60 }, S), false, "重要的照样重写");
  assert.equal(deferRewrite({ copy: { by: "rules", lead: "x", items: 4 } }, { _total: 5, importance: 50 }, S), false, "没有模型稿的要写");
  assert.equal(deferRewrite(row(4), { _total: 5, importance: 50 }, Object.assign({}, S, { rewrite_min: 0 })), false, "rewrite_min 为 0 关闭");
  const it = (summary, extra) => ({ items: [Object.assign({ title: "央行开展逆回购操作", summary, completeness: "full" }, extra || {})] });
  assert.equal(isBriefWire(it("央行今日开展 500 亿元 7 天期逆回购操作。"), { importance: 40 }, S, null), true);
  assert.equal(isBriefWire(it(LONG), { importance: 40 }, S, null), false, "原文长的要写");
  assert.equal(isBriefWire(it("短。"), { importance: 65 }, S, null), false, "重要的要写");
  assert.equal(isBriefWire(it("短。", { completeness: "partial" }), { importance: 40 }, S, null), false, "摘要被截断的要写（会去抓正文）");
  assert.equal(isBriefWire({ items: [it("短。").items[0], it("短。").items[0]] }, { importance: 40 }, S, null), false, "两篇以上的要写");
  assert.equal(isBriefWire(it("短。"), { importance: 40 }, S, { content: { body_chars: 3000 } }), false, "要长材料的读法照样写");
});

test("三轮版面：快讯不写；新报道少时沿用旧稿和上次的统筹，不调用统筹；攒够两篇再重写", async () => {
  const db = tmpDb();
  add(db, "top", "今天的头条事件", 90, LONG);
  // 头版 3 个位置：头条加两条要闻占满，下面几条都不在头版
  add(db, "f1", "国际要闻一则", 70, LONG);
  add(db, "f2", "财经要闻一则", 70, LONG);
  add(db, "a1", "某公司宣布重组方案", 50, LONG);
  add(db, "b1", "央行逆回购快讯", 40, "央行今日开展 500 亿元逆回购操作。");
  const { m, log } = fake();
  const e1 = await round(db, m);
  assert.equal(log.plan, 1);
  assert.equal(e1.stats.brief, 1);
  assert.equal(e1.stats.written, 4);
  assert.ok(!log.write.join("\n").includes("央行逆回购快讯"), "一句话快讯不交给模型");
  assert.notEqual(byTitle(e1, /快讯/).by, "llm");
  assert.match(byTitle(e1, /快讯/).lead, /500 亿元/, "快讯用程序稿（原文）");
  assert.ok(e1.stats.plan_at);

  // 第二轮：重组那件事多了一篇（同一规则事件，自动接上），另来一条排不进头版的新闻
  add(db, "a2", "某公司重组方案获批", 50, LONG, "ea1");
  add(db, "c1", "某地出台产业扶持政策", 45, LONG);
  const writes1 = log.write.length;
  const e2 = await round(db, m, { prev: latestEdition(db, "core").content });
  assert.equal(log.plan, 1, "变化小：沿用上次的统筹");
  assert.equal(e2.stats.plan_reused, true);
  assert.equal(e2.stats.plan_minor, 2);
  assert.equal(e2.headline, "总括");
  assert.deepEqual(e2.front, e1.front);
  assert.equal(e2.stats.deferred, 1);
  const a = byTitle(e2, /重组/);
  assert.equal(a.by, "llm");
  assert.match(a.update_text, /新增 1 篇：某公司重组方案获批/);
  const w2 = log.write.slice(writes1).join("\n");
  assert.ok(w2.includes("产业扶持政策") && !w2.includes("重组"), "只写新来的那条");

  // 第三轮：重组又多一篇，攒够两篇 → 重写；头版也没动，统筹照样沿用
  add(db, "a3", "某公司重组后首次披露业绩", 50, LONG, "ea1");
  const writes2 = log.write.length;
  const e3 = await round(db, m, { prev: latestEdition(db, "core").content });
  assert.equal(e3.stats.deferred, 0);
  assert.ok(log.write.slice(writes2).join("\n").includes("重组"), "攒够了重写");
  assert.equal(log.plan, 1);

  // 头版的故事线有了新报道：重新统筹
  add(db, "top2", "今天的头条事件有新进展", 90, LONG, "etop");
  await round(db, m, { prev: latestEdition(db, "core").content });
  assert.equal(log.plan, 1, "只是自动接上、没有交给模型归并的新闻：照旧沿用");
  add(db, "d1", "另一件头条大事", 95, LONG);
  await round(db, m, { prev: latestEdition(db, "core").content });
  assert.equal(log.plan, 2, "来了排得进头版的新闻：重新统筹");
  db.close();
});

test("事情走向变了才换标题：新标题要和导语说的是一件事、数字在材料里找得到；不合格的留原标题", async () => {
  const { acceptTitle, writePrompt } = await import("../../host/edition.mjs");
  const src = ["财联社｜11-11 17:00｜英伟达盘前涨幅扩大至5%，报177.4美元/股，芯片半导体板块全线大涨。"];
  const lead = "11月11日美股盘前，英伟达涨幅扩大至5%，报177.4美元/股，芯片半导体板块全线大涨。";
  assert.equal(acceptTitle("英伟达盘前反弹涨5% 芯片股大涨", "英伟达股价大跌 市值蒸发约1.76万亿美元", lead, src), "英伟达盘前反弹涨5% 芯片股大涨");
  assert.equal(acceptTitle("英伟达盘前涨8%", "英伟达股价大跌", lead, src), "", "8% 材料里没有");
  assert.equal(acceptTitle("苹果发布新款手机和平板电脑", "英伟达股价大跌", lead, src), "", "和导语不是一件事");
  assert.equal(acceptTitle("英伟达股价大跌", "英伟达股价大跌", lead, src), "", "没变");
  assert.equal(acceptTitle("涨了", "英伟达股价大跌", lead, src), "", "太短");
  assert.equal(acceptTitle("", "英伟达股价大跌", lead, src), "");
  const p = writePrompt([{ story: { title: "T", section: "markets", labels: [] }, mats: [{ id: "a", title: "x", summary: "y", source_id: "cls" }], bodies: new Map(), fresh: [], prevLead: "旧导语" }], LAYOUT);
  assert.match(p, /title：只对给了「上次导语」的报道写。事情的走向已经和原标题不符时/);
  assert.match(p, /"update":"","title":""/);
});
