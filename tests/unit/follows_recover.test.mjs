import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFollows } from "../../host/follows.mjs";

test("follows.json with a trailing fragment from a racing write is recovered and backed up", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nw-fol-"));
  const file = path.join(dir, "follows.json");
  const good = { version: 1, follow: [{ kind: "keyword", value: "特朗普", added_at: "2026-11-10T10:19:42.163Z" }], mute: [] };
  writeFileSync(file, JSON.stringify(good, null, 2) + "\n" + '": "2026-11-10T10:19:42.164Z"\n    }\n  ],\n  "mute": []\n}\n');
  const f = loadFollows(file);
  assert.equal(f.follow.length, 1);
  assert.equal(f.follow[0].value, "特朗普");
  assert.ok(existsSync(file + ".corrupt"));
});
