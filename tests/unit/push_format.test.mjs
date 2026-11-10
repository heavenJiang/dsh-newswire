import test from "node:test";
import assert from "node:assert/strict";
import { composeEditionMessage, sentences, isKeyStory } from "../../host/edition.mjs";

const st = (id, section, importance, extra) => Object.assign({ id, title: "标题" + id, section, importance, reason: "new", lead: "11月10日，" + id + "的导语第一句。第二句补充细节。", outlets: [{ name: "财联社电报" }, { name: "NewsNow" }], links: [{ name: "财联社电报", url: "https://www.cls.cn/detail/1" }], url: "https://www.cls.cn/detail/1", first_seen_at: "2026-11-10 05:00:00" }, extra);

test("推送版式：重点在前详写，其余按 科技与产业 → 市场与宏观 → 时政 → 其他，序号连续，来源名是链接", () => {
  const picks = [st("p", "politics", 70, { points: [{ text: "要点一" }], impact: "影响一句。" }), st("t", "tech", 56), st("m", "markets", 40), st("x", "society", 30), st("i", "industry", 45), st("q", "politics", 40)];
  const msg = composeEditionMessage({ hhmm: "18:08", from: "14:00", md: "11-10", warnings: [], title: "要闻" }, picks, { headline: "总括", mode: "llm", model: "m", items_read: 9 }, {});
  const L = msg.split("\n");
  assert.equal(L[1], "汇总 14:00–18:08 · 新报道 6 件");
  const order = L.filter((l) => /^\*\*(\d+\.|🔴|💻|📈|🌐|📌)/.test(l)).map((l) => l.replace(/\*\*/g, ""));
  assert.deepEqual(order, ["🔴 重点", "1. 标题p", "2. 标题t", "💻 科技与产业", "3. 标题i", "📈 市场与宏观", "4. 标题m", "🌐 时政与国际", "5. 标题q", "📌 其他", "6. 标题x"]);
  const p = L.indexOf("**1. 标题p**");
  assert.equal(L[p + 1], "p的导语第一句。第二句补充细节。", "重点详写，去掉开头的日期");
  assert.equal(L[p + 2], "· 要点一");
  assert.equal(L[p + 3], "影响：影响一句。");
  assert.match(L[p + 4], /^\[财联社电报\]\(https:\/\/www\.cls\.cn\/detail\/1\) 等 2 家 · \d\d:\d\d$/);
  const q = L.indexOf("**5. 标题q**");
  assert.match(L[q + 1], /^\[财联社电报\]|^q的导语第一句。/);
});

test("按句截：取 n 字内完整的句子；去掉快讯前缀；一句就超长时在逗号处截", () => {
  assert.equal(sentences("17:49 ChainCatcher 消息，11 月 10 日，甲发生了。乙随后跟进了很多很多事情。", 10), "甲发生了。");
  assert.equal(sentences("一二三四五，六七八九十一二三四五六七八", 8), "一二三四五…");
  assert.equal(isKeyStory({ section: "industry", importance: 55 }), true);
  assert.equal(isKeyStory({ section: "politics", importance: 55 }), false);
  assert.equal(isKeyStory({ section: "politics", importance: 55, followed: ["x"] }), true);
});
