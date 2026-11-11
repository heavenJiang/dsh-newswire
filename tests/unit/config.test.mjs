import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upgradeConfig, CONFIG_VERSION } from "../../engine/config.mjs";
import { getAdapter } from "../../engine/adapters/index.mjs";
import { CHANNELS } from "../../engine/constants.mjs";

const SEED = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "config", "sources.json"), "utf8"));

test("种子配置自洽：id 唯一、适配器存在、通道合法、点名的源都在", () => {
  assert.equal(SEED.version, CONFIG_VERSION);
  const ids = SEED.sources.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SEED.sources) {
    if (s.adapter) assert.ok(getAdapter(s.adapter), s.id + " 适配器不存在");
    for (const c of s.channels || []) assert.ok(CHANNELS.includes(c), s.id + " 通道 " + c);
    assert.ok(s.weight > 0 && s.weight <= 1, s.id + " weight");
    assert.ok(s.region && s.group && s.pack, s.id + " region/group/pack");
  }
  for (const id of ["cls_telegraph", "techflow", "caixin", "yicai", "jiemian", "thepaper", "reuters", "apnews_world"]) assert.ok(ids.includes(id), "缺 " + id);
});

test("v1 → v2：补新源与新字段、去掉 exa、保留用户改动", () => {
  const v1 = {
    version: 1, defaults: { channels: ["browse", "http", "jina", "exa"], max_items: 20 }, categories: ["我的分类"],
    sources: [
      { id: "cls_telegraph", name: "我改过的名字", category: "国内财经与公告", type: "cls_api", url: "https://www.cls.cn/telegraph", channels: ["browse", "exa"], max_items: 99 },
      { id: "my_feed", name: "自建源", category: "我的分类", type: "rss", url: "https://x.example/rss", channels: ["http"] },
    ],
  };
  const up = upgradeConfig(v1, SEED);
  assert.equal(up.changed, true);
  assert.equal(up.doc.version, CONFIG_VERSION);
  const cls = up.doc.sources.find((s) => s.id === "cls_telegraph");
  assert.equal(cls.name, "我改过的名字");
  assert.equal(cls.max_items, 99);
  assert.deepEqual(cls.channels, ["browse"]);
  assert.equal(cls.weight, 0.85);
  assert.equal(cls.group, "cls");
  assert.ok(up.doc.sources.find((s) => s.id === "my_feed"), "自建源保留");
  assert.ok(up.added.includes("jiemian") && up.added.includes("apnews_world"));
  assert.ok(up.doc.categories.includes("我的分类"));
  assert.deepEqual(up.doc.defaults.channels, ["browse", "agent_reach", "http"]);
  assert.equal(up.doc.defaults.max_items, 20);
  assert.equal(upgradeConfig(up.doc, SEED).changed, false, "已是最新不再改");
  assert.deepEqual(up.doc.push, SEED.push, "补齐推送规则");
  assert.deepEqual(up.doc.sources.find((s) => s.id === "jiemian").paging, { mode: "param", param: "page", start: 2, max_pages: 4 });
});

test("v6 → v8：只加海外技术源，而且关着；用户没加的旧种子源（试用频道）不借升级加进来；声明的读法补进已有的源", () => {
  const seed = SEED;
  const v6 = { version: 6, sources: seed.sources.filter((s) => !s.added_in && !s.id.startsWith("tg_")).map((s) => Object.assign({}, s, { enabled: s.id === "cls_telegraph" })) };
  const up = upgradeConfig(v6, seed);
  assert.equal(up.doc.version, CONFIG_VERSION);
  assert.deepEqual(up.added.sort(), seed.sources.filter((s) => s.added_in >= 7).map((s) => s.id).sort());
  assert.ok(up.added.includes("reddit_localllama") && up.added.includes("github_trending"), "v8 的源也加进来");
  assert.ok(up.added.includes("hn_front") && up.added.includes("simonw"));
  assert.ok(!up.added.some((id) => id.startsWith("tg_")));
  for (const id of up.added) assert.equal(up.doc.sources.find((s) => s.id === id).enabled, false);
  assert.equal(up.doc.sources.filter((s) => s.enabled !== false).length, 1, "用户开着的源不变");
  const hn = up.doc.sources.find((s) => s.id === "hn_front");
  assert.equal(hn.tier, "community");
  assert.equal(hn.profile, "community");
});
