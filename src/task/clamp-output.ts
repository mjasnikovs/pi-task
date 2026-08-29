/**
 * clamp-output — the ONE trail-side ceiling for captured tool output.
 *
 * `appendGateRecord` already collapses every run of whitespace-around-newline
 * into a single space, so each trail entry is one line. What it does NOT do is
 * bound the LENGTH, which is this. A wedged tool has no upper limit on what it
 * prints, and the trail is a task file a human reads.
 *
 * Both probes that carry tool output into a failure detail — the render check and
 * the gate's own command records — call THIS function, so the two trails cannot
 * start disagreeing about what was captured. A second clamp with a second ceiling
 * is exactly how that happens.
 *
 * At the boundary: 1200 characters pass through untouched, 1201 or more come back
 * clamped to 1200 plus a single ellipsis.
 */
const TRAIL_OUTPUT_MAX_CHARS = 1200

export function clampOutput(output: string): string {
    return output.length > TRAIL_OUTPUT_MAX_CHARS ?
            `${output.slice(0, TRAIL_OUTPUT_MAX_CHARS)}…`
        :   output
}
