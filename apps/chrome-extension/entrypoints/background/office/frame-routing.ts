import { isSpreadsheetResourceIdentity } from '../office-request-contract'
import type { OfficeReadFailure, PresentationResourceIdentity, SpreadsheetResourceIdentity } from '../office-request-contract'

export interface SpreadsheetFrameBinding {
  frameId: number
  frameUrl: string
  resource: SpreadsheetResourceIdentity
}

export interface PresentationFrameBinding {
  frameId: number
  frameUrl: string
  resource: PresentationResourceIdentity
}

const OFFICE_CONTENT_SCRIPT_FILES = ['content-scripts/office-read.js']

function isMissingReceivingEnd(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}

function probeMessageFor(message: Record<string, unknown>): Record<string, unknown> {
  const type = String(message.type)
  if (type === 'office-spreadsheet/v1') return { type, action: 'probe' }
  if (type === 'office-document/v1') return { type, action: 'probe' }
  if (type === 'office-presentation/v1') return { type, action: 'probe' }
  if (type === 'office-read-range/v1') return { type, action: 'probe' }
  return { type: 'office-read-range/v1', action: 'probe' }
}

/**
 * A "none ready within 8s" failure is ambiguous downstream: the doc.midea.com
 * page can host a spreadsheet iframe while the caller probed the light-document
 * channel (or vice versa), and the model then tells the user "the editor is
 * still loading" when the frames simply host the other document type. When the
 * requested channel stays silent, ask the sibling channel once: a ready answer
 * turns the error into an actionable "this Browser Target hosts a spreadsheet /
 * document, call the other tool" instead of a wrong diagnosis.
 */
function siblingProbeType(type: string): string | null {
  if (type === 'office-document/v1') return 'office-spreadsheet/v1'
  if (type === 'office-spreadsheet/v1') return 'office-document/v1'
  return null
}

function channelReadyLabel(type: string): string {
  if (type === 'office-document/v1') return 'light-document editor'
  if (type === 'office-spreadsheet/v1') return 'spreadsheet runtime'
  if (type === 'office-presentation/v1') return 'presentation runtime'
  return 'editor runtime'
}

function probeSucceeded(reply: { ok?: unknown; result?: unknown } | undefined): boolean {
  if (reply?.ok !== true) return false
  const result = reply.result as { status?: unknown; ready?: unknown } | undefined
  return result?.status === 'probe' && result?.ready === true
}

const OFFICE_PROBE_WAIT_MS_DEFAULT = 8_000
const OFFICE_PROBE_RETRY_MS = 250
const OFFICE_FRAME_READ_OPERATION_MS_DEFAULT = 8_000
const OFFICE_FRAME_WRITE_OPERATION_MS_DEFAULT = 22_000

function officeFrameOperationBudgetMs(message?: Record<string, unknown>): number {
  const configured = Number((globalThis as typeof globalThis & { __DSH_OFFICE_FRAME_OPERATION_MS?: unknown }).__DSH_OFFICE_FRAME_OPERATION_MS)
  if (Number.isFinite(configured) && configured >= 0) return configured
  // Content-script writes can take 20 seconds for runtime readiness, mutation,
  // and same-frame readback. Keep the outer frame budget above that window but
  // below the Native Connector's 30-second Office request deadline.
  return ['inspect_write', 'write'].includes(String(message?.action)) ? OFFICE_FRAME_WRITE_OPERATION_MS_DEFAULT : OFFICE_FRAME_READ_OPERATION_MS_DEFAULT
}

