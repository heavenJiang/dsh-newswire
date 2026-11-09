# dsh-newswire 引擎

[English](README.md) | 中文

纯 Node（≥ 22，只用内置 `node:sqlite`，无第三方依赖）。插件以子进程调用 `run.mjs`；也可以脱离插件直接运行。

## 目录
```
engine/
  run.mjs               CLI：fetch（抓一轮入库）| cycle（整轮 + 推送消息）| reprocess（重算标签与事件）| export（导出数据集）| test-source（试抓，不入库）
  taxonomy.mjs          分类体系：标签、地区、实体、数字记号、计数单位
  cursor.mjs            断点衔接：判定、游标推进、回看时长
  export.mjs            数据集导出（articles / events / manifest）
  retention.mjs         原始快照压缩与按天删除
  lock.mjs              跨进程文件锁（dataDir/run.lock）
  config.mjs            数据源配置读取与版本升级（自动补齐新源与新字段，旧文件留 .bak）
  bins.mjs              外部命令探测：browse / agent-reach / mcporter（显式路径 → PATH → 常见位置）
  constants.mjs         通道常量（无副作用，Host 半边可 import）
  query.mjs             读查询（插件工具与面板路由共用）
  channels/
    browse.mjs          browse CLI：status / session / execute；按模式生成页面脚本（rss / html_index / cls_api / html / article）
    agent_reach.mjs     agent-reach：RSS 用 venv 里的 feedparser；网页用 doctor 报告的 web 后端（web-reader MCP 或 Jina Reader）
    http.mjs            直取与 jina（r.jina.ai）
    classify.mjs        失败分类 error_kind + hint；错误原文去本机信息
    exa.mjs             补抓搜索（Exa，经 mcporter）
  adapters/             站点适配器（整页 HTML → 条目 + 源头热度信号）
    techflow.mjs jiemian.mjs thepaper.mjs apnews.mjs   index.mjs 注册表   _util.mjs
  parsers/generic.mjs   通用解析：RSS/Atom、HTML 链接、Markdown、JSON API（含 signals 字段映射）
  pipeline/
    fetch.mjs           单源通道链（不碰数据库，试抓与正式抓取共用）
    ingest.mjs          单源一轮：抓取 → 衔接判定 → 翻页 / 搜索补抓 → 入库 → 记衔接状态、缺口、游标
    paging.mjs          翻页补抓：param / cursor / id_walk
    events.mjs          分类 → 事件聚类 → 交叉验证打分；重算
    bodies.mjs          重点事件的正文抓取与抽取
    select.mjs          源头热度、按事件选推送、手机消息
    normalize.mjs       原始条目 → 入库记录（去重键、时间可信度、无标题快讯取首句、栏目名过滤）
    signals.mjs         热度信号归一化
    digest.mjs          汇总 Markdown 与 JSONL/CSV 导出
  store/
    schema.mjs          表结构与迁移（PRAGMA user_version）
    db.mjs              写入
  config/sources.json   数据源种子（插件首次运行复制到 dataDir）
  config/taxonomy.json  分类体系种子（同上）
  queries.sql           常用排查 SQL
```

## 抓多少：衔接优先

每个源每轮抓多少，不是按固定条数，而是**一直抓到上一轮的位置为止**：有断点的源（流式源）每轮保留比上一轮最新那条更新的全部条目，最多 300 条；财联社按时间往回翻页，直到翻过上一轮最新那条之前 5 分钟（最多 60 页，防接口异常时无限翻），隔夜也能一轮补齐。配置里的 `max_items` 只决定新源**第一轮**抓多少。这样财联社高峰期（一小时约 50 条）也不会漏掉中间一段。

## 数据流
```
配置 → 预检 browse → 逐源按通道链尝试（browse → agent_reach → http → jina，首个产出 ≥1 条的通道胜出）
     → 原始响应写 raw/YYYYMMDD/HH/<source>.<channel>.<ext>
     → 解析（适配器优先，否则通用解析）→ 归一化（时间可信度、去重键、信号）
     → 衔接判定，缺口时翻页 / 搜索补抓
     → articles（去重合并）+ observations（本轮位置与热度）+ signal_availability + continuity / coverage_gaps / source_cursors
     → 分类 → 事件聚类与打分 → 重点事件抓正文 → 汇总 digest →（cycle）选推送、生成消息
     → 原始快照保留策略（一天后压缩，超期删除）
```

