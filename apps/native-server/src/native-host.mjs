import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeNativeFrames, encodeNativeFrame } from './protocol.mjs'
import { BrowserConnector } from './connector.mjs'
import { BrowserTargetRunBindings } from './browser-target-run-bindings.mjs'
import { CONNECTOR_RESPONSE, sameBrowserTarget, validBrowserTarget, validBrowserTargetBinding } from './connector-protocol.mjs'
import { validRuntimeIdentitySummary } from './runtime-identity-contract.mjs'
import { HarnessWebProcess } from './harness-process.mjs'
import { redactSensitiveDiagnostic } from './redact.mjs'
import { checkUpdate, launchPreparedUpdate, prepareUpdate } from './release-update/index.mjs'
import { readUpdateStatus } from './release-update/update-status.mjs'
import { PrdEventTracker, normalizePrdTrackingEvent } from './prd-event-tracker.mjs'
import { UserIdentityTracker, normalizeUserIdentityObservation } from './user-identity-tracker.mjs'

const nativeLogPath = process.env.DSH_NATIVE_LOG?.trim()
const runtimeManifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime-manifest.json')

function validProductVersion(value) {
  return typeof value === 'string' && value.trim().length <= 128 && /^\d+(?:\.\d+){0,3}$/.test(value.trim())
}

function releaseUpdateCandidate(update) {
  if (update?.available !== true || typeof update.packageUrl !== 'string' || !/^https:\/\//.test(update.packageUrl)) return undefined
  if (typeof update.packageId === 'string' && update.packageId.length > 0 && update.packageId.length <= 1_024 && !/[\r\n]/.test(update.packageId)) {
    return Object.freeze({ packageId: update.packageId, packageUrl: update.packageUrl })
  }
  if (typeof update.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(update.version)
    || typeof update.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(update.sha256)) return undefined
  return Object.freeze({ version: update.version, sha256: update.sha256.toLowerCase(), packageUrl: update.packageUrl })
}

function releaseUpdateCandidateKey(candidate) {
  return candidate.packageId === undefined
    ? `release\u0000${candidate.version}\u0000${candidate.sha256}\u0000${candidate.packageUrl}`
    : `package\u0000${candidate.packageId}\u0000${candidate.packageUrl}`
}

function installedNativeVersion(installRoot) {
  try {
    const release = JSON.parse(readFileSync(resolve(installRoot, 'release.json'), 'utf8'))
    return validProductVersion(release?.extensionVersion) ? release.extensionVersion.trim() : undefined
  } catch {
    return undefined
  }
}

function installedRuntimeIdentity() {
  if (!existsSync(runtimeManifestPath)) return undefined
  try {
    const value = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
    if (!validRuntimeIdentitySummary(value)) return undefined
    return Object.freeze({
      format: value.format,
      upstreamRevision: value.upstreamRevision,
      productHash: value.productHash,
      assetHash: value.assetHash,
      assetFileCount: value.assetFileCount,
      pluginHash: value.pluginHash,
      pluginFileCount: value.pluginFileCount,
      bootEntries: value.bootEntries,
      productBootEntries: value.productBootEntries,
      installRoot: value.installRoot,
    })
  } catch {
    return undefined
  }
}

function nativeLog(message) {
  if (!nativeLogPath) return
  try {
    appendFileSync(nativeLogPath, `${new Date().toISOString()} ${redactSensitiveDiagnostic(message)}\n`)
  } catch {
    // Diagnostics must never interfere with the Native Messaging protocol.
  }
}

function harnessWebUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('Harness Web URL must be an http 127.0.0.1 loopback URL with a port')
  }
  return url.toString().replace(/\/$/, '')
}

