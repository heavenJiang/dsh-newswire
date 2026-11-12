# Changelog

English | [中文](CHANGELOG.zh.md)

## 1.1.37 (2026-11-12)

Reader request: for new tech, especially AI and large models (company news, new papers, newly released models), skip multi-source corroboration and get first-hand information.
- **Find the original.** After each fetch, for AI and new-tech items (the layout's focus area), the aggregator's item page is opened, its source link ("打开原文", "信源", "原文链接", "view on X") taken and the original read back. On the last day's 45 items: 15 from the AI hot list had a source, 11 of them the publisher's own (Google DeepMind's blog; DeepMind, Tencent Hunyuan and MiniMax on X; Databricks' blog). Cailian and ChainCatcher flash pages carry no source link, so nothing is found there. X posts keep only the post, not the replies below it.
- **Copy follows the original.** The original is part of the material (tagged 【原文（site）】) and the fact check accepts it; the AI and new-tech writing rules now say facts, figures and names follow the original, the lead says who published it where, and no "only one outlet" or "unconfirmed". Detailed reports and impact analysis get the original too. A story already written is rewritten once its original is found (before, with no new reports the old copy was reused as is and the original never used).
- **No outlet counting.** AI and new-tech stories with one outlet no longer go to "To verify"; their push bar is the lower of the two, never raised for having one outlet.
- **The original is visible.** Each story's byline ends with "first-hand · deepmind.google" or "first-hand · X @GoogleDeepMind" (green, the publisher's own) or "original · the-decoder.com" (blue, an earlier report), linking to it; pushes list the original first.
- **Fix: the recap never wrote itself.** The 1.1.35 "program recap after each edition" and "model recap at 21:30" called a function that was never imported and failed every time with `latestDaily is not defined`, so neither ever ran. The import is added.
- Database migration v29: articles gains origin_url / origin_site / origin_text / origin_at. The engine takes `--origin-budget` (items per round, default 16, 0 turns it off).

## 1.1.36 (2026-11-12)

A review of the model's copy (156 stories over two days): accuracy is good (97–99% of sentences pass the fact check, no fabrication found); the problems are information density and material choice. This release changes both:
- **Material covers the origin and the latest.** Big storylines used to give the model only the earliest reports: in an 18-report story about a Houthi attack on Riyadh, the lead stopped at the first "explosions heard in Riyadh" and missed that the Houthis had claimed four rounds of strikes. Writing now keeps the earliest report for context and fills the rest with the newest; near-duplicates (reposts, updated flashes) keep only the longest; if one outlet dominates, another outlet's newest report is swapped in. Material is still shown to the model in time order.
- **Leads give the current state, without a date opener.** The lead must say where things stand now, with the background in passing, and must not open with "11月12日，" (77% did; the edition and pushes already show times). The program strips such an opener too.
- **Points, views and impact may not restate the lead.** Before, 49 of 447 points reworded the lead; of 233 views, 85 repeated it and 44 named the reporting outlet as the speaker; impact often restated the fact. The writing rules now spell out "only information not in the lead", "who is the person or body taking a position; an outlet only when outlets' figures disagree", "impact is a consequence, not the fact", and "'did not respond to requests for comment' is not a view". The program filters again: points and views that nearly repeat the lead, impact that restates it, and link-only or "details at…" points are dropped. A view carrying a number not in the lead is always kept, since disagreeing figures are what readers need.
- **One-line flashes get a lead only.** When every report is at most 120 characters and all together under 200, the model is told to write only the lead. Before, 39 of 49 such flashes got filler points such as "reported by X".
- **Misgrouped material is ignored.** The model is told to skip material that is not about the same event; in testing, an Altman podcast no longer leaks into a story about a maths proof.
- Measured on a local model, old vs new on the same six storylines and the same sources: five clearly better, one (a single 286-character report) worse at first because the one-liner threshold of 300 characters was too high; with the threshold above it got its points back.
- The writing cache version is bumped: storylines with new material are rewritten under the new rules, untouched ones keep their copy.

