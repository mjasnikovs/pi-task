import type {WebSocket} from 'ws'

// globalThis persists across jiti module re-evaluations on session switches
const g = globalThis as unknown as Record<string, Set<WebSocket> | undefined>
if (!g.__piRemoteClients) g.__piRemoteClients = new Set<WebSocket>()

const clients = g.__piRemoteClients!

export function addClient(ws: WebSocket): void {
    clients.add(ws)
}

export function removeClient(ws: WebSocket): void {
    clients.delete(ws)
}

export function broadcast(msg: unknown): void {
    const json = JSON.stringify(msg)
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(json)
        }
    }
}

export function sendTo(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg))
    }
}
