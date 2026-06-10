let _isAgentIdle = true

export function isAgentIdle(): boolean {
    return _isAgentIdle
}

export function setAgentIdle(idle: boolean): void {
    _isAgentIdle = idle
}