## 断点衔接
| 源类型 | 判定 | 缺口时 |
|---|---|---|
| 流式（`continuity: "stream"`；rss / json_api / cls_api 默认） | 本批出现上轮最新 50 条之一 → 衔接；否则本批最旧的可信时间 ≤ 上轮最新可信时间 → 按时间衔接；id_walk 源看 id 是否接上 | 按 `paging` 往前翻：`param`（页码）、`cursor`（API 游标）、`id_walk`（按 id 逐条取详情页）、`native`（源脚本自己按时间回翻，如财联社）；仍接不上且 `backfill` 未关闭 → Exa 搜索兜底（每轮最多 3 个源） |
| 快照（`continuity: "snapshot"`；列表页默认） | 首页推荐类，不判断 | — |

每源每轮的回看时长 = 距上次成功 + 15 分钟（1–48 小时），财联社据此决定回翻页数；`cycle` 模式下距上一整轮 ≥6 小时或早 8 点前为隔夜模式，条数与翻页上限 ×4。
状态：`first` / `connected` / `connected_time` / `gap_filled` / `gap_partial` / `gap_open` / `snapshot` / `failed`，记在 `continuity` 表；缺口与补回条数记在 `coverage_gaps`。游标只在该源本轮成功后推进，失败的时段下一轮自动覆盖。

## 分类
`taxonomy.json`：`labels`（两级树，叶子有 keywords / patterns / exclude）、`category_defaults`（源分类 → 默认标签）、`regions`（地区码 → 词）、`entities`（跨语言别名，`weak` 的不计入匹配证据）、`watch`（关注词，事件 +5）、`mute`（屏蔽词，事件重要度归零）。
中文关键词按子串匹配；英文按整词、不区分大小写，较长的词允许 s/es/ed/ing 词尾；全大写且 ≤4 字符的缩写区分大小写。标题命中 2 分、摘要 1 分，≥2 分贴标签（置信度 分/4）；都不命中时用源分类的默认标签（0.3）。标签与地区写 `article_labels`（地区为 `region:XX`），带 `rules_version`。事件标签只取规则命中的。

## 事件聚类与交叉验证
- 每轮把本轮出现的条目归入近 48 小时的事件（倒排索引召回候选），找不到就新建。栏目名式的短标题（英文 <4 词、中文 <6 字）不参与。
- 合并：同语言标题二元组相似度 ≥0.5，或 ≥0.3 且有相同的关键数字（金额可跨中英文换算，以及百分比、人数），时间差 ≤6 小时；同一计数单位（件、家、台、亿元等）给出不同数字的视为两件事，除非标题几乎相同（人数与百分比不受此限，交给分歧判断）。跨语言要共享 ≥2 个具体实体且（有相同数字或 ≥3 个实体），时间差 ≤6 小时。
- 重要度 0–100 = 独立媒体（同 group 算一家，转载 / 聚合源算半家；1→10、2→30、3→40、4→46、5+→50）+ 源权重（≤10）+ 国内外同报 10 + 含权威源 5 + 源头热度（成员中最高热度×0.5，≤25）+ 3 家在 1 小时内跟进 5 + 持续 ≥3 轮 5 + 关注词 5；屏蔽词归零。因子明细存 `events.factors`。
- 可信度：单源 / 已印证（≥2 家独立媒体）/ 权威确认（含 tier=primary 且 weight≥0.9 的源）/ 存在分歧（≥2 家各给出一个不同的人数或百分比；金额不比，因为总额与分项常常都对）。
- 显示标题：有中文成员取最短的中文标题，否则取主条目标题；主条目 = 一手源优先，其次源头热度最高，再次最早。
- 重算时事件记到首条成员第一次被看到的那一轮（时间线依赖它）。

## 推送选择
本轮触及、首报在回看范围内的事件：多源（已印证 / 权威确认 / 存在分歧）重要度 ≥ `min_corroborated`（50），单源 ≥ `min_single`（36，实际需要级别 A，或两个强信号如级别 B + 阅读前 15%）。已推过的事件只在可信度升级或重要度上升 ≥ `upgrade_jump`（20）时再推（标 ↑）。每轮最多 `max`（8）条，按重要度排序。