/**
 * Chrome never re-injects content scripts into already-loaded frames, so every
 * extension reload orphans WebEdit iframes in pages opened before it: the frame
 * still exists but nobody answers. On that exact failure, re-inject the
 * registered content script into the frame once and retry, instead of failing
 * until the user manually refreshes the page.
 *
 * A doc.midea.com page can host several webedit.midea.com iframes (ad,
 * footer, hidden bridges) whose editor never finishes mounting — WebEdit can
 * reset iframes without notice, so getAllFrames order is not stable. Like
 * accr-ui's MCP-server probe, ask every candidate frame whether its editor
 * runtime is ready, then talk to the ready one instead of the first match.
 *
 * Editor boot is not instant: the in-frame runtimes themselves poll for the
 * editor global for up to 8s, and accr-ui budgets 30s. A single instant probe
 * would permanently skip every still-booting frame, so keep sweeping all
 * candidates within the same 8s budget before declaring none ready. The final
 * error names the frame count so "no iframe at all" and "iframes exist but no
 * editor inside" stay distinguishable downstream, and when the sibling channel
 * answers ready it names the actual document type so the caller switches tools
 * instead of misreading "wrong document type" as "editor still loading".
 *
 * Several frames can be ready at once (a preloaded blank editor beside the
 * user's real document), so each sweep collects every ready candidate and its
 * probe identity, then picks by framePreference below instead of the first
 * match.
 *
 * Returns the frame that actually answered so callers can verify that exact
 * frame afterwards.
 */
type ProbeIdentity = { kind?: unknown; origin?: unknown; path?: unknown; workbookName?: unknown; sheetName?: unknown; presentationName?: unknown; documentName?: unknown; documentId?: unknown; fingerprint?: unknown; slideCount?: unknown; hasContent?: unknown }

function identityPath(identity: ProbeIdentity | undefined): string {
  return typeof identity?.path === 'string' ? identity.path.toLowerCase() : ''
}

function pathLooksLikeSpreadsheet(path: string): boolean {
  return path.includes('/weboffice/office/s/') || path.includes('/moewebv7/document-cloud')
}

function pathLooksLikeLightDocument(path: string): boolean {
  return path.includes('/weboffice/office/o/')
}

function pathLooksLikePresentation(path: string): boolean {
  return path.includes('/weboffice/office/p/')
}

function substantialSpreadsheet(identity: ProbeIdentity | undefined): boolean {
  return identity?.hasContent === true
    || (typeof identity?.workbookName === 'string' && identity.workbookName.length > 0)
}

function probeIdentityOf(reply: { ok?: unknown; result?: unknown } | undefined): ProbeIdentity | undefined {
  // The light-document and spreadsheet adapters expose `identity`; the
  // presentation adapter exposes the same data as `resource`.  Treat both as
  // the probe identity so the background stays adapter-neutral.
  const result = reply?.result as { status?: unknown; identity?: unknown; resource?: unknown } | undefined
  const identity = result?.identity ?? result?.resource
  return identity && typeof identity === 'object' && !Array.isArray(identity) ? identity as ProbeIdentity : undefined
}

/**
 * Rank a ready frame for the "which document did the user mean" choice.
 * A doc.midea.com page can preload a blank editor iframe (workbookName null,
 * fresh Sheet1, nothing typed) beside the user's real document, so a blind
 * "first ready frame wins" reads the wrong spreadsheet and every cell comes
 * back null. Prefer frames that prove content, then named workbooks; only
 * fall back to iteration order when nothing better distinguishes them.
 * Lower rank wins; ties keep getAllFrames order.
 */
/**
 * One quick identity sweep for list_work_tabs: ask every webedit frame on
 * both editor channels (spreadsheet + light document), without the 8s wait or
 * healing budget that real operations use. A hardcoded documentIdentity:null
 * made downstream models read "no WebEdit document here" out of a page whose
 * spreadsheet editor answers in milliseconds, so report the best ready frame's
 * kind and identity instead; null now genuinely means "nothing answered".
 *
 * accr-ui classifies /weboffice/office/o/ as a light document and /office/s/
 * as a spreadsheet. A Team Knowledge light-document page also preloads a
 * blank spreadsheet iframe; prefer the ready light document over that blank
 * sheet so light_document_read is used instead of a spreadsheet read.
 */
