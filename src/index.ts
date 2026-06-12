import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerConfig} from './config/register.js'
import {registerTask} from './task/orchestrator.js'
import {registerTaskAuto} from './task/auto-orchestrator.js'
import {registerWorkers} from './workers/index.js'
import {registerRemote} from './remote/register.js'
import {registerThinkingCompression} from './thinking/compress.js'

export default function (pi: ExtensionAPI): void {
    registerConfig(pi)
    registerTask(pi)
    registerTaskAuto(pi)
    registerWorkers(pi)
    registerRemote(pi)
    registerThinkingCompression(pi)
}
