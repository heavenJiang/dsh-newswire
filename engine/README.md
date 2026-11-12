# dsh-newswire engine

English | [中文](README.zh.md)

Plain Node.js (22 or later, only the built-in `node:sqlite`, no third-party dependencies). The plugin runs `run.mjs` as a subprocess; it also runs on its own.

## Layout
```
engine/
  run.mjs               CLI: fetch (one round into the database) | cycle (full round + push message) | reprocess (recompute labels and events) | export (dataset) | test-source (trial fetch, nothing stored)
  taxonomy.mjs          Topics: labels, regions, entities, number tokens, counting units
  cursor.mjs            Continuity: checks, checkpoint advance, look-back window
  export.mjs            Dataset export (articles / events / manifest)
  retention.mjs         Raw snapshot compression and deletion by day
  lock.mjs              Cross-process file lock (dataDir/run.lock)
  config.mjs            Source config loading and upgrades (new sources and fields merged in, old file kept as .bak)
  bins.mjs              External command detection: browse / agent-reach / mcporter (explicit path → PATH → common locations)
  constants.mjs         Channel constants (no side effects; safe for the host side)
  query.mjs             Read queries shared by plugin tools and panel routes
  channels/
    browse.mjs          browse CLI: status / session / execute; page scripts per mode (rss / html_index / cls_api / html / article)
    agent_reach.mjs     agent-reach: feedparser from its venv for RSS; the web backend doctor reports (web-reader MCP or Jina Reader) for pages
    http.mjs            Plain requests and jina (r.jina.ai)
    classify.mjs        Failure classes (error_kind + hint); error text scrubbed of local paths
    exa.mjs             Backfill search (Exa through mcporter)
  adapters/             Site adapters (whole page HTML → items + source heat)
    techflow.mjs jiemian.mjs thepaper.mjs apnews.mjs telegram.mjs   index.mjs registry   _util.mjs
  parsers/generic.mjs   Generic parsers: RSS/Atom, HTML links, Markdown, JSON API (with signal field mapping)
  pipeline/
    fetch.mjs           Channel chain for one source (no database; shared by trial and real fetches)
    ingest.mjs          One source, one round: fetch → continuity → paging / search backfill → store → continuity, gaps, checkpoint
    paging.mjs          Paging backfill: param / cursor / id_walk / before
    events.mjs          Classify → cluster events → cross-validate and score; reprocess
    bodies.mjs          Body fetching and extraction for top events
    select.mjs          Source heat, event selection for push, the phone message
    normalize.mjs       Raw item → stored record (dedup key, time confidence, titles for untitled flashes, navigation-label filter)
    signals.mjs         Heat signal normalization
    digest.mjs          Digest Markdown and JSONL/CSV export
  store/
    schema.mjs          Tables and migrations (PRAGMA user_version)
    db.mjs              Writes
  config/sources.json   Source seed (copied to dataDir on first run)
  config/taxonomy.json  Topic seed (same)
  queries.sql           Troubleshooting SQL
```

## How much to fetch: continuity first

A round does not fetch a fixed number of items; it **fetches until it reaches where the last round ended**. A source with a continuity cursor keeps everything newer than the last round's newest item, up to 300 per round; Cailian pages back in time until it passes 5 minutes before the last round's newest item (at most 60 pages, a guard against a looping API), so even an overnight gap closes in one round. `max_items` in the config only sets how many a new source takes on its **first** round. That way even a busy Cailian (about 50 items an hour) leaves no gap.

## Data flow
```
config → browse preflight → per source, try the channel chain (browse → agent_reach → http → jina; the first channel with ≥1 item wins)
       → raw response to raw/YYYYMMDD/HH/<source>.<channel>.<ext>
       → parse (adapter first, otherwise generic) → normalize (time confidence, dedup key, signals)
       → continuity check; on a gap, page back or search
       → articles (merged) + observations (rank and heat this round) + signal_availability + continuity / coverage_gaps / source_cursors
       → classify → cluster and score events → fetch bodies for top events → digest → (cycle) pick pushes, write the message
       → raw retention (gzip after a day, delete after the retention period)
```

