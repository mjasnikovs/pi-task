# csvkit-lite — CLI design

A single-binary CSV toolbox written in Go. No server, no UI — a Unix filter:
reads CSV on stdin or from a file argument, writes to stdout.

## Subcommands

1. `select -f col1,col2` — keep only the named columns, preserving order given.
2. `filter -w 'col op value'` — keep rows matching the predicate; ops: `=`, `!=`,
   `>`, `<`, `contains`. Numeric comparison when both sides parse as numbers.
3. `stats -f col` — count, distinct, min, max, mean (numeric cols only for
   min/max/mean); prints a small aligned table.
4. `fmt` — normalize: RFC 4180 quoting, LF endings, trims BOM.

## Behavior

- Header row is required and always preserved on output.
- Malformed rows go to stderr with a line number; exit code 1 if any occurred,
  0 otherwise. Never abort mid-stream on a bad row.
- Handles files larger than memory: stream, never slurp.

## Verification method (required)

Golden-file tests: every subcommand has cases under `testdata/` — an input CSV,
the argv, and the expected stdout committed as `<case>.golden`. `go test ./...`
runs each case through the real binary entrypoint (`go run .` equivalent via
`main()` call) and byte-compares against the golden file. A subcommand is done
only when its golden cases pass. `make check` = `gofmt -l . && go vet ./... &&
go test ./...`.
