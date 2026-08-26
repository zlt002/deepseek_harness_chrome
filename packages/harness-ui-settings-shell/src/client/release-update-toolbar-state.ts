export type ReleaseToolbarState =
  | { phase: 'checking' | 'hidden' }
  | { phase: 'ready'; version?: string }
  | { phase: 'preparing' }
  | { phase: 'error'; error: string }

export function supportsReleaseUpdateToolbar(userAgent: string): boolean {
  return /Windows/i.test(userAgent)
}

export function checkedReleaseToolbarState(update: { available?: unknown, version?: unknown }): ReleaseToolbarState {
  return update.available === true
    ? { phase: 'ready', ...(typeof update.version === 'string' ? { version: update.version } : {}) }
    : { phase: 'hidden' }
}

export function releaseToolbarAction(state: ReleaseToolbarState): 'prepare' | undefined {
  return state.phase === 'ready' ? 'prepare' : undefined
}
