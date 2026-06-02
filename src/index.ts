import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerTask} from './task/orchestrator.js'
import {registerWorkers} from './workers/index.js'

export default function (pi: ExtensionAPI): void {
    registerTask(pi)
    registerWorkers(pi)
}
