import assert from "node:assert/strict";
import { test } from "node:test";
import { renderJob } from "../../engine/channels/browse.mjs";
import { createHithinkMarket } from "../../host/hithink_market.mjs";
import { openDb } from "../../engine/store/schema.mjs";
import { aShareSymbol, communitySentiment, createStockResearch, explainStockScenarios, marketSnapshot, parseAnnouncements, researchForecast, verifyForecast } from "../../host/stock_research.mjs";

function series(n = 660) {
  const index = [], asset = [];
  for (let ms = Date.UTC(2023, 0, 1); index.length < n; ms += 86400000) {
    if ([0, 6].includes(new Date(ms).getUTCDay())) continue;
    const i = index.length, date = new Date(ms).toISOString().slice(0, 10);
    const close = 20 + i * 0.017 + Math.sin(i / 6) + Math.cos(i / 23) * 3;
    index.push({ date, close: 3000 + i + Math.sin(i / 13) * 160 });
    asset.push({ date, close, high: close * 1.02, low: close * 0.98, volume: 400 + i % 100 });
  }
  return { index, asset };
}
const toMs = (date, time = "16:30:00") => Date.parse(date + "T" + time + "+08:00");

test("证券标识只接受合法板块与交易所，公告代码和域名均核对", () => {
  assert.deepEqual(aShareSymbol("600519.sh"), { code: "600519", exchange: "SH", provider: "sh600519" });
  assert.equal(aShareSymbol("920992").exchange, "BJ");
  assert.equal(aShareSymbol("600519.SZ"), null);
  assert.equal(aShareSymbol("000300.SH"), null);
  assert.equal(aShareSymbol("NVDA"), null);
  assert.deepEqual(parseAnnouncements({ announcements: [
    { secCode: "600519", announcementTitle: "<em>公告</em>", announcementId: 1, adjunctUrl: "finalpage/1.pdf", announcementTime: toMs("2026-11-23") },
    { secCode: "600519", announcementTitle: "假链接", adjunctUrl: "https://cninfo.com.cn.example.test/x.pdf" },
    { secCode: "000001", announcementTitle: "其他公告", adjunctUrl: "finalpage/2.pdf" },
  ] }, "600519"), [{ id: "1", title: "公告", at: "2026-11-23", url: "https://static.cninfo.com.cn/finalpage/1.pdf" }]);
});

test("市场只统计快照同日有成交的 A 股，分页缺失显式报告", () => {
  const now = toMs("2026-11-23");
  const row = (code, change, amount, seconds = now / 1000) => ({ f12: code, f2: 10, f3: change, f6: amount, f20: 100, f100: "设备", f124: seconds });
  const market = marketSnapshot([row("600519", 2, 12), row("000001", -1, 9), row("000002", 0, 0), row("000003", 3, 4, now / 1000 - 86400)], 6);
  assert.equal(market.received, 4);
  assert.equal(market.complete, false);
  assert.deepEqual([market.stats.count, market.stats.up, market.stats.down, market.stats.amount, market.stats.median], [2, 1, 1, 21, 0.5]);
});

test("社区分类只对日期内原生个人帖按用户去重，资讯和引用不参与", () => {
  const post = (fields) => ({ stockbar_code: "600519", post_type: 0, user_id: "a", post_publish_time: "2026-11-23 11:00:00", post_title: "继续上涨", ...fields });
  const html = "var article_list=" + JSON.stringify({ re: [
    post({ post_publish_time: "2026-11-23 09:00:00" }), post({ post_title: "继续下跌" }),
    post({ user_id: "b", post_title: "看多吗？" }), post({ user_id: "c", post_type: 1 }),
    post({ user_id: "d", post_source_id: "article" }), post({ user_id: "e", post_publish_time: "2026-11-10 11:00:00" }),
  ] }) + "; var next = [];";
  const x = communitySentiment(html, "600519", toMs("2026-11-23"));
  assert.deepEqual([x.sample, x.authors, x.bullish, x.bearish, x.unclassified], [3, 2, 0, 1, 1]);
  assert.equal(communitySentiment("<html>unavailable</html>", "600519", toMs("2026-11-23")), null);
});

test("5/20 个交易日预测锚定已完成收盘，日后补写验证但保留原区间", () => {
  const { asset, index } = series();
  const cut = 630, date = index[cut - 1].date, intraday = index[cut].date;
  const quote = { at: intraday + " 10:30:00", price: 99, priorClose: 31, state: "traded" };
  const f = researchForecast(asset.slice(0, cut + 1), index.slice(0, cut + 1), quote, toMs(intraday, "10:30:00"));
  assert.equal(f.status, "ready");
  assert.equal(f.date, date);
  assert.equal(f.baseline, 31);
  assert.deepEqual(f.horizons.map((h) => h.horizon), [5, 20]);
  assert.deepEqual(verifyForecast(f, asset.slice(0, cut + 1), index.slice(0, cut + 1), toMs(intraday, "10:30:00")), f);
  const f2 = verifyForecast(f, asset, index, toMs(index.at(-1).date));
  assert.equal(f2.horizons[0].observed.date, index[cut + 4].date);
  assert.equal(f2.horizons[1].observed.date, index[cut + 19].date);
  assert.equal(f2.horizons[0].observed.state, "complete");
  assert.deepEqual(f2.horizons.map((h) => h.scenarios), f.horizons.map((h) => h.scenarios));
});

