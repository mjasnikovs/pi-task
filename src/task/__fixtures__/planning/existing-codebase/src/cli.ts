#!/usr/bin/env bun
/** logstats — nginx access-log statistics CLI (existing, working). */
import pc from 'picocolors'
import {parseLine} from './parse.js'

const [subcommand, logPath] = process.argv.slice(2)

if (subcommand !== 'counts' || !logPath) {
    console.error('usage: logstats counts <access.log> [--since <ISO date>]')
    process.exit(2)
}

const since = readSinceFlag(process.argv)
const counts = new Map<number, number>()
for (const line of (await Bun.file(logPath).text()).split('\n')) {
    if (line.trim().length === 0) continue
    const entry = parseLine(line)
    if (entry === null) continue
    if (since !== null && entry.time < since) continue
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)
}

for (const [status, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`${pc.bold(String(status))}  ${n}`)
}

function readSinceFlag(argv: string[]): Date | null {
    const i = argv.indexOf('--since')
    if (i === -1 || argv[i + 1] === undefined) return null
    const d = new Date(argv[i + 1])
    return Number.isNaN(d.getTime()) ? null : d
}
