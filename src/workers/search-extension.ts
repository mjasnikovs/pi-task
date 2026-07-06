import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerPiWorkerSearch} from './pi-worker-search.js'
import {registerPiWorkerFetch} from './pi-worker-fetch.js'

export default function (pi: ExtensionAPI): void {
    registerPiWorkerSearch(pi)
    registerPiWorkerFetch(pi)
}
