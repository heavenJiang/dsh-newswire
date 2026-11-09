/* 解析规则：模型读页面结构写选择器，程序试抓验证，不过关带着反馈再改一次。 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanExtract, judgeRecipe, learnRecipe, recipePrompt } from "../../host/recipe.mjs";
import { renderJob } from "../../engine/channels/browse.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("规则清洗：只留认识的键，没有 item 不算，可疑写法丢掉", () => {
  assert.deepEqual(cleanExtract({ item: "article[data-testid=tweet]", link: "a:has(time)", junk: "x", title: "" }), { item: "article[data-testid=tweet]", link: "a:has(time)" });
  assert.equal(cleanExtract({ link: "a" }), null);
  assert.equal(cleanExtract({ item: "div{}" }), null);
  assert.equal(cleanExtract(null), null);
});

test("试抓结果是否合格：条数、链接、标题", () => {
  const items = (ts, us) => ts.map((t, i) => ({ title: t, url: us ? us[i] : "https://x.com/a/status/" + i }));
  assert.equal(judgeRecipe({ ok: true, kept: 2, items: items(["一二三四五六七", "七六五四三二一"]) }).ok, false);
  assert.equal(judgeRecipe({ ok: true, kept: 3, items: items(["路透社报道一件事", "另一件事发生了", "第三件事的进展"], ["u", "u", "u"]) }).ok, false, "链接都一样");
  assert.equal(judgeRecipe({ ok: true, kept: 3, items: items(["Reuters", "Reuters", "Reuters"]) }).ok, false, "标题都是作者名");
  assert.equal(judgeRecipe({ ok: true, kept: 3, items: items(["路透社报道一件事", "另一件事发生了", "第三件事的进展"]) }).ok, true);
});

test("学规则：第一次不过关时把结果告诉模型，第二次过关", async () => {
  const prompts = [];
  const replies = [
    JSON.stringify({ item: "article", link: "a", title: "span" }),
    JSON.stringify({ item: "article[data-testid=tweet]", link: "a:has(time)", title: "[data-testid=tweetText]", time: "time[datetime]", note: "帖子" }),
  ];
  const model = { complete: async (p) => { prompts.push(p); return replies[prompts.length - 1]; } };
  const tests = [];
  const deps = {
    model,
    outline: async () => ({ ok: true, title: "Reuters / X", outline: "article[data-testid=tweet]\n  time[datetime=2026-11-09T10:00:00Z]" }),
    test: async (src) => {
      tests.push(src);
      if (src.extract.link === "a") return { ok: true, kept: 3, items: [1, 2, 3].map(() => ({ title: "Reuters", url: "https://x.com/Reuters" })) };
      return { ok: true, kept: 3, items: [1, 2, 3].map((i) => ({ title: "第 " + i + " 条帖子的正文", url: "https://x.com/Reuters/status/" + i })) };
    },
  };
  const r = await learnRecipe(deps, { id: "x", name: "路透 X", url: "https://x.com/Reuters" });
  assert.equal(r.ok, true);
  assert.equal(r.tries, 2);
  assert.equal(r.extract.item, "article[data-testid=tweet]");
  assert.deepEqual(tests[1].channels, ["browse"], "规则只在真实浏览器里执行");
  assert.match(prompts[1], /上一次的选择器试抓结果不理想/);
  assert.match(prompts[1], /链接大多相同/);
});

test("页面骨架拿不到时直接失败，不调用模型", async () => {
  let called = false;
  const r = await learnRecipe({ model: { complete: async () => { called = true; return "{}"; } }, outline: async () => ({ ok: false, error: "browse_unavailable" }), test: async () => ({}) }, { url: "https://x.com/a" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "outline_failed");
  assert.equal(called, false);
});

test("浏览器脚本：按规则提取与页面骨架两种任务语法正确，规则原样带进去", () => {
  const ex = { item: "article[data-testid='tweet']", link: "a:has(time)" };
  const sel = renderJob("select", "https://x.com/Reuters", 20, { extract: ex });
  assert.ok(sel.includes(JSON.stringify(ex)));
  assert.doesNotThrow(() => new AsyncFunction("page", "files", sel));
  assert.doesNotThrow(() => new AsyncFunction("page", "files", renderJob("outline", "https://x.com/Reuters", 1, {})));
  assert.match(recipePrompt({ url: "https://x.com/a", outline: "body" }), /只输出一个 JSON 对象/);
});
