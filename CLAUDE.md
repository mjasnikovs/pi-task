## Comments (mandatory)

These are rules, not taste. A comment that breaks one is a defect, and `npm run check` will not
catch it — you have to.

- Never restate what the code does. A comment adds only what the code cannot carry: intent, and why
  this way and not the obvious way.
- Keep it brief and clear. One line where one line does.
- No value, no comment. Do not write it.
- A good comment does not excuse unclear code. If you cannot say it in one short line, the code
  needs refactoring, not a comment.
- Needing a block of comments is a refactor signal. Split the code instead.
- Do justify unidiomatic code: workarounds, performance hacks, deliberate deviations. Say why, so
  the next developer does not "fix" it back into a bug.
- Never invent a magic number, in a comment or in a fix. A 30 second timeout is not a fix. It
  assumes hardware, OS, load, and task size never change, and every one of those changes. Wait on
  the real signal.

```ts
// BAD — the line already says this
// increment the retry counter
retries++

// BAD — a comment propping up code that should be readable
// if the node is dirty, is not the root, and its scene is open, mark it
if (n.d && !n.r && s.o) mark(n)

// BAD — a guessed number dressed up as a reason
await sleep(30_000) // give the editor time to import
```

Writing one is the last step, not the first. Name the thing better, split the function, delete the
branch. Reach for a comment only when the code is already as clear as it can be and something true
about it still cannot be seen.
