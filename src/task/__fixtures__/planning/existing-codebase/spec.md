# logstats — add JSON output and a `summary` subcommand

The repo already contains a working CLI (`logstats`) that parses nginx access logs
and prints per-status-code request counts as a text table. Extend it — do not
rebuild or re-scaffold anything that exists.

## What to add

1. A `--json` flag on the existing `counts` subcommand: print the same data as a
   JSON object (`{"200": 1234, "404": 7}`) instead of the table. Table output stays
   the default and must not change byte-for-byte.
2. A new `summary` subcommand: total requests, unique IPs, top 5 paths by hits,
   and the busiest hour (UTC). Supports the same `--json` flag.
3. Both subcommands read the log path from the existing positional argument and
   honor the existing `--since <ISO date>` filter.

## Constraints

- Keep the existing `package.json` scripts and dependencies — extend, don't replace.
- The existing `parseLine()` in `src/parse.ts` is the only log parser; reuse it.
- Every new subcommand/flag gets a `bun test` case in `test/` using the fixture log
  at `test/fixtures/access.log` (add new fixture lines if needed, never rewrite the
  file wholesale).
