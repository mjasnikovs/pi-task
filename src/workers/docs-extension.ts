import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerPiWorkerDocs} from './pi-worker-docs.js'

export default function (pi: ExtensionAPI): void {
    registerPiWorkerDocs(pi)
}