## 1.1.35 (2026-11-12)

Nine problems a reader pointed out, each fixed:
- **Every timeline is newest first.** Storyline detail (reports, updates, pushes), tracker detail (storylines and single reports), tracker milestones, the detailed report's timeline, event detail reports, each round in Timeline, and the expanded updates and detailed report on the phone.
- **Buttons by weight.** "Text" in a timeline is now a blue "Show text ▾" on its own line; "Not this story" sits at the end of the row and asks "Move this report out of the storyline?" before doing anything. The tracker's "Not this story" works the same way. "Full analysis", "More: views, impact and sources" and "Expand all" are blue links; grey is kept for feedback actions such as mute and report.
- **"Markets" in the right column becomes "Latest".** The market box was filled once per edition, and a local-model edition takes 20–30 minutes, so it was always stale. The new column does not wait for the edition: it updates after every fetch, newest first, one entry per event, skipping low-scored single-outlet items, at most 3 per source; items the edition has not covered yet are marked "new"; clicking opens the storyline (or the original when there is none).
- **Back returns to where you were.** Opening a storyline or tracker from Today, Recap or Tracking and coming back keeps the list loaded and restores the scroll position (measured: opened at 5635 px, back at 5635 px).
- **The recap writes itself.** After each edition the program puts together "today so far" (no model call, a second or two); after 21:30, with the model idle, the model writes the full recap, and the program version never replaces it. Opening a past day with no recap builds one on the spot. Recap opens on today, and a program-made recap says the model version comes in the evening.
- **Quiet trackers explain themselves.** 华谊兄弟 and 中科曙光 never updated because every report about them came from sources that are now off (股吧, 雪球) and none made the edition, while tracking only counted storylines. Company, technology and person trackers now also list single reports that mention them (tagged "single"); after two days without a mention they say how long the sources that are on have been silent, where the last mention came from, whether that source is off, and offer "Turn it back on (trial)". With no storylines, the synthesis button that could not work is gone. Themes do not list single reports (their keywords are too broad).
- **Events opens the first item.** On wide screens, Events and Timeline show the first event on the right right away, with the storyline's impact analysis when there is one.
- **Fixed: publish times in the future.** "11月13日" in a 36kr flash about a car launch on 13 November was taken as the publish time, so the item sat at the top of Items for days. A publish time more than an hour after the fetch is no longer accepted; the fetch time is used, and existing rows are corrected by a migration (v28).
- **Fixed: a newly added source did not appear.** The source list came only from the database, which learns about a source on its next fetch. It now comes from the source config, with new sources first and marked "just added · data after the next fetch".

## 1.1.34 (2026-11-12)

Two real rounds on a local model, on a copy of the data, and what they showed:
- **"Done but incomplete" is no longer a green check.** In one round, 4 writing batches timed out and only 11 of 23 stories were written, yet the chart showed a green check. Such a step now gets an amber mark with how many were written, how many batches failed and why (timeout, over the time budget, malformed model output), and that those stories use program copy until the next round; the round reads "Done, 1 step incomplete". Grouping batches that failed and a failed front-page plan are shown the same way.
- **Grouping shows which batch is running.** One batch takes three or four minutes on a local model, and the count used to sit at 0/4.
- With the flow line showing, the note above the edition no longer repeats the written count.

## 1.1.33 (2026-11-12)