## Continuity
| Source kind | Check | On a gap |
|---|---|---|
| Stream (`continuity: "stream"`; default for rss / json_api / cls_api) | One of the previous round's 50 newest items appears → connected; otherwise the oldest trusted time ≤ the previous newest trusted time → connected by time; id_walk / before sources check whether ids connect | Page back per `paging`: `param` (page number), `cursor` (API cursor), `id_walk` (detail pages by id), `before` (page back from the smallest message id on the page, as with Telegram's `?before=`), `native` (the source script pages back by time, as for 财联社); still a gap and the source sets `backfill: true` → Exa search (a paid API, off by default; at most 3 sources per round) |
| Snapshot (`continuity: "snapshot"`; default for list pages) | Curated front pages, not checked | — |

Each source looks back from its last success plus 15 minutes (1–48 hours); 财联社 sizes its paging from that. In `cycle` mode, 6 hours or more since the last cycle, or before 08:00, is overnight mode: item and page limits ×4.
Statuses `first` / `connected` / `connected_time` / `gap_filled` / `gap_partial` / `gap_open` / `snapshot` / `failed` go to `continuity`; gaps and recovered counts to `coverage_gaps`. A checkpoint advances only after the source succeeds, so a failed period is covered by the next round.

## Topics
`taxonomy.json`: `labels` (two-level tree; leaves have keywords / patterns / exclude), `category_defaults` (source category → default label), `regions` (code → words), `entities` (cross-language aliases; `weak` ones do not count as evidence), `watch` (watch words, event +5), `mute` (mute words, event importance 0).
Chinese keywords match as substrings; English ones as whole words, case-insensitive, with s/es/ed/ing endings for longer words; all-caps abbreviations of up to 4 characters are case-sensitive. A title hit scores 2, a summary hit 1; 2 or more adds the label (confidence score/4); with no hit, the source category's default label (0.3) is used. Labels and regions go to `article_labels` (regions as `region:XX`) with `rules_version`. Event labels use rule labels only.

## Event clustering and cross-validation
- Each round assigns this round's items to events of the last 48 hours (candidates recalled through an inverted index) or starts a new event. Navigation-like short titles (English under 4 words, Chinese under 6 characters) are skipped.
- Merge: same-language title bigram similarity ≥0.5, or ≥0.3 with a matching key number (amounts convert across Chinese and English, plus percentages and casualty counts), within 6 hours. Different numbers for the same counting unit (件, 家, 台, 亿元…) mean two stories unless the titles are nearly identical (casualty counts and percentages are exempt; they go to the dispute check). Across languages: two or more specific shared entities plus a matching number (or three entities), within 6 hours.
- Importance 0–100 = independent outlets (one per group, reposting or aggregating sources count half; 1→10, 2→30, 3→40, 4→46, 5+→50) + source weights (≤10) + home and abroad 10 + authoritative source 5 + source heat (highest member heat ×0.5, ≤25) + three outlets within an hour 5 + seen in 3+ rounds 5 + watch words 5; mute words set it to 0. Factors are stored in `events.factors`.
- Credibility: single / corroborated (2+ independent outlets) / confirmed (includes a source with tier=primary and weight ≥0.9) / disputed (two or more outlets each give one different casualty count or percentage; amounts are not compared, since totals and parts are often both right).
- Display title: the shortest Chinese member title when there is one, otherwise the lead article's title; the lead prefers primary sources, then the highest heat, then the earliest.
- Reprocessing records each event in the round its first member was first seen (the timeline depends on it).

## Push selection
Events touched this round whose first report is within the look-back window: multi-source (corroborated / confirmed / disputed) with importance ≥ `min_corroborated` (50), single-source ≥ `min_single` (36, which in practice needs level A or two strong signals such as level B plus top-15% views). A pushed event is pushed again only when its credibility is upgraded or its importance rises by ≥ `upgrade_jump` (20), marked ↑. At most `max` (8) per round, by importance.

## Bodies
Events with importance ≥50 this round, up to 2 members per event (primary sources first), `--body-budget` per round (default 12). Paywalled sources, `body: "list"` sources (news flashes whose list text is the full text, training-ready from 60 characters), `body: "none"` sources, and sources whose body fetches failed 3+ times in 7 days without success are skipped.
Extraction: plain request → JSON-LD `articleBody` → the longest body field in Next.js `__NEXT_DATA__` → page paragraphs (inside `<article>` when present, without navigation and boilerplate); when the request is refused (401/403) and browse is available, the real browser reads the article; the reader (Jina) last. Verification pages are never taken as bodies or bypassed; they are recorded as `bot_blocked`. Results go to `article_bodies`, and fill `articles.content` and `training_ready` when longer than what was there.

