import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerPiWorker} from './pi-worker.js'
import {registerPiWorkerSearch} from './pi-worker-search.js'
import {registerPiWorkerFetch} from './pi-worker-fetch.js'
import {registerPiWorkerDocs} from './pi-worker-docs.js'

export function registerWorkers(pi: ExtensionAPI): void {
    registerPiWorker(pi)
    registerPiWorkerSearch(pi)
    registerPiWorkerFetch(pi)
    registerPiWorkerDocs(pi)
}
