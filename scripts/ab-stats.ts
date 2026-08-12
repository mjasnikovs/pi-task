/**
 * The statistics an A/B harness reports its verdict from.
 *
 * `ab-verdict.ts` owns the counting rule and the exit code. It did not own the
 * arithmetic that decides significance, so seven harnesses each carried a private
 * Fisher exact — none of them tested, and one of them wrong for a year: it let the
 * 2×2 margins move with the summation index, making it exact only at the first
 * term of the tail. That copy returned 0.0759 for a table whose true p is 0.0268,
 * on the wrong side of every alpha anyone uses. It is fixed and pinned here now.
 *
 * The rule this module exists to enforce: a statistic that decides SHIPPED vs
 * REFUTED is tested, and there is one of it. `scripts/ab-stats.test.ts` checks
 * every function against exact BigInt references rather than against a second
 * floating-point implementation, which would only prove the two agree.
 */

/** log(n!) by summation. n is a trial count, so this stays small and exact enough. */
export function logFactorial(n: number): number {
    let s = 0
    for (let i = 2; i <= n; i++) s += Math.log(i)
    return s
}

/** log C(n, k). */
export function logChoose(n: number, k: number): number {
    if (k < 0 || k > n) return -Infinity
    return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

/**
 * THE TAILS ARE COMPUTED IN EXACT RATIONAL ARITHMETIC, and there is a specific
 * reason. Trial counts are small — twenty per arm, not twenty million — so exact
 * BigInt binomials cost nothing, and the log-space alternative has a failure mode
 * that points the wrong way.
 *
 * At 3 trials per arm with perfect separation the true floor is exactly 1/20 =
 * 0.05, so a harness gating `p < 0.05` can never be satisfied. Summed in log
 * space that same value comes back as 0.049999999999999961, and the gate PASSES —
 * on rounding noise, at the smallest n anyone would run. That is a false SHIPPED,
 * the one direction of error this repo treats as unrecoverable.
 *
 * Exact up to `EXACT_N_MAX` observations; beyond that the log path takes over,
 * where n is large enough that no threshold sits on a representable boundary.
 */
const EXACT_N_MAX = 2000

function bigChoose(n: bigint, k: bigint): bigint {
    if (k < 0n || k > n) return 0n
    let r = 1n
    const kk = k > n - k ? n - k : k
    for (let i = 0n; i < kk; i++) r = (r * (n - i)) / (i + 1n)
    return r
}

function gcd(a: bigint, b: bigint): bigint {
    let x = a < 0n ? -a : a
    let y = b < 0n ? -b : b
    while (y !== 0n) [x, y] = [y, x % y]
    return x
}

/** A BigInt ratio as the nearest double, without overflowing through Infinity. */
function ratioToNumber(num: bigint, den: bigint): number {
    if (den === 0n) return 1
    const g = gcd(num, den)
    const n2 = num / g
    const d2 = den / g
    const LIMIT = BigInt(Number.MAX_SAFE_INTEGER)
    // Both exact as doubles ⇒ one correctly-rounded division. This is the path that
    // makes 1/20 the SAME double as the literal 0.05, which is the whole point.
    if (n2 <= LIMIT && d2 <= LIMIT) return Number(n2) / Number(d2)
    const SCALE = 1n << 64n
    return Number((n2 * SCALE) / d2) / Number(SCALE)
}

/** Unnormalised weight of cell `x`: C(row1, x) · C(n − row1, col1 − x). */
function weight(x: bigint, row1: bigint, col1: bigint, n: bigint): bigint {
    if (x < 0n || x > row1 || x > col1 || n - row1 - col1 + x < 0n) return 0n
    return bigChoose(row1, x) * bigChoose(n - row1, col1 - x)
}

/** Log-space fallback for tables too large to enumerate exactly. */
function hypergeometricLog(x: number, row1: number, col1: number, n: number): number {
    if (x < 0 || x > row1 || x > col1 || n - row1 - col1 + x < 0) return 0
    return Math.exp(logChoose(row1, x) + logChoose(n - row1, col1 - x) - logChoose(n, col1))
}

/**
 * One-sided Fisher exact: P(X >= a) for the table [[a,b],[c,d]].
 *
 * Fisher conditions on BOTH margins, fixed at the observed table. Every term of
 * the tail comes from that one distribution — recomputing the margins per term is
 * the mistake that motivated this module.
 *
 * Use this when the harness has a DIRECTION registered in advance — "the treatment
 * arm should exhibit the shape more often than the baseline". Registering the
 * direction after seeing the data is not a pre-registration, so if you find
 * yourself choosing the tail to fit the result, you want `fisherTwoSided`.
 */
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
    const n = a + b + c + d
    if (n === 0) return 1
    const row1 = a + b
    const col1 = a + c
    const hi = Math.min(row1, col1)

    if (n <= EXACT_N_MAX) {
        const N = BigInt(n)
        const R = BigInt(row1)
        const C1 = BigInt(col1)
        let num = 0n
        for (let x = BigInt(a); x <= BigInt(hi); x++) num += weight(x, R, C1, N)
        return Math.min(1, ratioToNumber(num, bigChoose(N, C1)))
    }

    let tail = 0
    for (let x = a; x <= hi; x++) tail += hypergeometricLog(x, row1, col1, n)
    return Math.min(1, tail)
}

/**
 * Two-sided Fisher exact: the total probability of every table no more likely
 * than the observed one. Use it when the harness registered no direction, or
 * when a move either way would count.
 */