test("个股解释只引用公告及媒体材料，程序区间不交给模型修改", async () => {
  const data = { symbol: { code: "600519", name: "示例" }, quote: null, forecast: { date: "2026-11-23" }, community: { data: { token: "SENTIMENT_ONLY" } },
    announcements: { data: [{ id: "a", title: "关于召开股东大会的公告", url: "https://www.cninfo.com.cn/example" }] }, news: [] };
  const model = { complete: async (prompt) => {
    assert.doesNotMatch(prompt, /SENTIMENT_ONLY/);
    return JSON.stringify({ overview: "尚需等待披露", scenarios: [{ name: "base", trigger: "等待会议决议", invalidation: "会议取消", refs: [1, 99] },
      { name: "strong", trigger: "涨幅99%", invalidation: "会议取消", refs: [1] }] });
  } };
  const explanation = await explainStockScenarios(data, model, 1000);
  assert.deepEqual(explanation.scenarios.map((s) => s.name), ["base"]);
  assert.equal(explanation.scenarios[0].refs.length, 1);
});

test("个股服务支持名称搜索、合法标的和本地预测持久化", async () => {
  const { index, asset } = series();
  const date = index.at(-1).date;
  const db = openDb(":memory:");
  const fields = Array(50).fill("");
  Object.assign(fields, { 1: "示例股份", 2: "600519", 3: "30", 4: "29", 5: "29", 6: "100", 30: date.replaceAll("-", "") + "150000", 32: "2" });
  const json = (value) => new Response(JSON.stringify(value));
  const fetcher = async (value, opts) => {
    const url = new URL(value);
    if (url.host === "qt.gtimg.cn") return new Response("v_sh600519=\"" + fields.map((f) => f === "示例股份" ? "Company" : f).join("~") + "\";");
    if (url.host === "web.ifzq.gtimg.cn") {
      const code = url.searchParams.get("param").split(",")[0];
      return json({ data: { [code]: { qfqday: (code === "sh000300" ? index : asset).map((b) => [b.date, b.open, b.close, b.high, b.low, b.volume]) } } });
    }
    if (url.pathname.endsWith("szse_stock.json")) return json({ stockList: [{ code: "600519", category: "A股", orgId: "org", zwjc: "示例股份" }] });
    if (url.host === "www.cninfo.com.cn") {
      assert.equal(opts.body.get("stock"), "600519,org");
      return json({ announcements: [] });
    }
    return new Response("var article_list={\"re\":[]};");
  };
  const app = createStockResearch({ fetcher, withDb: (fn) => fn(db), now: () => toMs(date) });
  assert.deepEqual(await app.search("示例"), [{ code: "600519", name: "示例股份" }]);
  const item = await app.stock("600519");
  assert.equal(item.forecast.status, "ready");
  assert.equal(item.announcements.ok, true);
  assert.equal(item.community.data.sample, 0);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM kv WHERE key = ?").get("stock-research:forecast:sh600519").value).forecasts.length, 1);
  db.close();
});

test("同花顺行情与日线优先，雪球只用于独立情绪", async () => {
  const { index, asset } = series();
  const date = index.at(-1).date, at = date + " 15:00:00", now = toMs(date);
  let quoteFallback = 0, historyFallback = 0, browseCalls = 0;
  const quote = { source: "Hithink", at, price: 30, priorClose: 29, change: 1, state: "traded" };
  const fetcher = async (value) => {
    const url = new URL(value);
    if (url.host === "qt.gtimg.cn") { quoteFallback++; throw new Error("unexpected secondary"); }
    if (url.host === "web.ifzq.gtimg.cn") { historyFallback++; throw new Error("unexpected secondary"); }
    return new Response(url.pathname.endsWith("szse_stock.json")
      ? JSON.stringify({ stockList: [{ code: "600519", category: "A股", orgId: "x", zwjc: "样例" }] }) : "{}");
  };
  const primary = {
    quotes: async () => ({ sh600519: quote }),
    history: async (code) => code === "sh000300" ? index : asset,
    heat: async () => ({ route: "api", inTop30: true, rank: 10 }),
  };
  const xueqiuBrowse = async () => { browseCalls++; return { ok: true, items: [{ author: 1, text: "看多", at: now }] }; };
  const service = createStockResearch({ fetcher, withDb: (fn) => fn(null), now: () => now, primary, xueqiuBrowse });
  const item = await service.stock("600519");
  assert.equal(item.quote.source, "Hithink");
  assert.equal(item.forecast.historySource, "Hithink");
  assert.equal(browseCalls, 0, "行情不依赖浏览器情绪");
  assert.equal(quoteFallback, 0);
  assert.equal(historyFallback, 0);
  const sentiment = await service.sentiment("600519");
  assert.equal(sentiment.xueqiu.data.route, "browse");
  assert.equal(sentiment.xueqiu.data.bullish, 1);
  assert.equal(sentiment.hithink.data.rank, 10);
  assert.equal("bullish" in sentiment.hithink.data, false);
  await service.sentiment("600519");
  assert.equal(browseCalls, 1);
});

