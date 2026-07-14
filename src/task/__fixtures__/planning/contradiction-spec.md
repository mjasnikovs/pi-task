# Status page — design (v1)

A public status page for our API, plus a small internal control surface.

## Scope (v1)

Public, read-only status page at `/`. **v1 ships with NO admin interface — do
not create an admin page or any `/admin` route**; incidents are managed by
inserting rows with the `incident` CLI below. Keep the deployable surface to the
public page and the JSON API only.

## Components

1. **Checker** — a loop that probes each monitored endpoint every 60s and writes
   a row to `checks` (SQLite): `target`, `status`, `latency_ms`, `at`.
2. **JSON API** — `GET /api/status` (current state per target),
   `GET /api/history?target=&hours=` (bucketed uptime for the chart).
3. **Public page** — server-rendered `/`: per-target badge (up/degraded/down),
   90-day uptime bar, open incidents banner.
4. **Incident CLI** — `incident open|close|list` writing to the same DB.
5. **Admin page** — `/admin` (HTTP basic auth): open/close incidents and
   pause/resume a target's checks from the browser, for on-call use from a phone.

## Data retention

Raw `checks` rows are kept 90 days; a nightly job compacts older rows into
daily aggregates in `checks_daily`. The uptime bar reads `checks_daily` only —
**it must never query the raw `checks` table** (that scan took the page down at
a previous employer). The `/api/history` endpoint reads raw `checks` for its
hour-resolution buckets.

## Timestamps

All timestamps are stored as UTC ISO-8601 strings (`2026-07-14T12:00:00Z`) in
every table. The JSON API returns timestamps as Unix epoch seconds (integers)
in every payload for chart-library compatibility.
