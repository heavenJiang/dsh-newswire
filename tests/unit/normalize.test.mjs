import { test } from "node:test";
import assert from "node:assert/strict";
import { toRecord, titleFromText } from "../../engine/pipeline/normalize.mjs";

const SRC = { id: "s", category: "c", region: "CN", lang: "zh", pack: "core" };

test("无标题快讯从正文首句取标题，去掉电头", () => {
  assert.equal(titleFromText("财联社11月8日电，UPS正寻求收购澳大利亚物流公司Smartways，交易对价约6亿澳元。"), "UPS正寻求收购澳大利亚物流公司Smartways，交易对价约6亿澳元");
  const r = toRecord({ title: "", link: "https://www.cls.cn/detail/1", summary: "财联社11月8日电，央行开展1000亿元逆回购操作。", published_at: "2026-11-08T07:00:00Z" }, SRC, { index: 0, nowMs: Date.now() });
  assert.equal(r.title, "央行开展1000亿元逆回购操作");
});

test("时间可信度：feed / page_text / fetched", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const a = toRecord({ title: "有源头时间的新闻标题", link: "https://a.example/1", published_at: "2026-11-08T07:00:00Z" }, SRC, { index: 0, nowMs: now });
  assert.equal(a.time_confidence, "feed");
  const b = toRecord({ title: "列表上写了几点的新闻", link: "https://a.example/2", published_raw: "3小时前" }, SRC, { index: 1, nowMs: now });
  assert.equal(b.time_confidence, "page_text");
  assert.equal(b.published_at, "2026-11-08 09:00:00");
  const c = toRecord({ title: "完全没有时间的新闻标题", link: "https://a.example/3" }, SRC, { index: 2, nowMs: now });
  assert.equal(c.time_confidence, "fetched");
  assert.equal(c.published_at, null);
});

test("过滤：非 http、广告链接、url_include、垃圾标题", () => {
  assert.equal(toRecord({ title: "正常标题足够长", link: "javascript:void(0)" }, SRC, { index: 0 }).skip, "bad_url");
  assert.equal(toRecord({ title: "正常标题足够长", link: "https://a.example/ads/1" }, SRC, { index: 0 }).skip, "ad_url");
  assert.equal(toRecord({ title: "正常标题足够长", link: "https://a.example/x" }, Object.assign({}, SRC, { url_include: "/news/" }), { index: 0 }).skip, "url_include");
  assert.equal(toRecord({ title: "12:30 · · 2026", link: "https://a.example/y" }, SRC, { index: 0 }).skip, "junk_title");
});

test("去重键与追踪参数无关", () => {
  const a = toRecord({ title: "同一条新闻", link: "https://a.example/n/1?utm_source=x" }, SRC, { index: 0 });
  const b = toRecord({ title: "同一条新闻", link: "https://a.example/n/1" }, SRC, { index: 0 });
  assert.equal(a.id, b.id);
});