## 正文
本轮重要度 ≥50 的事件，每个事件最多 2 家成员（一手源优先），每轮 `--body-budget` 篇（默认 12）。跳过付费墙源、`body: "list"`（快讯：列表里就是全文，60 字以上即可用于训练）与 `body: "none"` 的源，以及近 7 天抓正文失败 ≥3 次且从未成功的源。
抽取顺序：http 取页 → JSON-LD `articleBody` → Next.js `__NEXT_DATA__` 里最长的正文字段 → 页面段落（优先 `<article>` 内，去掉导航与样板句）；请求被拒（401/403）且 browse 可用时用真实浏览器读正文；最后用阅读器（Jina）。验证页一律不当正文、不绕过，记为 `bot_blocked`。结果写 `article_bodies`，比原内容长时回填 `articles.content` 与 `training_ready`。

## 数据集导出
`--mode export --from YYYY-MM-DD [--to …] [--kind all|articles|events] [--pack core]` 写 `dataDir/datasets/dataset-<起>_<止>-<时间>/`：`articles.jsonl`（含每一轮的观测）、`events.jsonl`（成员、打分轨迹、推送）、`manifest.json`（数据集版本 `dsh-newswire-dataset/1`、范围、数据源、各版本号、运行、未补全缺口与失败的源轮次）。正文只在 `training_ready=1` 时给出，否则 `content_withheld` 为 `paywall` 或 `too_short`。

## 主题包
源带 `pack`；`sources.json` 里有 `packs.<包>`（名称、消息标题、默认定时）和 `push.<包>`（门槛、可选 `require_labels`）。`--packs <包>` 只跑一个包，本轮记为该包（`runs.pack`），隔夜判断和回看只看这个包的上一轮。隔夜 = 本地时间 10 点前，且距该包上一轮 ≥6 小时（或首轮）。`--lock-wait-ms` 让本轮等锁而不是放弃（插件最多等 15 分钟），两个包的定时轮次撞上时依次执行。

## 从链接推断时间
源头没给时间时看链接：完整时间戳（`/2026101415255489242/`）记为 `page_text`；只有日期（`t20261107_`、`/20261029/`、`/2026/11-08/`）记为 `url_date`（北京时间零点），用于显示和数据集，但断点衔接和聚类不把它当可信时间。合并时时间可信度只升不降：fetched < url_date < page_text < feed。主条目的时间（含链接日期）早于回看范围一天以上的事件不推送，新源首轮列表里的旧条目不会被当成新闻。

