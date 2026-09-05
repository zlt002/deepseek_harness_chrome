import { validBrowserTarget, validBrowserTargetBinding } from '../transport/connector-protocol.mjs'

function validRunId(value) {
  return typeof value === 'string' && value.length > 0
}

function validSessionIdentity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

function frozenBinding(browserTarget, browserTargets, unavailableBrowserTargets) {
  if (!validBrowserTarget(browserTarget)) return undefined
  const targets = browserTargets ?? [browserTarget]
  const unavailable = unavailableBrowserTargets ?? []
  return Object.freeze({
    browserTarget: Object.freeze({ ...browserTarget }),
    browserTargets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
    unavailableBrowserTargets: Object.freeze(unavailable.map((item) => Object.freeze({ browserTarget: Object.freeze({ ...item.browserTarget }), reason: item.reason }))),
  })
}

function bindingResult(runId, binding) {
  return Object.freeze({ runId, ...(binding ?? { browserTarget: undefined, browserTargets: undefined, unavailableBrowserTargets: Object.freeze([]) }) })
}

/**
 * The Native Host and Browser Connector's single authority for Run bindings.
 * Every public read returns an immutable snapshot; callers never receive a
 * mutable reference to the selected or captured Browser Target.
 */
export class BrowserTargetRunBindings {
  #runs = new Map()
  #captures = new Map()
  #currentRunId = undefined

  get currentRunId() { return this.#currentRunId }

  clear() {
    this.#runs.clear()
    this.#captures.clear()
    this.#currentRunId = undefined
  }

  current() {
    return this.#currentRunId === undefined ? undefined : this.bindingFor(this.#currentRunId)
  }

  /** Register a new active Run. A later target movement must use transfer(). */
  register(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (!validRunId(runId) || (browserTarget !== undefined && !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets))) {
      return Object.freeze({ ok: false, runChanged: false, targetChanged: false })
    }
    const previousRunId = this.#currentRunId
    const runChanged = previousRunId !== undefined && previousRunId !== runId
    this.#currentRunId = runId
    if (!this.#runs.has(runId)) this.#runs.set(runId, frozenBinding(browserTarget, browserTargets, unavailableBrowserTargets))
    if (runChanged) this.#captures.clear()
    return Object.freeze({ ok: true, runChanged, targetChanged: false })
  }

  /** Move only the active Run to an explicitly trusted Browser Target. */
  transfer(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (runId !== this.#currentRunId || !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      return Object.freeze({ ok: false, runChanged: false, targetChanged: false })
    }
    const previous = this.#runs.get(runId)
    const next = frozenBinding(browserTarget, browserTargets, unavailableBrowserTargets)
    const targetChanged = previous !== undefined
      && (previous.browserTarget.browser !== next.browserTarget.browser
        || previous.browserTarget.windowId !== next.browserTarget.windowId
        || previous.browserTarget.tabId !== next.browserTarget.tabId
        || previous.browserTarget.url !== next.browserTarget.url)
    this.#runs.set(runId, next)
    return Object.freeze({ ok: true, runChanged: false, targetChanged })
  }

  /** Capture one submission's frozen target without changing the active Run binding. */
  capture(runId, sessionId, submissionId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (runId !== this.#currentRunId || !validSessionIdentity(sessionId) || !validSessionIdentity(submissionId)
      || !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) return false
    const binding = frozenBinding(browserTarget, browserTargets, unavailableBrowserTargets)
    this.#captures.set(`${runId}\u0000${sessionId}`, Object.freeze({ submissionId, ...binding }))
    return true
  }

  /** Release only the exact submission that owns the current session capture. */
  release(sessionId, submissionId) {
    if (this.#currentRunId === undefined || !validSessionIdentity(sessionId) || !validSessionIdentity(submissionId)) return false
    const key = `${this.#currentRunId}\u0000${sessionId}`
    const capture = this.#captures.get(key)
    if (capture?.submissionId !== submissionId) return false
    this.#captures.delete(key)
    return true
  }

  hasCaptures(runId) {
    return typeof runId === 'string' && [...this.#captures.keys()].some((key) => key.startsWith(`${runId}\u0000`))
  }

  /** Return the active Run binding, or a session capture when sessionId is supplied. */
  bindingFor(runId, sessionId) {
    if (!validRunId(runId) || !this.#runs.has(runId)) return undefined
    if (sessionId !== undefined) {
      if (!validSessionIdentity(sessionId)) return undefined
      const capture = this.#captures.get(`${runId}\u0000${sessionId}`)
      return capture === undefined ? undefined : Object.freeze({ runId, ...capture })
    }
    return bindingResult(runId, this.#runs.get(runId))
  }
}
