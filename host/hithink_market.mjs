/** 同花顺公开 REST 接入。沿用用户级凭据，服务端独占 API Key。 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hour12: false });
const n = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const timeOf = (ms) => n(ms) > 0 && Number(ms) <= 8.64e15 ? formatter.format(new Date(Number(ms))) : null;

async function installedKey() {
  if (process.env.HITHINK_FINANCE_API_KEY?.trim()) return process.env.HITHINK_FINANCE_API_KEY.trim();
  const home = os.homedir();
  const dir = process.platform === "darwin" ? path.join(home, "Library/Application Support") :
    process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData/Roaming") : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  try {
    const file = await readFile(path.join(dir, "hithink-finance", "credentials.env"), "utf8");
    const entry = /^\s*(?:export\s+)?HITHINK_FINANCE_API_KEY\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(file);
    if (entry) return entry[1] || entry[2] || entry[3];
  } catch { /* 可使用兼容变量 */ }
  return process.env.FUYAO_TOKEN?.trim() || null;
}

const toThs = (code) => code.slice(2) + "." + code.slice(0, 2).toUpperCase();
function quoteOf(row, timestamp) {
  const at = timeOf(row?.timestamp || timestamp);
  const price = n(row?.last_price);
  if (!at || !(price > 0) || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(row.thscode)) return null;
  return {
    code: row.thscode.slice(0, 6), name: row.name || null, at, price, priorClose: n(row.prev_price), open: n(row.open_price),
    change: n(row.price_change_ratio_pct), high: n(row.high_price), low: n(row.low_price), volume: n(row.volume),
    amount: n(row.turnover), turnover: null, state: n(row.open_price) > 0 && n(row.volume) > 0 ? "traded" : "no_trade", source: "Hithink",
  };
}

