/* 添加数据源的推断（id、类型、地区、试用）与主线关注的来源标记。 */
import test from "node:test";
import assert from "node:assert/strict";
import { draftSource } from "../../index.js";
import { updateFollows, normalizeFollows, emptyFollows } from "../../host/follows.mjs";

test("添加数据源：id 取主域名加栏目，按后缀和标题判断地区，新源先试用", () => {
  const bbc = draftSource({ name: "BBC 商业", url: "https://feeds.bbci.co.uk/news/business/rss.xml" }, []);
  assert.equal(bbc.id, "bbci_business");
  assert.equal(bbc.type, "rss");
  assert.equal(bbc.region, "UK", "名字是中文也按域名判断地区");
  assert.equal(bbc.category, "国际宏观");
  assert.equal(bbc.trial, true);
  assert.equal(bbc.enabled, true);
  const sina = draftSource({ name: "新浪财经", url: "https://finance.sina.com.cn/roll/" }, []);
  assert.equal(sina.id, "sina_roll");
  assert.equal(sina.type, "html_index");
  assert.equal(sina.region, "CN");
  const cx = draftSource({ name: "财新", url: "https://www.caixin.com/finance/", cjk: true }, []);
  assert.equal(cx.region, "CN", ".com 域名看试抓到的标题是不是中文");
  assert.equal(draftSource({ name: "Reuters", url: "https://www.reuters.com/world/" }, []).region, "INTL");
  const dup = draftSource({ name: "x", url: "https://www.stcn.com/" }, [{ id: "stcn" }]);
  assert.equal(dup.id, "stcn_2", "id 撞了加序号");
  assert.equal(draftSource({ name: "留学", url: "https://www.example.org/feed", pack: "study_abroad" }, []).category, "留学与签证");
});

test("主线关注：每条故事线一项，带来源标记，读写都保留", () => {
  let f = emptyFollows();
  f = updateFollows(f, "follow", "story", "st-1", "AI与数据中心", "tracker:7");
  f = updateFollows(f, "follow", "story", "st-2", "AI与数据中心", "tracker:7");
  f = updateFollows(f, "follow", "keyword", "英伟达|NVIDIA", "英伟达");
  const back = normalizeFollows(JSON.parse(JSON.stringify(f)));
  assert.deepEqual(back.follow.filter((x) => x.via === "tracker:7").map((x) => x.value), ["st-1", "st-2"]);
  assert.equal(back.follow.find((x) => x.kind === "keyword").via, undefined);
});
