# `siphon` — incremental warehouse ingestion daemon

A long-running daemon that pulls change streams from operational databases,
normalises them, and lands them in a columnar warehouse with exactly-once
semantics. No UI, no HTTP surface beyond a health endpoint.

## 1. Decisions (locked)

- Single static binary, no plugin loading at runtime.
- Rust 2024 edition, tokio runtime, one workspace with three crates.
- Sources are pull-based only; the daemon never accepts pushed events.
- Checkpoints are the single source of truth for progress; no external scheduler.

## 2. Dependencies (pinned)

- `tokio` `1.48` — async runtime, multi-thread scheduler
- `sqlx` `0.9` — source connections (postgres, mysql)
- `arrow` `56.0` — in-memory columnar batches
- `parquet` `56.0` — warehouse file format
- `rdkafka` `0.39` — change-stream transport
- `serde_yaml` `0.10` — pipeline configuration

## 3. Workspace layout

- `crates/core` — batch model, checkpoint store, retry policy
- `crates/sources` — postgres logical decoding, mysql binlog, kafka topics
- `crates/sink` — parquet writer, warehouse manifest, compaction
- One root `Cargo.toml` workspace; no crate depends on a sibling's internals.

## 4. Checkpoint store

Checkpoints live in a local embedded key-value store, one namespace per pipeline.

- key: `(pipeline_id, partition)` — composite, lexicographically ordered
- value: opaque source cursor bytes plus a monotonic `epoch` u64
- A checkpoint is committed only AFTER its batch is durable in the warehouse.
- On restart the daemon resumes from the last committed checkpoint, never earlier.
- Corrupted checkpoint records are quarantined, not deleted, and the pipeline halts.

## 5. Source connectors

Each connector exposes the same `Source` trait: `poll() -> Batch`, `commit(cursor)`.

- **Postgres**: logical decoding via replication slot; slot is created on first run
  and its name is derived from the pipeline id.
- **MySQL**: binlog streaming from a given file+position; GTID mode when available.
- **Kafka**: one consumer group per pipeline, manual offset commit only.
- A connector that returns an empty batch three times in a row backs off exponentially.
- Schema changes observed mid-stream emit a `SchemaEvolved` event rather than failing.

## 6. Normalisation

- Every source row is converted to an Arrow `RecordBatch` before it leaves the connector.
- Type coercion is table-driven and lives in `crates/core/src/coerce.rs`.
- Rows failing coercion go to a dead-letter file, keyed by pipeline and epoch.
- The dead-letter file is itself parquet, so it can be queried by the same warehouse.

## 7. Warehouse sink

- Batches accumulate in memory until either 128 MB or 60 seconds, whichever first.
- Each flush writes ONE parquet file plus a manifest entry naming its row range.
- Manifest entries are append-only; a rewrite is always a new entry, never an edit.
- Small-file compaction runs when a partition exceeds 200 files.
- A flush that fails midway leaves no manifest entry, so partial files are invisible.

## 8. Retry and backpressure

- Transient source errors retry with jittered exponential backoff, capped at 5 minutes.
- Sink errors retry forever; the daemon must not drop a batch it has acknowledged.
- When the in-memory buffer exceeds 512 MB the daemon stops polling sources.
- Backpressure state is observable via the health endpoint.

## 9. Observability

- A `/health` endpoint reports per-pipeline lag, last checkpoint epoch, and buffer depth.
- Structured JSON logs to stdout; one line per flush, one per checkpoint commit.
- A `siphon status` subcommand prints the same data as `/health` from the CLI.

## 10. Testing

- **Test-first cadence (required):** a test lands *as fast as possible* — in the same
  change — as each new connector or sink component.
- No connector or sink is considered done until its test exists and passes.
- Don't batch testing to the end of a milestone.
- **Integration tests** — run each connector against a real containerised source
  (postgres, mysql, kafka) and assert exactly-once landing across a forced restart.
- Property tests for the checkpoint store: resume never replays a committed epoch.

## 11. Operational constraints

- The daemon must never write outside its configured data directory.
- Secrets are read from the environment only, never from the pipeline YAML.
- A pipeline must not be runnable twice concurrently against the same checkpoint namespace.

## 12. Build order (milestones)

- **Scaffold** — workspace, three crates, config loading, health endpoint skeleton.
- **Checkpoints** — embedded store, commit ordering, resume + tests.
- **Postgres source** — replication slot, decoding, cursor commit + tests.
- **Normalisation** — Arrow conversion, coercion table, dead-letter path + tests.
- **Parquet sink** — flush thresholds, manifest, partial-failure invisibility + tests.
- **MySQL and Kafka sources** — binlog and consumer-group connectors + tests.
- **Compaction** — small-file merge, manifest rewrite semantics + tests.
- **Backpressure** — buffer accounting, poll suspension, observability + tests.
