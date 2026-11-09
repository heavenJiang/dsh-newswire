/* 外文标题译中文与跨语言归并、行情速览。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../engine/store/schema.mjs";
import { upsertSource } from "../../engine/store/db.mjs";
import { compileTaxonomy } from "../../engine/taxonomy.mjs";
import { clusterArticles } from "../../engine/pipeline/events.mjs";
import { compileNoise, matchNoise } from "../../engine/pipeline/quality.mjs";
import { upgradeTaxonomy } from "../../engine/config.mjs";
import { createModel } from "../../host/model.mjs";
import { translateTitles, plausibleLink } from "../../host/translate.mjs";
import { instrumentOf, tickerBoard, gatherItems } from "../../host/edition.mjs";

const CFG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config");
const TAXDOC = JSON.parse(fs.readFileSync(path.join(CFG, "taxonomy.json"), "utf8"));
const TAX = compileTaxonomy(TAXDOC);
const NOISE = compileNoise(TAXDOC.noise);
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function tmpDb() {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-v21-")), "n.sqlite"));
  for (const id of ["cls", "bbc"]) upsertSource(db, { id, name: id, type: "rss", url: "https://" + id }, iso(0));
  return db;
}
function art(db, id, title, src, msAgo, extra) {
  const t = iso(msAgo || 3600000);
  db.prepare("INSERT INTO articles (id, url, title, summary, source_id, first_seen_at, last_seen_at, published_at, time_confidence, kind, pack, completeness) VALUES (?,?,?,?,?,?,?,?,'feed',?, 'core','full')").run(id, "https://x/" + id, title, (extra && extra.summary) || "", src, t, t, t, (extra && extra.kind) || "news");
}
function fake(reply) {
  const calls = [];
  const llm = { stream(o) { const p = o.messages[0].content[0].text; calls.push(p); const r = reply(p); return (async function* () { yield { type: "text-delta", text: r }; yield { type: "finish", reason: { kind: "stop" } }; })(); } };
  return { m: createModel({ getLlm: () => llm, getDefault: () => ({ currentSelection: () => ({ provider: "f", model: "m" }) }) }), calls };
}

test("行情跳动：指数、收益率、金价、币价的单条涨跌归入 ticker；有内容的行情新闻不算", () => {
  const k = (title) => { const h = matchNoise(NOISE, { title, summary: "", source_id: "cls" }); return h && h.kind; };
  assert.equal(k("日经225指数期货早盘上涨1.1%"), "ticker");
  assert.equal(k("日本10年期国债收益率上升5.5个基点至2.69%"), "ticker");
  assert.equal(k("现货黄金向上触及4100美元/盎司，日内涨0.72%"), "ticker");
  assert.equal(k("BTC 跌破 74,000 美元，24 小时跌幅 2.32%"), "ticker");
  assert.equal(k("央行宣布降准0.5个百分点 释放长期资金约1万亿元"), null);
  assert.equal(k("恒指高开0.59%，报24625.71点；恒生科技指数涨1.02%。"), "ticker");
  // 实测误判过的：评论、带数字的统计新闻、正文里提到指数的标题，都不是行情跳动
  for (const t of ["机构：10月50城住宅平均租金环比下跌0.28%", "稳市政策持续加码 机构：A股震荡反弹行情有望延续", "早新闻｜这些重要消息将影响股市", "国家统计局：10月份居民消费价格同比上涨0.7%", "2026年我国能源投资总额或达9400亿美元"]) assert.equal(k(t), null, t);
  assert.equal(matchNoise(NOISE, { title: "早新闻｜这些重要消息将影响股市", summary: "恒生指数涨0.59%", source_id: "cls" }), null, "只看标题，不看正文");
  assert.equal(k("沙特首都遇袭"), null);
});

test("行情速览：每个品种只留最新一条", () => {
  assert.equal(instrumentOf("日经225指数涨幅扩大，现涨2.0%，最新报58586.45点"), "日经225指数");
  assert.equal(instrumentOf("美股纳指期货涨0.25%"), "纳指期货");
  assert.equal(instrumentOf("恒指高开0.59%，报24625.71点"), "恒生指数");
  assert.equal(instrumentOf("香港恒生指数开盘涨0.59%"), "恒生指数");
  assert.equal(instrumentOf("台湾证交所加权股价指数上涨4.1%至41,321.80点"), instrumentOf("台交所加权股价指数上涨3%至40,903.48点"));
  const db = tmpDb();
  art(db, "t1", "日经225指数上涨1.0%", "cls", 7200000, { kind: "ticker" });
  art(db, "t2", "日经225指数涨幅扩大至2.0%", "cls", 600000, { kind: "ticker" });
  art(db, "t3", "现货黄金报4112美元/盎司", "cls", 900000, { kind: "ticker" });
  const b = tickerBoard(db, { since: iso(12 * 3600000) });
  assert.deepEqual(b.map((x) => x.text), ["日经225指数涨幅扩大至2.0%", "现货黄金报4112美元/盎司"]);
  assert.equal(gatherItems(db, { pack: "core", since: iso(12 * 3600000), limit: 50 }).length, 0, "行情不进版面材料");
  db.close();
});

test("译标题：中文译名经核对后存下；编出原文没有的数字的不收；模型判的同一件事要字面上说得过去才记", async () => {
  const db = tmpDb();
  art(db, "z1", "沙特首都金融区遭袭，阿美石油公司大楼受损", "cls", 7200000);
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance) VALUES ('e1','core',?, 'z1', ?, ?, 1, 1, 70)").run("沙特首都金融区遭袭，阿美石油公司大楼受损", iso(7200000), iso(0));
  art(db, "en1", "Houthi attack damages Aramco building in Riyadh", "bbc", 1000000);
  art(db, "en2", "Collision of two trains in Egypt kills at least seven", "bbc", 2000000);
  art(db, "en3", "India’s night lights up for Diwali", "bbc", 3000000);
  art(db, "zh", "已经是中文的标题", "bbc");
  const { m, calls } = fake(() => JSON.stringify({ titles: [
    { n: 1, zh: "胡塞袭击致利雅得阿美大楼受损", same: "E1" },
    { n: 2, zh: "埃及两列火车相撞至少70人死亡", same: "" },
    { n: 3, zh: "印度夜空点亮庆祝排灯节", same: "E1" },
  ] }));
  const r = await translateTitles(db, m, { since: iso(12 * 3600000) });
  assert.deepEqual([r.tried, r.ok, r.rejected, r.linked], [3, 2, 1, 1]);
  const row = (id) => db.prepare("SELECT title_zh, link_to FROM articles WHERE id = ?").get(id);
  assert.deepEqual({ ...row("en1") }, { title_zh: "胡塞袭击致利雅得阿美大楼受损", link_to: "z1" });
  assert.equal(row("en2").title_zh, "", "70 人是编的：不收，也不再重试");
  assert.equal(row("en3").link_to, null, "牵强的同一件事不记");
  assert.match(calls[0], /E1 沙特首都金融区遭袭/);
  assert.ok(!calls[0].includes("已经是中文的标题"), "中文标题不送去译");
  assert.equal((await translateTitles(db, m, { since: iso(12 * 3600000) })).tried, 0, "译过的不再译");
  assert.ok(plausibleLink("埃及火车相撞4人死亡", "埃及卫生部：列车脱轨已造成4人死亡"));
  db.close();
});

test("聚类认模型判的同一件事：外文报道归入中文报道那件事，先处理哪条都一样；没有链接时外文与中文各自成事", () => {
  const run = (order, linked) => {
    const db = tmpDb();
    art(db, "z1", "沙特首都金融区遭袭，阿美石油公司大楼受损", "cls", 7200000);
    art(db, "en1", "Houthi attack damages Aramco building in Riyadh", "bbc", 3600000);
    db.prepare("UPDATE articles SET title_zh = '胡塞袭击致利雅得阿美大楼受损', link_to = ? WHERE id = 'en1'").run(linked ? "z1" : null);
    const rows = order.map((id) => db.prepare("SELECT id, title, title_zh, link_to, source_id, published_at, time_confidence, first_seen_at FROM articles WHERE id = ?").get(id));
    clusterArticles(db, rows, { runId: "r", nowIso: iso(0), tax: TAX, sources: new Map([["cls", {}], ["bbc", {}]]) });
    const ev = db.prepare("SELECT article_id, event_id, method FROM event_members ORDER BY article_id").all();
    db.close();
    return ev;
  };
  const a = run(["z1", "en1"], true);
  assert.equal(a[0].event_id, a[1].event_id);
  assert.equal(a.find((x) => x.article_id === "en1").method, "llm");
  const b = run(["en1", "z1"], true);
  assert.equal(b[0].event_id, b[1].event_id, "外文先处理也能归到一起");
  const c = run(["z1", "en1"], false);
  assert.notEqual(c[0].event_id, c[1].event_id);
});

test("内置噪声规则随种子更新（同 id 覆盖），用户自己的规则保留", () => {
  const old = { version: 4, labels: [], noise: [{ id: "market_ticks", name: "旧", kind: "ticker", all: ["指数", "涨"] }, { id: "mine", name: "我的", title: "^x" }] };
  const up = upgradeTaxonomy(old, TAXDOC).doc;
  assert.ok(up.noise.find((r) => r.id === "market_ticks").title_all, "旧的内置规则被新版替换");
  assert.ok(up.noise.find((r) => r.id === "mine"));
});