export async function probeDocumentIdentity(tabId: number): Promise<Record<string, unknown> | null> {
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }) ?? [])
      .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
    if (frames.length === 0) return null
    const spreadsheetCandidates: ProbeIdentity[] = []
    const lightDocumentCandidates: ProbeIdentity[] = []
    const presentationCandidates: ProbeIdentity[] = []
    await Promise.all(frames.flatMap((frame) => (['office-spreadsheet/v1', 'office-document/v1', 'office-presentation/v1'] as const).map(async (channel) => {
      try {
        const reply = await sendMessageWithBudget(tabId, { type: channel, action: 'probe' }, frame.frameId, 250)
        if (!probeSucceeded(reply)) return
        const identity = probeIdentityOf(reply) ?? {}
        const path = identityPath(identity)
        // accr-ui: /weboffice/office/o/ is a light document, /office/s/ is a
        // spreadsheet. A Team Knowledge light-document page also preloads a
        // blank spreadsheet iframe; never let that blank frame steal identity.
        if (channel === 'office-spreadsheet/v1') {
          if (pathLooksLikeLightDocument(path) || pathLooksLikePresentation(path)) return
          spreadsheetCandidates.push(identity)
        } else if (channel === 'office-document/v1') {
          if (pathLooksLikeSpreadsheet(path) || pathLooksLikePresentation(path)) return
          lightDocumentCandidates.push(identity)
        } else {
          // A Team Knowledge PPT can expose its outer document-cloud route to
          // the runtime while webNavigation still identifies the editor frame
          // as /office/p/. The presentation probe itself must be ready; the
          // frame URL merely supplies the missing route discriminator.
          if (!pathLooksLikePresentation(path) && !pathLooksLikePresentation(frame.url)) return
          presentationCandidates.push(identity)
        }
      } catch { /* diagnostic-only probe: an unreachable frame simply does not count */ }
    })))
    const lightDocumentReady = lightDocumentCandidates.length > 0
    const substantial = spreadsheetCandidates.filter(substantialSpreadsheet)
    // Every presentation candidate above has already passed a ready
    // presentation-runtime probe and an explicit presentation route check.
    const presentations = presentationCandidates
    const spreadsheetKind = (best: ProbeIdentity) => ({
      kind: 'webedit_spreadsheet',
      workbookName: typeof best.workbookName === 'string' ? best.workbookName : null,
      sheetName: typeof best.sheetName === 'string' ? best.sheetName : null,
      hasContent: best.hasContent === true ? true : best.hasContent === false ? false : null,
      webeditFrames: frames.length,
    })
    if (presentations.length > 0) {
      const best = presentations[0]
      return {
        kind: 'webedit_presentation',
        presentationName: typeof best.presentationName === 'string' ? best.presentationName : typeof best.documentName === 'string' ? best.documentName : null,
        slideCount: Number.isInteger(best.slideCount) ? Number(best.slideCount) : null,
        hasContent: best.hasContent === true ? true : null,
        webeditFrames: frames.length,
      }
    }
    if (substantial.length > 0) {
      const best = substantial.reduce((leader, candidate) => framePreference(candidate) < framePreference(leader) ? candidate : leader)
      return spreadsheetKind(best)
    }
    if (lightDocumentReady) return { kind: 'webedit_light_document', workbookName: null, sheetName: null, hasContent: null, webeditFrames: frames.length }
    if (spreadsheetCandidates.length > 0) {
      const best = spreadsheetCandidates.reduce((leader, candidate) => framePreference(candidate) < framePreference(leader) ? candidate : leader)
      return spreadsheetKind(best)
    }
    return null
  } catch { /* a failed context probe must never break list_work_tabs itself */ return null }
}

function framePreference(identity: ProbeIdentity | undefined): number {  if (identity?.hasContent === true) return 0
  if (typeof identity?.workbookName === 'string' && identity.workbookName.length > 0) return 1
  return 2
}

function isProbeTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'probe_timeout')
}