process.on('uncaughtException', (error) => {
  nativeLog(`uncaughtException ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
process.on('unhandledRejection', (error) => {
  nativeLog(`unhandledRejection ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})

/**
 * Chrome Native Messaging host. Its stdout is protocol-only; diagnostics go
 * to stderr so Chrome never sees an unframed byte.
 */
export class NativeHost {
  /** @param {{ processFactory?: (options: { mcpConnector: { url: string, token: string }, prototypeRecoveryPublicKey: string, prototypeRecoveryRunId: string, env?: NodeJS.ProcessEnv }) => HarnessWebProcess, connectorFactory?: (options: { requestExtension: (request: object) => void, reportPrdEvent: (event: object) => Promise<unknown>, browserTargetRunBindings: BrowserTargetRunBindings }) => BrowserConnector, browserTargetRunBindings?: BrowserTargetRunBindings, prdEventTracker?: PrdEventTracker, userIdentityTracker?: UserIdentityTracker, exit?: (code: number) => void, runtimeIdentity?: object, nativeVersion?: string, updateCheck?: typeof checkUpdate, updatePrepare?: typeof prepareUpdate, updateLaunch?: typeof launchPreparedUpdate, updateStatusRead?: typeof readUpdateStatus, installRoot?: string, platform?: NodeJS.Platform, prototypeRecoveryKeyPair?: { privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject } }} [options] */
  constructor(options = {}) {
    this.processFactory = options.processFactory ?? ((processOptions) => new HarnessWebProcess(processOptions))
    this.connectorFactory = options.connectorFactory ?? ((connectorOptions) => new BrowserConnector(connectorOptions))
    this.exit = options.exit ?? ((code) => process.exit(code))
    this.harness = undefined
    this.connector = undefined
    this.browserTargetRunBindings = options.browserTargetRunBindings ?? new BrowserTargetRunBindings()
    this.serverUrl = undefined
    this.startPromise = undefined
    this.closePromise = undefined
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.runtimeIdentity = options.runtimeIdentity ?? installedRuntimeIdentity()
    this.updateCheck = options.updateCheck ?? checkUpdate
    this.updatePrepare = options.updatePrepare ?? prepareUpdate
    this.updateLaunch = options.updateLaunch ?? launchPreparedUpdate
    this.updateStatusRead = options.updateStatusRead ?? readUpdateStatus
    this.releaseUpdateRequest = undefined
    this.releaseUpdateCandidates = new Map()
    this.releaseUpdateCommitted = false
    this.installRoot = options.installRoot ?? this.runtimeIdentity?.installRoot ?? process.env.ACCR_INSTALL_ROOT ?? process.cwd()
    this.nativeVersion = validProductVersion(options.nativeVersion) ? options.nativeVersion.trim() : installedNativeVersion(this.installRoot)
    this.platform = options.platform ?? process.platform
    this.productVersion = process.env.ACCR_PRODUCT_VERSION
    this.prdEventTracker = options.prdEventTracker ?? new PrdEventTracker({ productVersion: this.productVersion })
    this.userIdentityTracker = options.userIdentityTracker ?? new UserIdentityTracker({ productVersion: this.productVersion, apiKey: this.prdEventTracker.apiKey })
    this.prdEventTracker.start()
    this.userIdentityTracker.start()
    this.prototypeRecoveryKeyPair = options.prototypeRecoveryKeyPair ?? generateKeyPairSync('ed25519')
    this.prototypeRecoveryPublicKey = this.prototypeRecoveryKeyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  }

  /** Attach stdin/stdout and start consuming frames. */
  start() {
    nativeLog(`start pid=${process.pid} cwd=${process.cwd()} stdinTTY=${String(stdin.isTTY)} stdoutTTY=${String(stdout.isTTY)}`)
    stdin.on('data', (chunk) => {
      try {
        nativeLog(`stdin data bytes=${String(chunk.length)}`)
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
        const decoded = decodeNativeFrames(this.buffer)
        this.buffer = decoded.remainder
        nativeLog(`decoded messages=${String(decoded.messages.length)} remainder=${String(this.buffer.length)} errors=${String(decoded.errors.length)}`)
        for (const error of decoded.errors) this.send({ type: 'error', error })
        for (const message of decoded.messages) void this.handle(message)
      } catch (error) {
        this.send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
        void this.close('invalid native frame')
      }
    })
    stdin.on('end', () => {
      nativeLog('stdin end')
      void this.close('browser disconnected')
    })
    stdin.on('error', (error) => {
      nativeLog(`stdin error ${error.message}`)
      void this.close(`stdin error: ${error.message}`)
    })
    stdout.on('error', (error) => {
      nativeLog(`stdout error ${error.message}`)
      void this.close(`stdout error: ${error.message}`)
    })
  }

  /** @param {unknown} message */
  async handle(message) {
    if (this.closed) return
    if (!message || typeof message !== 'object') {
      this.send({ type: 'error', error: 'Native message must be an object.' })
      return
    }
    const type = message.type
    if (type === 'ping') {
      this.send({ type: 'pong' })
      return
    }
    if (type === 'start') {
      await this.startHarness(message.browserTarget, message.browserTargets, message.unavailableBrowserTargets, message.productVersion)
      return
    }
    if (type === 'transfer-browser-target') {
      this.transferBrowserTarget(message.requestId, message.runId, message.browserTarget, message.browserTargets, message.unavailableBrowserTargets)
      return
    }
    if (type === 'capture-browser-target') {
      this.captureBrowserTarget(message.requestId, message.runId, message.sessionId, message.submissionId, message.browserTarget, message.browserTargets, message.unavailableBrowserTargets)
      return
    }
    if (type === 'release-browser-target-capture') {
      this.browserTargetRunBindings.release(message.sessionId, message.submissionId)
      return
    }
    if (type === 'sign-prototype-recovery') {
      this.signPrototypeRecovery(message.requestId, message.payload)
      return
    }
    if (type === 'release-update-check') {
      await this.checkReleaseUpdate(message.requestId)
      return
    }
    if (type === 'release-update-prepare') {
      await this.prepareReleaseUpdate(message.requestId, message.candidate)
      return
    }
    if (type === 'release-update-cancel') {
      this.cancelReleaseUpdate(message.requestId)
      return
    }
    if (type === 'report-prd-event') {
      await this.reportPrdEvent(message.requestId, message.payload)
      return
    }
    if (type === 'report-user-identity') {
      const observation = normalizeUserIdentityObservation(message.payload)
      if (observation !== undefined) void this.userIdentityTracker.report(observation).catch(() => {})
      return
    }
    if (type === 'record-pmd-prd-review-adoption') {
      this.recordPmdPrdReviewAdoption(message.requestId, message.payload)
      return
    }
    if (type === CONNECTOR_RESPONSE) {
      if (this.connector?.acceptExtensionResponse(message) !== true) {
        this.send({ type: 'error', error: 'Unrecognized Connector response.' })
      }
      return
    }
    if (type === 'stop') {
      await this.close('stop requested')
      return
    }
    this.send({ type: 'error', error: `Unknown native message type: ${String(type)}` })
  }

  /** Confirm a report only after the tracker has persisted it to the local outbox. */
  async reportPrdEvent(requestId, payload) {
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 160) return
    const event = normalizePrdTrackingEvent(payload)
    if (event === undefined) {
      this.send({ type: 'prd_event_failed', requestId, error: 'PRD 埋点数据无效。' })
      return
    }
    try {
      if (await this.prdEventTracker.report(event) !== true) {
        this.send({ type: 'prd_event_failed', requestId, error: 'PRD 埋点未持久化。' })
        return
      }
      this.send({ type: 'prd_event_recorded', requestId })
    } catch (error) {
      this.send({ type: 'prd_event_failed', requestId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async startHarness(browserTarget, browserTargets, unavailableBrowserTargets, productVersion) {
    if (this.closed) return
    const currentBinding = this.browserTargetRunBindings.current()
    const currentRunId = currentBinding?.runId
    const boundTarget = currentBinding?.browserTarget
    if (validBrowserTarget(browserTarget) && validBrowserTarget(boundTarget) && !sameBrowserTarget(browserTarget, boundTarget)) {
      this.send({ type: 'error', error: 'Harness Run is already bound to a different Browser Target.' })
      return
    }
    if (browserTarget !== undefined && !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      this.send({ type: 'error', error: 'Browser Target binding must contain a trusted primary target and one or more unique selected targets.' })
      return
    }
    if (currentRunId === undefined) this.#createRun(browserTarget, browserTargets, unavailableBrowserTargets)
    else if (validBrowserTarget(browserTarget) && boundTarget === undefined) {
      this.send({ type: 'error', error: 'Harness Run is unbound. Use transfer-browser-target to bind an explicit Browser Target.' })
      return
    }
    if (this.serverUrl !== undefined) {
      this.send({ type: 'server_started', payload: { url: this.serverUrl, runId: this.browserTargetRunBindings.currentRunId, knowledgeProxyUrl: `${this.connector.url}/knowledge-proxy`, knowledgeProxyToken: this.connector.token, ...(this.nativeVersion === undefined ? {} : { nativeVersion: this.nativeVersion }), ...(this.runtimeIdentity === undefined ? {} : { runtimeIdentity: this.runtimeIdentity }) } })
      return
    }
    if (this.startPromise === undefined) {
      this.startPromise = this.#startHarness(productVersion).finally(() => {
        this.startPromise = undefined
      })
    }
    try {
      const url = await this.startPromise
      this.send({ type: 'server_started', payload: { url, runId: this.browserTargetRunBindings.currentRunId, knowledgeProxyUrl: `${this.connector.url}/knowledge-proxy`, knowledgeProxyToken: this.connector.token, ...(this.nativeVersion === undefined ? {} : { nativeVersion: this.nativeVersion }), ...(this.runtimeIdentity === undefined ? {} : { runtimeIdentity: this.runtimeIdentity }) } })
    } catch (error) {
      this.send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  transferBrowserTarget(requestId, runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (typeof requestId !== 'string' || requestId.length === 0 || typeof runId !== 'string' || runId.length === 0
      || !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      this.send({ type: 'browser_target_transfer_failed', requestId, error: 'transfer-browser-target requires a request id, Run id, and explicit Chrome Browser Target.' })
      return false
    }
    if (runId !== this.browserTargetRunBindings.currentRunId) {
      this.send({ type: 'browser_target_transfer_failed', requestId, error: 'Browser Target transfer does not match the active Harness Run.' })
      return false
    }
    const transferred = this.connector === undefined
      ? this.browserTargetRunBindings.transfer(runId, browserTarget, browserTargets, unavailableBrowserTargets).ok
      : this.connector.bindBrowserTarget(runId, browserTarget, browserTargets, unavailableBrowserTargets)
    if (!transferred) {
      this.send({ type: 'browser_target_transfer_failed', requestId, error: 'Browser Target transfer does not match the active Harness Run.' })
      return false
    }
    const binding = this.browserTargetRunBindings.bindingFor(runId)
    const targetSet = binding.browserTargets
    const unavailable = binding.unavailableBrowserTargets
    const isMultiTarget = browserTargets !== undefined || unavailableBrowserTargets !== undefined
    this.send({ type: 'browser_target_transferred', requestId, payload: {
      runId, browserTarget: { ...binding.browserTarget },
      ...(isMultiTarget ? {
        browserTargets: targetSet.map((target) => ({ ...target })),
        unavailableBrowserTargets: unavailable.map((item) => ({ browserTarget: { ...item.browserTarget }, reason: item.reason })),
      } : {}),
    } })
    return true
  }

  captureBrowserTarget(requestId, runId, sessionId, submissionId, browserTarget, browserTargets, unavailableBrowserTargets) {
    const fail = (error) => { this.send({ type: 'browser_target_capture_failed', requestId, error }); return false }
    if (typeof requestId !== 'string' || requestId.length === 0 || typeof runId !== 'string' || runId !== this.browserTargetRunBindings.currentRunId
      || typeof sessionId !== 'string' || typeof submissionId !== 'string'
      || !validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)) {
      return fail('capture-browser-target requires the active Run, trusted Harness session, submission, and explicit Browser Target.')
    }
    if (this.browserTargetRunBindings.capture(runId, sessionId, submissionId, browserTarget, browserTargets, unavailableBrowserTargets) !== true) {
      return fail('Browser Target capture does not match the active Harness Run.')
    }
    this.send({ type: 'browser_target_captured', requestId })
    return true
  }

  signPrototypeRecovery(requestId, payload) {
    const fail = (error) => { this.send({ type: 'prototype_recovery_sign_failed', requestId, error }); return false }
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160 || this.browserTargetRunBindings.currentRunId === undefined || this.serverUrl === undefined) return fail('Prototype recovery signing requires the active Native Harness Run.')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 6) return fail('Prototype recovery signing payload is invalid.')
    const { projectId, expectedSessionId, referenceId, evidenceFingerprint, capabilityFingerprint, expectedRecoveryEpoch } = payload
    if (typeof projectId !== 'string' || !/^prototype-[a-z0-9-]{8,72}$/.test(projectId)
      || typeof expectedSessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(expectedSessionId)
      || typeof referenceId !== 'string' || referenceId.length < 1 || referenceId.length > 160
      || typeof evidenceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceFingerprint)
      || typeof capabilityFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(capabilityFingerprint)
      || !Number.isSafeInteger(expectedRecoveryEpoch) || expectedRecoveryEpoch < 0) return fail('Prototype recovery signing payload is invalid.')
    const issuedAt = Date.now()
    const assertion = { v: 1, purpose: 'prototype-studio-capability-recovery', runId: this.browserTargetRunBindings.currentRunId, projectId, expectedSessionId, referenceId, evidenceFingerprint, capabilityFingerprint, expectedRecoveryEpoch, nonce: randomUUID(), issuedAt, expiresAt: issuedAt + 60_000 }
    const bytes = Buffer.from(JSON.stringify([assertion.v, assertion.purpose, assertion.runId, assertion.projectId, assertion.expectedSessionId, assertion.referenceId, assertion.evidenceFingerprint, assertion.capabilityFingerprint, assertion.expectedRecoveryEpoch, assertion.nonce, assertion.issuedAt, assertion.expiresAt]))
    const signature = sign(null, bytes, this.prototypeRecoveryKeyPair.privateKey).toString('base64url')
    this.send({ type: 'prototype_recovery_signed', requestId, assertion, signature })
    return true
  }

  recordPmdPrdReviewAdoption(requestId, payload) {
    const fail = (error) => { this.send({ type: 'pmd_prd_review_adoption_failed', requestId, error }); return false }
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160 || this.browserTargetRunBindings.currentRunId === undefined || this.connector === undefined) return fail('PRD adoption requires the active Native Harness Run.')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 7) return fail('PRD adoption payload is invalid.')
    const { harnessSessionId, reviewId, resourceId, displayPath, revision, fingerprint, contentHash } = payload
    if (![harnessSessionId, reviewId, resourceId, revision].every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value))
      || typeof displayPath !== 'string' || displayPath.length < 1 || displayPath.length > 2048
      || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)
      || typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(contentHash)) return fail('PRD adoption payload is invalid.')
    const recorded = this.connector.recordPmdPrdReviewAdoption({ runId: this.browserTargetRunBindings.currentRunId, harnessSessionId, reviewId, resourceId, displayPath, revision, fingerprint, contentHash })
    if (!recorded) return fail('PRD adoption does not match the active Native Harness Run.')
    this.send({ type: 'pmd_prd_review_adoption_recorded', requestId })
    return true
  }

  async checkReleaseUpdate(requestId) {
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160) return this.send({ type: 'release_update_failed', requestId, error: '更新检查请求无效' })
    if (this.platform !== 'win32') return this.send({ type: 'release_update_failed', requestId, error: '在线更新仅支持 Windows Lite' })
    if (this.releaseUpdateRequest !== undefined || this.releaseUpdateCommitted) return this.send({ type: 'release_update_failed', requestId, error: '另一个在线更新请求正在处理中' })
    const controller = new AbortController()
    this.releaseUpdateRequest = { requestId, controller }
    try {
      const lastUpdate = await this.updateStatusRead(this.installRoot)
      const update = await this.updateCheck({
        installRoot: this.installRoot,
        currentVersion: this.productVersion,
        ...(lastUpdate?.state === 'succeeded' && typeof lastUpdate.packageId === 'string' ? { currentPackageId: lastUpdate.packageId } : {}),
        signal: controller.signal,
      })
      const candidate = releaseUpdateCandidate(update)
      if (candidate !== undefined) {
        this.releaseUpdateCandidates.set(releaseUpdateCandidateKey(candidate), candidate)
        while (this.releaseUpdateCandidates.size > 32) this.releaseUpdateCandidates.delete(this.releaseUpdateCandidates.keys().next().value)
      }
      this.send({ type: 'release_update_checked', requestId, update: { ...update, ...(lastUpdate === undefined ? {} : { lastUpdate }) } })
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      let lastUpdate
      try { lastUpdate = await this.updateStatusRead(this.installRoot) } catch {}
      if (lastUpdate === undefined) this.send({ type: 'release_update_failed', requestId, error: errorText })
      else this.send({ type: 'release_update_checked', requestId, update: { available: false, error: errorText, lastUpdate } })
    } finally {
      if (this.releaseUpdateRequest?.requestId === requestId) this.releaseUpdateRequest = undefined
    }
  }

  async prepareReleaseUpdate(requestId, requestedCandidate) {
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160) return this.send({ type: 'release_update_failed', requestId, error: '更新请求无效' })
    if (this.platform !== 'win32') return this.send({ type: 'release_update_failed', requestId, error: '在线更新仅支持 Windows Lite' })
    if (this.releaseUpdateRequest !== undefined || this.releaseUpdateCommitted) return this.send({ type: 'release_update_failed', requestId, error: '另一个在线更新请求正在处理中' })
    if (this.connector?.isBusy?.() === true) return this.send({ type: 'release_update_failed', requestId, error: '当前任务尚未完成；请等待浏览器操作结束后再更新' })
    const candidate = releaseUpdateCandidate({ available: true, ...requestedCandidate })
    if (candidate === undefined || !this.releaseUpdateCandidates.has(releaseUpdateCandidateKey(candidate))) return this.send({ type: 'release_update_failed', requestId, error: '请先检查更新，再开始安装' })
    const connector = this.connector
    const quiescent = typeof connector?.beginUpdateQuiescence === 'function'
    if (quiescent && connector.beginUpdateQuiescence() !== true) return this.send({ type: 'release_update_failed', requestId, error: '当前任务尚未完成；请等待浏览器操作结束后再更新' })
    const controller = new AbortController()
    this.releaseUpdateRequest = { requestId, controller }
    try {
      const prepared = await this.updatePrepare({ installRoot: this.installRoot, currentVersion: this.productVersion, candidate, signal: controller.signal })
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('在线更新请求已取消')
      if (connector?.isBusy?.() === true) throw new Error('当前任务尚未完成；请等待浏览器操作结束后再更新')
      // Starting the detached waiter is part of preparation: do not tell the
      // Browser that an update is accepted unless Windows has a process ready
      // to run the existing installer after this Host exits.
      await this.updateLaunch(prepared, {
        installRoot: this.installRoot,
        nativePid: process.pid,
        signal: controller.signal,
        onCommitted: () => { this.releaseUpdateCommitted = true },
      })
      this.releaseUpdateCommitted = true
      const reloadRequired = validProductVersion(this.productVersion) && prepared.version !== this.productVersion
      if (reloadRequired) this.send({ type: 'release_update_reload_required', requestId, version: prepared.version })
      this.send({ type: 'release_update_prepared', requestId, update: { available: true, version: prepared.version, sha256: prepared.sha256, reloadRequired } })
      // The detached updater waits for this Native Host PID. Close the Harness
      // process normally before Windows replaces its runtime files.
      setTimeout(() => {
        void this.close('release update requested')
      }, 20)
    } catch (error) {
      if (controller.signal.aborted && !this.releaseUpdateCommitted) this.send({ type: 'release_update_cancelled', requestId })
      else this.send({ type: 'release_update_failed', requestId, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.releaseUpdateRequest?.requestId === requestId) this.releaseUpdateRequest = undefined
      if (!this.releaseUpdateCommitted && quiescent) connector.endUpdateQuiescence()
    }
  }

  cancelReleaseUpdate(requestId) {
    if (typeof requestId !== 'string') return false
    const request = this.releaseUpdateRequest
    if (request?.requestId !== requestId) {
      this.send({ type: 'release_update_cancel_unknown', requestId })
      return false
    }
    if (this.releaseUpdateCommitted) {
      this.send({ type: 'release_update_cancel_too_late', requestId })
      return false
    }
    request.controller.abort(new Error('在线更新请求已取消'))
    return true
  }

  async close(reason) {
    if (this.closed) return
    this.closed = true
    nativeLog(`close reason=${reason}`)
    this.closePromise = (async () => {
      if (reason !== 'browser disconnected') process.stderr.write(`[native-server] ${reason}\n`)
      await this.harness?.stop()
      this.harness = undefined
      await this.connector?.stop()
      this.connector = undefined
      this.prdEventTracker.stop()
      this.userIdentityTracker.stop()
      this.browserTargetRunBindings.clear()
      this.serverUrl = undefined
      this.exit(0)
    })()
    await this.closePromise
  }

  async #startHarness(productVersion) {
    try {
      if (validProductVersion(productVersion)) {
        this.productVersion = productVersion.trim()
        this.prdEventTracker.setProductVersion(this.productVersion)
        this.userIdentityTracker.setProductVersion(this.productVersion)
      }
      if (this.connector === undefined) {
        this.connector = this.connectorFactory({
          requestExtension: (request) => this.send(request),
          reportPrdEvent: (event) => this.prdEventTracker.report(event),
          browserTargetRunBindings: this.browserTargetRunBindings,
        })
      }
      const connector = await this.connector.start()
      if (this.harness === undefined) {
        this.harness = this.processFactory({
          mcpConnector: { url: `${connector.url}/mcp`, token: connector.token },
          prototypeRecoveryPublicKey: this.prototypeRecoveryPublicKey,
          prototypeRecoveryRunId: this.browserTargetRunBindings.currentRunId,
          env: validProductVersion(productVersion)
            ? { ...process.env, ACCR_PRODUCT_VERSION: productVersion.trim() }
            : process.env,
        })
      }
      const harnessUrl = await this.harness.start()
      this.serverUrl = harnessWebUrl(harnessUrl)
      return this.serverUrl
    } catch (error) {
      await this.harness?.stop()
      this.harness = undefined
      await this.connector?.stop()
      this.connector = undefined
      this.browserTargetRunBindings.clear()
      this.serverUrl = undefined
      throw error
    }
  }

  #createRun(browserTarget, browserTargets, unavailableBrowserTargets) {
    const runId = randomUUID()
    this.browserTargetRunBindings.register(runId, browserTarget, browserTargets, unavailableBrowserTargets)
  }

  /** @param {unknown} message */
  send(message) {
    if (this.closed) return
    try {
      nativeLog(`send type=${typeof message === 'object' && message !== null ? String(message.type) : 'unknown'}`)
      stdout.write(encodeNativeFrame(message))
    } catch (error) {
      process.stderr.write(`[native-server] failed to write response: ${String(error)}\n`)
    }
  }
}

/** Start the production host when this module is used as the executable. */
export function runNativeHost() {
  const host = new NativeHost()
  host.start()
  return host
}
