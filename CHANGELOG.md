# Changelog

English | [中文](CHANGELOG.zh.md)

## 1.1.19 (2026-11-11)

- **Reddit and GitHub Trending**, also off by default and read through browse:
  - Reddit: today's top posts in r/LocalLLaMA and r/MachineLearning with 50 points or more. Written as Community discussion; the 6 highest-scoring posts have their page read for top-level comments (AutoModerator skipped). Reddit refuses logged-out requests, so it is read with your browser's session.
  - GitHub Trending: projects with 100 or more new stars today, written with the new Open-source project profile: what it is, who made it, highlights and who it suits, from the project README. Tagged "开源" in the panel.
- Source config upgrades to v8: only these three sources are added, and they start off.

## 1.1.18 (2026-11-11)

- **Background from earlier coverage for long-form tech.** After Horizon's history search, but over local storylines: up to 2 written storylines from the last 90 days, matched by title similarity and shared entities, are given to the model as H1, H2 and may be used only in Background. Only that block may rest on them when checking; the lead and points still rest on this story's reports alone. In the panel, "earlier" opens that storyline. No model call, no network. Any profile can use it by giving a block `materials: ["history"]`.
- **Impact analysis can search the web first.** browse opens the Bing results page (original HTML, unaffected by auto-translate) and the top results become background material; the model is told these are search snippets, not reports of the event. Numbers must still be found in the material. No paid search API is used. Turn it on in a profile with `search: { analysis: n }`; "AI and new technology" and "Long-form tech" search once by default. New engine mode `--mode search`.
- Hacker News points and comment counts are kept as heat only, not written into the summary; the body is fetched from the article. Before, an HN story not yet written showed a lead like "Hacker News 讨论：769 分…".

## 1.1.17 (2026-11-11)