type ReadyWebEditFrame = { frame: chrome.webNavigation.GetAllFrameResultDetails; identity: ProbeIdentity | undefined }

export interface PresentationFrameSelection {
  expectedResource?: PresentationResourceIdentity
  precondition?: Record<string, unknown>
  binding?: PresentationFrameBinding
}
export interface SpreadsheetFrameSelection {
  expectedResource?: SpreadsheetResourceIdentity
  precondition?: Record<string, unknown>
  binding?: SpreadsheetFrameBinding
}

export function presentationResourceFromProbe(value: unknown): PresentationResourceIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const resource = value as Record<string, unknown>
  const presentationName = typeof resource.presentationName === 'string' || resource.presentationName === null ? resource.presentationName : undefined
  const documentName = typeof resource.documentName === 'string' || resource.documentName === null ? resource.documentName : undefined
  const documentId = typeof resource.documentId === 'string' || typeof resource.documentId === 'number' || resource.documentId === null ? resource.documentId : undefined
  const path = typeof resource.path === 'string' ? resource.path : undefined
  const fingerprint = typeof resource.fingerprint === 'string' && resource.fingerprint.length > 0 ? resource.fingerprint : undefined
  const slideCount = Number.isInteger(resource.slideCount) && Number(resource.slideCount) >= 0 ? Number(resource.slideCount) : undefined
  if (resource.kind !== 'webedit_presentation' || resource.origin !== 'https://webedit.midea.com' || fingerprint === undefined) return undefined
  // A fingerprint alone cannot prove which of two ready presentations owns it
  // after a runtime reset. Require at least one stable service/editor anchor.
  if (documentId === undefined && path === undefined && presentationName === undefined && documentName === undefined) return undefined
  return {
    kind: 'webedit_presentation', origin: 'https://webedit.midea.com', fingerprint,
    ...(presentationName === undefined ? {} : { presentationName }),
    ...(documentName === undefined ? {} : { documentName }),
    ...(documentId === undefined ? {} : { documentId }),
    ...(path === undefined ? {} : { path }),
    ...(slideCount === undefined ? {} : { slideCount }),
  }
}

function presentationNameOf(resource: PresentationResourceIdentity): string | null | undefined {
  return resource.presentationName ?? resource.documentName
}

function samePresentationAnchor(expected: PresentationResourceIdentity, actual: PresentationResourceIdentity): boolean {
  if (expected.documentId !== undefined && expected.documentId !== null && actual.documentId !== expected.documentId) return false
  if (expected.path !== undefined && actual.path !== expected.path) return false
  const expectedName = presentationNameOf(expected)
  const actualName = presentationNameOf(actual)
  return !(expectedName !== undefined && expectedName !== null && actualName !== expectedName)
}

function presentationIdentityKey(resource: PresentationResourceIdentity): string | undefined {
  if (resource.documentId !== undefined && resource.documentId !== null) return `id:${String(resource.documentId)}`
  if (resource.path !== undefined) return `path:${resource.path}`
  const name = presentationNameOf(resource)
  return name === undefined || name === null ? undefined : `name:${name}`
}

async function completePresentationProbe(tabId: number, candidate: ReadyWebEditFrame): Promise<{ candidate: ReadyWebEditFrame; resource?: PresentationResourceIdentity }> {
  const direct = presentationResourceFromProbe(candidate.identity)
  if (direct !== undefined) return { candidate, resource: direct }
  // Older/partially mounted presentation probes can report only `ready`. A
  // private context read supplies the runtime resource without exposing a new
  // model-facing field or sending a mutation to an unverified frame.
  try {
    const reply = await sendMessageWithBudget(tabId, { type: 'office-presentation/v1', action: 'get_context' }, candidate.frame.frameId, Math.min(1_000, officeFrameOperationBudgetMs()))
    return { candidate, resource: presentationResourceFromProbe((reply?.result as { resource?: unknown } | undefined)?.resource) }
  } catch { return { candidate } }
}

