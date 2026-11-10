import test from "node:test";
import assert from "node:assert/strict";
import { losslessJson } from "../../index.js";

test("tool output is lossless JSON: undefined dropped, NaN null, -0 zero, Date string", () => {
  const d = new Date("2026-11-10T00:00:00Z");
  const out = losslessJson({ ok: true, waited: undefined, edition: { error: undefined, n: NaN, z: -0, inf: Infinity }, at: d, list: [1, undefined, 2] });
  assert.deepEqual(out, { ok: true, edition: { n: null, z: 0, inf: null }, at: "2026-11-10T00:00:00.000Z", list: [1, null, 2] });
  assert.equal(Object.is(out.edition.z, -0), false);
  assert.equal(losslessJson(undefined), null);
});