## 数据模型（schema v21）
| 表 | 内容 |
|---|---|
| `sources` | 源配置快照（含 weight / tier / grp / pack / adapter / removed_at） |
| `runs` | 每轮：起止时间、模式、主题包、成败源数、新增 / 重复 |
| `articles` | 去重后的文章。去重键 `id = sha1(canonical_url + 归一化标题)`；`time_confidence` = feed（源头给的时间）/ page_text（页面文字或链接里的时间戳推断）/ url_date（只有日期，来自链接）/ fetched（以抓取时间近似，`published_at` 为 NULL）；`parser_version`；`pack` |
| `observations` | **每轮每条**：`rank`、`section`、`views/comments/likes/shares/favorites`、`hot`（JSON 数组，源头原文）、`level`、`signals_raw`。同一条在多轮出现即形成热度时间序列 |
| `signal_availability` | 每源实际采到过哪些信号、次数、最近时间 |
| `fetch_attempts` | 每次通道尝试：channel、backend、ok、http_status、items、latency_ms、error_kind、error（已去本机信息）、hint、note |
| `source_cursors` | 每源断点：last_ok_at、head_keys（最新 50 条去重键）、head_time / tail_time（可信时间范围）、max_id（id_walk） |
| `continuity` | 每轮每源衔接状态、重叠条数、翻页数、补回条数、缺口区间 |
| `coverage_gaps` | 缺口与补抓结果（backfilled / partial / open，方式 paging / agent_reach_search） |
| `article_labels` | 条目标签与地区（label、confidence、origin、rules_version） |
| `events` | 事件：标题、主条目、首报 / 最近时间、成员数、独立媒体数、各源（outlets）、国内外分布、重要度、可信度、标签、地区、实体、打分因子、分歧、诞生轮次；`llm_notes`：模型解读（summary / why / watch、模型、时间、写时的成员数、提示词版本） |
| `event_members` | 事件成员（每条至多属于一个事件）：相似度与合并方式（seed / title / title+number / entity） |
| `event_scores` | 每轮的事件打分轨迹 |
| `pushes` | 推送记录：event_id、主条目、当时的重要度与可信度、原因（new / upgraded / jumped） |
| `article_bodies` | 正文：内容、长度、抽取方式（json-ld / next-data / paragraphs / browse / reader）、通道、是否付费墙、成败与错误 |
| `briefings` | 模型简报（v8）：主题包、轮次、时间、模型、回看小时数、总括、内容（points / watch，各带 event_ids）、参与的事件、成败与错误、耗时。失败也记一行 |
| `editions` | 版面（v9）：主题包、轮次、时间、模式（llm / rules）、模型、版式版本、时段、阅读条数、总括、整份内容（头版、版块、报道、值得关注、待核实）、错误、耗时、调用次数 |
| `edition_items` | 每条新闻在版面里的归属：报道、规则事件、版块、标签、重要度（LLM 模式下是模型的判断） |
| `stories` | 故事线（v10）：跨版面延续的报道——标题、版块、标签、重要度、状态（active / merged 及并入谁）、模型写的稿（含写稿时的新闻条数，用于判断能否沿用）、首末版面 |
| `story_items` | 每条新闻属于哪条故事线（一条新闻只属于一条）、对应规则事件、何时归入 |
| `story_updates` | 故事线进展（v11）：哪份版面、何时、进展文字、新增几篇、模型还是程序写的 |
| `kv` | 简单状态，如每个包的上次查看时间（`seen:<包>`） |
| `digests` | 日报（v12）：包、日期、模式、模型、总括、整份内容（主线脉络、明日关注、当日数字）、耗时、调用次数 |
| `feedback` | 读者反馈：错句（error）、放错故事线的报道（misplaced）、「这是广告」（promo）与「这是新闻」（not_promo），所在故事线与版面、说明、处理时间 |

`articles` 的内容质量字段（v13）：`kind` = news / promo（广告、付费栏目引流、营销）/ digest（合集原稿，拆条后本身不再参与）/ digest_item（从合集拆出的一条，`parent_id` 指向原稿）；`kind_by` = rule / llm / reader（读者的判断不被规则与模型覆盖）；`kind_note` 记命中的规则或原稿标题；`completeness` = full / truncated / title_only；`kind` 另有 ticker（单条行情跳动，进版面的「行情速览」，不单独成稿、不参与事件）。v16：`title_zh` 外文标题的中文译名（LLM 模式由模型译并核对；聚类按它比较，面板显示它），`link_to` 模型判定的「同一件事」——指向那件事的首条报道，聚类时据此归并，重算也保留。噪声规则在 `taxonomy.json` 的 `noise` 里（`source` / `title` / `text` / `all` 正则），改完跑 `--mode reprocess` 重新定性。
| `articles_fts` | FTS5 全文索引（trigram，中文 ≥3 字可检索；更短的词查询层退回 LIKE） |

合并规则：同一去重键再次出现时，摘要 / 正文取更长的；发布时间只在「原来是 fetched、现在拿到了可信时间」时升级；首见时间不变。时间线有专门的索引，任意一天的首屏查询约 1 毫秒。

## 热度信号
只记源头真实给出的值，取不到为 NULL（不是 0）。各源实际情况（2026-11-08 核实）：

| 源 | 信号 |
|---|---|
| 财联社电报 | level（A/B/C）、views（阅读）、shares、comments |
| 华尔街见闻 | level（score，2=重要）、comments |
| 深潮 TechFlow | views、shares、favorites、hot（热门 / 推送 / 日推荐） |
| 界面快讯 | hot（a-item-red → 加红）、rank |
| 澎湃首页 | likes（praiseTimes）、comments（interactionNum）、section（头图 / 要闻 / 频道） |
| 美联社 | hot（Most Read #n / Most commented #n）、comments（评论榜）、section |
| 其它 RSS / 列表页 | 只有 rank |