function presentationSelectionError(code: OfficeReadFailure['code'], message: string): OfficeReadFailure {
  return { code, message }
}

async function selectPresentationFrame(tabId: number, candidates: ReadyWebEditFrame[], selection: PresentationFrameSelection): Promise<ReadyWebEditFrame> {
  const enriched = await Promise.all(candidates.map((candidate) => completePresentationProbe(tabId, candidate)))
  const complete = enriched.flatMap((item) => item.resource === undefined ? [] : [item as { candidate: ReadyWebEditFrame; resource: PresentationResourceIdentity }])
  if (complete.length !== candidates.length) {
    throw presentationSelectionError('context_mismatch', 'A ready presentation iframe did not expose a complete Resource Identity and fingerprint; routing is refused before the Office operation.')
  }
  if (selection.expectedResource !== undefined) {
    const expectedFingerprint = selection.expectedResource.fingerprint
    const preconditionFingerprint = selection.precondition?.resourceFingerprint
    if (typeof preconditionFingerprint !== 'string' || preconditionFingerprint.length === 0) {
      throw presentationSelectionError('precondition_required', 'Presentation write routing requires the approved resource fingerprint precondition.')
    }
    if (preconditionFingerprint !== expectedFingerprint) {
      throw presentationSelectionError('fingerprint_mismatch', 'The approved presentation Resource Identity and precondition fingerprint disagree; no write was sent.')
    }
    const sameResource = complete.filter((item) => samePresentationAnchor(selection.expectedResource!, item.resource))
    if (sameResource.length === 0) {
      throw presentationSelectionError('context_mismatch', 'No ready presentation iframe matches the approved Resource Identity on this Browser Target.')
    }
    const exact = sameResource.filter((item) => item.resource.fingerprint === expectedFingerprint)
    if (exact.length === 0) {
      throw presentationSelectionError('fingerprint_mismatch', 'The matching presentation Resource Identity has a different fingerprint; no write was sent.')
    }
    const preconditionCount = selection.precondition?.slideCount
    if (preconditionCount !== undefined && (!Number.isInteger(preconditionCount) || exact.some((item) => item.resource.slideCount !== Number(preconditionCount)))) {
      throw presentationSelectionError('fingerprint_mismatch', 'The matching presentation slide count no longer satisfies the approved precondition; no write was sent.')
    }
    return exact.find((item) => item.candidate.frame.frameId === selection.binding?.frameId && item.candidate.frame.url === selection.binding.frameUrl)?.candidate ?? exact[0].candidate
  }
  if (selection.binding !== undefined) {
    const matching = complete.filter((item) => samePresentationAnchor(selection.binding!.resource, item.resource))
    if (matching.length === 0) {
      throw presentationSelectionError('context_mismatch', 'The presentation previously bound to this Browser Target is no longer ready; routing is refused.')
    }
    return matching.find((item) => item.candidate.frame.frameId === selection.binding!.frameId && item.candidate.frame.url === selection.binding!.frameUrl)?.candidate ?? matching[0].candidate
  }
  const identities = new Set(complete.map((item) => presentationIdentityKey(item.resource)))
  if (identities.size !== 1 || identities.has(undefined)) {
    throw presentationSelectionError('context_mismatch', 'This Browser Target has multiple ready presentation resources and none is bound to the Connector Run; routing is refused.')
  }
  return complete[0].candidate
}

export function spreadsheetResourceFromResult(value: unknown): SpreadsheetResourceIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const resource = (value as { resource?: unknown }).resource
  return isSpreadsheetResourceIdentity(resource) ? resource : undefined
}

function sameSpreadsheetAnchor(expected: SpreadsheetResourceIdentity, actual: SpreadsheetResourceIdentity): boolean {
  return expected.kind === actual.kind && expected.origin === actual.origin
    && expected.workbookName === actual.workbookName && expected.sheetName === actual.sheetName
}

