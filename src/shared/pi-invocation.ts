import * as fs from 'node:fs'
import * as path from 'node:path'

/** Pick the right way to re-invoke pi: prefer the current pi script under the
 *  current node/bun runtime; fall back to the `pi` shim on PATH. This mirrors
 *  pi's own subagent example, which ships a function of the same name and the
 *  same three-step shape in `examples/extensions/subagent/index.ts`. What is
 *  added here is the `PI_BIN` override, the `/$bunfs/root/` guard, and `stdin`.
 *
 *  `stdin`, when given, is the prompt to feed the child over stdin instead of as
 *  an argv element — pi reads its prompt from stdin when no positional message
 *  is passed, which keeps a large prompt off the argv ceiling that would
 *  otherwise fail the spawn outright (see runChild). It is threaded through
 *  unchanged: every branch below returns it as given. */
export function getPiInvocation(
    args: string[],
    stdin?: string
): {command: string; args: string[]; stdin?: string} {
    // Test/dev override: point at a specific pi binary directly. It bypasses the
    // re-invoke-current-script heuristic below, which goes wrong under the test
    // runner — confirmed by printing it from inside a test, where `process.argv[1]`
    // is the `.test.ts` file itself. Without this the child would be the runtime
    // re-running a test file, not pi.
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