export function createHithinkMarket({ fetcher = fetch, key = installedKey } = {}) {
  let pauseUntil = 0;
  let hotListCache = null, industryCatalog = null;
  async function request(endpoint, params, signal) {
    if (Date.now() < pauseUntil) throw new Error("hithink_backoff");
    const token = await key();
    if (!token) { pauseUntil = Date.now() + 60000; throw new Error("hithink_not_configured"); }
    const url = new URL("https://fuyao.aicubes.cn/api/" + endpoint);
    url.search = new URLSearchParams(params);
    const response = await fetcher(url, { headers: { "X-api-key": token }, signal: signal || AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) pauseUntil = Date.now() + 60000;
      throw new Error("hithink_http_" + response.status);
    }
    const result = await response.json();
    if (result.code !== 0 || !result.data) {
      if ([2001, 2003, 4001].includes(result.code)) pauseUntil = Date.now() + 60000;
      throw new Error("hithink_data_unavailable");
    }
    return result.data;
  }
  async function quotes(symbols, index = false) {
    const data = await request((index ? "a-share-index" : "a-share") + "/prices/snapshot", { thscodes: symbols.map(toThs).join(",") });
    const result = {};
    const routes = new Map(symbols.map((code) => [toThs(code), code]));
    for (const row of data.item || []) {
      const symbol = routes.get(row.thscode);
      const quote = quoteOf(row, data.timestamp);
      if (symbol && quote) result[symbol] = quote;
    }
    return result;
  }
  async function history(symbol, now, index) {
    const data = await request((index ? "a-share-index" : "a-share") + "/prices/historical", {
      thscode: toThs(symbol), interval: "1d", start: String(now - 1000 * 86400000), end: String(now), ...(index ? {} : { adjust: "forward" }),
    });
    const bars = new Map();
    for (const row of data.item || []) {
      const date = timeOf(row.date_ms)?.slice(0, 10);
      const close = n(row.close_price);
      if (date && close > 0) bars.set(date, { date, close, open: n(row.open_price), high: n(row.high_price), low: n(row.low_price), volume: n(row.volume) });
    }
    return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  async function universe() {
    const signal = AbortSignal.timeout(26000);
    const page = async (limit, offset) => request("a-share/prices/snapshot", { limit: String(limit), offset: String(offset) }, signal);
    const first = await page(200, 0);
    if (!Number.isInteger(first.total) || first.total < 1 || !Array.isArray(first.item) || !first.item.length) throw new Error("hithink_empty_universe");
    const size = first.item.length;
    const rows = new Map();
    let pageAsOf = null;
    const add = (result) => {
      const stamp = timeOf(result.timestamp);
      if (!stamp || !Array.isArray(result.item)) return;
      if (pageAsOf && stamp.slice(0, 10) !== pageAsOf.slice(0, 10)) return;
      if (!pageAsOf || stamp > pageAsOf) pageAsOf = stamp;
      for (const it of result.item) if (it.thscode) rows.set(it.thscode, quoteOf(it, result.timestamp));
    };
    add(first);
    let next = size;
    async function worker() {
      while (next < first.total && !signal.aborted && Date.now() >= pauseUntil) {
        const offset = next;
        next += size;
        try { add(await page(size, offset)); } catch { /* 缺页由上层切换数据源 */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, Math.ceil(first.total / size) - 1) }, worker));
    return { asOf: pageAsOf, total: first.total, received: rows.size, quotes: [...rows.values()].filter(Boolean) };
  }
  function hotList() {
    if (hotListCache?.until > Date.now()) return hotListCache.promise;
    const promise = request("a-share/special-data/hot-stock-list", { period: "day" }).catch((err) => {
      hotListCache = null;
      throw err;
    });
    hotListCache = { promise, until: Date.now() + 180000 };
    return promise;
  }
  async function industries() {
    if (!industryCatalog || industryCatalog.until <= Date.now()) {
      const catalog = await request("a-share-index/catalog/ths-index-list", { tag: "industry" });
      const symbols = (catalog.item || []).filter((r) => /^\d{6}\.TI$/.test(r.thscode) && r.name);
      if (!symbols.length) throw new Error("hithink_industries_unavailable");
      industryCatalog = { until: Date.now() + 3600000, symbols };
    }
    const names = new Map(industryCatalog.symbols.map((r) => [r.thscode, r.name]));
    const snapshots = await request("a-share-index/prices/snapshot", { thscodes: [...names.keys()].join(",") });
    const asOf = timeOf(snapshots.timestamp);
    const rows = (snapshots.item || []).flatMap((r) => {
      const name = names.get(r.thscode), change = n(r.price_change_ratio_pct);
      return name && change != null ? [{ name, median: change, up: null, count: null, amount: n(r.turnover) }] : [];
    }).sort((a, b) => b.median - a.median);
    return asOf && rows.length ? { source: "Hithink", leaders: rows.slice(0, 6), laggards: rows.slice(-6).reverse(), day: asOf.slice(0, 10) } : null;
  }
  async function heat(symbol, now) {
    const [rank, list] = await Promise.allSettled([
      request("a-share/special-data/hot-stock-rank-trend", { thscode: toThs(symbol), start_date: timeOf(now - 6 * 86400000).slice(0, 10), end_date: timeOf(now).slice(0, 10) }),
      hotList(),
    ]);
    const trend = (rank.value?.item || []).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && n(r.rank) > 0)
      .map((r) => ({ date: r.date, rank: Number(r.rank) })).sort((a, b) => a.date.localeCompare(b.date));
    const top = list.value?.item?.find((r) => r.thscode === toThs(symbol));
    if (!trend.length && !top && list.status === "rejected") throw new Error("hithink_heat_unavailable");
    return { source: "Hithink", asOf: timeOf(list.value?.timestamp), trend, rank: n(top?.rank), heat: top?.heat == null ? null : String(top.heat),
      inTop30: list.status === "fulfilled" ? Boolean(top) : null, route: "api" };
  }
  async function limits(date) {
    const dateMs = Date.parse(date + "T00:00:00+08:00");
    if (!Number.isFinite(dateMs)) return {};
    const pools = { upLimit: "limit-up-pool", downLimit: "limit-down-pool", failedLimit: "limit-break-pool" };
    const calls = await Promise.allSettled(Object.entries(pools).map(async ([key, name]) => {
      const result = await request("a-share/special-data/" + name, { date_ms: String(dateMs), page: "1", size: "1" });
      const count = n(result.pagination?.total);
      return [key, count !== null && count >= 0 ? count : null];
    }));
    return Object.fromEntries(calls.filter((x) => x.status === "fulfilled").map((x) => x.value));
  }
  return { quotes, history, universe, heat, industries, limits };
}