- **See which step a round is on.** A round on a local model takes ten to twenty minutes, and the panel used to say only "laying out". A round is now a flow chart of three phases and 12 steps:
  - **Fetch**: prepare → fetch sources (each source's result and new items) → clean & split → classify & cluster → fill bodies
  - **Edition**: translate titles → group storylines (which batch) → front page (or "little changed, kept the last one") → write (how many written, which ones now) → fact check (sentences checked, dropped) → lay out & save
  - **Push**: sent to the phone / push when written / handed to the scheduled task / not pushed this round, and why
  - Each step shows its state (done, running, skipped, failed), time taken and one line of detail; steps not yet started show an estimate. Estimates come from each step's last 8 real durations (model and program layouts counted separately); on a first run without history, progress is counted by steps.
- **Where.** At the top of Today, while a round runs (or within 10 minutes after): one line with the trigger, current step, time so far, time left and overall progress, and "Show flow" for the full chart; the edition reloads when the round ends. The Runs page keeps the current (or last) round's full chart at the top. Phases sit side by side on wide screens and stack on narrow ones.
- **Ask from the phone.** `newswire_snapshot` includes a text version of the flow, so asking the assistant "how far is the news" or "why no push yet" gets the current step and time left, or how the last round ended.
- Every trigger feeds the same flow: scheduled rounds (the plugin's clock or the host task), manual fetches, pre-push warm-ups, re-layouts, push-when-written, and the panel's Push button. A round with no activity for 45 minutes is marked interrupted instead of running forever.

## 1.1.32 (2026-11-12)

- **A missed slot is caught up.** When the plugin pushes on its own clock it fires only in the exact minute of a slot; if the host is restarting, the plugin is being upgraded or the computer is asleep at that minute, the round was lost until the next slot two hours later. It happened in real use: today's 09:00 round (Beijing time) did not run because the host was down for those minutes. Each clock check now looks back: if a slot was missed within the last 75 minutes, no round has run since, and no push is being written, it runs once. A slot is caught up at most once; beyond 75 minutes it waits for the next one. This applies to direct pushes only (rounds triggered by the host's scheduled task are the host's business).

## 1.1.31 (2026-11-12)

More problems found from real results:
- **The morning push is on time.** This morning's 7:00 push arrived at 7:16: 136 items had piled up overnight and that edition took 21 minutes, while the head start came from the median of ordinary editions and was only 11 minutes. When the last model edition is 5 or more hours old, the head start now follows the slowest of the recent editions, at least 25 minutes and at most an hour.
- **Alias linking is stricter.** A storyline used to be linked to a tracker if a single report's title mentioned an alias, and a storyline with dozens of reports nearly always has one that mentions some company in passing: "Anthropic roadshow" (93 reports) and "US October CPI" (33) ended up under an Nvidia theme, so the front page's tracking strip showed an off-topic latest item. The alias must now be in the storyline's headline, or in at least 30% of its report titles (one is enough for a storyline of one or two reports). A one-time cleanup after upgrading removes links made the old way; on a copy of real data it removed 9.

## 1.1.30 (2026-11-12)

What the first scheduled direct push showed in real use:
- **A push now has a ceiling.** This morning's 07:16 push carried 111 items and 15,638 characters ("everything new" plus 9 hours overnight); Telegram turns a message that long into a file attachment, which nobody reads. The "short push" from the last releases had only been tried on two-hour daytime rounds. One message now spells out at most 12 items with a sentence and a source, then 18 as headlines only (one line each, still numbered and expandable by reply), and gives a count for the rest by area. When there are only a few more than 12 (up to 4), all get a sentence. Recomposed from this morning's edition: 56 items, 2,280 characters. Unlisted items are still recorded, so a later upgrade or development is pushed as usual.
- **Ranked by importance, with 10 points for what you follow.** Followed items used to come first unconditionally; with many follows, trivial ones pushed real news down. After re-ranking, "dollar at an 18-month high" and "Trump open to resuming Iran talks" made the top 12, and a minor followed item moved to the headline-only tier.
- **No sentence when there is nothing to add.** The line under a headline is dropped when it merely restates the headline, or when it is an untranslated foreign-language summary.

## 1.1.29 (2026-11-12)

Housekeeping, no behaviour change:
- **The edition module is split.** `host/edition.mjs` (1641 lines) becomes four files by responsibility: `edition_base.mjs` (layout, materials, fact checks, assembly, the program-made edition), `edition_llm.mjs` (the model's prompts and incremental layout), `edition_store.mjs` (storage, diffs, storyline detail) and `edition_push.mjs` (picking pushes, numbering, composing messages, the ticker board). `edition.mjs` stays as the entry and re-exports everything, so imports elsewhere are unchanged. The last three depend only on the base and not on each other. Like the entry file, the split was mechanical; afterwards the 237 tests, the smoke tests and a call to each of the 37 routes and 23 tools all pass.
- `client.js` is not split: the host wants the panel as one file with no build step, and adding a bundler is not worth it.
- The README shows the check status badge.

## 1.1.28 (2026-11-12)

- **Sources that keep failing are throttled.** After 3 failed rounds in a row (timeout, blocked, redesigned page) a source is skipped in normal rounds and retried every 6 hours; one successful fetch puts it back to normal. Before, every round tried again: each timeout cost at least 30 seconds, the panel kept showing "1 source failed", and every push ended with the same warning. In real data one X account source had timed out 10 rounds in a row. The Sources page says how many rounds a throttled source has failed, why, and when it will be retried. Fetching a source by name and the panel's test fetch are not affected; no extra state is stored, it is derived from each round's continuity records.
- **Checks run on every commit.** GitHub Actions now runs the syntax check, 237 unit tests, the panel render smoke test and the grouping quality baseline, with no network and no model. The tests pass under UTC, Beijing and US Eastern time.
- Fixed: two digest tests failed during the first ten minutes after midnight Beijing time (test data dated "ten minutes ago" fell on the previous day). Tests only; the feature was not affected.

## 1.1.27 (2026-11-11)

- **When the story moves on, so does the headline.** A storyline's headline was fixed when it was first grouped; later reports only rewrote the lead and points, so a headline could say "shares plunge" over a lead about the rebound. When a storyline with new developments is rewritten, the model may now give a headline that fits the present (none if the old one still holds). A new headline must pass three checks: 6 to 24 characters; its numbers and names appear in the sources; and it is about what the new lead says (at least 30% text overlap). Otherwise the old headline stays. The edition where it changed shows the previous headline under the story. Measured on a local model with three storylines: the two whose direction had not changed got no new headline, the one that had changed got one that passed the checks. It rides on the same writing call, so no extra model calls.

## 1.1.26 (2026-11-11)

- **Themes carry their own search keywords.** A theme tracker ("Nvidia turmoil", "AI and data centers") has no ready-made aliases the way a company does, and after the stricter linking rule in the last release it could only grow through a same-named edition theme, so it stalled easily. Keywords are now taken from the name (dropping tails such as 风波 or 进展), and new reports whose titles carry one are linked. A keyword must be specific: generic words (AI, market, tech…) are refused, and so is anything found in more than 6% of the last 7 days' storyline titles. This happens when a theme is created; existing themes without aliases get theirs when the next edition comes out. On a copy of real data, 5 of 6 themes got a keyword and linked 1 to 26 on-topic stories from the last two days.
- Not adopted: having the model read a theme's existing headlines and propose keywords. It also returned words that merely co-occurred (Iran and UFC for a Trump theme, the foreign ministry and Congress for an Nvidia theme), which pulled in unrelated stories. You can still add aliases to a theme by hand.

## 1.1.25 (2026-11-11)

Housekeeping, no behaviour change:
- **The entry file is split.** `index.js` goes from 3186 lines to 1245: module-level helpers (settings and paths, source config I/O, the engine subprocess, source validation) move to `host/core.mjs`, the 37 panel routes to `host/routes.mjs`, and the 23 model tools plus the system prompt section to `host/tools.mjs`. The entry keeps the config schema and one run's state and flow (model queue, editions, pushes and the clock), handed to routes and tools through one `app` object. The split was mechanical: text cut by statement, each file's references computed by scope analysis, no logic changed; afterwards every route and tool was called once on a copy of real data with no reference errors.
- Fixed: the first-run endpoint (`/api/newswire/onboard`) referenced a variable that did not exist after saving preferences, so it returned an error (the preferences were saved). The scope analysis for the split found it.

## 1.1.24 (2026-11-11)

What you track comes first, and two tracking bugs that made the data drift are fixed:
- **Tracking at the top of the front page.** Today's edition starts with the trackers that got new reports in the last 24 hours (up to 4): name, how many new, the time and headline of the latest, and the current-state line from the summary. Click to open that storyline.
- **"New" in tracking means a new report arrived.** It used to follow the storyline's update time, which every edition refreshes for every storyline on the board, so nearly everything counted as new. That was the root cause of summaries being rewritten every round. It now follows the time the last report joined.
- **Themes no longer snowball.** A theme tracker used to take over a whole edition theme if a single story overlapped; after a few days each theme had over a hundred near-identical stories (SpaceX reports under an Nvidia theme). Now the edition theme must have the same or a similar name, or at least half of its stories (and at least two) must already belong to the tracker. Core entities also link stories: an entity present in at least half of the tracker's storylines (Nvidia in an Nvidia theme) brings in new storylines that carry it. **A one-time cleanup runs after upgrading**: links made by the old rule are removed (stories added when the tracker was created, links by alias or entity, and your own removals are untouched). On real data it removed 805 links, leaving each theme with its original 3–7 stories to grow again under the new rule.
- **Rewritten detailed reports mark what is new.** Timeline entries, key numbers, views and open questions that were not in the previous report are marked "new", with a count at the top; the phone version marks them with 🆕. Matching is by text similarity, with no model call.
- **A hint for single-outlet sections.** The Sources page says so when 85% or more of a section's storylines in the last 24 hours (at least 5) have one outlet, since corroboration and differing views cannot work there.
- Fixed: the program-made preview listed the same storyline twice under "Worth watching"; the "upgraded" push reason was untranslated.

## 1.1.23 (2026-11-11)

Pushes were too long and feedback too rare (3 votes on 265 pushes). Both change together:
- **Short pushes, expand by replying.** By default each pushed item is a headline, one sentence and one source link, with a number that is unique for the day (numbering continues through the day, so rounds never collide). On the phone, reply `3` for the lead, every point, views, impact, recent updates and sources; `3 详` for the detailed report, written in the background if there is none and then sent; `3 有用` / `3 没用` for feedback; `3 追踪` to follow the story. When the plugin can post to the phone it answers by itself (the tool returns `sent: true` and the model replies with just ✓); otherwise the message goes back for the model to relay verbatim. New tool `newswire_reply`; push preferences gain `format` (brief / full, default brief), and the long format is under Push → Length. The database moves to v27 (`pushes.n`).
- **Trackers with movement come first.** Items in a round that belong to something you track are listed in one line under the headline; trackers with at most 3 hits are also tagged on their items.
- **Feedback without extra taps.** Expanding an item, asking for its detailed report, following it, or opening a pushed storyline in the panel each count as interest, worth half a "useful" vote in the per-section threshold adjustment (once per storyline, kind and day). The Push page shows how many items were pushed in the last 14 days, how many were voted on, and how many were expanded or opened.

## 1.1.22 (2026-11-11)

A slow local model with many things wanting it. This release sorts out who gets the model first, and which route a push really takes:
- **Push path check.** The top of "Follows & push" lists each step: whether the Switchboard direct-send service is there, whether it can send, the delivery setting, the schedule, whether the plugin has taken over the clock, the result of the last direct send, and pushes in the last 24 hours. Broken steps say why and how to fix them. Before, when the service was present but its "schedule chats" were empty, the panel only said Switchboard was not installed, and pushes kept going through the model relay (which times out and rewrites). The `newswire_push_prefs` tool returns `health` too.
- **One queue for model work, the reader first.** Every model call takes a slot (as many slots as the measured concurrency) by priority: what the reader asks for (detailed report, impact analysis, Q&A, rewriting a tracker summary by hand) → editions and digests for a push → pre-warming, automatic analysis, model page reading → tracker summaries and parser repair. A job keeps its place for 1.5 seconds between two of its calls, so lower-priority work cannot slip in. Measured with an edition running: a detailed report started right after the call in flight (about 90 seconds) and the edition resumed after it. The edition view shows what the model is running and what is waiting. Automatic analysis and tracker summaries no longer mark the model as busy, so the next edition does not wait for them.
- **Tracker summaries are not rewritten every round.** Three days of the call log: 92 summaries for 8 trackers, more than 20 each for four broad themes. Automatic summaries are now at least a few hours apart (Lean 12, Balanced 8, Deep 6, Unlimited 4); inside the gap only a new story of importance 80 or more triggers one, and trackers with the most new stories go first.
- **Model calls that are not worth it are not made.** Writing takes more than half of each round's model time, and part of it was wasted. Three rules: (1) a storyline with one report of at most 160 characters and importance under 60 is not sent to the model (it would only reword the sentence) and uses program copy; 15 of the 79 storylines written by the model in the last day were like this. (2) A storyline that has model copy, is not on the front page and has importance under 60 keeps that copy (still checked sentence by sentence) while fewer than 2 new reports, and fewer than a quarter of what it had, have joined since; the update line says what was added, and it is rewritten once enough accumulate. (3) When front-page storylines have nothing new, every changed storyline ranks below the front page, at most 6 changed, and the last plan is under 3 hours old, the headline, front page and watch list are kept, saving one planning call (about a minute). New layout fields: `story.rewrite_min` / `rewrite_ratio` / `brief_chars` and `plan.reuse_hours` / `reuse_changes`; 0 turns each off.
- **Daily cleanup of tables that only grew.** Editions: all of the last 48 hours, then the last one per pack per day, nothing past 30 days (editions were over a third of the database). Model call log, fetch attempts and ranking observations: 30 days. Detailed reports: the latest 2 per storyline; impact analyses 3; tracker summaries 5 per tracker. Articles, storylines, push records and feedback are untouched. The file is compacted after a large cleanup.

## 1.1.21 (2026-11-11)

Copy was too short to learn the details. Three changes:
- **Big stories get more key points.** When a storyline has 4 or more reports and enough text between them, writing reads 10 of them (was 6) and allows up to 6 points of 60 characters (was 3 of 40), with an instruction to cover what happened, the key numbers and what each party did. Stories with one or two reports stay as they were: the originals are that short, and longer copy would have to be made up. On real data, "tankers on fire in the Strait of Hormuz" (39 reports) and "Russia–US–Ukraine talks" (19 reports) went from about 150 to about 310 characters, all checks passed. New layout `story` fields `rich_items` / `rich_points` / `rich_point_chars` / `rich_materials`; `rich_items: 0` turns it off.
- **Original text in the storyline view.** Each report in the timeline has a "Text" toggle that expands its body (or summary), plus "Expand all".
- **New detailed report.** In the storyline view, "Write detailed report" has the model read every report in the storyline (near-duplicates keep only the longest; up to 20 reports and 12,000 characters) and write an overview, a timeline, key numbers, who said what, background, and what is disputed or unconfirmed. Every sentence is checked against the originals; sentences that fail are removed, and citations link to the originals. It runs in the background (about 2–4 minutes on a local model), and you're told when new reports make a rewrite worthwhile. On three real storylines it wrote 1,100–1,300 characters with every check passing. Database schema v26 (new `story_details` table). The `newswire_story` tool includes the detailed report, if written, and the opening of each report's text.

## 1.1.20 (2026-11-11)

Fixes from running the new profiles on real data with a local model:
- Checking now counts the material's source name. Long-form tech leads say "NVIDIA Technical Blog 介绍…" as asked, and used to be flagged unverified because the source name isn't in the body. Sources not in the material are still flagged.
- Profiles that need long material (long-form tech, open-source projects) always fetch the article body before writing. A GitHub project's one-line description used to count as complete, so its README was never fetched and the copy came out thin.
- Long-form tech, community and open-source copy no longer says "材料称" ("the material says") or similar.
- Reddit r/MachineLearning now takes the week's top posts with 30 points or more: it has few posts a day, so the daily 50-point bar often returned nothing and was logged as a failed fetch. Sources already in your config keep their settings; change the URL and threshold in the panel if you like.

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
