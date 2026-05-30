---
name: media-hub
description: Query and curate the media-hub local news/signal database and configs. Use when the user asks about RSS, Bluesky, Polymarket, media-hub digests/searches, source quality, or improving the hub configuration over time.
---

# Media Hub Skill

Use this skill to query the local media-hub SQLite database and to curate media-hub source configs over time.

## Project/runtime locations

Development repo, when working inside this project:

```text
/home/tdinh/projects/media-hub
```

Installed runtime defaults:

```text
DB:      ~/.local/share/media-hub/media-hub.sqlite
Config:  ~/.config/media-hub/{rss,bluesky,polymarket}.yaml
Scripts: ~/.local/bin/media-hub-*
```

Repo-local development fallbacks:

```text
DB:      data/media-hub.sqlite or data/*.sqlite
Config:  config/*.local.yaml, then config/*.example.yaml
Scripts: ./scripts/*.sh
```

Prefer installed runtime paths for real queries/config updates unless the user explicitly asks to edit repo examples.

## Core model

Media-hub is:

```text
RSS worker + Bluesky worker + Polymarket worker -> JSONL -> SQLite records table
```

There is one flexible table:

```sql
records(
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  record_type TEXT NOT NULL,
  canonical_url TEXT,
  observed_at TEXT NOT NULL,
  title TEXT,
  raw_json TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

Record types:

```text
feed_item           RSS/document sources
social_post         Bluesky posts/mentions
probability_signal  Polymarket market snapshots
```

`raw_json` contains the full worker-emitted record. Use `json_extract(raw_json, '$.field')` for source-specific fields.

## Query workflow

When the user asks a media-hub question:

1. Infer time range/topic/source constraints from the conversation.
2. If ambiguous, choose a sensible default and state it briefly:
   - time range: last 24h or last 7d depending on the question
   - sources: all sources unless topic/source is specified
   - limit: 10-25 for interactive summaries
3. Query SQLite directly with `sqlite3`, or use installed helpers for simple lookups.
4. Return a concise answer with enough provenance: title/source/time/link when available.

Useful commands:

```bash
media-hub-items --limit 20
media-hub-items --since 24h --type feed_item
media-hub-search "query" --limit 20
sqlite3 -header -column ~/.local/share/media-hub/media-hub.sqlite 'select ...;'
```

If `~/.local/share/media-hub/media-hub.sqlite` is missing, look for repo-local DBs:

```bash
find /home/tdinh/projects/media-hub/data -name '*.sqlite' -type f
```

## Useful SQL patterns

Recent records:

```sql
select id, observed_at, source, record_type, coalesce(title, canonical_url, '') as item
from records
order by observed_at desc, id desc
limit 25;
```

Search title/raw JSON:

```sql
select id, observed_at, source, record_type, title, canonical_url
from records
where title like '%QUERY%' or canonical_url like '%QUERY%' or raw_json like '%QUERY%'
order by observed_at desc, id desc
limit 25;
```

Counts by source/type:

```sql
select source, record_type, count(*)
from records
group by source, record_type
order by count(*) desc;
```

Recent RSS items by tag:

```sql
select observed_at, source, title, canonical_url
from records
where record_type = 'feed_item'
  and raw_json like '%"TAG"%'
order by observed_at desc
limit 25;
```

Bluesky posts with links:

```sql
select observed_at, source,
       json_extract(raw_json, '$.author_handle') as author,
       title,
       canonical_url
from records
where record_type = 'social_post'
  and canonical_url is not null
order by observed_at desc
limit 25;
```

Polymarket top volume snapshots:

```sql
select observed_at,
       title,
       json_extract(raw_json, '$.probability') as probability,
       json_extract(raw_json, '$.volume') as volume,
       canonical_url
from records
where record_type = 'probability_signal'
order by cast(json_extract(raw_json, '$.volume') as real) desc
limit 25;
```

Polymarket movement fields, when present:

```sql
json_extract(raw_json, '$.oneDayPriceChange')
json_extract(raw_json, '$.oneWeekPriceChange')
json_extract(raw_json, '$.oneMonthPriceChange')
```

## Config curation workflow

Real config files live in:

```text
~/.config/media-hub/rss.yaml
~/.config/media-hub/bluesky.yaml
~/.config/media-hub/polymarket.yaml
```

Repo-local `config/*.local.yaml` may also exist for development and are gitignored. Do not put personal configs into `config/*.example.yaml` unless explicitly asked.

When improving configs:

1. Inspect current config before editing.
2. Ask before large or preference-shaping changes.
3. Prefer small reversible changes.
4. Preserve existing source entries and comments where practical.
5. After editing, validate YAML:

```bash
python3 - <<'PY'
import yaml
for p in ['~/.config/media-hub/rss.yaml','~/.config/media-hub/bluesky.yaml','~/.config/media-hub/polymarket.yaml']:
    p = __import__('os').path.expanduser(p)
    yaml.safe_load(open(p))
    print('ok', p)
PY
```

6. Optionally run one targeted tick or worker sample to confirm.

## RSS config guidance

RSS is the clearest curation loop.

Config shape:

```yaml
feeds:
  - name: Example
    source: example
    url: https://example.com/feed.xml
    tags: [tech]
    fetch_articles: false
```

To add RSS sources:

- Use web search to find official RSS/Atom feeds.
- Prefer official feeds over third-party mirrors.
- Use stable lowercase kebab-case `source` values.
- Add durable tags matching user interests.
- Remove feeds that repeatedly 403/404 only after asking or when clearly dead.

## Bluesky config guidance

Bluesky is mainly configured by actors, feeds, and searches:

```yaml
actors:
  - handle: example.bsky.social
    tags: [tech]
    limit: 25

feeds:
  - name: Example Feed
    uri: at://did:.../app.bsky.feed.generator/...
    tags: [tech]
    limit: 25

searches:
  - query: cybersecurity
    tags: [security]
    limit: 25
```

Notes:

- Public search may require auth depending on AppView.
- Actor feeds may include reposts; `author_handle` can differ from the configured actor.
- For curation, prefer topic-specific actors/feeds over generic high-follower accounts once user preferences become clear.
- Use web search or Bluesky profile pages to verify handles before adding.

## Polymarket config guidance

Polymarket public Gamma search can be noisy. Prefer:

1. `top_markets` for broad discovery.
2. explicit `markets` for reliable watchlists.
3. cautious `searches` only as discovery, not as trusted signal.

Config shape:

```yaml
top_markets:
  - name: Top active markets by total volume
    metric: volumeNum
    limit: 32
    active: true
    closed: false
    tags: [top, volume]

markets:
  - slug: example-market-slug
    tags: [geopolitics]

searches:
  - query: iran
    tags: [geopolitics]
    limit: 25
```

Known useful metrics:

```text
volumeNum     total historical volume
volume24hr    current activity
liquidityNum  available liquidity
```

For long-term feedback loop:

- Use top markets to discover broad candidates.
- Query recent snapshots and ask the user which markets/topics are useful.
- Promote useful markets to explicit `markets` watchlist.
- Remove noisy searches/top categories only when the user confirms.

## Triggering updates

Manual tick:

```bash
media-hub-tick
```

Debug tick with retained JSONL/logs:

```bash
media-hub-debug-tick
```

Systemd timer status:

```bash
systemctl --user status media-hub.timer
systemctl --user list-timers media-hub.timer
journalctl --user -u media-hub.service
```
