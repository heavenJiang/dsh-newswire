import { test } from "node:test";
import assert from "node:assert/strict";
import { relayRunning, parseExec01, wrapJob01, genOf } from "../../engine/channels/browse.mjs";

test("browse generation comes from the version; 0.1.1 idle relay still writes running:false", () => {
  assert.equal(genOf({ relay: { running: false, endpoint: "http://127.0.0.1:19988" }, setup: { version: "0.1.1" } }), "0.1");
  assert.equal(genOf({ relay: { version: "0.1.1", pid: 1 } }), "0.1");
  assert.equal(genOf({ relay: { running: true }, setup: { version: "0.0.17" } }), "0.0");
  assert.equal(genOf({ relay: { running: false } }), "0.0");
  assert.equal(genOf({ relay: { endpoint: "x", pid: 2 } }), "0.1");
  assert.equal(genOf({}), "");
});

test("browse 0.1.x status has no relay.running: a relay with a pid or endpoint is running", () => {
  assert.equal(relayRunning({ running: true }), true); // 0.0.x
  assert.equal(relayRunning({ running: false, pid: 1 }), false);
  assert.equal(relayRunning({ version: "0.1.1", endpoint: "http://127.0.0.1:19988", pid: 87924 }), true); // 0.1.x
  assert.equal(relayRunning(null), false);
  assert.equal(relayRunning({}), false);
});

test("browse 0.1.x execute output: value JSON, optional tab line, trailing notes", () => {
  assert.deepEqual(parseExec01('{"mode":"index","count":2}\n\nPage: 1 navigation\n'), { ok: true, value: { mode: "index", count: 2 } });
  assert.deepEqual(parseExec01('tab: 12\n\n{"a":1}\n\nConsole:\nx\n'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseExec01("plain text"), { ok: true, value: "plain text" });
});

test("browse 0.1.x jobs close their own tab", () => {
  const w = wrapJob01("'use strict';\nawait page.goto(u);\nreturn 1;");
  assert.ok(w.startsWith("try {\nawait page.goto"));
  assert.ok(w.includes("finally { try { await page.close(); }"));
});