async function completeSpreadsheetProbe(tabId: number, candidate: ReadyWebEditFrame): Promise<{ candidate: ReadyWebEditFrame; resource?: SpreadsheetResourceIdentity }> {
  // Spreadsheet probe identities omit the canonical resource fingerprint. A
  // bounded context read is required before routing a multi-frame target.
  try {
    const reply = await sendMessageWithBudget(tabId, { type: 'office-spreadsheet/v1', action: 'context' }, candidate.frame.frameId, Math.min(1_000, officeFrameOperationBudgetMs()))
    return { candidate, resource: spreadsheetResourceFromResult(reply?.result) }
  } catch { return { candidate } }
}

function spreadsheetSelectionError(code: OfficeReadFailure['code'], message: string): OfficeReadFailure {
  return { code, message }
}

async function selectSpreadsheetFrame(tabId: number, candidates: ReadyWebEditFrame[], selection: SpreadsheetFrameSelection): Promise<ReadyWebEditFrame> {
  const enriched = await Promise.all(candidates.map((candidate) => completeSpreadsheetProbe(tabId, candidate)))
  const complete = enriched.flatMap((item) => item.resource === undefined ? [] : [item as { candidate: ReadyWebEditFrame; resource: SpreadsheetResourceIdentity }])
  if (complete.length !== candidates.length) {
    throw spreadsheetSelectionError('context_mismatch', 'A ready spreadsheet iframe did not expose a complete Resource Identity and fingerprint; routing is refused before the Office operation.')
  }
  const chooseBound = (matches: { candidate: ReadyWebEditFrame; resource: SpreadsheetResourceIdentity }[], binding: SpreadsheetFrameBinding | undefined): ReadyWebEditFrame => {
    const bound = matches.find((item) => item.candidate.frame.frameId === binding?.frameId && item.candidate.frame.url === binding.frameUrl)
    if (bound !== undefined) return bound.candidate
    if (matches.length === 1) return matches[0].candidate
    throw spreadsheetSelectionError('context_mismatch', 'Multiple ready spreadsheet iframes match the Resource Identity but the bound iframe is unavailable; routing is refused.')
  }
  if (selection.expectedResource !== undefined) {
    const expectedFingerprint = selection.expectedResource.fingerprint
    const preconditionFingerprint = selection.precondition?.resourceFingerprint
    if (typeof preconditionFingerprint !== 'string' || preconditionFingerprint.length === 0) {
      throw spreadsheetSelectionError('precondition_required', 'Spreadsheet write routing requires the approved resource fingerprint precondition.')
    }
    if (preconditionFingerprint !== expectedFingerprint) {
      throw spreadsheetSelectionError('fingerprint_mismatch', 'The approved spreadsheet Resource Identity and precondition fingerprint disagree; no write was sent.')
    }
    const sameResource = complete.filter((item) => sameSpreadsheetAnchor(selection.expectedResource!, item.resource))
    if (sameResource.length === 0) {
      throw spreadsheetSelectionError('context_mismatch', 'No ready spreadsheet iframe matches the approved Resource Identity on this Browser Target.')
    }
    const exact = sameResource.filter((item) => item.resource.fingerprint === expectedFingerprint)
    if (exact.length === 0) {
      throw spreadsheetSelectionError('fingerprint_mismatch', 'The matching spreadsheet Resource Identity has a different fingerprint; no write was sent.')
    }
    return chooseBound(exact, selection.binding)
  }
  if (selection.binding !== undefined) {
    const sameResource = complete.filter((item) => sameSpreadsheetAnchor(selection.binding!.resource, item.resource))
    if (sameResource.length === 0) {
      throw spreadsheetSelectionError('context_mismatch', 'The spreadsheet previously bound to this Browser Target is no longer ready; routing is refused.')
    }
    const exact = sameResource.filter((item) => item.resource.fingerprint === selection.binding!.resource.fingerprint)
    if (exact.length === 0) {
      throw spreadsheetSelectionError('fingerprint_mismatch', 'The bound spreadsheet Resource Identity has changed since the prior read; no operation was sent.')
    }
    return chooseBound(exact, selection.binding)
  }
  const identities = new Set(complete.map((item) => item.resource.fingerprint))
  if (identities.size !== 1) {
    throw spreadsheetSelectionError('context_mismatch', 'This Browser Target has multiple ready spreadsheet resources and none is bound to the Connector Run; routing is refused.')
  }
  return complete[0].candidate
}

