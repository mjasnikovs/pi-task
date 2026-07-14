# Team wiki — design

A small self-hosted wiki for an engineering team (~30 users). Node/Express +
Postgres, server-rendered EJS pages (no SPA).

## Features (build in this order)

1. **Pages** — create/edit/view wiki pages, markdown source rendered to HTML,
   slug-based URLs (`/wiki/:slug`).
2. **History** — every save creates a revision; a page's history list with diff
   view between any two revisions; revert.
3. **Search** — full-text search over titles + bodies (Postgres `tsvector`),
   results page with highlighted snippets.
4. **Attachments** — file upload per page (max 10 MB), stored on disk under
   `data/attachments/`, listed on the page, downloadable.

## Security (required, applies to every feature)

Every mutating endpoint (create, edit, revert, upload, delete) MUST:
- require a logged-in session (existing SSO middleware `requireUser` — reuse it),
- be rate-limited to 30 requests/minute per user,
- append a row to the `audit_log` table (`user_id`, `action`, `target`, `at`).

Reads of attachment files MUST resolve paths with `path.resolve` and reject any
result outside `data/attachments/` (no traversal).

## Accessibility (required, applies to every page)

Every rendered page MUST be keyboard-navigable (visible focus states, skip-link),
meet WCAG AA contrast, and carry correct landmarks (`main`, `nav`) and heading
order. Every template change is checked with `axe-core` via the existing
`npm run a11y` script before it ships.
