# Pastebin-lite — spec

A tiny single-user paste service to run on my home server. Keep it minimal — this
is a weekend utility, not a product.

## Requirements

1. `POST /paste` accepts a plain-text body (max 256 KB) and returns a short random
   id (8 url-safe chars).
2. `GET /paste/:id` returns the stored text as `text/plain; charset=utf-8`, or 404.
3. Pastes expire 30 days after creation; expired pastes are deleted lazily on read
   and by a sweep on startup.
4. Storage is a single SQLite file at `./data/pastes.db` — no external services.
5. The server binds `127.0.0.1:8090` only (it sits behind an existing reverse proxy).

Use Bun with no HTTP framework (`Bun.serve`). Single file `server.ts` is fine.