- **Overseas tech sources**: Hacker News and nine tech blogs (OpenAI News, Simon Willison, Hugging Face, NVIDIA Technical Blog, vLLM, Lil'Log, Ahead of AI, Interconnects, GitHub Blog). After upgrading they appear in the Sources tab, **off by default**; turn them on yourself. All are read through browse; no paid API is used.
  - Hacker News uses a new `hackernews` adapter on the front page: only posts with 100 points or more, linked to the article they point to, so other outlets' reports of the same piece group with it. The 8 highest-scoring posts also have their discussion page read for top-level comments, which the Community discussion profile writes up as Community views.
  - Tech blogs use the Long-form tech profile; OpenAI News is official news and goes through "AI and new technology" by category.
  - Items from sources that declare a profile skip rule triage and rank higher when material is picked, so the model scores them with that profile's guidance. Before, such single-source posts scored too low by the rules to reach the model.
- **Community discussion is not an independent outlet.** New source tier `tier: "community"`: no source points, no "corroborated", and listed after the byline as "Discussed on Hacker News"; stories with only community discussion stay out of To verify.
- **The browser's auto-translate no longer pollutes English pages.** With auto-translate on, browse read the translated page: Chinese translations were inserted after English titles and the comment markup was scrambled. Adapters can declare `rawHtml` to read the server's original HTML from inside the page instead (Hacker News does).
- **Exa backfill is off by default.** Exa is a paid API; gaps are closed by paging back. To use it, set `"backfill": true` on a source.
- Source config upgrades to v7: only the sources added in this release are added, and they start off; trial channels you never added are not slipped in by the upgrade. Sources you edited are left as they are.

## 1.1.16 (2026-11-11)

- **Profiles can write their own parts.** Besides lead, points, views and impact, a profile can add a paragraph (`text`) or a few short lines (`list`), such as Background, Takeaways or Community views. Every part is checked sentence by sentence and failing sentences are removed. The panel shows them under More, and readers can flag these sentences too.
- **Two new built-in profiles**, used when a source declares them:
  - Long-form tech (`tech-deep`): tech blogs and long articles. Lead, technical points, background and takeaways; 3,000 characters of body, excerpted from start, middle and end. Tagged "长文" in the panel.
  - Community discussion (`community`): Hacker News-style threads. Lead and points rest only on the linked item, Community views only on the comments; numbers from comments cannot enter the lead. Tagged "社区" in the panel.
- Community comments are stored separately (database v25, `articles.comments`), not mixed into the body.

## 1.1.15 (2026-11-11)

- **Profiles: different kinds of stories are written differently.** After Horizon's profiles, adapted to storylines. A profile sets a story's scoring guidance, writing guidance, how its material is excerpted, and what impact analysis looks at.
  - Two are built in: "News" (the default) and "AI and new technology". The focus-area wording that used to sit in code now lives in Markdown files in the profile directory; the writing is the same as before.
  - Which profile a story uses: if all its items come from sources that declare a profile (new `profile` field in `sources.json`), that one; otherwise the highest-priority profile whose categories or sources match; otherwise "News".
  - A `profiles/<id>/` directory in the data directory replaces a built-in profile or adds a new one. `focus` in `layout.json` still works and overrides the name, categories and boost of "AI and new technology".
  - Each writing batch uses one profile, so the fixed part of the prompt is identical and hosted models' prefix cache hits. When a profile's writing changes, cached copy is rewritten.
  - Storylines record their profile, and impact analysis follows its focus.
  - Long articles can be excerpted from the start, middle and end (`head-middle-tail`), so conclusions are not cut off.

## 1.1.14 (2026-11-11)

- **Pushes go straight to the phone instead of through a model.** Until now the local model in the scheduled task had to copy the whole push into its reply. It failed to copy a 14,000-character push and sent stray `<tool_call>` markup to the phone instead, and did the same in rounds that had nothing to push. With dsh-switchboard 0.5.23 or later installed:
  - The plugin fetches and writes the edition on the scheduled task's timetable and posts it itself to the chats that get scheduled results.
  - The host's scheduled task is paused so no model steps in; it still sets the times.
  - If switchboard is missing, its "Let other plugins post to the phone" setting is off, or the panel's delivery is set to "Through the scheduled task", the scheduled task is resumed and pushes work as before. Neither plugin depends on the other.
  - The panel's Push settings have a new Delivery choice, Straight to the phone or Through the scheduled task; `newswire_push_prefs` takes it as `delivery`.
- **Model results are no longer lost.**
  - Each story is saved as soon as the model writes it. After a restart, interruption or timeout, the edition is laid out again and stories with the same material reuse what was written instead of asking the model again.
  - When the plugin restarts with a push still waiting for its edition, it carries on writing that edition instead of pushing an older one.
  - When the local model server drops the connection ("Connection error"), the call is retried once after 20 seconds instead of falling back to program-written copy.
- The 科技 section now holds up to 8 stories by default (was 3).

- **Telegram channels as sources.** A new `telegram` adapter reads a public channel's web preview (`https://t.me/s/<channel>`), with no login or API key. A channel that posts one story per message gives one item per message: the bold first line is the title, the 信源 link is kept as the original source, and views and reactions are recorded as signals. A roundup posted in parts (`[1/3] [2/3] [3/3]`) is joined back together and split into one item per story, and each item keeps the outlets it cites.
- Two channels are added to the built-in source list as trial sources: 币圈新闻汇总 (CryptoMarketAggregator, 市场与交易) and 动察 Beating AI (OneMillion_AI, 科技与AI). An existing install's source list is not changed. Add them in the panel to use them.
- **Adding a source recognises Telegram links.** Paste `t.me/<channel>`, `t.me/s/<channel>`, `@<channel>` or a link to any message, and the source is set up with the Telegram adapter, paging and continuity checks. Invite links (`t.me/+…`) are private channels and are not accepted.
- **AI and new technology come first.** The layout has a new `focus` setting, on by default for 科技 and AI 与半导体:
  - These items are picked first for the model to read, so the item limit does not cut them, and they skip rule-based triage, so a story with a single report is not missed.
  - The model rates them by the technology's impact rather than the number of outlets: how new it is, who released it, and what it changes for competition, developers, users, compute supply and related companies.
  - The front page keeps at least one such story when one scores 45 or more (the lead story stays), and a full section keeps up to 3 extra places for them.
  - Their impact line and points describe what the technology changes, and impact analysis looks at them first, from 10 points lower.
  - Set `focus.labels` to `[]` in layout.json to turn it off, or list other category ids.
- New paging mode `before` for gaps: the plugin pages back with `?before=<smallest message id>` until it reaches the previous round.
- Titles that mix Chinese and English, such as "Stripe完成收购OpenRouter", are no longer dropped as navigation links.

## 1.1.13 (2026-11-10)

- A story is a key story (🔴 重点) when the model rates its importance 60 or more. Tech, industry and followed stories no longer get a lower bar, so the model alone decides how much a story matters.

## 1.1.12 (2026-11-10)

The push message has a new layout. It is Markdown, which Telegram and Feishu both render.
- **Header**: date and time, then "汇总 HH:MM–HH:MM" (the period it covers) with the number of new stories and stories with new reports. The headline follows as a quote.
- **🔴 重点 first**, with more detail: a full lead (up to about 200 characters, cut at a sentence), up to 2 key points and the impact. A story counts as key at importance 60, or 55 for tech, industry and followed stories.
- **The rest by area**, briefly (one or two complete sentences): 💻 科技与产业 → 📈 市场与宏观 → 🌐 时政与国际 → 📌 其他.
- **Each story**: a numbered bold title, the text, then the source line. Outlet names are links to their own article, so the URL is not shown. Up to 3 outlets are listed, and an aggregator that reposts the same article is listed once.
- Leads drop the leading date and wire prefixes such as "17:49" and "ChainCatcher 消息，".

## 1.1.11 (2026-11-10)

- **A manual fetch now pushes too.** After 抓一轮 in the panel, or `newswire_run`, the plugin writes the edition and then sends one push, the same way 写完再推 does. It only pushes stories that have not been pushed yet, and it sends nothing when there are none. It needs the push scheduled task. With the cadence set to 只看晚间日报, a manual fetch still pushes nothing.
- **A 推送 button next to 抓一轮** pushes the latest written edition right away. It only pushes what has not been pushed yet, and when everything has been pushed it says so. It does not affect a round that is still being written.
- A pending push that is ready is now delivered whatever the push timing is.

## 1.1.10 (2026-11-10)

The model takes 9–19 minutes to write an edition, longer than the host's 10-minute limit for a scheduled task, so pushes often carried the previous round's edition. Two new push settings (panel → 关注与推送 → 推送, or `newswire_push_prefs`):

- **Timing**
  - `on_time` (default): push at the scheduled time, as before.
  - `when_ready`: the scheduled call only fetches, starts the edition in the background and returns an empty message, so nothing is pushed yet. Once the edition is written, the plugin runs the same scheduled task again, and that call pushes this round's edition. Each round sends one message, usually 10–20 minutes after the scheduled time, and everything in it is from this round.
  - If the edition fails or takes longer than 45 minutes, the latest written edition is pushed and the message says so. A pending push survives a host restart.
- **Content**
  - `picked` (default): stories over the bar, within the per-round and daily limits, as before.
  - `full`: every new story this round, plus every pushed story that has new reports. The bar and the limits do not apply. The message opens with a count line, and leads are trimmed to 80 characters.
- The scheduled task's instruction now says to reply nothing when `message` is empty. Existing tasks are updated automatically.

## 1.1.9 (2026-11-10)

- The same race could also leave `follows.json` damaged: a complete file followed by a leftover tail from the other write. Before, a damaged file read as "no follows", and the next save would wipe them all. Now the plugin backs it up once as `follows.json.corrupt`, keeps the complete part at the start, and the next save writes the file clean again.

## 1.1.8 (2026-11-10)

- Fix a crash that stopped the whole host: `ENOENT: rename follows.json.tmp -> follows.json`. When several theme trackers picked up new stories in one round, each wrote `follows.json` at the same time through the same temp file. The first rename succeeded and the others failed, and the failure was not caught, so the host exited.
  - Writes to the same file now queue up, and each write uses its own temp file.
  - Changes to follows and settings are now read, changed and saved one at a time. Before, two changes made at the same moment could overwrite each other.
  - Background work (tracker follows, editions, daily digests, prewarm, saving settings) now logs its errors instead of crashing the host.

## 1.1.7 (2026-11-10)

Four problems from trial use:

- **Scheduled push failed with `value is not lossless JSON`**:
  - Cause: `newswire_cycle` returned fields whose value was `undefined` (`edition.waited` is `undefined` whenever the wait does not time out). The host accepts only lossless JSON, so it rejected the whole result.
  - By then the pushes were already recorded, but the message never reached the phone.
  - Every tool's result is now converted to lossless JSON. The smoke test checks all 22 tools with the host's own rule.
- **Hard to tell this round from earlier content**:
  - The masthead adds a line: "Since the last edition (time): N new · M developing · K unchanged", with a "Changes only" filter.
  - Every story is tagged new or developing. Unchanged stories have grey titles.
  - The previous edition is counted per fetch round: a round's program preview, progress versions and re-layouts after follow changes count as one edition.
  - While the panel is open it checks for a newer edition every minute. When a scheduled round or a background layout finishes, a banner offers it. A program preview is replaced at once.
  - The past-editions list shows one edition per round, not a run of duplicates with the same headline.
- **Key stories did not stand out**:
  - A "Key stories" box at the top lists the most important stories, one line of title and one sentence each.
  - Stories with importance 70 or more get a red "Key" tag.
  - Section stories are tiered by weight: 60 or more get the full card, 45–59 get the title and two lines, below 45 only the title.
  - The masthead story count counts only the stories laid out on the page.
- **Web-page sources moved on before more content loaded**:
  - The browser used to scroll 3 screens with a 0.9 s wait each, then read. The 同花顺 home page takes over 2 s per batch, so the next source started before new items appeared.
  - Now each scroll waits until new content actually appears (up to 6 s). Scrolling stops after two screens with nothing new.
  - Scrolling also stops once 5 links from the previous round are on the page, because the round has connected with the last one.
  - Home-page and list sources now record how many items overlap the previous round. Zero overlap is noted as a possible gap. After the first round they read up to 60 items (was 20).
- Items with only a date in the link (such as 同花顺) all showed "00:00" and were listed as a story's first source. Items first fetched on that same day now use the first-fetch time.

## 1.1.6 (2026-11-10)

Fixes from checking original pages for all 44 sources, including removed ones:

- **Whole-page text must match the title to count as the body**:
  - The reader and the browser read the whole page. The title's key terms must appear in the text, and the opening must relate to the title.
  - Thresholds come from measured data: real articles score ≥ 0.1 even with editorial headlines; junk scores ≤ 0.03.
  - Junk now recognized and rejected: the market ticker on 华尔街见闻 flash pages, AP's donation box, FT paywall pages, and the 巨潮 page template.
  - Matching the title line is not enough on its own: on flash pages the title line is the whole story, and what follows is something else.
- **Charsets**: pages are decoded by the charset in the response header or page, so GBK sites (such as regional 中新网 sites) are no longer garbled.
- **巨潮 announcements** are read from the announcement PDF. The detail page is only a front-end template with no content.
- **JSON-LD truncated by the site** (链捕手 keeps only the first 1,200 characters): the article container is used when it is longer.
- **Paywall prompt pages** ("Try unlimited access", "订阅后阅读") are recorded as paywalled, not taken as the body.
- **Leading and trailing boilerplate** is removed:
  - license numbers, copyright, abuse-report contacts, "about / contact";
  - publish time, view counts, font-size buttons;
  - membership upsells, "listen", share buttons, the "xx on X:" prefix;
  - `&emsp;` and similar entities.
- New sources whose list looks complete get 2 original pages checked in the first round, so "the list is only a summary" (true of most RSS feeds) is found sooner.
- The 1.1.5 migration also re-checks stored bodies by these rules; mismatches are voided and fall back to the list text.

## 1.1.5 (2026-11-09)

- **Full text judged source by source**:
  - Sources whose list already carries the full text (like Cailian wire flashes) get one original page checked per round, up to 3 in 7 days, to confirm they match. If the original pages are clearly longer, the list was only a lead, and the source switches to fetching bodies.
  - Sources whose full article is a click away (like 10jqka and TechFlow) get a body fetched for every item that lists only a title or a one-line lead.
  - Runs → Content completeness lists every source with how its full text is obtained and how that was decided.
- **Cleaner body extraction**:
  - Article containers are recognized first, so one- or two-sentence flashes are captured whole instead of falling back to the reader.
  - When the reader reads a whole page, text starts at the article's title line. Disclaimers, related-headline lists, live news feeds, comments and social links are cut. Before this, a short flash could pick up neighboring headlines from the sidebar as its body.
  - Bodies already stored are cleaned with the new rules.
- **Completeness fixes**: a "summary" that is only a date, or a headline ending in "!" (often clickbait), no longer counts as complete, so its body is fetched.
- Program-built leads end at a full sentence instead of breaking off with an ellipsis.

## 1.1.4 (2026-11-09)

- When adding a source with a very short domain (x.com), the id uses the full domain (`x_com`, `x_com_reuters`) instead of `s_x`; the matching test is fixed (one 1.1.3 unit test failed on this).

## 1.1.3 (2026-11-09)

- **Learning starts automatically when adding a source**: if the generic test fetch can't read the page and a model is available, the model is asked to learn parsing rules right away, with no extra click; "Let the model try again" retries.
- **Bare domains work**: `x.com` or `www.stcn.com/...` get `https://` added, and duplicates are checked on the completed URL.
- **Fixed learning the x.com home page**:
  - The timeline loads late, so the page outline used to be taken before any posts appeared. Outlines, and the snapshots used for model page reading, now wait until the page text has been stable for two seconds (up to 15 seconds).
  - The output limit for learning rules went from 3,000 to 8,000 tokens, so thinking models are no longer cut off.

## 1.1.2 (2026-11-09)

- **Unlimited: the model reads every web page**:
  - New "Unlimited" model effort on top of Deep: the model reads each web-page source directly every round, with no parsing rules, so site redesigns don't break anything.
  - No invention: links reach the model as numbers and it can only point to them; titles and times are copied from the page and summaries are cut from the original text by the program; every item is checked and failures are dropped.
  - No daily token budget applies. RSS, APIs and dedicated adapters stay with the program.
  - Reading follows a time budget, and sources it can't reach or fails to read are fetched by the program as usual. Prewarming before scheduled pushes accounts for reading time.
  - Runs → Model shows the latest reading: sources read, items found, items dropped by checks, and time taken.

## 1.1.1 (2026-11-09)

- **Let the model learn a page**:
  - For pages the generic parser can't read (an X feed, say), click "Let the model learn this page" under Add a source.
  - The model reads the page structure and writes parsing rules (CSS selectors). A test fetch verifies them, and if they fail the model gets the results and tries once more.
  - Once learned, the program follows the rules every round with no model calls.
  - On Balanced and Deep, a source that parses nothing two rounds in a row is relearned automatically, at most once a day per source.
- **Stricter test fetch**: one or two items such as a login page or navigation no longer count as success; the panel says they look wrong and offers to let the model learn the page.

## 1.1.0 (2026-11-09)

- **Scheduled pushes no longer time out**:
  - The harness waits at most 10 minutes for a tool call, while a slow local model needs over ten minutes per edition, so pushes used to time out without model results.
  - The plugin now prepares the edition ahead of each scheduled push, using how long recent editions actually took, so the push only adds the last few minutes.
  - Each round has a time budget (`cycleBudgetMs`, 9 minutes by default). If time runs short, it sends the edition the model has finished so far and keeps writing in the background.
  - Task prompts tell the agent to allow 10 minutes, and existing tasks are updated automatically.
- **Add a source**: "+ Add a source" at the top of the Sources tab. Enter a name and URL, test-fetch to preview, then add it on trial. Type, region and id are worked out for you, and duplicate URLs are rejected.
- **No more duplicate follows**: when you track a theme, its storylines show as one row under Following (e.g. "theme · AI与数据中心 · 6 storylines") and can be removed in one click.
- **Look and feel**:
  - A light page with content on cards, a masthead with a brand mark and stat chips, a marked top story, and a color for each section.
  - Credibility as colored badges, a red dot on major stories, and the markets box colored by direction (up red, down green, as in Chinese markets) with arrows.
  - Your follows in their own accented block; Tracking, Push and Sources pages use the full width.

## 1.0.0 (2026-11-09)

First public release of 见微知著 (Newswire).

- **Edition**: news from dozens of Chinese and international outlets, read by a language model and laid out as a newspaper-style edition. Reports on one event form a single storyline that carries across editions, Chinese and English reports included, and reposts are labeled. The top shows what changed since your last visit.
- **Citations and checks**: every sentence the model writes names the reports it rests on. Numbers, foreign names and quoted words are checked by the program, and sentences that fail are dropped. Readers can flag errors.
- **Tracking**: follow companies, technologies, people or themes over time. Related storylines attach automatically, and the model writes an incremental synthesis covering current state, trend, milestones, impact and possible paths. It also suggests subjects worth tracking.
- **Impact and outlook**: major stories get a projection of their effect on markets, companies, industries and policy, with possible paths and signals to watch.
- **Ask the news**: search the local store and get a cited, time-ordered answer from the model.
- **Pushes and digest**: phone pushes through Telegram or Feishu with adjustable cadence, thresholds and caps, tuned automatically by useful / not-useful feedback. An evening digest arrives every day.
- **Content quality**: full-text recovery, roundup splitting, ad and paywall-teaser filtering, and a completeness label on every item. Market ticks go to a separate markets box.
- **Continuity**: each source resumes where the last round stopped and pages back to close gaps. Unfilled gaps are recorded and listed in exports.
- **Source scorecards**: each source gets a scorecard and can be set to on, trial or off. 33 sources ship in two packs, core and study abroad.
- **Model runtime**: incremental processing, cache-friendly prompts, measured concurrency, three depth levels, and an optional daily token budget with a call ledger. A save-tokens mode makes no model calls at all.
- **Data**: local SQLite storage with full-text search and day-by-day history, plus dataset export.