## Dataset export
`--mode export --from YYYY-MM-DD [--to …] [--kind all|articles|events] [--pack core]` writes `dataDir/datasets/dataset-<from>_<to>-<time>/`: `articles.jsonl` (with every round's observations), `events.jsonl` (members, score trail, pushes), `manifest.json` (dataset schema `dsh-newswire-dataset/1`, range, sources, versions, runs, open gaps and failed source-rounds). Bodies are given only when `training_ready=1`; otherwise `content_withheld` is `paywall` or `too_short`.

## Topic packs
Sources carry `pack`; `sources.json` holds `packs.<pack>` (name, message title, default schedule) and `push.<pack>` (thresholds, optional `require_labels`). `--packs <pack>` runs one pack; the round is recorded with that pack (`runs.pack`), and the overnight check and look-back use only that pack's previous cycle. Overnight means before 10:00 local time and 6 hours or more since the pack's last cycle (or its first cycle). `--lock-wait-ms` makes a round wait for the lock instead of giving up (the plugin waits up to 15 minutes), so two packs' scheduled rounds that meet run one after the other.

## Profiles
Different kinds of stories are written differently (after Horizon's profiles, adapted to storylines). A profile is chosen per **story**; writing, checking and impact analysis follow it. Sections and counts are still set by `layout.json`.

Location: built-in `engine/config/profiles/<id>/`; a `profiles/<id>/` directory in the data directory replaces the built-in profile with the same id (the whole directory), or adds a new one. A broken directory is skipped and the built-in one is used. Click Re-lay out in the panel after editing.

`profile.json`:
| Field | Meaning |
|---|---|
| `id` / `name` / `version` | Id, name (shown before the story in the writing prompt), version (bump it when the writing changes; cached copy is then rewritten) |
| `priority` | When a story matches several profiles, the higher one wins |
| `match.labels` / `match.sources` | Category ids (a top-level id covers its children), source ids |
| `focus` | Focus area (only the first counts): `boost` raises its items when picking material; a front-page slot, 3 extra section slots, no rule triage. `focus` in `layout.json` overrides its name, categories and boost |
| `content` | Material: `materials` count (2–10), `body_chars` body excerpt length, `summary_chars` summary length, `sampling` (`prefix` takes the start; `head-middle-tail` takes start, middle and end at 4:3:3) |
| `blocks` | Which parts to write (default: lead, points, views, impact) |
| `search` | `{ "analysis": n }`: before impact analysis, search n times through browse (Bing results page, no paid API) and add the results as background material; default 0. The built-in "AI and new technology" and "Long-form tech" use 1 |
| `badge` | Short tag shown before the title in the panel (up to 6 characters), such as "长文" or "社区"; none if omitted |
| `prompts` | `rubric` (scoring when grouping), `plan`, `write`, `analysis` (impact analysis focus), each a Markdown file; `{name}` becomes the profile name |

Each entry in `blocks`: `kind` is `lead` (required) / `points` / `views` / `impact` (the original four), or `text` (a paragraph) / `list` (a few short lines). Custom blocks need an `id` and a `name` (the subheading in the panel); `chars`, `max` and `ask` set length, count and instructions; `materials` says what the block may rest on: `source` only the reports, `community` also community comments (when the profile's `content.comments` is above 0, comments are appended to the material, marked 【社区评论】), `history` also related earlier storylines (up to 2 written storylines from the last 90 days, matched by title similarity and shared entities, numbered H1, H2 and usable only in that block; in the panel, "earlier" opens that storyline). Every block is checked sentence by sentence: the lead and points against the reports only, comment-based blocks against material including comments; sentences in custom blocks that fail are dropped.

Built-in profiles:
| id | Name | When | Writes |
|---|---|---|---|
| `wire` | News | Default | Lead, points, views, impact |
| `tech-frontier` | AI and new technology | Category tech or AI & semiconductors (focus area) | Same, with impact on technology and technical points first |
| `tech-deep` | Long-form tech | Source declares `profile: "tech-deep"` (tech blogs) | Lead, technical points, background, takeaways; 3,000 characters of body, excerpted from start, middle and end |
| `community` | Community discussion | Source declares `profile: "community"` (Hacker News, Reddit) | Lead and points (from the linked item), community views (from comments) |
| `oss` | Open-source project | Source declares `profile: "oss"` (GitHub Trending) | Lead (what it is, who made it), highlights, who it suits; material is the README |

Which profile a story uses: if every item's source declares a `profile` in `sources.json`, the declared one (the most common); otherwise the highest-priority profile whose categories or sources match; otherwise the default `wire`. The storyline records its profile (`stories.profile`) and impact analysis follows it. Each writing batch holds one profile, so the fixed part of the prompt is identical and hosted models' prefix cache hits.

## Times from links
When a source gives no time, the link is checked: a full timestamp (`/2026101415255489242/`) counts as `page_text`; a date only (`t20261107_`, `/20261029/`, `/2026/11-08/`) is stored as `url_date` (Beijing midnight) for display and datasets, but continuity and clustering treat it as untrusted. Time confidence only rises on merge: fetched < url_date < page_text < feed. Push selection skips events whose lead article's time (including a link date) is more than a day before the look-back window, so a new source's old list items are not pushed.

## Data model (schema v28)
| Table | Contents |
|---|---|
| `sources` | Source config snapshot (with weight / tier / grp / pack / adapter / removed_at / profile) |
| `runs` | Each round: start and end, mode, pack, sources ok and failed, new and duplicate items |
| `articles` | Deduplicated articles. Key `id = sha1(canonical_url + normalized title)`; `time_confidence` = feed (time from the source) / page_text (inferred from page text or a timestamp in the link) / url_date (date only, from the link) / fetched (approximated by fetch time; `published_at` is NULL); `parser_version`; `pack` |
| `observations` | **Every item, every round**: `rank`, `section`, `views/comments/likes/shares/favorites`, `hot` (JSON array, as the source wrote it), `level`, `signals_raw`. An item seen in several rounds forms a heat series |
| `signal_availability` | Which signals each source has actually provided, how often, and when last |
| `fetch_attempts` | Every channel attempt: channel, backend, ok, http_status, items, latency_ms, error_kind, error (scrubbed of local paths), hint, note |
| `source_cursors` | Checkpoint per source: last_ok_at, head_keys (dedup keys of the newest 50), head_time / tail_time (trusted time range), max_id (id_walk / before) |
| `continuity` | Continuity status per round and source, overlap, pages, recovered items, gap range |
| `coverage_gaps` | Gaps and recovery (backfilled / partial / open; by paging or agent_reach_search) |
| `article_labels` | Item labels and regions (label, confidence, origin, rules_version) |
| `events` | Events: title, lead article, first and last seen, members, independent outlets, outlets, home/abroad mix, importance, credibility, labels, regions, entities, score factors, dispute, round of birth; `llm_notes`: the model's explanation (summary / why / watch, model, time, member count when written, prompt version) |
| `event_members` | Event members (an item belongs to at most one event): similarity and how it joined (seed / title / title+number / entity) |
| `event_scores` | Event score trail per round |
| `pushes` | Pushes: event_id, lead article, importance and credibility at the time, reason (new / upgraded / jumped); `n` (v27) is the item's number for the day in the message, which the reader replies with to expand it or give feedback |
| `article_bodies` | Bodies: text, length, extractor (json-ld / next-data / paragraphs / browse / reader), channel, paywalled, success and error |
| `briefings` | Model briefings (v8): pack, round, time, model, look-back hours, headline, content (points / watch, each with event_ids), events considered, success and error, duration. Failures get a row too |
| `editions` | Editions (v9): pack, round, time, mode (llm / rules), model, layout version, period, items read, headline, full content (front page, sections, stories, worth watching, to verify), error, duration, calls |
| `edition_items` | Where each item landed in an edition: story, rule event, section, topics, importance (the model's judgment in LLM mode) |
| `stories` | Storylines (v10): stories that persist across editions — title, section, topics, importance, status (active / merged and into which), the model's copy (with the item count when written, to decide reuse), first and last edition, profile (v24) |
| `story_items` | Which storyline each item belongs to (one per item), its rule event, when it joined |
| `story_updates` | Storyline developments (v11): edition, time, text, reports added, written by model or program |
| `story_details` | Detailed reports (v26): written by the model from all of a storyline's reports when a reader asks (overview, timeline, key numbers, who said what, background, open questions; every sentence checked), one row per write, with the report count at the time |
| `kv` | Simple state such as the last viewing time per pack (`seen:<pack>`) |
| `digests` | Daily digests (v12): pack, date, mode, model, headline, full content (arcs, tomorrow, numbers), duration, calls |
| `feedback` | Reader feedback: a wrong sentence (error), a misplaced report, "this is an ad" (promo) and "this is news" (not_promo), with storyline, edition, note, and when it was handled |

Content-quality columns on `articles` (v13): `kind` = news / promo (ads, paid-column teasers, marketing) / digest (a roundup; once split it no longer takes part) / digest_item (one item split from a roundup, `parent_id` points to it); `kind_by` = rule / llm / reader (a reader's call is never overridden by rules or the model); `kind_note` names the rule or the roundup; `completeness` = full / truncated / title_only; `kind` can also be ticker (a single market move, shown in the edition's Markets box, never its own story or event). v16: `title_zh` is the Chinese title of a foreign-language item (translated and checked by the model in LLM mode; clustering compares it and the panel shows it); `link_to` is the model's "same story" call, pointing at the first report of that event; clustering follows it, including on reprocess. Noise rules live under `noise` in `taxonomy.json` (`source` / `title` / `text` / `all` regexes); run `--mode reprocess` after editing them.
| `articles_fts` | FTS5 full-text index (trigram; Chinese from 3 characters; shorter queries fall back to LIKE) |

Merging: when a dedup key appears again, the longer summary and body win; the publish time is upgraded only from fetched to a trusted time; the first-seen time never changes. The timeline has dedicated indexes; the first screen of any day loads in about 1 ms.

## Heat signals
Only values the source actually gives; missing values are NULL (not 0). Per source (checked 2026-11-08):

| Source | Signals |
|---|---|
| 财联社电报 | level (A/B/C), views, shares, comments |
| 华尔街见闻 | level (score, 2 = important), comments |
| 深潮 TechFlow | views, shares, favorites, hot (热门 / 推送 / 日推荐) |
| 界面快讯 | hot (a-item-red → 加红), rank |
| 澎湃首页 | likes (praiseTimes), comments (interactionNum), section (头图 / 要闻 / 频道) |
| AP | hot (Most Read #n / Most commented #n), comments (most commented list), section |
| Other RSS / list pages | rank only |

## Site adapters
`adapters/<id>.mjs` exports `{ id, browseMode: "html", waitFor, parse(html, { url, max, src }) }`, optionally `rawHtml: true` and `enrich(items, { fetchHtml, src, deadline })`. The browse channel reads the rendered page in `html` mode (waiting up to 15 seconds for the `waitFor` selector); with `rawHtml` it instead fetches the page's original HTML from inside the page, so the browser's auto-translate cannot rewrite it. The http channel passes the response body to the same `parse`. `enrich` runs after a successful fetch to read detail pages (browse first, then http; `src.enrich_ms`, default 120 s).
The `hackernews` adapter reads the Hacker News front page: posts with at least `min_points` (default 100), linked to the article they point to (Ask/Show HN without a link use the discussion page), with points and comment count as heat. `enrich` reads the discussion pages of the `comment_items` (default 8) highest-scoring posts and stores the top-level comments in `articles.comments`; Ask HN text becomes the summary. The `reddit` adapter reads an old.reddit.com subreddit page (`/r/<sub>/top/?t=day`): score, comment count, time and link from the `data-*` attributes; promoted posts and posts below `min_points` (default 50) are skipped; image, video and text posts link to the post page, link posts to the article. `enrich` reads the post pages of the `comment_items` (default 6) highest-scoring posts (`?depth=1&sort=top`, top-level comments only, no AutoModerator) and uses a text post's body as its summary. Reddit refuses logged-out requests, so only browse works.
The `github_trending` adapter reads GitHub Trending: repository, description, language, total stars and stars today (heat); repositories below `min_stars_today` (default 100) are skipped; there is no publish time.
Sources with `tier: "community"` never count as an independent outlet: events list them separately (`community: true` in `outlets`) and they do not raise source points or credibility.
The `telegram` adapter reads the public web preview of a Telegram channel, `https://t.me/s/<channel>`, with no login. A channel that posts one story per message gives one item per message: the bold first line is the title and the 信源 (source) link is kept as the original source. A roundup posted in parts (`[1/3] [2/3] …`) is joined back together and split into items by its `━━ section ━━` headers and `N、title` numbering. Each item links to its message plus `?i=<item number>`. To configure a source, set `url` to `https://t.me/s/<channel>` and `paging` to `{ "mode": "before", "param": "before", "id_pattern": "t\\.me/[A-Za-z0-9_]+/(\\d+)" }`. Private channels (`t.me/+…` invite links) and channels with the web preview turned off cannot be read, and the machine needs network access to t.me.

To add one: write the module → register it in `adapters/index.mjs` → save a snapshot as `tests/fixtures/<id>.html.gz` → add assertions to `tests/unit/adapters.test.mjs`.

## Parsing rules (learned by the model, run by the program)
A source can carry `extract`: `{ item, link?, title?, time?, summary?, wait_for? }`, all CSS selectors. `item` selects each entry on the page and the rest are looked up inside it; entries without a separate headline (social posts) use the first line of their text. Sources with `extract` use browse's `select` mode (wait for `wait_for`, scroll three screens, then read).
The rules are usually not hand-written: when the generic parser can't read a page, the plugin takes a page outline with `--mode outline --url <url>` (tags, a few classes, data-* attributes, link and time attributes, short text, at most three repeated siblings), has the model write selectors, and verifies them with a test fetch (at least 3 entries with distinct links and titles); if they fail, the model gets the results and tries once more. See `host/recipe.mjs`.

## Model page reading (Unlimited)
`--mode search --query <terms> [--max 6]` opens the Bing results page through browse (reading the server's original HTML) and returns `[{ title, url, snippet, site }]` with redirect links unwrapped. Impact analysis calls it per the profile's `search.analysis`; no paid search API is used.

`--mode read --url <url>` takes a full-text snapshot of the page: text in reading order with each link numbered in place as 【n】 and time elements marked 〈时间 …〉, plus the link table and time list. The plugin has the model list `[title, link number, time]`, checks each entry (the number exists, the title is in the page text, the time comes from the page), saves them per source as `<dir>/<id>.json`, and passes `--prefetched <dir>` to fetch / cycle: sources with pre-read items use them (channel `llm`) and go through the usual ingest, dedup, continuity and event clustering; the others use their channels as usual. See `host/modelread.mjs`.

## CLI
```bash
# One round (external command paths are detected when not given)
node engine/run.mjs --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite \
  --out ~/.dsh/newswire/out --raw ~/.dsh/newswire/raw --since-hours 24 --export jsonl,csv \
  [--sources a,b] [--categories x] [--packs core] [--max-items N] [--body-budget 12] [--raw-retention-days 180]

# Full round for the scheduled task: last stdout line NEWSWIRE_JSON { message, parts, stats, picks, continuity }; --dry-run records no pushes; --defer-push proposes candidates without recording them (in LLM mode the plugin decides from the edition)
node engine/run.mjs --mode cycle --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite \
  --out ~/.dsh/newswire/out --raw ~/.dsh/newswire/raw [--overnight] [--min-corroborated 50] [--min-single 36] [--max-push 8] [--dry-run] [--defer-push]

# Recompute after editing taxonomy.json or source body modes (default last 72 hours; stage=labels for labels only)
node engine/run.mjs --mode reprocess --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite --hours 72

# Export a dataset
node engine/run.mjs --mode export --config ~/.dsh/newswire/sources.json --db ~/.dsh/newswire/news.sqlite --from 2026-11-01 --to 2026-11-07

# Trial fetch (nothing stored): a configured source or a new one in a JSON file; last stdout line NEWSWIRE_JSON {...}
node engine/run.mjs --mode test-source --config ~/.dsh/newswire/sources.json --source jiemian --max-items 5
node engine/run.mjs --mode test-source --source-file ./new-source.json
```

## Failure classes
browser_unavailable, channel_unavailable (agent-reach not installed), dns, connection_reset, timeout, tls, http_404, rate_limited, bot_blocked, paywall, parse_error, unknown. Each comes with a hint.

## Known limits
- agent-reach's page backend is currently Jina Reader (mcporter has no web-reader configured), which gives no times or heat.
- AP refuses plain requests (403) and can only be fetched through browse; Jina is refused too. Reuters bodies need a login and are treated as paywalled.
- Slow list pages (such as Reuters) set `wait_for` to a selector that browse waits for before reading (up to 15 seconds).
