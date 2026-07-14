I want a little bookmarks manager I can self-host. The heart of it is saving a
URL with a title and optional tags from a bookmarklet, so the save endpoint has
to accept a GET with query params and then bounce you straight back to the page
you came from. When a bookmark is saved the server should go fetch the page once
in the background and keep a plain-text extract of the article body so that
searching later works over the full text and not just titles. Search matters
more to me than anything else here, it should be a single box that matches
words in the title, the tags, and that extracted text, newest first. Tags are
just free strings separated by commas, and clicking a tag anywhere should show
everything with that tag. There needs to be a way to export the whole collection
as a single JSON file from the UI, and importing that same file back on a fresh
install must reproduce the collection exactly, ids and dates included, because
this is also my backup story. Everything sits behind a single shared password —
one user, me — entered once and remembered with a cookie for a month. Any page
or endpoint that shows or changes my data has to check that cookie, including
the export, since the whole point of self-hosting is that nobody else can read
my bookmarks. Keep it to SQLite and one small server process. Every route you
add should come with a test that actually calls it over HTTP and checks the
response, and the import/export round-trip specifically needs a test proving
export-then-import is lossless.
