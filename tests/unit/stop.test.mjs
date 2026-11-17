import { test } from "node:test";
import assert from "node:assert/strict";
import { createStopper, isStopped } from "../../host/stop.mjs";
import { createModel } from "../../host/model.mjs";
import { createQueue } from "../../host/queue.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("stop reaches work inside a round, including work it left in the background; outside work is untouched", async () => {
  const st = createStopper();
  let bg = null;
  await st.run(async () => { bg = (async () => { await sleep(20); return st.stopped(); })(); });
  const outside = st.signal();
  st.stop("test");
  assert.equal(await bg, true);
  assert.equal(outside, null);
  // a round started after the stop is a new generation
  assert.equal(await st.run(async () => st.stopped()), false);
  assert.throws(() => st.run(() => { st.stop(); st.check(); }), (e) => isStopped(e));
});

function slowLlm(calls) {
  return {
    stream(opts) {
      calls.push(opts);
      return (async function* () {
        for (let i = 0; i < 100; i++) { if (opts.signal.aborted) throw opts.signal.reason; await sleep(10); }
        yield { type: "text-delta", text: "ok" };
      })();
    },
  };
}

test("a stopped round cancels its running model call and the ones waiting for a slot", async () => {
  const st = createStopper();
  const q = createQueue({ slots: () => 1 });
  const calls = [];
  const model = createModel({ getLlm: () => slowLlm(calls), provider: "f", model: "m", slot: (s) => q.acquire(s), stopSignal: () => st.signal() });
  const results = st.run(() => Promise.allSettled([model.complete("a"), model.complete("b")]));
  await sleep(30);
  st.stop("test");
  const [a, b] = await results;
  assert.equal(a.status, "rejected");
  assert.ok(isStopped(a.reason));
  assert.equal(b.status, "rejected");
  assert.ok(isStopped(b.reason));
  assert.equal(calls.length, 1); // the queued one never reached the model
  // the slot is free again for work outside the round
  assert.equal(await model.complete("c"), "ok");
});

test("a stopped round marks the running step stopped and keeps it out of the timing stats", async () => {
  const { createProgress } = await import("../../host/progress.mjs");
  const kv = {};
  const pg = createProgress({ load: (k) => kv[k] || null, save: (k, v) => { kv[k] = v; } });
  pg.begin("manual", { runId: "r1" });
  pg.start("sources");
  pg.finish("stopped", "已手动停止");
  const last = pg.view().last;
  assert.equal(last.outcome, "stopped");
  assert.equal(last.steps.find((s) => s.id === "sources").status, "stopped");
  assert.equal(last.steps.find((s) => s.id === "clean").status, "skipped");
  assert.ok(!kv.flow_stats["sources"]);
});
