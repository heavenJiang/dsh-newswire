/* 插件自己的时钟：五段 cron 的解析、到点判断与下一次。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextCron } from "../../host/clock.mjs";

const bj = (s) => new Date(s + "+08:00");

test("解析：常见写法与写错的", () => {
  assert.ok(parseCron("0 7-21/2 * * *"));
  assert.ok(parseCron("0 8,12,16,20 * * *"));
  assert.ok(parseCron("30 21 * * 1-5"));
  assert.equal(parseCron("0 25 * * *"), null);
  assert.equal(parseCron("0 8 * *"), null);
  assert.equal(parseCron("x 8 * * *"), null);
  assert.deepEqual([...parseCron("0 7-21/2 * * *").hour], [7, 9, 11, 13, 15, 17, 19, 21]);
});

test("到点：按北京时间的墙上时间", () => {
  assert.ok(cronMatches("0 7-21/2 * * *", bj("2026-11-11T09:00:00"), "Asia/Shanghai"));
  assert.ok(!cronMatches("0 7-21/2 * * *", bj("2026-11-11T08:00:00"), "Asia/Shanghai"));
  assert.ok(!cronMatches("0 7-21/2 * * *", bj("2026-11-11T09:01:00"), "Asia/Shanghai"));
  assert.ok(cronMatches("0 9 * * *", new Date("2026-11-11T01:00:00Z"), "Asia/Shanghai"), "UTC 01:00 是北京 09:00");
  // 周：2026-11-11 是周三；0 与 7 都是周日（11-15）
  assert.ok(cronMatches("0 9 * * 3", bj("2026-11-11T09:00:00"), "Asia/Shanghai"));
  assert.ok(cronMatches("0 9 * * 7", bj("2026-11-15T09:00:00"), "Asia/Shanghai"));
  // 日和周都限定时满足其一
  assert.ok(cronMatches("0 9 1 * 3", bj("2026-11-11T09:00:00"), "Asia/Shanghai"));
});

test("下一次：不含当前这一分钟，跨天", () => {
  assert.equal(nextCron("0 8,12,18 * * *", "Asia/Shanghai", bj("2026-11-11T12:00:00")).toISOString(), "2026-11-11T10:00:00.000Z");
  assert.equal(nextCron("0 8,12,18 * * *", "Asia/Shanghai", bj("2026-11-11T19:30:00")).toISOString(), "2026-11-12T00:00:00.000Z");
  assert.equal(nextCron("bad", "Asia/Shanghai", Date.now()), null);
});

test("提前量：平时按中位数，一轮写得完就不提前；隔夜按最慢的那份、至少 25 分钟、最多一小时", async () => {
  const { prewarmLead } = await import("../../host/clock.mjs");
  const M = 60000;
  assert.equal(prewarmLead({ ms: [3 * M, 4 * M, 5 * M], budgetMs: 9 * M, gapHours: 2 }), 0, "4+3 分钟在预算内");
  assert.equal(prewarmLead({ ms: [5 * M, 6.5 * M, 21 * M], budgetMs: 9 * M, gapHours: 2 }), 11.5 * M, "中位数 6.5 + 5");
  assert.equal(prewarmLead({ ms: [5 * M, 6.5 * M, 21 * M], budgetMs: 9 * M, gapHours: 9 }), 26 * M, "隔夜：最慢的 21 + 5");
  assert.equal(prewarmLead({ ms: [3 * M], budgetMs: 9 * M, gapHours: 9 }), 25 * M, "隔夜至少 25 分钟");
  assert.equal(prewarmLead({ ms: [70 * M], budgetMs: 9 * M, gapHours: 9 }), 60 * M, "最多一小时");
  assert.equal(prewarmLead({ ms: [], budgetMs: 9 * M, gapHours: 0 }), 20 * M, "没有记录按 15 分钟估");
});

test("往回找错过的整点：75 分钟内有就返回那一刻，没有返回 null", async () => {
  const { prevCron } = await import("../../host/clock.mjs");
  const cron = "0 7-21/2 * * *";
  const at = (s) => new Date(s);
  // 北京时间 09:23 → 错过的是 09:00（UTC 01:00）
  assert.equal(prevCron(cron, "Asia/Shanghai", at("2026-11-12T01:23:30Z"), 75).toISOString(), "2026-11-12T01:00:00.000Z");
  assert.equal(prevCron(cron, "Asia/Shanghai", at("2026-11-12T02:20:00Z"), 75), null, "10:20 离 09:00 超过 75 分钟：等 11 点");
  assert.equal(prevCron(cron, "Asia/Shanghai", at("2026-11-12T01:00:20Z"), 75), null, "正在整点这一分钟：不算错过");
  assert.equal(prevCron(cron, "Asia/Shanghai", at("2026-11-11T15:30:00Z"), 75), null, "夜里 23:30：21 点之后没有整点");
  assert.equal(prevCron("bad", "Asia/Shanghai", at("2026-11-12T01:23:00Z"), 75), null);
});
