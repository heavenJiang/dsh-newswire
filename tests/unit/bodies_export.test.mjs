/* 正文抽取、正文候选、数据集导出（含覆盖情况）、原始快照保留。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extractBody, readerText, bodyCandidates, CHALLENGE, trimTail, anchorReader, bodyUrl } from "../../engine/pipeline/bodies.mjs";
import { relevant, PAYWALL_TEXT } from "../../engine/pipeline/bodytext.mjs";
import { decodeBody } from "../../engine/channels/http.mjs";
import { exportDataset, DATASET_SCHEMA } from "../../engine/export.mjs";
import { applyRetention } from "../../engine/retention.mjs";
import { openDb } from "../../engine/store/schema.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const LONG = "央行今日开展1000亿元7天期逆回购操作，中标利率持平于1.4%，当日有800亿元逆回购到期，实现净投放200亿元。";

test("正文抽取：JSON-LD 优先，其次 Next.js 数据，再次段落；去掉导航与样板句", () => {
  const ld = '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","articleBody":"' + LONG.repeat(3) + '"}]}</script><p>无关段落无关段落无关段落无关段落无关段落</p>';
  assert.equal(extractBody(ld).extractor, "json-ld");
  const nd = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"detail":{"content":"<p>' + LONG.repeat(3) + '</p>"}}}}</script>';
  assert.equal(extractBody(nd).extractor, "next-data");
  const html = "<nav><p>首页 电报 话题 盯盘 VIP 下载 APP 首页 电报 话题</p></nav><article><p>" + LONG + LONG + "</p><p>" + LONG.slice(5) + "</p><p>本文版权所有，未经授权不得转载，责任编辑：某某</p></article>";
  const p = extractBody(html);
  assert.equal(p.extractor, "paragraphs");
  assert.ok(!/首页 电报/.test(p.text) && !/版权所有/.test(p.text));
  assert.equal(extractBody("<p>太短</p>"), null);
});

test("正文容器：短讯（一句话）也算全文；容器外的侧栏、免责声明不算", () => {
  const flash = "11月9日，外交部发言人主持例行记者会，就中俄美元首会晤相关问题回应称，中方同相关方保持沟通。（澎湃新闻）";
  const html = '<div class="news-content article-content" id="x"><div class="news-content-parsed"><p>' + flash + '</p><strong></strong></div></div>' +
    '<span>免责声明：风险提示：本文内容仅供参考，不代表本站观点。</span><aside><p>' + LONG + '</p><p>' + LONG.slice(3) + '</p></aside>';
  const r = extractBody(html);
  assert.equal(r.extractor, "container");
  assert.equal(r.text, flash);
  // 容器里有长文时优先用容器
  const art = '<div class="article-content"><p>' + LONG + '</p><p>' + LONG.slice(2) + '</p><p>' + LONG.slice(4) + '</p><p>联系我们：support@example.com</p></div><div class="side"><p>' + "侧栏里的别的新闻标题很长很长很长".repeat(3) + "</p></div>";
  const a = extractBody(art);
  assert.equal(a.extractor, "container");
  assert.ok(!/侧栏|联系我们/.test(a.text));
});

test("阅读器整页文字：从标题那行取，截掉结尾样板与相关新闻列表", () => {
  const page = ["首页 全部文章 深度&专访 7x24h快讯", "特朗普称将与中俄元首在APEC讨论美伊冲突", "11月9日，外交部发言人郭嘉昆主持例行记者会，就相关问题作出回应。",
    "免责声明：风险提示：本文内容仅供参考。", "美股三大指数集体高开，标普500指数涨0.85%。", "联系我们：support@x.com"].join("\n");
  assert.equal(anchorReader(page, "特朗普称将与中俄元首在APEC讨论美伊冲突及无核化问题，外交部回应"), "11月9日，外交部发言人郭嘉昆主持例行记者会，就相关问题作出回应。");
  assert.equal(anchorReader(page, "亚玛顿：控股股东拟6.8亿元转让20%股份"), "", "对不上标题，交给调用方按更严的长度要求处理");
  assert.equal(anchorReader("实时行情 美元指数 101.91 欧元/美元 1.16 黄金 4010 原油 87.7 埃及政府官员：我国与雪佛龙签署离岸天然气勘探协议。 美国9月批发库存环比增长0.7%。", "埃及政府官员：我国与雪佛龙签署离岸天然气勘探协议。"), "", "标题挤在快讯流中间不算对上");
  assert.equal(trimTail("正文第一段\n正文第二段\nTelegram订阅群： https://t.me/x\nTwitter官方账号： https://x.com/y"), "正文第一段\n正文第二段");
  // 阅读器读出的相关新闻列表
  assert.equal(trimTail("交通运输部11月9日发布公告。\n*   ### 国务院关税税则委员会：继续暂停\n*   _00:19_### 美国先减关税"), "交通运输部11月9日发布公告。");
  assert.equal(trimTail("正文。\n1 ### 利好！拟最高回购2亿元2 ### 今夜全线拉升"), "正文。");
  // 深潮快讯页：开头的时间与分享按钮、结尾的 7x24h 快讯流
  assert.equal(trimTail(["2026.11.09 - 03:16", "分享至分享到Twitter", "深潮 TechFlow 消息，马斯克今日发帖。", "截至发稿，该帖浏览量已超过 30 万次。", "7x24h 快讯",
    "11/9 15:26美联储古尔斯比：大问题一直出在通胀方面", "11/9 15:25特朗普质疑中期选举公正性", "11/9 15:15首发 PNC 企业客户可接收 USDC"].join("\n")),
  "深潮 TechFlow 消息，马斯克今日发帖。\n截至发稿，该帖浏览量已超过 30 万次。");
  // 圈子帖：相关文章列表与评论区
  assert.equal(trimTail("鲁比奥为军事行动辩护。\n*   指南针，被罚！\n*   今夜，全线拉升！\n*   又一家A股公司分红！\n所有评论（14）\n*    网友  评论内容"), "鲁比奥为军事行动辩护。");
  // 正文里偶尔一行带时间不算新闻流
  assert.equal(trimTail("美股开盘。\n22:30 公布CPI数据。\n市场等待结果。"), "美股开盘。\n22:30 公布CPI数据。\n市场等待结果。");
});

test("整页读出的文字要对得上标题：行情条、捐款提示、付费墙页不是正文", () => {
  assert.ok(relevant("据外媒报道，法国官员怀疑伊朗是10月份冰箱黑客攻击事件的幕后黑手。", "法国官员怀疑伊朗是10月份冰箱黑客攻击事件的幕后黑手。"));
  assert.ok(!relevant("实时行情 查看更多 > 综览 外汇 商品 债券 资产 现价 涨跌 美元指数 DXY 101.91 -0.38 欧元/美元", "法国官员怀疑伊朗是10月份冰箱黑客攻击事件的幕后黑手。"));
  assert.ok(!relevant("Can you stand with independent journalism? AP is proudly independent with no parent company.", "SpaceXAI started Southaven data center construction without water permits"));
  assert.ok(relevant("Nvidia shares fell after an internal probe into CEO Jensen Huang was announced, and the company said…", "Internal probe into CEO Jensen Huang and Nvidia shares"));
  assert.ok(PAYWALL_TEXT.test("Try unlimited access Only $1 for 4 weeks"));
  // 评论式标题与正文用词少有重合，也要认得出
  assert.ok(relevant("11月6日，北京。中国社会科学院大学冷门绝学学院揭牌，全国冷门绝学联盟同步启动。这是全国高校设立的第一个冷门绝学学院。", "马上评｜“绝学”何以继？“冷门”何以兴？"));
  assert.ok(relevant("举办中国国际进口博览会，是中国主动向世界开放市场的重大举措。2026年11月5日至10日，第九届进博会在上海举行。", "壹视界·心相知丨在上海，遇见世界"));
  assert.ok(!relevant("{{month}} {{date}} {{hourSecond}} {{bulletinStatus}}{{stockName}}{{stockCode}}{{price}} 浏览 收藏公告 {{fundtitle}} 公告下载", "荣昌生物关于与烟台荣昌制药股份有限公司签署许可协议暨关联交易的公告"));
  // 快讯流页面里出现了这条的标题，但开头是行情条：不是正文
  assert.ok(!relevant("实时行情 查看更多 > 综览 外汇 商品 债券 资产 现价 涨跌 美元指数 DXY 101.91 欧元/美元 1.16 英镑/美元 1.31 美元/日元 154.2 黄金 4010 原油 87.7 比特币 74000 ".repeat(8) + "埃及政府官员：我国与雪佛龙签署离岸天然气勘探协议。 美国9月批发库存环比增长0.7%。", "埃及政府官员：我国与雪佛龙签署离岸天然气勘探协议。"));
  assert.deepEqual(bodyUrl("https://www.cninfo.com.cn/new/disclosure/detail?stockCode=688331&orgId=9900047137&announcementId=1225664560&announcementTime=2026-11-10"), { url: "https://static.cninfo.com.cn/finalpage/2026-11-10/1225664560.PDF", kind: "pdf" });
  assert.equal(bodyUrl("https://www.cls.cn/detail/1"), null);
  // PDF 抽出的公告字间有空格；中文译名标题配英文原文时看列表里的原文开头
  assert.ok(relevant("证券代码： 688331 荣昌生物 关于与烟台荣昌制药股份 有限公司签署许可协议暨关联 交易的公告", "荣昌生物关于与烟台荣昌制药股份有限公司签署许可协议暨关联交易的公告"));
  assert.ok(relevant("Why AI Agents Are Repeating 2019's Microservices Mistake. The author reviews a multi-agent workflow…", "AI Agent 为何在重演 2019 年微服务的错误", "Why AI Agents Are Repeating 2019’s Microservices Mistake 作者复盘"));
});

test("正文首尾样板：备案号、版权、发布时间与浏览数、字号按钮、X 帖子前缀", () => {
  assert.equal(trimTail(["时间：2024年10月21日 浏览次数：564 【字体：大中小】", "2024年10月17日下午，夏建辉副主任在中心会见了新西兰梅西大学副校长一行。", "关于我们　联系我们　法律声明　网站地图", "京ICP备05070218号 京公网安备11010202000001号"].join("\n")),
    "2024年10月17日下午，夏建辉副主任在中心会见了新西兰梅西大学副校长一行。");
  assert.equal(trimTail('qinbafrank on X: "聊聊沃伦担任银行委员会主席对加密的影响。'), "聊聊沃伦担任银行委员会主席对加密的影响。");
  assert.equal(trimTail("正文一段。\n经营许可证：沪B2-2017116 © 2014-2026 上海东方报业有限公司"), "正文一段。");
  // 图集说明、图片署名、署名行
  assert.equal(trimTail(["1 of 4 |", "Options traders work on the floor of the New York Stock Exchange. (AP Photo/Yuki Iwamura)", "License this photo", "BY  DAMIAN TROISE", "NEW YORK (AP) — Wall Street's winners and losers after the midterms."].join("\n")),
    "NEW YORK (AP) — Wall Street's winners and losers after the midterms.");
  assert.equal(trimTail("正文。\n风险提示及免责条款\n市场有风险，投资需谨慎。"), "正文。");
});

test("按页面声明的字符集解码（GBK 中文站）", () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 「中文」的 GBK 编码
  assert.equal(decodeBody(Buffer.concat([Buffer.from('<meta charset="gb2312">'), gbk]), "text/html"), '<meta charset="gb2312">中文');
  assert.equal(decodeBody(gbk, "text/html; charset=GBK"), "中文");
  assert.equal(decodeBody(Buffer.from("中文"), "text/html"), "中文");
});

test("验证页不是正文", () => {
  assert.ok(CHALLENGE.test("Performing security verification This website uses a security service"));
  assert.equal(extractBody("<title>Just a moment...</title><p>Checking your browser before accessing the site, please wait a moment while we verify.</p>"), null);
});

test("阅读器 Markdown → 纯文本", () => {
  const md = "Title: x\n\nMarkdown Content:\n# 标题\n![img](https://x/a.png)\n" + LONG + "\n[首页](https://x)\n" + LONG.slice(3) + "\n";
  const t = readerText(md);
  assert.ok(t.startsWith("央行今日"));
  assert.ok(!/!\[|\]\(/.test(t));
});

function seed(db) {
  const now = "2026-11-08 05:00:00";
  const art = db.prepare("INSERT INTO articles (id, url, title, summary, content, published_at, time_confidence, first_seen_at, last_seen_at, source_id, pack, paywalled, text_len, training_ready, parser_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  art.run("a1", "https://x/1", "央行开展逆回购", "s", LONG.repeat(4), "2026-11-08 04:50:00", "feed", now, now, "cls", "core", 0, LONG.length * 4, 1, "0.7.0/generic");
  art.run("a2", "https://y/2", "财新独家", "s", "", "2026-11-08 04:55:00", "feed", now, now, "caixin", "core", 1, 10, 0, "0.7.0/generic");
  art.run("a3", "https://z/3", "旧闻", "s", "", "2026-11-06 04:55:00", "feed", "2026-11-06 05:00:00", "2026-11-06 05:00:00", "cls", "core", 0, 10, 0, "0.7.0/generic");
  db.prepare("INSERT INTO runs (run_id, started_at, finished_at, mode, sources_total, sources_ok, sources_failed, items_new) VALUES ('r1', ?, ?, 'cycle', 3, 2, 1, 2)").run(now, now);
  db.prepare("INSERT INTO observations (run_id, source_id, article_id, rank, views, hot, seen_at) VALUES ('r1', 'cls', 'a1', 0, 4200, '[\"加红\"]', ?)").run(now);
  db.prepare("INSERT INTO events (event_id, pack, title, lead_article_id, first_seen_at, last_seen_at, member_count, source_count, importance, credibility, labels, regions, factors, created_run) VALUES ('ev1', 'core', '央行开展逆回购', 'a1', '2026-11-08 04:50:00', ?, 2, 2, 72, 'corroborated', '[\"macro.monetary\"]', '[\"CN\"]', '{}', 'r1')").run(now);
  db.prepare("INSERT INTO event_members (event_id, article_id, source_id, grp, similarity, method, joined_at, joined_run) VALUES ('ev1', 'a1', 'cls', 'cls', 1, 'seed', ?, 'r1'), ('ev1', 'a2', 'caixin', 'caixin', 0.8, 'title', ?, 'r1')").run(now, now);
  db.prepare("INSERT INTO continuity (run_id, source_id, status, note) VALUES ('r1', 'reuters', 'failed', 'browse:timeout -> http:paywall')").run();
  db.prepare("INSERT INTO coverage_gaps (source_id, run_id, gap_from, gap_to, status, method, recovered, updated_at) VALUES ('jiemian', 'r1', '2026-11-08 01:00:00', '2026-11-08 03:00:00', 'open', 'paging', 0, ?), ('techflow', 'r1', '2026-11-08 01:00:00', '2026-11-08 02:00:00', 'backfilled', 'paging', 9, ?)").run(now, now);
}

test("正文候选：重点事件成员，跳过付费墙源与 body=list / none 的源", () => {
  const dir = tmp("newswire-bodies-");
  const db = openDb(path.join(dir, "news.sqlite"));
  seed(db);
  db.prepare("UPDATE articles SET text_len = 10, content = '' WHERE id = 'a1'").run();
  const sources = new Map([["cls", { id: "cls", tier: "primary" }], ["caixin", { id: "caixin", paywall: true }]]);
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 5, sources }).map((c) => c.id), ["a1"]);
  sources.set("cls", { id: "cls", body: "list" });
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 5, sources }), []);
  assert.deepEqual(bodyCandidates(db, { touched: ["ev1"], budget: 0, sources: new Map() }), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("导出：条目带观测轨迹与事件，正文按可训练性给出；清单列出未补全缺口与失败的源轮次", () => {
  const dir = tmp("newswire-export-");
  const db = openDb(path.join(dir, "news.sqlite"));
  seed(db);
  const cfg = { version: 5, sources: [{ id: "cls", name: "财联社电报", type: "cls_api", region: "CN", weight: 0.85, tier: "primary", group: "cls" }, { id: "caixin", name: "财新", type: "html_index", paywall: true }] };
  const r = exportDataset(db, { from: "2026-11-08", kind: "all", outDir: dir, cfg, tax: { rulesVersion: "t1" }, now: Date.parse("2026-11-08T10:00:00Z") });
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, "manifest.json"), "utf8"));
  assert.equal(m.schema, DATASET_SCHEMA);
  assert.deepEqual(m.range, { from_date: "2026-11-08", to_date: "2026-11-08", timezone: "Asia/Shanghai", from_utc: "2026-11-07 16:00:00", to_utc: "2026-11-08 16:00:00" });
  assert.deepEqual(m.files, { "articles.jsonl": 2, "events.jsonl": 1, "stories.jsonl": 0, "editions.jsonl": 0, "digests.jsonl": 0 }, "11-06 的旧闻不在范围内；all 也导出故事线、版面、日报");
  assert.deepEqual(m.coverage.open_gaps.map((g) => g.source_id), ["jiemian"], "已补回的缺口不列");
  assert.deepEqual(m.coverage.failed_source_runs.map((f) => f.source_id), ["reuters"]);
  assert.equal(m.versions.taxonomy_rules, "t1");
  const arts = fs.readFileSync(path.join(r.dir, "articles.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const a1 = arts.find((a) => a.id === "a1");
  const a2 = arts.find((a) => a.id === "a2");
  assert.ok(a1.content && a1.content_withheld === null);
  assert.equal(a1.event_id, "ev1");
  assert.deepEqual(a1.observations.map((o) => [o.views, o.hot]), [[4200, ["加红"]]]);
  assert.equal(a2.content, null);
  assert.equal(a2.content_withheld, "paywall");
  const ev = JSON.parse(fs.readFileSync(path.join(r.dir, "events.jsonl"), "utf8").trim());
  assert.equal(ev.members.length, 2);
  assert.deepEqual(ev.labels, ["macro.monetary"]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("原始快照：今天的不动，之前的压缩（内容不变），超过保留期的删除", () => {
  const raw = tmp("newswire-raw-");
  const mk = (rel, body) => { const p = path.join(raw, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  mk("20261108/09/cls.browse.json", "today");
  const old = mk("20261107/21/jiemian.browse.html", "<html>" + "x".repeat(5000) + "</html>");
  mk("20261107/21/done.html.gz", "already");
  mk("20260101/cls.xml", "ancient");
  const r = applyRetention({ rawDir: raw, today: "20261108", retentionDays: 180 });
  assert.equal(r.compressed, 1);
  assert.equal(r.removedDays, 1);
  assert.ok(r.savedBytes > 4000);
  assert.ok(fs.existsSync(path.join(raw, "20261108/09/cls.browse.json")));
  assert.ok(!fs.existsSync(old));
  assert.equal(gunzipSync(fs.readFileSync(old + ".gz")).toString(), "<html>" + "x".repeat(5000) + "</html>");
  assert.ok(!fs.existsSync(path.join(raw, "20260101")));
  assert.equal(applyRetention({ rawDir: raw, today: "20261108", retentionDays: 180 }).compressed, 0, "重复执行无事可做");
  fs.rmSync(raw, { recursive: true, force: true });
});
