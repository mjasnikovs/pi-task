/**
 * clamp-output — the ONE trail-side ceiling for captured tool output.
 *
 * `appendGateRecord` flattens newlines to spaces, so the gate trail stays one line
 * per entry; this caps the volume, because a wedged tool can emit megabytes.
 * Extracted from task-gates.ts so every probe that carries evidence into a failure
 * detail clamps the SAME way: a second clamp with a second ceiling is how two
 * trails start disagreeing about what was captured.
 */
const TRAIL_OUTPUT_MAX_CHARS = 1200

export function clampOutput(output: string): string {
    return output.length > TRAIL_OUTPUT_MAX_CHARS ?
            `${output.slice(0, TRAIL_OUTPUT_MAX_CHARS)}…`
        :   output
}
