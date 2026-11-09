/* 模型读页面（「不限」档）：模型只能用页面上的链接编号，标题与时间照抄页面，程序逐条核对。 */
import test from "node:test";
import assert from "node:assert/strict";
import { verifyRead, parseReadOutput, readSource, readTargets } from "../../host/modelread.mjs";
import { DEPTHS, makeGate } from "../../host/runtime.mjs";

const snap = {
  ok: true, url: "https://example.com/kx", page_url: "https://example.com/kx", title: "快讯",
  text: "快讯\n06:21\n【1】伊朗称美取消制裁和停止战争是谈判前提\n【2】人民财讯11月9日电，伊朗外交部发言人表示，美国取消制裁是启动谈判的前提。（央视新闻）\n【3】\n06:16\n【4】恒坤新材：董事长提议回购股份\n〈时间 2026-11-09T06:16:00.000Z〉\n公司拟以5000万元回购股份，用于股权激励。\n",
  links: [{ n: 1, href: "https://example.com/a/1", text: "伊朗称美取消制裁和停止战争是谈判前提" }, { n: 2, href: "https://example.com/a/1", text: "" }, { n: 3, href: "https://example.com/kx", text: "" }, { n: 4, href: "https://example.com/a/2", text: "恒坤新材：董事长提议回购股份" }, { n: 5, href: "https://example.com/a/3", text: "" }],
  times: ["2026-11-09T06:16:00.000Z"],
};

test("核对：链接编号必须存在、标题必须在页面上、时间取自页面，摘要从原文截取", () => {
  const v = verifyRead(snap, [
    ["伊朗称美取消制裁和停止战争是谈判前提", 1, "06:21"],
    ["恒坤新材：董事长提议回购股份", 4, "2026-11-09T06:16:00.000Z"],
    ["编造的一条新闻标题在页面上没有", 5, ""],
    ["伊朗称美取消制裁和停止战争是谈判前提", 99, ""],
    ["伊朗称美取消制裁和停止战争是谈判前提", 3, ""],
    ["恒坤新材：董事长提议回购股份", 4, "2026-11-10T00:00:00.000Z"],
  ], 10);
  assert.equal(v.items.length, 2);
  assert.equal(v.items[0].link, "https://example.com/a/1");
  assert.equal(v.items[0].published_raw, "06:21");
  assert.match(v.items[0].summary, /^人民财讯11月9日电/);
  assert.equal(v.items[1].published_at, "2026-11-09T06:16:00.000Z");
  assert.equal(v.why.title_not_on_page, 1, "编造的标题");
  assert.equal(v.why.bad_link, 2, "不存在的编号、指回列表页本身");
  assert.equal(v.why.dup_link, 1);
});

test("页面上没有的 ISO 时间不用", () => {
  const v = verifyRead(snap, [["恒坤新材：董事长提议回购股份", 4, "2026-11-10T00:00:00.000Z"]], 10);
  assert.equal(v.items[0].published_at, "");
  assert.equal(v.items[0].published_raw, "");
});

test("输出被截断时逐条捞出完整的条目", () => {
  const cut = '{"items":[["第一条标题",1,"06:21"],["第二条标题",4,""],["第三条没写完",';
  assert.deepEqual(parseReadOutput(cut), [["第一条标题", 1, "06:21"], ["第二条标题", 4, ""]]);
  assert.deepEqual(parseReadOutput('{"items":[["a",1,""]]}'), [["a", 1, ""]]);
  assert.equal(parseReadOutput("没有 JSON"), null);
});

test("读一个源：快照失败不调用模型；读出来的经过核对", async () => {
  let calls = 0;
  const bad = await readSource({ read: async () => ({ ok: false }), model: { complete: async () => { calls++; return ""; } } }, { url: "u" });
  assert.equal(bad.ok, false);
  assert.equal(calls, 0);
  const good = await readSource({ read: async () => snap, model: { complete: async () => '{"items":[["伊朗称美取消制裁和停止战争是谈判前提",1,"06:21"],["瞎编的",4,""]]}' } }, { url: snap.url, name: "快讯" });
  assert.equal(good.ok, true);
  assert.equal(good.items.length, 1);
  assert.equal(good.dropped, 1);
});

test("哪些源让模型读：网页类，不含 RSS、接口、专用适配器和停用的", () => {
  const ids = readTargets([
    { id: "a", type: "html_index", weight: 0.9 }, { id: "b", type: "rss" }, { id: "c", type: "cls_api" }, { id: "d", type: "html_index", adapter: "jiemian" },
    { id: "e", type: "html_index", enabled: false }, { id: "f", type: "html_index", extract: { item: "article" }, trial: true }, { id: "g", type: "html_index", pack: "study_abroad" },
  ], { packs: "core" }).map((s) => s.id);
  assert.deepEqual(ids, ["a", "f"]);
});

test("「不限」档：模型读页面，且不受每日 token 预算限制", () => {
  assert.equal(DEPTHS.full.modelRead, true);
  const gate = makeGate(() => null, () => ({ depth: "full", daily_tokens: 1 }));
  assert.equal(gate(), null);
});