test("同花顺过期或缺项时按标的回退，其他指数维持首选接口", async () => {
  const date = "2026-11-23", now = toMs(date, "10:30:00");
  const rows = Array(50).fill("");
  Object.assign(rows, { 1: "Index", 2: "000001", 3: "3000", 4: "2990", 5: "2990", 6: "100", 30: "20261123103000", 32: "0.3" });
  const fetcher = async (value) => {
    const u = new URL(value);
    if (u.host === "qt.gtimg.cn") {
      assert.equal(u.pathname, "/q=sh000001,sz399001,sz399006");
      return new Response("v_sh000001=\"" + rows.join("~") + "\";");
    }
    throw new Error("no public fixture");
  };
  const primary = {
    universe: async () => ({ asOf: date + " 10:30:00", total: 1, received: 1, quotes: [{ at: date + " 10:30:00", state: "traded", change: 2, amount: 100 }] }),
    quotes: async () => ({ sh000300: { at: date + " 10:29:00", source: "Hithink", change: 2 }, sh000001: { at: "2026-11-20 15:00:00", source: "Hithink", change: 0 } }),
    industries: async () => null,
    limits: async () => ({ upLimit: 1, downLimit: 2, failedLimit: 3 }),
  };
  const service = createStockResearch({ fetcher, withDb: (fn) => fn(null), now: () => now, primary });
  const market = await service.overview();
  assert.equal(market.market.source, "Hithink");
  assert.equal(market.indices.sh000300.source, "Hithink");
  assert.equal(market.indices.sh000001.source, "Tencent Finance");
  assert.deepEqual(market.limits, { upLimit: 1, downLimit: 2, failedLimit: 3 });
});

test("同花顺 REST 根据信封和字段取数，认证只放在供应商请求头", async () => {
  const at = toMs("2026-11-23");
  const visited = [];
  const api = createHithinkMarket({ key: async () => "test-secret", fetcher: async (url, opts) => {
    visited.push(url.pathname);
    assert.equal(url.origin, "https://fuyao.aicubes.cn");
    assert.equal(opts.headers["X-api-key"], "test-secret");
    assert.doesNotMatch(url.href, /test-secret/);
    if (url.pathname.endsWith("historical")) {
      assert.equal(url.searchParams.get("adjust"), "forward");
      return new Response(JSON.stringify({ code: 0, data: { item: [{ date_ms: at, close_price: 50, volume: 300 }] } }));
    }
    return new Response(JSON.stringify({ code: 0, data: { timestamp: at, item: [
      { thscode: "600519.SH", last_price: 50, price_change_ratio_pct: 1, open_price: 49, volume: 300 },
    ] } }));
  } });
  assert.equal((await api.quotes(["sh600519"])).sh600519.source, "Hithink");
  assert.equal((await api.history("sh600519", at, false))[0].date, "2026-11-23");
  assert.deepEqual(visited, ["/api/a-share/prices/snapshot", "/api/a-share/prices/historical"]);
});

test("雪球 Browse 支持 www 站点并只返回匿名个人评论样本", async () => {
  const rows = [
    { id: 1, user: { id: 120 }, created_at: Date.now() - 15000, description: "看多" },
    { id: 2, user: { id: 120 }, created_at: Date.now() - 10000, description: "<p>继续上涨</p>" },
    { id: 3, user: { id: 130 }, created_at: Date.now() - 5000, description: "转帖", retweet_status_id: 15 },
    { id: 4, user: { id: 140 }, created_at: Date.now() - 5000, description: "新闻", type: "news" },
    { id: 5, user: { id: 150 }, created_at: Date.now() - 5000, description: "【公司公告】采购事项" },
  ];
  const page = {
    goto: async () => {},
    evaluate: async (fn, arg) => {
      const { runInNewContext } = await import("node:vm");
      return runInNewContext("(" + fn.toString() + ")(arg)", {
        arg, URL, URLSearchParams, AbortSignal, location: { hostname: "www.xueqiu.com" }, document: { title: "雪球" },
        fetch: async (url) => { assert.match(url, /symbol=SH600519/); return { ok: true, json: async () => ({ list: rows }) }; },
      });
    },
    url: () => "https://www.xueqiu.com/S/SH600519", title: () => "雪球",
  };
  let gathered;
  const files = { async write(_name, json) { gathered = JSON.parse(json); return "/tmp/fake"; } };
  const code = renderJob("xueqiu-discussions", "https://www.xueqiu.com/S/SH600519", 20, {});
  await new Function("page", "files", "return (async () => {" + code + "})();")(page, files);
  assert.equal(gathered.items.length, 2);
  assert.equal(gathered.items[0].author, 1);
  assert.equal(gathered.items[1].author, 1);
  assert.equal("user" in gathered.items[0], false);
});