## 站点适配器
`adapters/<id>.mjs` 导出 `{ id, browseMode: "html", waitFor, parse(html, { url, max }) }`。browse 通道用 `html` 模式取渲染后的整页（等 `waitFor` 选择器出现，最多 15 秒），http 通道把响应体交给同一个 `parse`。
新增适配器：写模块 → 在 `adapters/index.mjs` 登记 → 存一份快照 `tests/fixtures/<id>.html.gz` → 在 `tests/unit/adapters.test.mjs` 加断言。

## 解析规则（模型学会、程序执行）
源上可以带 `extract`：`{ item, link?, title?, time?, summary?, wait_for? }`，都是 CSS 选择器。`item` 在整页上选出每一条，其余在每条内部找；没有单独标题的（社交平台的帖子）取正文第一行作标题。有 `extract` 的源走 browse 的 `select` 模式（等 `wait_for`，往下滚三屏再取）。
规则通常不是手写的：通用解析认不出页面时，插件用 `--mode outline --url <地址>` 取页面骨架（标签、少量 class、data-*、链接与时间属性、短文本，重复的兄弟只留 3 个），交给模型写选择器，再用试抓验证（至少 3 条、链接和标题各不相同），不过关带着结果让模型再改一次。见 `host/recipe.mjs`。

## 模型读页面（「不限」档）
`--mode read --url <地址>` 取页面全文快照：按阅读顺序的文字，每个链接就地标号【n】，时间元素标成〈时间 …〉，另附链接表与时间列表。插件让模型列出 `[标题, 链接编号, 时间]`，核对后（编号存在、标题在页面原文里、时间取自页面）按源 id 存成 `<dir>/<id>.json`，再以 `--prefetched <dir>` 交给 fetch / cycle：有预读条目的源直接用（通道记为 `llm`），照常走入库、去重、衔接与事件聚类；没有的照常走通道。见 `host/modelread.mjs`。

## CLI
```bash
# 抓一轮（外部命令路径不给就自动探测）
node engine/run.mjs --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite \
  --out ~/.dsh/newswire/out --raw ~/.dsh/newswire/raw --since-hours 24 --export jsonl,csv \
  [--sources a,b] [--categories x] [--packs core] [--max-items N] [--body-budget 12] [--raw-retention-days 180]

# 整轮（定时任务用）：stdout 末行 NEWSWIRE_JSON { message, parts, stats, picks, continuity }；--dry-run 不记推送；--defer-push 只给候选、不记推送（LLM 模式由插件按版面决定）
node engine/run.mjs --mode cycle --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite \
  --out ~/.dsh/newswire/out --raw ~/.dsh/newswire/raw [--overnight] [--min-corroborated 50] [--min-single 36] [--max-push 8] [--dry-run] [--defer-push]

# 改了 taxonomy.json 或源的 body 方式后重算（默认近 72 小时；stage=labels 只重算标签）
node engine/run.mjs --mode reprocess --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite --hours 72

# 导出数据集
node engine/run.mjs --mode export --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite --from 2026-11-01 --to 2026-11-07

# 试抓（不入库）：已配置的源，或一个 JSON 文件里的新源；stdout 末行 NEWSWIRE_JSON {...}
node engine/run.mjs --mode test-source --config ~/.dsh/newswire/sources.json --source jiemian --max-items 5
node engine/run.mjs --mode test-source --source-file ./new-source.json
```

## 失败分类
browser_unavailable、channel_unavailable（agent-reach 未安装）、dns、connection_reset、timeout、tls、http_404、rate_limited、bot_blocked、paywall、parse_error、unknown。每条带 hint。

## 已知限制
- agent-reach 的网页后端目前是 Jina Reader（mcporter 未配置 web-reader），走这条路时拿不到时间与热度信号。
- 美联社直取 403，只能走 browse；Jina 也被拦。路透正文需要登录，按付费墙处理。
- 加载慢的列表页（如路透）用源字段 `wait_for` 指定一个选择器，browse 等它出现再取（最多 15 秒）。