async function sendMessageWithBudget(tabId: number, message: Record<string, unknown>, frameId: number, budgetMs: number): Promise<{ ok?: unknown; result?: unknown; error?: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<{ ok?: unknown; result?: unknown; error?: unknown } | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('office probe timed out'), { code: 'probe_timeout' })), Math.max(0, budgetMs))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function sendToWebEditFrame(tabId: number, frames: chrome.webNavigation.GetAllFrameResultDetails[], message: Record<string, unknown>, presentationSelection?: PresentationFrameSelection, spreadsheetSelection?: SpreadsheetFrameSelection): Promise<{ reply: { ok?: unknown; result?: unknown; error?: unknown } | undefined; frame: chrome.webNavigation.GetAllFrameResultDetails }> {
  const configuredWaitMs = Number((globalThis as typeof globalThis & { __DSH_OFFICE_PROBE_WAIT_MS?: unknown }).__DSH_OFFICE_PROBE_WAIT_MS)
  const waitBudgetMs = Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0 ? configuredWaitMs : OFFICE_PROBE_WAIT_MS_DEFAULT
  const deadline = Date.now() + waitBudgetMs
  let lastMissingReceiver: unknown
  const healedFrameIds = new Set<number>()
  // A Team Knowledge spreadsheet page hosts two webedit iframes. Probing them
  // one-by-one lets a hung preload/light-document APP eat the whole 8s budget
  // before the ready sheet is asked. Probe every candidate in parallel. A
  // content-bearing ready frame wins immediately; otherwise wait out this
  // sweep so a slower real document can still beat a blank preload.
  for (;;) {
    const remainingMs = Math.max(0, deadline - Date.now())
    const perFrameMs = Math.min(1_000, remainingMs)
    const readyByFrameId = new Map<number, ReadyWebEditFrame>()
    let pending = frames.length
    let settleSweep!: () => void
    const sweepDone = new Promise<void>((resolve) => { settleSweep = resolve })
    const finishSweep = (): void => { pending = 0; settleSweep() }
    const considerReady = (): void => {
      // Presentation writes need every ready probe before resource matching;
      // a content flag is not a presentation Resource Identity.
      if ((String(message.type) !== 'office-presentation/v1' && [...readyByFrameId.values()].some((candidate) => framePreference(candidate.identity) === 0)) || pending <= 0) finishSweep()
    }
    const timer = setTimeout(finishSweep, perFrameMs)
    let sweepError: unknown
    try {
      void Promise.all(frames.map(async (frame) => {
        let probeReply: { ok?: unknown; result?: unknown; error?: unknown } | undefined
        try {
          probeReply = await sendMessageWithBudget(tabId, probeMessageFor(message), frame.frameId, perFrameMs)
        } catch (error) {
          if (isProbeTimeout(error)) { pending -= 1; considerReady(); return }
          if (!isMissingReceivingEnd(error)) { sweepError = error; finishSweep(); return }
          if (healedFrameIds.has(frame.frameId)) { lastMissingReceiver = error; pending -= 1; considerReady(); return }
          healedFrameIds.add(frame.frameId)
          try {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: OFFICE_CONTENT_SCRIPT_FILES })
            probeReply = await sendMessageWithBudget(tabId, probeMessageFor(message), frame.frameId, Math.max(0, deadline - Date.now()))
          } catch (retryError) {
            if (isProbeTimeout(retryError)) { pending -= 1; considerReady(); return }
            if (!isMissingReceivingEnd(retryError)) { sweepError = retryError; finishSweep(); return }
            lastMissingReceiver = retryError
            pending -= 1
            considerReady()
            return
          }
        }
        if (probeSucceeded(probeReply)) readyByFrameId.set(frame.frameId, { frame, identity: probeIdentityOf(probeReply) })
        pending -= 1
        considerReady()
      }))
      await sweepDone
      if (sweepError !== undefined) throw sweepError
    } finally {
      clearTimeout(timer)
    }
    const readyCandidates = frames.flatMap((frame) => {
      const candidate = readyByFrameId.get(frame.frameId)
      return candidate ? [candidate] : []
    })
    if (readyCandidates.length > 0) {
      const needsSpreadsheetSelection = spreadsheetSelection?.expectedResource !== undefined || spreadsheetSelection?.binding !== undefined || readyCandidates.length > 1
      const chosen = String(message.type) === 'office-presentation/v1'
        ? await selectPresentationFrame(tabId, readyCandidates, presentationSelection ?? {})
        : String(message.type) === 'office-spreadsheet/v1'
          ? (needsSpreadsheetSelection ? await selectSpreadsheetFrame(tabId, readyCandidates, spreadsheetSelection ?? {}) : readyCandidates[0])
          : readyCandidates.reduce((best, candidate) => framePreference(candidate.identity) < framePreference(best.identity) ? candidate : best)
      const operationBudgetMs = officeFrameOperationBudgetMs(message)
      try {
        const reply = await sendMessageWithBudget(tabId, message, chosen.frame.frameId, operationBudgetMs)
        return { reply, frame: chosen.frame }
      } catch (error) {
        if (isProbeTimeout(error)) {
          throw { code: 'timeout', message: `The WebEdit iframe did not finish the ${channelReadyLabel(String(message.type))} operation within ${Math.round(operationBudgetMs / 100) / 10}s.` } satisfies OfficeReadFailure
        }
        throw error
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(OFFICE_PROBE_RETRY_MS, Math.max(0, deadline - Date.now()))))
  }
  if (lastMissingReceiver !== undefined) throw lastMissingReceiver
  const channel = String(message.type)
  const siblingType = siblingProbeType(channel)
  let siblingReadyCount = 0
  if (siblingType !== null) {
    const siblingBudgetMs = 250
    await Promise.all(frames.map(async (frame) => {
      try {
        const siblingReply = await sendMessageWithBudget(tabId, { type: siblingType, action: 'probe' }, frame.frameId, siblingBudgetMs)
        if (probeSucceeded(siblingReply)) siblingReadyCount += 1
      } catch { /* diagnostic-only probe: an unreachable frame simply does not count */ }
    }))
  }
  const hint = siblingType === null || siblingReadyCount === 0
    ? ''
    : siblingType === 'office-spreadsheet/v1'
      ? ` ${siblingReadyCount} of them expose a ready WebEdit spreadsheet runtime instead — this Browser Target hosts a spreadsheet, so call read_work_tab.`
      : ` ${siblingReadyCount} of them expose a ready WebEdit light-document editor instead — this Browser Target hosts a document, so call light_document_read.`
  throw { code: 'unsupported', message: `The bound Browser Target has ${frames.length} WebEdit iframe(s), but none exposed a ready ${channelReadyLabel(channel)} within ${Math.round(waitBudgetMs / 100) / 10}s.${hint}` } satisfies OfficeReadFailure
}

export async function waitForTeamDocWritableFrame(tabId: number, timeoutMs = 30_000): Promise<chrome.webNavigation.GetAllFrameResultDetails | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }) ?? [])
      .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
    if (frames.length > 0) {
      try {
        const { reply, frame } = await sendToWebEditFrame(tabId, frames, { type: 'office-document/v1', action: 'probe' })
        const latest = await chrome.webNavigation.getAllFrames({ tabId }) ?? []
        if (reply?.ok === true && latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) return frame
      } catch { /* the editor is still mounting or its iframe was rebuilt; retry within the write budget */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