export function fisherTwoSided(a: number, b: number, c: number, d: number): number {
    const n = a + b + c + d
    if (n === 0) return 1
    const row1 = a + b
    const col1 = a + c
    const lo = Math.max(0, row1 + col1 - n)
    const hi = Math.min(row1, col1)

    if (n <= EXACT_N_MAX) {
        const N = BigInt(n)
        const R = BigInt(row1)
        const C1 = BigInt(col1)
        // Exact comparison of weights — no epsilon needed, and none of the
        // "is this term equal enough to the observed one" guesswork that a
        // floating-point version has to do.
        const observed = weight(BigInt(a), R, C1, N)
        let num = 0n
        for (let x = BigInt(lo); x <= BigInt(hi); x++) {
            const w = weight(x, R, C1, N)
            if (w <= observed) num += w
        }
        return Math.min(1, ratioToNumber(num, bigChoose(N, C1)))
    }

    const observed = hypergeometricLog(a, row1, col1, n)
    let total = 0
    for (let x = lo; x <= hi; x++) {
        const p = hypergeometricLog(x, row1, col1, n)
        // Relative tolerance: terms equal in exact arithmetic can differ in the
        // last bits here, and dropping one would silently shrink the p.
        if (p <= observed * (1 + 1e-9)) total += p
    }
    return Math.min(1, total)
}

/**
 * The smallest p-value these arm sizes can REACH, at the most extreme table
 * (every treatment trial hits, no baseline trial does).
 *
 * This is the depth of this module. A run whose floor is above alpha could never
 * have produced a significant result whatever happened, so reporting it as "not
 * significant" is a category error — it is an ABSTAIN, the same "absence of
 * evidence is not evidence of absence" rule `ab-verdict.ts` applies one level up.
 * `live-research-fanout-budget-ab.test.ts` already encodes this by hand ("n=3 per
 * arm can never reach 0.05 — this is why MIN_CONTROL_N is 4"); this makes it a
 * question any harness can ask before spending model time.
 */
export function minAttainableP(nTreatment: number, nBaseline: number): number {
    if (nTreatment <= 0 || nBaseline <= 0) return 1
    return fisherOneSided(nTreatment, 0, 0, nBaseline)
}

/** Wilson score interval for a proportion — the honest one at small n. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
    if (n === 0) return [0, 0]
    const p = hits / n
    const d = 1 + (z * z) / n
    const centre = (p + (z * z) / (2 * n)) / d
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
    return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

export const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length

/**
 * One percentage format, one zero-denominator convention. The harnesses grew five
 * `pct` signatures and four different renderings of 0/0 (`'n/a'`, `' n/a'`,
 * `'  n/a'`, `'—'`); a reader comparing two reports could not tell "nothing
 * happened" from "nothing was measured".
 */
export function pct(n: number, d: number, digits = 1): string {
    if (d === 0) return 'n/a'
    return `${((100 * n) / d).toFixed(digits)}%`
}

const EXACT_PERMUTATION_MAX_N = 12
const SAMPLED_PERMUTATIONS = 20000

/**
 * Two-sample permutation test on the difference of means, two-sided.
 *
 * Exact enumeration up to EXACT_PERMUTATION_MAX_N per arm (C(24,12) ≈ 2.7M,
 * ~1s); beyond that a sampled p is ample for a threshold decision. Sampling is
 * seeded so a verdict is reproducible — an A/B that reports a different p on
 * re-score is not a verdict.
 *
 * Use this rather than Fisher when the measurement is a QUANTITY per trial
 * (seconds, entries, tokens) instead of a hit or a miss.
 */
export function permutationP(a: number[], b: number[]): number {
    const all = [...a, ...b]
    const n = all.length
    const k = a.length
    const obs = Math.abs(mean(a) - mean(b))
    // Guard the degenerate cases before enumerating: identical means can never
    // be exceeded, and an empty arm has nothing to permute.
    if (k === 0 || b.length === 0) return 1
    const total = all.reduce((s, x) => s + x, 0)
    // Work in SUMS: with k fixed, comparing |sumA/k - sumB/(n-k)| is monotone in
    // sumA, so only the chosen half's sum is needed per arrangement.
    const diffOf = (sumA: number): number => Math.abs(sumA / k - (total - sumA) / (n - k))
    const EPS = 1e-9

    if (a.length <= EXACT_PERMUTATION_MAX_N && b.length <= EXACT_PERMUTATION_MAX_N) {
        let ge = 0
        let seen = 0
        // Enumerate every k-subset by index, accumulating its sum as we descend.
        const walk = (start: number, chosen: number, sumA: number): void => {
            if (chosen === k) {
                seen++
                if (diffOf(sumA) >= obs - EPS) ge++
                return
            }
            // Prune: not enough elements left to finish a k-subset.
            for (let i = start; i <= n - (k - chosen); i++) walk(i + 1, chosen + 1, sumA + all[i]!)
        }
        walk(0, 0, 0)
        return ge / seen
    }

    // Sampled fallback. Deterministic LCG rather than Math.random so re-scoring
    // the same corpus reports the same p.
    let seed = 0x9e3779b9
    const next = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 0x1_0000_0000
    }
    let ge = 0
    const pool = [...all]
    for (let s = 0; s < SAMPLED_PERMUTATIONS; s++) {
        // Partial Fisher-Yates: only the first k slots need to be settled.
        for (let i = 0; i < k; i++) {
            const j = i + Math.floor(next() * (n - i))
            ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
        }
        let sumA = 0
        for (let i = 0; i < k; i++) sumA += pool[i]!
        if (diffOf(sumA) >= obs - EPS) ge++
    }
    // Add-one so a sampled p is never exactly 0 — an unobserved event is not an
    // impossible one, and 0 would read as infinite confidence.
    return (ge + 1) / (SAMPLED_PERMUTATIONS + 1)
}
