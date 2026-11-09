# Changelog

English | [中文](CHANGELOG.zh.md)

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
