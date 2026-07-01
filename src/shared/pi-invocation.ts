import * as fs from 'node:fs'
import * as path from 'node:path'

/** Pick the right way to re-invoke pi: prefer the current pi script under the
 *  current node/bun runtime; fall back to the `pi` shim on PATH. Mirrors the
 *  pattern from pi-coding-agent's official subagent example.
 *
 *  `stdin`, when given, is the prompt to feed the child over stdin instead of as
 *  an argv element — pi reads its prompt from stdin when no positional message
 *  is passed, which keeps a large prompt off the length-limited command line
 *  (see runChild / GitHub issue #1). It is threaded through unchanged. */
export function getPiInvocation(
    args: string[],
    stdin?: string
): {command: string; args: string[]; stdin?: string} {
    // Test/dev override: point at a specific pi binary directly. Bypasses the
    // re-invoke-current-script heuristic, which goes wrong under `bun test`
    // (currentScript is the .test.ts file, not a pi entrypoint).
    if (process.env.PI_BIN) {
        return {command: process.env.PI_BIN, args, stdin}
    }
    const currentScript = process.argv[1]
    const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return {command: process.execPath, args: [currentScript, ...args], stdin}
    }
    const execName = path.basename(process.execPath).toLowerCase()
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
    if (!isGenericRuntime) {
        return {command: process.execPath, args, stdin}
    }
    return {command: 'pi', args, stdin}
}
