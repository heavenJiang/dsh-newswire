import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../index.js";

test("concurrent atomic writes to one file neither fail nor leave temp files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nw-atomic-"));
  const file = path.join(dir, "follows.json");
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, JSON.stringify({ i }))));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { i: 19 });
  assert.deepEqual(await readdir(dir), ["follows.json"]);
});
