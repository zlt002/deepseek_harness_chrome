import { sameBrowserTarget, validBrowserTarget, validBrowserTargetBinding } from './connector-protocol.mjs'

/**
 * Owns the trusted Run -> Browser Target relationship. Callers receive frozen
 * snapshots and never mutate the registry's target identity in place.
 */
export class RunTargetRegistry {
  constructor() {
    this.primary = new Map()
    this.selected = new Map()
    this.unavailable = new Map()
    this.currentRunId = undefined
  }

  clear() {
    this.primary.clear()
    this.selected.clear()
    this.unavailable.clear()
    this.currentRunId = undefined
  }

  register(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (typeof runId !== 'string' || runId.length === 0) return { ok: false, runChanged: false, targetChanged: false }
    if (browserTarget !== undefined && !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      return { ok: false, runChanged: false, targetChanged: false }
    }
    const previousRunId = this.currentRunId
    const previousTarget = this.primary.get(runId)
    this.currentRunId = runId
    if (validBrowserTarget(browserTarget)) {
      const targets = browserTargets ?? [browserTarget]
      const unavailable = unavailableBrowserTargets ?? []
      this.primary.set(runId, Object.freeze({ ...browserTarget }))
      this.selected.set(runId, Object.freeze(targets.map((target) => Object.freeze({ ...target }))))
      this.unavailable.set(runId, Object.freeze(unavailable.map((item) => Object.freeze({ browserTarget: Object.freeze({ ...item.browserTarget }), reason: item.reason }))))
    }
    return {
      ok: true,
      runChanged: previousRunId !== undefined && previousRunId !== runId,
      targetChanged: validBrowserTarget(previousTarget) && validBrowserTarget(browserTarget) && !sameBrowserTarget(previousTarget, browserTarget),
    }
  }

  get(runId) {
    const browserTarget = this.primary.get(runId)
    return {
      browserTarget,
      browserTargets: this.selected.get(runId) ?? (browserTarget === undefined ? undefined : [browserTarget]),
      unavailableBrowserTargets: this.unavailable.get(runId) ?? [],
    }
  }

  current() {
    return this.currentRunId === undefined ? undefined : { runId: this.currentRunId, ...this.get(this.currentRunId) }
  }
}
