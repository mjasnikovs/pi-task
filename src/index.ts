import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerConfig} from './config/register.js'
import {registerTask} from './task/orchestrator.js'
import {registerTaskAuto} from './task/auto-orchestrator.js'
import {registerTaskPlan} from './task/plan-orchestrator.js'
import {registerWorkers} from './workers/index.js'
import {registerRemote} from './remote/register.js'
import {registerCommandWatchdog} from './task/command-watchdog.js'
import {registerStreamWatchdog} from './task/stream-watchdog.js'

export default function (pi: ExtensionAPI): void {
    registerConfig(pi)
    registerTask(pi)
    registerTaskAuto(pi)
    registerTaskPlan(pi)
    registerWorkers(pi)
    registerRemote(pi)
    registerCommandWatchdog(pi)
    registerStreamWatchdog(pi)
}
