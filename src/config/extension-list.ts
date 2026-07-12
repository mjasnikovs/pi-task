import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {DefaultPackageManager, SettingsManager, getAgentDir} from '@earendil-works/pi-coding-agent'

/**
 * Enumerates the host's installed pi extensions for the /task-config whitelist
 * (GitHub issue #4) using pi's OWN resolver — the same DefaultPackageManager
 * the host runtime discovers extensions with — so the menu always mirrors what
 * `pi list`/discovery would load: install a package and it appears, uninstall
 * it and it vanishes (a stale whitelist entry is then skipped at spawn time by
 * extensionArgs' existence filter, never fatal).
 */

export interface InstalledExtension {
    /** Absolute entry-point path — the whitelist identity AND the `-e` value. */
    path: string
    /** Short display name: package name for package sources, file stem for loose files. */
    label: string
    /** Provenance shown in the menu, e.g. "npm:pi-lmstudio (user)" or "discovered (user)". */
    origin: string
}

/**
 * pi-task's own package root. Anything resolve() reports under it is pi-task
 * itself (`dist/index.js` shows up as a discovered extension) and MUST be
 * excluded: whitelisting pi-task into its own children would recursively boot
 * the remote server and re-register every command in each child.
 */
export function selfPackageRoot(fromDir?: string): string {
    let dir = fromDir ?? path.dirname(fileURLToPath(import.meta.url))
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return dir
        dir = parent
    }
}

function isUnder(p: string, root: string): boolean {
    const rel = path.relative(root, p)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Display label for a resolved extension entry. */
export function extensionLabel(entryPath: string, source: string): string {
    // Package sources keep their identity ("npm:pi-lmstudio" → "pi-lmstudio");
    // discovered/local files read best as the file or directory stem.
    if (source.includes(':')) return source.slice(source.indexOf(':') + 1)
    const base = path.basename(entryPath).replace(/\.(ts|js|mts|mjs|cts|cjs)$/, '')
    return base === 'index' ? path.basename(path.dirname(entryPath)) : base
}

export interface ListInstalledOptions {
    cwd: string
    /** Override for tests; defaults to the host's real agent dir (~/.pi/agent). */
    agentDir?: string
    /** Override for tests; defaults to pi-task's own package root. */
    selfRoot?: string
}

/**
 * List every extension the host pi would load, excluding pi-task itself.
 * Only enabled entries are offered: an extension the user disabled in
 * `pi config` shouldn't be sneaked back in through a child whitelist.
 * Errors (unreadable settings, missing package dirs) surface as an empty
 * list at the caller — the menu then simply shows no extension toggles.
 */
export async function listInstalledExtensions(
    opts: ListInstalledOptions
): Promise<InstalledExtension[]> {
    const agentDir = opts.agentDir ?? getAgentDir()
    const selfRoot = opts.selfRoot ?? selfPackageRoot()
    const settingsManager = SettingsManager.create(opts.cwd, agentDir)
    const pm = new DefaultPackageManager({cwd: opts.cwd, agentDir, settingsManager})
    // "skip": a package in settings whose install dir is missing must not
    // trigger an interactive install prompt from inside a config menu.
    const resolved = await pm.resolve(() => Promise.resolve('skip'))
    const out: InstalledExtension[] = []
    for (const r of resolved.extensions) {
        if (!r.enabled) continue
        const abs = path.resolve(r.path)
        if (isUnder(abs, selfRoot)) continue
        out.push({
            path: abs,
            label: extensionLabel(abs, r.metadata.source),
            origin:
                r.metadata.source === 'auto' ?
                    `discovered (${r.metadata.scope})`
                :   `${r.metadata.source} (${r.metadata.scope})`
        })
    }
    return out
}
