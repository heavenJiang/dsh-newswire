# Changelog

English | [中文](CHANGELOG.zh.md)

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
