import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localEditScopeIssues, localEditSelection } from './local-edit-scope.mjs'
import { productBrief } from './product-brief.mjs'
import { directRequirementMatch, productRequirementCoverage, productRequirementCoverageValue, unmatchedRequirements } from './requirement-coverage.mjs'

const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const MAX_REVISIONS = 20
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,160}$/
const HASH = /^[0-9a-f]{64}$/
const RECOVERY_RUN_ID = /^[A-Za-z0-9._:-]{1,160}$/
const PROJECT_LOCK_WAIT_MS = 8_000
const PROJECT_LOCK_RETRY_MS = 20
const BRIEF_SUGGESTION_TTL_MS = 10 * 60_000

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function safeEqual(left, right) {
  const a = Buffer.from(hash(left)); const b = Buffer.from(hash(right))
  return timingSafeEqual(a, b)
}
function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function optionalRevisionId(value) { return value === undefined || value === null || (typeof value === 'string' && value.length > 0 && value.length <= 160) }
function sameRevisionId(left, right) { return (left ?? undefined) === (right ?? undefined) }
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function sqliteBusy(error) {
  // `errcode === 5` is SQLITE_BUSY.  Node has kept `ERR_SQLITE_ERROR` as the
  // public error code across the supported Node 22.5+ and 24 lines, so retain
  // the message fallback for platform builds that omit `errcode`.
  return error?.errcode === 5 || (error?.code === 'ERR_SQLITE_ERROR' && /database is locked|database is busy/i.test(String(error?.message)))
}
function generationAttempt(record) {
  const item = record.generationAttempt
  if (!exactObject(item) || !REQUEST_ID.test(item.requestId) || !optionalRevisionId(item.expectedRevisionId) || (item.status !== 'pending' && item.status !== 'error') || typeof item.at !== 'string') return undefined
  if (item.status === 'error' && (typeof item.message !== 'string' || item.message.length === 0 || item.message.length > 600)) return undefined
  if (item.prompt !== undefined && (typeof item.prompt !== 'string' || item.prompt.trim().length === 0 || item.prompt.length > 6_000)) return undefined
  if (item.localEditScope !== undefined) {
    const scope = item.localEditScope
    if (!exactObject(scope) || Object.keys(scope).length !== 2 || !HASH.test(String(scope.baselineDocumentFingerprint)) || localEditSelection(scope.selection) === undefined) return undefined
  }
  if (item.productBrief !== undefined && productBrief(item.productBrief) === undefined) return undefined
  if (item.allowRevisionEviction !== undefined && item.allowRevisionEviction !== true) return undefined
  return item
}
function pendingCandidate(record) {
  const item = record.pendingCandidate
  if (!exactObject(item) || item.v !== 1 || typeof item.candidateId !== 'string' || !/^candidate-[0-9a-f-]{36}$/i.test(item.candidateId)
    || !REQUEST_ID.test(item.requestId) || !optionalRevisionId(item.expectedRevisionId) || typeof item.sessionId !== 'string' || item.sessionId.length < 1 || item.sessionId.length > 160
    || typeof item.designSpecFingerprint !== 'string' || !HASH.test(item.designSpecFingerprint) || !Array.isArray(item.evidenceFingerprints) || item.evidenceFingerprints.length < 1 || item.evidenceFingerprints.length > 3 || item.evidenceFingerprints.some(value => typeof value !== 'string' || !HASH.test(value))
    || !exactObject(item.revision) || typeof item.revision.id !== 'string' || item.revision.id !== item.candidateId || typeof item.createdAt !== 'string') return undefined
  if (item.productBrief !== undefined && productBrief(item.productBrief) === undefined) return undefined
  if (item.requirementCoverage !== undefined && productRequirementCoverageValue(item.requirementCoverage) === undefined) return undefined
  if (item.localEditScope !== undefined) {
    const scope = item.localEditScope
    if (!exactObject(scope) || Object.keys(scope).length !== 2 || !HASH.test(String(scope.baselineDocumentFingerprint)) || localEditSelection(scope.selection) === undefined) return undefined
  }
  return item
}
function briefSuggestionAttempt(record) {
  const item = record.briefSuggestionAttempt
  if (!exactObject(item) || !REQUEST_ID.test(item.requestId) || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= Date.now() || (item.status !== 'pending' && item.status !== 'saved')) return undefined
  return item
}
function hasPrototypeInteraction(document) {
  const visit = nodes => nodes.some(node => {
    if (exactObject(node.action)) return true
    if (Array.isArray(node.rows) && node.rows.some(row => exactObject(row?.action))) return true
    if (Array.isArray(node.items) && node.items.some(item => exactObject(item?.action))) return true
    if (Array.isArray(node.children) && visit(node.children)) return true
    if (node.type === 'tabs' && Array.isArray(node.tabs) && node.tabs.length >= 2) return true
    return Array.isArray(node.tabs) && node.tabs.some(tab => exactObject(tab?.action) || (Array.isArray(tab?.children) && visit(tab.children)))
  })
  return (Array.isArray(document?.shell?.items) && document.shell.items.length >= 2)
    || (Array.isArray(document?.screens) && document.screens.some(screen => Array.isArray(screen?.nodes) && visit(screen.nodes)))
}

function visibleEntityText(entity) {
  if (!exactObject(entity)) return []
  const result = []
  for (const key of ['label', 'title', 'text', 'value', 'detail', 'placeholder', 'description', 'name']) if (typeof entity[key] === 'string' && entity[key].trim() !== '') result.push(entity[key])
  if (Array.isArray(entity.values)) for (const value of entity.values) if (typeof value === 'string' && value.trim() !== '') result.push(value)
  if (exactObject(entity.cells)) for (const value of Object.values(entity.cells)) if (typeof value === 'string' && value.trim() !== '') result.push(value)
  if (Array.isArray(entity.columns)) for (const column of entity.columns) if (exactObject(column)) result.push(...visibleEntityText(column))
  return result
}

function revisionNodeMap(document) {
  const result = new Map()
  const visit = (nodes, screenId) => {
    for (const node of nodes ?? []) {
      if (!exactObject(node) || typeof node.id !== 'string') continue
      result.set(node.id, { screenId, type: String(node.type ?? ''), label: String(node.label ?? node.title ?? node.text ?? node.id).slice(0, 80), value: JSON.stringify(node) })
      if (Array.isArray(node.children)) visit(node.children, screenId)
      for (const tab of node.tabs ?? []) if (Array.isArray(tab?.children)) visit(tab.children, screenId)
    }
  }
  for (const screen of document?.screens ?? []) if (exactObject(screen) && typeof screen.id === 'string') visit(screen.nodes, screen.id)
  return result
}

export function revisionComparison(baseline, candidate) {
  const beforeScreens = new Map((baseline?.screens ?? []).filter(exactObject).map(screen => [screen.id, String(screen.title ?? screen.id)]))
  const afterScreens = new Map((candidate?.screens ?? []).filter(exactObject).map(screen => [screen.id, String(screen.title ?? screen.id)]))
  const beforeNodes = revisionNodeMap(baseline); const afterNodes = revisionNodeMap(candidate)
  const addedScreens = [...afterScreens].filter(([id]) => !beforeScreens.has(id)).map(([, title]) => title).slice(0, 8)
  const removedScreens = [...beforeScreens].filter(([id]) => !afterScreens.has(id)).map(([, title]) => title).slice(0, 8)
  const addedNodes = [...afterNodes].filter(([id]) => !beforeNodes.has(id)).map(([, node]) => node.label).slice(0, 8)
  const removedNodes = [...beforeNodes].filter(([id]) => !afterNodes.has(id)).map(([, node]) => node.label).slice(0, 8)
  const changedNodes = [...afterNodes].filter(([id, node]) => beforeNodes.has(id) && beforeNodes.get(id).value !== node.value).map(([, node]) => node.label).slice(0, 8)
  const details = []
  if (baseline?.title !== candidate?.title) details.push(`原型名称：${String(baseline?.title ?? '未命名')} → ${String(candidate?.title ?? '未命名')}`)
  if (addedScreens.length > 0) details.push(`新增页面：${addedScreens.join('、')}`)
  if (removedScreens.length > 0) details.push(`移除页面：${removedScreens.join('、')}`)
  if (addedNodes.length > 0) details.push(`新增内容：${addedNodes.join('、')}`)
  if (removedNodes.length > 0) details.push(`移除内容：${removedNodes.join('、')}`)
  if (changedNodes.length > 0) details.push(`修改内容：${changedNodes.join('、')}`)
  if (details.length === 0) details.push('页面结构和组件内容没有可见变化。')
  return { screenCountBefore: beforeScreens.size, screenCountAfter: afterScreens.size, componentCountBefore: beforeNodes.size, componentCountAfter: afterNodes.size, details: details.slice(0, 8) }
}

export function firstPrototypeQualityIssues(document, briefValue, { checkFirstVersionBaseline = true } = {}) {
  const summary = { count: 0, types: new Set(), actions: [], actionControls: [], visibleText: [], hasConditionalState: false, requiredInputs: 0, requiredInputsWithError: 0, inputs: 0 }
  const recordAction = action => {
    if (!exactObject(action)) return
    if (action.type === 'sequence' && Array.isArray(action.actions)) action.actions.forEach(recordAction)
    else if (typeof action.type === 'string') summary.actions.push(action.type)
  }
  const visit = nodes => {
    for (const node of nodes ?? []) {
      if (!exactObject(node)) continue
      summary.count += 1; if (typeof node.type === 'string') summary.types.add(node.type)
      summary.visibleText.push(...visibleEntityText(node))
      if (node.visibleWhen !== undefined) summary.hasConditionalState = true
      if (node.type === 'input') { summary.inputs += 1; if (node.required === true) { summary.requiredInputs += 1; if (typeof node.errorText === 'string' && node.errorText.trim() !== '') summary.requiredInputsWithError += 1 } }
      if (exactObject(node.action)) { summary.actionControls.push(visibleEntityText(node).join(' ')); recordAction(node.action) }
      for (const row of node.rows ?? []) { summary.visibleText.push(...visibleEntityText(row)); if (exactObject(row?.action)) { summary.actionControls.push(visibleEntityText(row).join(' ')); recordAction(row.action) } }
      for (const item of node.items ?? []) { summary.visibleText.push(...visibleEntityText(item)); if (exactObject(item?.action)) { summary.actionControls.push(visibleEntityText(item).join(' ')); recordAction(item.action) } }
      if (Array.isArray(node.children)) visit(node.children)
      for (const tab of node.tabs ?? []) { summary.visibleText.push(...visibleEntityText(tab)); if (exactObject(tab?.action)) { summary.actionControls.push(visibleEntityText(tab).join(' ')); recordAction(tab.action) } else if (node.type === 'tabs' && node.tabs.length >= 2) { summary.actionControls.push(visibleEntityText(tab).join(' ')); summary.actions.push('set-tab') } if (Array.isArray(tab?.children)) visit(tab.children) }
    }
  }
  for (const item of document?.shell?.items ?? []) {
    const text = visibleEntityText(item)
    summary.visibleText.push(...text)
    summary.actionControls.push(text.join(' '))
    summary.actions.push('navigate')
  }
  for (const screen of document?.screens ?? []) visit(screen?.nodes)
  const issues = []
  if (checkFirstVersionBaseline) {
    if (summary.count < 10) issues.push('首次原型至少需要 10 个真实组件，不能只交付骨架页面。')
    if (![...summary.types].some(type => ['input', 'table', 'list', 'chart', 'empty-state'].includes(type))) issues.push('首次原型必须包含表单、表格、列表、图表或空状态中的至少一种真实业务结构。')
    if (![...summary.types].some(type => ['alert', 'badge', 'empty-state'].includes(type)) && !summary.hasConditionalState) issues.push('首次原型必须表达至少一种成功、风险、错误、空结果或业务状态。')
    if (summary.actions.includes('submit-success') && summary.inputs === 0) issues.push('带提交动作的流程必须包含真实输入字段，不能用空表单直接成功。')
    else if (summary.actions.includes('submit-success') && summary.requiredInputs === 0) issues.push('带提交动作的表单至少要声明一个 required 必填字段和错误反馈。')
    else if (summary.actions.includes('submit-success') && summary.requiredInputsWithError < summary.requiredInputs) issues.push('每个 required 必填字段都要提供具体 errorText，避免只显示含糊的默认错误。')
    if ((document?.screens?.length ?? 0) >= 3 && !exactObject(document?.shell)) issues.push('三个及以上页面的产品必须提供 shell 产品导航，避免每页复制假导航。')
  }
  const brief = productBrief(briefValue)
  if (brief !== undefined && (document?.screens?.length ?? 0) < Math.min(brief.requiredPages.length, 4)) issues.push(`需求清单包含 ${brief.requiredPages.length} 个必须页面，当前原型至少需要 ${Math.min(brief.requiredPages.length, 4)} 个可导航页面。`)
  if (brief !== undefined) {
    const screenTitles = (document?.screens ?? []).filter(exactObject).map(screen => String(screen.title ?? ''))
    const missingPages = unmatchedRequirements(brief.requiredPages, screenTitles, directRequirementMatch)
    if (missingPages.length > 0) issues.push(`需求清单中的页面尚未真正出现：${missingPages.join('、')}。页面数量相同也不能用无关页面代替。`)
    const missingModules = unmatchedRequirements(brief.requiredModules ?? [], summary.visibleText, directRequirementMatch)
    if (missingModules.length > 0) issues.push(`需求清单中的关键模块尚未在页面中可见：${missingModules.join('、')}。`)
    const coverage = productRequirementCoverage(document, brief)
    const missingFlows = coverage.items.filter(item => item.kind === 'flow' && item.status === 'missing').map(item => item.requirement)
    if (missingFlows.length > 0) issues.push(`以下必须演示流程还没有通过可信运行器逐步骤回放：${missingFlows.join('、')}。`)
  }
  return issues
}

export class PrototypeProjectStore {
  constructor(root, contracts) { this.root = root; this.contracts = contracts; this.queues = new Map() }
  file(projectId) { if (!PROJECT_ID.test(projectId)) throw new Error('Invalid prototype project id.'); return join(this.root, `${projectId}.json`) }
  screenshotFile(projectId, referenceId) { this.file(projectId); if (typeof referenceId !== 'string' || !/^ref-[a-z0-9-]{8,72}$/.test(referenceId)) throw new Error('Invalid prototype reference screenshot id.'); return join(this.root, 'reference-screenshots', `${projectId}-${referenceId}.json`) }
  projectLockDatabaseFile() { return join(this.root, '.prototype-project-coordinator.sqlite') }
  async read(projectId) {
    const parsed = JSON.parse(await readFile(this.file(projectId), 'utf8'))
    if (!exactObject(parsed) || parsed.v !== 1 || parsed.id !== projectId || typeof parsed.sessionId !== 'string' || typeof parsed.capabilityHash !== 'string' || !Array.isArray(parsed.evidence) || !Array.isArray(parsed.revisions)) throw new Error('Stored prototype project is invalid.')
    return parsed
  }
  async write(record, recoveryFence) {
    if (recoveryFence === undefined || typeof recoveryFence.assertOwnership !== 'function') throw new Error('Prototype project writes require an active project lock.')
    await mkdir(this.root, { recursive: true })
    const target = this.file(record.id); const temporary = `${target}.${randomUUID()}.tmp`; const body = JSON.stringify(record)
    try {
      await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      if (recoveryFence !== undefined) await recoveryFence.assertOwnership()
      await rename(temporary, target)
      if (recoveryFence !== undefined) await recoveryFence.assertOwnership()
    } catch (error) {
      try { await unlink(temporary) } catch (removeError) { if (removeError?.code !== 'ENOENT') throw removeError }
      throw error
    }
    const readback = await this.read(record.id)
    if (hash(JSON.stringify(readback)) !== hash(body)) throw new Error('Prototype project write-back verification failed.')
    return readback
  }
  async exclusive(projectId, operation) {
    const previous = this.queues.get(projectId) ?? Promise.resolve(); const next = previous.then(operation); const marker = next.then(() => undefined, () => undefined)
    this.queues.set(projectId, marker)
    try { return await next } finally { if (this.queues.get(projectId) === marker) this.queues.delete(projectId) }
  }
  projectLockWaitMs() { return PROJECT_LOCK_WAIT_MS }
  projectLockRetryMs() { return PROJECT_LOCK_RETRY_MS }
  async openProjectLockCoordinator() {
    await mkdir(this.root, { recursive: true })
    const databaseFile = this.projectLockDatabaseFile()
    // Create the coordinator with owner-only permissions before SQLite opens
    // it.  The database stores no project payload or capability; it is only a
    // cross-process transaction coordinator.  chmod is intentionally best
    // effort on Windows, where POSIX modes are not enforced in the same way.
    const handle = await open(databaseFile, 'a', 0o600)
    await handle.close()
    try { await chmod(databaseFile, 0o600) } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EINVAL'].includes(error?.code)) throw error
    }
    const database = new DatabaseSync(databaseFile)
    database.exec('PRAGMA busy_timeout = 0')
    return database
  }
  async withProjectLock(projectId, operation) {
    // Validate before opening the shared coordinator.  `BEGIN IMMEDIATE` is
    // an OS-backed SQLite writer lock: exactly one process can hold it, and a
    // process crash/connection close rolls it back automatically.  Unlike a
    // lock-file read+unlink sequence, there is no separate stale-lock cleanup
    // operation that can delete a successor's lock.
    this.file(projectId)
    const owner = randomUUID()
    const deadline = Date.now() + this.projectLockWaitMs()
    let coordinator
    while (true) {
      try {
        coordinator = await this.openProjectLockCoordinator()
        coordinator.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        try { coordinator?.close() } catch {}
        coordinator = undefined
        if (!sqliteBusy(error)) throw error
        if (Date.now() >= deadline) throw new Error('Prototype project recovery is busy; retry.')
        await sleep(this.projectLockRetryMs())
      }
    }
    const assertOwnership = async () => {
      // This statement cannot succeed after a lost/closed coordinator.  The
      // transaction itself is the ownership proof; no mutable lock record is
      // exposed for another recovery contender to remove or replace.
      try { coordinator.exec('SELECT 1') } catch { throw new Error('Prototype project recovery lock ownership was lost.') }
    }
    let committed = false
    try {
      const result = await operation({ owner, assertOwnership })
      coordinator.exec('COMMIT')
      committed = true
      return result
    } finally {
      if (!committed) {
        try { coordinator.exec('ROLLBACK') } catch {}
      }
      coordinator.close()
    }
  }
  // Kept as a compatibility alias for existing callers/tests. Every mutation
  // now goes through this same project-wide lock, not just capability recovery.
  async withRecoveryLock(projectId, operation) { return this.withProjectLock(projectId, operation) }
  async mutate(projectId, operation) { return this.exclusive(projectId, () => this.withProjectLock(projectId, operation)) }
  async open({ projectId, sessionId, capability, evidence }) {
    if (!PROJECT_ID.test(projectId) || typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 160 || typeof capability !== 'string' || capability.length < 32 || capability.length > 256) throw new Error('Invalid prototype project handoff.')
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 3) throw new Error('A prototype project requires one to three captured references.')
    const checked = evidence.map(item => this.contracts.validateReferenceEvidence(item))
    if (checked.some(item => !item.ok) || new Set(checked.map(item => item.ok ? item.value.id : '')).size !== checked.length) throw new Error('Captured reference evidence failed trusted verification.')
    if (!(await Promise.all(checked.map(item => this.contracts.verifyReferenceEvidenceFingerprint(item.value)))).every(Boolean)) throw new Error('Captured reference evidence failed trusted verification.')
    return this.mutate(projectId, async (projectFence) => {
      try {
        const existing = await this.read(projectId)
        if (existing.sessionId !== sessionId || !safeEqual(existing.capabilityHash, hash(capability)) || JSON.stringify(existing.evidence.map(item => item.fingerprint)) !== JSON.stringify(checked.map(item => item.value.fingerprint))) throw new Error('Prototype project already exists with different authority.')
        return this.snapshot(existing)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const now = new Date().toISOString()
      const storedEvidence = checked.map(item => { const { screenshotDataUrl: _screenshot, ...stored } = item.value; return stored })
      for (const item of checked.map(item => item.value)) await this.persistReferenceScreenshot(projectId, item)
      const record = { v: 1, id: projectId, sessionId, capabilityHash: hash(capability), evidence: storedEvidence, revisions: [], recoveryEpoch: 0, consumedRecoveryNonces: [], createdAt: now, updatedAt: now }
      return this.snapshot(await this.write(record, projectFence))
    })
  }
  async persistReferenceScreenshot(projectId, evidence) {
    if (evidence.screenshotDataUrl === undefined) return
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(evidence.screenshotDataUrl)
    if (match === null || evidence.screenshotFingerprint === undefined || hash(evidence.screenshotDataUrl) !== evidence.screenshotFingerprint) throw new Error('Captured reference screenshot failed integrity verification.')
    const data = Buffer.from(match[2], 'base64')
    if (data.byteLength === 0 || data.byteLength > 1_500_000) throw new Error('Captured reference screenshot exceeds the bounded image limit.')
    const target = this.screenshotFile(projectId, evidence.id); const temporary = `${target}.${randomUUID()}.tmp`
    await mkdir(join(this.root, 'reference-screenshots'), { recursive: true })
    await writeFile(temporary, JSON.stringify({ v: 1, mediaType: match[1], screenshotFingerprint: evidence.screenshotFingerprint, data: data.toString('base64') }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    const readback = JSON.parse(await readFile(target, 'utf8'))
    if (!exactObject(readback) || readback.mediaType !== match[1] || readback.screenshotFingerprint !== evidence.screenshotFingerprint || typeof readback.data !== 'string' || hash(`data:${readback.mediaType};base64,${readback.data}`) !== evidence.screenshotFingerprint) throw new Error('Captured reference screenshot write-back verification failed.')
  }
  async referenceScreenshot({ projectId, sessionId, requestId, referenceId }) {
    const record = await this.read(projectId)
    if (record.sessionId !== sessionId || !REQUEST_ID.test(requestId)) throw new Error('Prototype reference screenshot authority is invalid.')
    const active = generationAttempt(record)
    if (active === undefined || active.status !== 'pending' || active.requestId !== requestId) throw new Error('Prototype reference screenshot is only available for the active generation request.')
    const evidence = record.evidence.find(item => item.id === referenceId)
    if (evidence === undefined || typeof evidence.screenshotFingerprint !== 'string') throw new Error('No captured screenshot is available for this reference.')
    const item = JSON.parse(await readFile(this.screenshotFile(projectId, referenceId), 'utf8'))
    if (!exactObject(item) || (item.mediaType !== 'image/png' && item.mediaType !== 'image/jpeg') || item.screenshotFingerprint !== evidence.screenshotFingerprint || typeof item.data !== 'string') throw new Error('Stored prototype reference screenshot is invalid.')
    const data = Buffer.from(item.data, 'base64')
    if (data.byteLength === 0 || data.byteLength > 1_500_000 || hash(`data:${item.mediaType};base64,${item.data}`) !== evidence.screenshotFingerprint) throw new Error('Stored prototype reference screenshot failed integrity verification.')
    return { mediaType: item.mediaType, data, name: `${referenceId}.${item.mediaType === 'image/png' ? 'png' : 'jpg'}` }
  }
  authorize(record, capability) {
    if (typeof capability !== 'string' || !safeEqual(record.capabilityHash, hash(capability))) throw new Error('Prototype project capability is invalid.')
  }
  snapshot(record) {
    const current = record.revisions.find(item => item.revision.id === record.currentRevisionId)
    const candidate = pendingCandidate(record)
    const confirmedDesignSpec = record.confirmedDesignSpec ?? current?.designSpec
    const currentBrief = productBrief(current?.productBrief) ?? productBrief(record.productBrief)
    const currentCoverage = current === undefined || currentBrief === undefined ? undefined : productRequirementCoverage(current.revision.document, currentBrief)
    return {
      v: 1, projectId: record.id, sessionId: record.sessionId, evidence: record.evidence,
      projectName: typeof record.projectName === 'string' && record.projectName.trim() !== '' ? record.projectName : String(current?.revision?.document?.title ?? record.evidence[0]?.source?.title ?? '未命名原型').slice(0, 160),
      recoveryEpoch: Number.isSafeInteger(record.recoveryEpoch) && record.recoveryEpoch >= 0 ? record.recoveryEpoch : 0,
      revisions: record.revisions.map(item => ({ id: item.revision.id, parentRevisionId: item.revision.parentRevisionId, createdAt: item.revision.createdAt, changeSummary: item.revision.changeSummary, current: item.revision.id === record.currentRevisionId })),
      designConfirmed: confirmedDesignSpec !== undefined,
      ...(confirmedDesignSpec === undefined ? {} : { confirmedDesignSpec }),
      ...(current === undefined ? {} : { designSpec: current.designSpec, document: current.revision.document, currentRevisionId: current.revision.id }),
      ...(currentBrief === undefined ? {} : { productBrief: currentBrief }),
      ...(currentCoverage === undefined ? {} : { requirementCoverage: currentCoverage }),
      ...(generationAttempt(record) === undefined ? {} : { generationAttempt: generationAttempt(record) }),
      ...(candidate === undefined ? {} : { pendingCandidate: {
        v: 1, candidateId: candidate.candidateId, requestId: candidate.requestId,
        ...(candidate.expectedRevisionId === undefined ? {} : { expectedRevisionId: candidate.expectedRevisionId }),
        documentFingerprint: candidate.revision.documentFingerprint, changeSummary: candidate.revision.changeSummary, createdAt: candidate.createdAt,
        document: candidate.revision.document, designSpec: candidate.designSpec,
        ...(candidate.productBrief === undefined ? {} : { productBrief: candidate.productBrief }),
        ...(candidate.requirementCoverage === undefined ? {} : { requirementCoverage: candidate.requirementCoverage }),
        comparison: revisionComparison(current?.revision.document, candidate.revision.document),
      } }),
      ...(briefSuggestionAttempt(record) === undefined ? {} : { briefSuggestionAttempt: briefSuggestionAttempt(record) }),
      ...(briefSuggestionAttempt(record) === undefined || productBrief(record.suggestedProductBrief) === undefined ? {} : { suggestedProductBrief: productBrief(record.suggestedProductBrief) }),
      // Legacy consumers still read this field. New generation state is the
      // request-bound generationAttempt above.
      ...(exactObject(record.lastAttempt) && record.lastAttempt.status === 'error' && typeof record.lastAttempt.message === 'string' && typeof record.lastAttempt.at === 'string' ? { lastAttempt: record.lastAttempt } : {}),
    }
  }
  async authorizedSnapshot(projectId, capability) { const record = await this.read(projectId); this.authorize(record, capability); return this.snapshot(record) }
  async renameProject({ projectId, capability, projectName }) {
    const name = typeof projectName === 'string' ? projectName.trim() : ''
    if (!PROJECT_ID.test(projectId) || name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid prototype project name.')
    return this.mutate(projectId, async projectFence => {
      const record = await this.read(projectId); this.authorize(record, capability)
      record.projectName = name; record.updatedAt = new Date().toISOString()
      const readback = await this.write(record, projectFence); this.authorize(readback, capability)
      if (readback.projectName !== name) throw new Error('Prototype project rename write-back verification failed.')
      return { status: 'verified_write', projectId, projectName: name, snapshot: this.snapshot(readback) }
    })
  }
  async deleteProject({ projectId, capability, confirmationProjectId }) {
    if (!PROJECT_ID.test(projectId) || confirmationProjectId !== projectId) throw new Error('Prototype project deletion confirmation is invalid.')
    return this.mutate(projectId, async projectFence => {
      const record = await this.read(projectId); this.authorize(record, capability)
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined || briefSuggestionAttempt(record) !== undefined) throw new Error('Finish, apply, or discard the active AI request before deleting this project.')
      for (const evidence of record.evidence) {
        if (typeof evidence.screenshotFingerprint !== 'string') continue
        try { await unlink(this.screenshotFile(projectId, evidence.id)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
      await projectFence.assertOwnership(); await unlink(this.file(projectId)); await projectFence.assertOwnership()
      try { await this.read(projectId); throw new Error('Prototype project deletion read-back verification failed.') } catch (error) { if (error?.code !== 'ENOENT') throw error }
      return { status: 'verified_delete', projectId }
    })
  }
  async rebindSession({ projectId, capability, expectedSessionId, sessionId }) {
    if (!PROJECT_ID.test(projectId) || typeof expectedSessionId !== 'string' || expectedSessionId.length < 1 || expectedSessionId.length > 160 || typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 160) throw new Error('Invalid prototype session rebind request.')
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (record.sessionId !== expectedSessionId) throw new Error('Prototype project session changed before rebind.')
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined || briefSuggestionAttempt(record) !== undefined) throw new Error('Finish, apply, or discard the active AI request before continuing in another conversation.')
      record.sessionId = sessionId
      record.updatedAt = new Date().toISOString()
      const readback = await this.write(record, projectFence)
      this.authorize(readback, capability)
      if (readback.sessionId !== sessionId) throw new Error('Prototype project session rebind write-back verification failed.')
      return { status: 'verified_write', projectId, previousSessionId: expectedSessionId, sessionId, snapshot: this.snapshot(readback) }
    })
  }
  async recoverCapability({ projectId, expectedSessionId, referenceId, evidenceFingerprint, capability, expectedRecoveryEpoch, nonce, expiresAt, runId }) {
    if (!PROJECT_ID.test(projectId) || typeof expectedSessionId !== 'string' || expectedSessionId.length < 1 || expectedSessionId.length > 160 || typeof referenceId !== 'string' || referenceId.length < 1 || referenceId.length > 160 || !HASH.test(evidenceFingerprint) || typeof capability !== 'string' || capability.length < 32 || capability.length > 256 || !Number.isSafeInteger(expectedRecoveryEpoch) || expectedRecoveryEpoch < 0 || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce) || !Number.isSafeInteger(expiresAt) || typeof runId !== 'string' || !RECOVERY_RUN_ID.test(runId)) throw new Error('Invalid prototype project recovery request.')
    return this.mutate(projectId, async (recoveryFence) => {
      const record = await this.read(projectId)
      const evidence = record.evidence[0]
      const recoveryEpoch = Number.isSafeInteger(record.recoveryEpoch) && record.recoveryEpoch >= 0 ? record.recoveryEpoch : 0
      const previousRunId = typeof record.lastRecoveryRunId === 'string' && RECOVERY_RUN_ID.test(record.lastRecoveryRunId) ? record.lastRecoveryRunId : undefined
      const usedRunIds = Array.isArray(record.recoveryRunIds) ? record.recoveryRunIds.filter(item => typeof item === 'string' && RECOVERY_RUN_ID.test(item)).slice(-31) : []
      if (record.sessionId !== expectedSessionId || evidence?.id !== referenceId || evidence?.fingerprint !== evidenceFingerprint) throw new Error('Prototype project recovery authority does not match the stored project.')
      const now = Date.now()
      const retainedNonces = Array.isArray(record.consumedRecoveryNonces) ? record.consumedRecoveryNonces.filter(item => exactObject(item) && typeof item.nonce === 'string' && Number.isSafeInteger(item.expiresAt) && item.expiresAt >= now).slice(-31) : []
      const consumed = retainedNonces.find(item => item.nonce === nonce)
      if (consumed !== undefined) {
        if (previousRunId === runId && consumed.runId === runId && consumed.expectedRecoveryEpoch === expectedRecoveryEpoch && safeEqual(record.capabilityHash, hash(capability))) return { status: 'verified_write', projectId, sessionId: record.sessionId, referenceId, evidenceFingerprint, capabilityFingerprint: hash(capability), recoveryEpoch }
        throw new Error('Prototype project recovery assertion was already used.')
      }
      // Within one Native Host run, assertions are strict compare-and-swap
      // operations. A newly started Host run has a fresh private key and a
      // freshly clicked assertion, so it may safely rotate from the current
      // disk epoch even when browser-local non-secret binding data is stale
      // after a full browser restart.
      if (previousRunId === runId && recoveryEpoch !== expectedRecoveryEpoch) throw new Error('Prototype project recovery authority does not match the stored project.')
      if (previousRunId !== runId && usedRunIds.includes(runId)) throw new Error('Prototype project recovery assertion belongs to an earlier Native Host run.')
      record.capabilityHash = hash(capability)
      record.recoveryEpoch = recoveryEpoch + 1
      record.lastRecoveryRunId = runId
      record.recoveryRunIds = [...usedRunIds.filter(item => item !== runId), runId].slice(-32)
      record.consumedRecoveryNonces = [...retainedNonces, { nonce, expiresAt, expectedRecoveryEpoch, runId }]
      record.updatedAt = new Date().toISOString()
      const readback = await this.write(record, recoveryFence)
      this.authorize(readback, capability)
      if (readback.sessionId !== expectedSessionId || readback.evidence[0]?.id !== referenceId || readback.evidence[0]?.fingerprint !== evidenceFingerprint || readback.recoveryEpoch !== recoveryEpoch + 1 || !readback.consumedRecoveryNonces?.some(item => item.nonce === nonce)) throw new Error('Prototype project recovery write-back verification failed.')
      return { status: 'verified_write', projectId, sessionId: readback.sessionId, referenceId, evidenceFingerprint, capabilityFingerprint: hash(capability), recoveryEpoch: readback.recoveryEpoch }
    })
  }
  async inspectRevision({ projectId, capability, targetRevisionId }) {
    const record = await this.read(projectId)
    this.authorize(record, capability)
    if (typeof targetRevisionId !== 'string' || targetRevisionId.length === 0 || targetRevisionId.length > 160) throw new Error('Prototype revision preview target is invalid.')
    const target = record.revisions.find(item => item.revision.id === targetRevisionId)
    if (target === undefined) throw new Error('The requested prototype revision does not exist.')
    if (!(await this.contracts.verifyTrustedRevision(target.revision, target.designSpec, record.evidence))) throw new Error('The requested prototype revision failed trusted verification.')
    const current = record.revisions.find(item => item.revision.id === record.currentRevisionId)
    if (current !== undefined && !(await this.contracts.verifyTrustedRevision(current.revision, current.designSpec, record.evidence))) throw new Error('The current prototype revision failed trusted verification.')
    return {
      v: 1, projectId, revisionId: target.revision.id, current: target.revision.id === record.currentRevisionId,
      createdAt: target.revision.createdAt, changeSummary: target.revision.changeSummary,
      document: target.revision.document, designSpec: target.designSpec,
      ...(productBrief(target.productBrief) === undefined ? { productBriefKnown: false } : { productBriefKnown: true, productBrief: productBrief(target.productBrief), requirementCoverage: productRequirementCoverage(target.revision.document, productBrief(target.productBrief)) }),
      comparison: revisionComparison(current?.revision.document, target.revision.document),
      ...(current === undefined ? {} : { comparedToRevisionId: current.revision.id }),
    }
  }
  async confirmDesign({ projectId, capability, designSpec }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('The design specification is already locked by the saved prototype history.')
      const checked = this.contracts.validateDesignSpec(designSpec, record.evidence.map(item => item.id))
      if (!checked.ok) throw new Error(checked.errors[0] ?? 'Confirmed design specification validation failed.')
      const fingerprint = await this.contracts.sha256Fingerprint(checked.value)
      if (record.confirmedDesignSpecFingerprint !== undefined && record.confirmedDesignSpecFingerprint !== fingerprint) throw new Error('A different design specification was already confirmed for this prototype project.')
      const updated = await this.write({ ...record, confirmedDesignSpec: checked.value, confirmedDesignSpecFingerprint: fingerprint, updatedAt: new Date().toISOString() }, projectFence)
      if (updated.confirmedDesignSpecFingerprint !== fingerprint || await this.contracts.sha256Fingerprint(updated.confirmedDesignSpec) !== fingerprint) throw new Error('Confirmed design specification read-back verification failed.')
      return { status: 'verified_write', projectId, designSpecFingerprint: fingerprint }
    })
  }
  async reopenDesign({ projectId, capability }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined) throw new Error('A prototype generation request is still active, or a candidate awaits action. Stop it before adjusting the design specification.')
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('This prototype already has saved history. Create a new prototype project before changing its design specification.')
      if (record.confirmedDesignSpec === undefined || typeof record.confirmedDesignSpecFingerprint !== 'string') throw new Error('The design specification is not currently confirmed.')
      const { confirmedDesignSpec: _designSpec, confirmedDesignSpecFingerprint: _fingerprint, ...unconfirmed } = record
      const updated = await this.write({ ...unconfirmed, updatedAt: new Date().toISOString() }, projectFence)
      if (updated.confirmedDesignSpec !== undefined || updated.confirmedDesignSpecFingerprint !== undefined || updated.currentRevisionId !== undefined || updated.revisions.length !== 0 || generationAttempt(updated) !== undefined) throw new Error('Design specification reopening read-back verification failed.')
      return { status: 'verified_write', projectId, designConfirmed: false }
    })
  }
  async confirmProductBrief({ projectId, capability, brief }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (record.confirmedDesignSpec === undefined || typeof record.confirmedDesignSpecFingerprint !== 'string') throw new Error('Confirm the design specification before confirming product requirements.')
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined) throw new Error('A prototype generation request or candidate is still active. Stop it before changing product requirements.')
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('The product requirement checklist is already bound to saved prototype history.')
      const checked = productBrief(brief)
      if (checked === undefined) throw new Error('Product requirement checklist is invalid.')
      const fingerprint = await this.contracts.sha256Fingerprint(checked)
      const { briefSuggestionAttempt: _attempt, suggestedProductBrief: _suggested, ...withoutSuggestion } = record
      const updated = await this.write({ ...withoutSuggestion, productBrief: checked, updatedAt: new Date().toISOString() }, projectFence)
      const readback = productBrief(updated.productBrief)
      if (readback === undefined || await this.contracts.sha256Fingerprint(readback) !== fingerprint) throw new Error('Product requirement checklist read-back verification failed.')
      return { status: 'verified_write', projectId, productBrief: readback, productBriefFingerprint: fingerprint }
    })
  }
  async beginBriefSuggestion({ projectId, capability, requestId }) {
    return this.mutate(projectId, async projectFence => {
      const record = await this.read(projectId); this.authorize(record, capability)
      if (!REQUEST_ID.test(requestId)) throw new Error('Product brief suggestion request is invalid.')
      if (record.confirmedDesignSpec === undefined || typeof record.confirmedDesignSpecFingerprint !== 'string') throw new Error('Confirm the design specification before suggesting product requirements.')
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined) throw new Error('A prototype generation request or candidate is still active.')
      const active = briefSuggestionAttempt(record)
      if (active?.status === 'saved' && active.requestId === requestId) throw new Error('This product brief suggestion request was already saved.')
      const expiresAt = active?.status === 'pending' && active.requestId === requestId ? active.expiresAt : Date.now() + BRIEF_SUGGESTION_TTL_MS
      const updated = await this.write({ ...record, briefSuggestionAttempt: { status: 'pending', requestId, expiresAt }, suggestedProductBrief: undefined, updatedAt: new Date().toISOString() }, projectFence)
      if (briefSuggestionAttempt(updated)?.requestId !== requestId) throw new Error('Product brief suggestion begin read-back verification failed.')
      return { status: 'verified_write', projectId, requestId, expiresAt }
    })
  }
  async saveBriefSuggestion({ projectId, sessionId, requestId, brief }) {
    return this.mutate(projectId, async projectFence => {
      const record = await this.read(projectId)
      if (record.sessionId !== sessionId) throw new Error('Prototype project belongs to a different Harness session.')
      const active = briefSuggestionAttempt(record)
      if (active === undefined || active.requestId !== requestId || active.status !== 'pending') throw new Error('Product brief suggestion request is no longer active.')
      const checked = productBrief(brief); if (checked === undefined) throw new Error('Suggested product requirements are invalid.')
      const updated = await this.write({ ...record, briefSuggestionAttempt: { ...active, status: 'saved' }, suggestedProductBrief: checked, updatedAt: new Date().toISOString() }, projectFence)
      if (briefSuggestionAttempt(updated)?.status !== 'saved' || productBrief(updated.suggestedProductBrief) === undefined) throw new Error('Product brief suggestion read-back verification failed.')
      return { status: 'verified_write', projectId, requestId, suggestedProductBrief: productBrief(updated.suggestedProductBrief) }
    })
  }
  async beginGeneration({ projectId, capability, requestId, expectedRevisionId, prompt, selection, brief, allowRevisionEviction }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (!REQUEST_ID.test(requestId) || !optionalRevisionId(expectedRevisionId)) throw new Error('Prototype generation request is invalid.')
      if (prompt !== undefined && (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 6_000)) throw new Error('Prototype generation prompt is invalid.')
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined) throw new Error('A prototype generation request or candidate is already active for this project.')
      if (!sameRevisionId(record.currentRevisionId, expectedRevisionId)) throw new Error(`Prototype revision conflict: current revision is ${record.currentRevisionId ?? 'empty'}. Read it before generating again.`)
      const checkedSelection = selection === undefined ? undefined : localEditSelection(selection)
      if (selection !== undefined && checkedSelection === undefined) throw new Error('Local prototype edit selection is invalid.')
      const current = record.revisions.find(item => item.revision.id === record.currentRevisionId)
      const requestedBrief = brief === undefined ? undefined : productBrief(brief)
      if (brief !== undefined && requestedBrief === undefined) throw new Error('Product requirement checklist is invalid.')
      const storedBrief = productBrief(record.productBrief)
      const briefChanged = requestedBrief !== undefined && storedBrief !== undefined && await this.contracts.sha256Fingerprint(requestedBrief) !== await this.contracts.sha256Fingerprint(storedBrief)
      if (briefChanged && current === undefined) throw new Error('产品需求清单已经变化，请先重新确认后再生成。')
      if (briefChanged && checkedSelection !== undefined) throw new Error('更新整个产品需求时不能同时限定为局部元素修改。请切换到“完善整个原型”后重试。')
      const checkedBrief = requestedBrief ?? storedBrief
      if (current === undefined && checkedBrief === undefined) throw new Error('首次生成前请先保存并确认产品需求清单。')
      if (record.revisions.length >= MAX_REVISIONS && allowRevisionEviction !== true) throw new Error('已保存 20 个历史版本。请先明确确认替换最旧版本。')
      if (checkedSelection !== undefined && current === undefined) throw new Error('Local prototype edits require a saved prototype revision.')
      if (checkedSelection !== undefined && localEditScopeIssues({ baseline: current.revision.document, candidate: current.revision.document, selection: checkedSelection }).length > 0) throw new Error('The selected prototype element is no longer available. Refresh the prototype and select it again.')
      const at = new Date().toISOString()
      const attempt = {
        status: 'pending', requestId, ...(expectedRevisionId === undefined || expectedRevisionId === null ? {} : { expectedRevisionId }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(checkedSelection === undefined ? {} : { localEditScope: { selection: checkedSelection, baselineDocumentFingerprint: await this.contracts.sha256Fingerprint(current.revision.document) } }),
        ...(checkedBrief === undefined ? {} : { productBrief: checkedBrief }),
        ...(allowRevisionEviction === true ? { allowRevisionEviction: true } : {}),
        at,
      }
      const updated = await this.write({ ...record, generationAttempt: attempt, lastAttempt: undefined, updatedAt: at }, projectFence)
      if (generationAttempt(updated)?.status !== 'pending' || generationAttempt(updated)?.requestId !== requestId || !sameRevisionId(generationAttempt(updated)?.expectedRevisionId, expectedRevisionId) || (checkedSelection !== undefined && generationAttempt(updated)?.localEditScope?.selection?.elementId !== checkedSelection.elementId)) throw new Error('Prototype generation begin read-back verification failed.')
      return { status: 'verified_write', projectId, requestId, ...(expectedRevisionId === undefined || expectedRevisionId === null ? {} : { expectedRevisionId }) }
    })
  }
  async cancelGeneration({ projectId, capability, requestId, expectedRevisionId, message = '本次原型生成请求已取消。' }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (!REQUEST_ID.test(requestId) || !optionalRevisionId(expectedRevisionId)) throw new Error('Prototype generation cancellation is invalid.')
      const active = generationAttempt(record)
      if (active === undefined || active.requestId !== requestId || !sameRevisionId(active.expectedRevisionId, expectedRevisionId)) throw new Error('Prototype generation request is no longer active.')
      const at = new Date().toISOString(); const cancelled = String(message).replace(/\s+/g, ' ').trim().slice(0, 600) || '本次原型生成请求已取消。'
      const updated = await this.write({ ...record, generationAttempt: undefined, lastAttempt: { status: 'error', requestId, message: cancelled, at }, updatedAt: at }, projectFence)
      if (generationAttempt(updated) !== undefined || updated.lastAttempt?.message !== cancelled) throw new Error('Prototype generation cancellation read-back verification failed.')
      return { status: 'verified_write', projectId, requestId }
    })
  }
  async recordFailure({ projectId, sessionId, requestId, error }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      if (record.sessionId !== sessionId) throw new Error('Prototype project belongs to a different Harness session.')
      if (!REQUEST_ID.test(requestId)) throw new Error('Prototype generation request is invalid.')
      const active = generationAttempt(record)
      if (active === undefined || active.requestId !== requestId) throw new Error('Prototype generation request is no longer active.')
      const message = String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 600) || '原型保存失败。'
      const at = new Date().toISOString(); const attempt = { status: 'error', requestId, ...(active.expectedRevisionId === undefined ? {} : { expectedRevisionId: active.expectedRevisionId }), message, at }
      const updated = await this.write({ ...record, generationAttempt: { ...attempt, ...(active.prompt === undefined ? {} : { prompt: active.prompt }), ...(active.localEditScope === undefined ? {} : { localEditScope: active.localEditScope }), ...(active.productBrief === undefined ? {} : { productBrief: active.productBrief }), ...(active.allowRevisionEviction === true ? { allowRevisionEviction: true } : {}) }, lastAttempt: { status: 'error', requestId, message, at }, updatedAt: at }, projectFence)
      if (generationAttempt(updated)?.status !== 'error' || generationAttempt(updated)?.requestId !== requestId) throw new Error('Prototype generation failure read-back verification failed.')
    })
  }
  async restore({ projectId, capability, targetRevisionId, expectedCurrentRevisionId }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (typeof targetRevisionId !== 'string' || targetRevisionId.length === 0 || targetRevisionId.length > 160 || typeof expectedCurrentRevisionId !== 'string' || expectedCurrentRevisionId.length === 0 || expectedCurrentRevisionId.length > 160) throw new Error('Prototype Studio restore arguments are invalid.')
      if (generationAttempt(record) !== undefined || pendingCandidate(record) !== undefined) throw new Error('A prototype generation request is still active, or a candidate awaits action. Cancel or discard it before restoring a version.')
      if (record.currentRevisionId !== expectedCurrentRevisionId) throw new Error(`Prototype revision conflict: current revision is ${record.currentRevisionId ?? 'empty'}. Read it before restoring again.`)
      const target = record.revisions.find(item => item.revision.id === targetRevisionId)
      if (target === undefined) throw new Error('The requested prototype revision does not exist.')
      if (!(await this.contracts.verifyTrustedRevision(target.revision, target.designSpec, record.evidence))) throw new Error('The requested prototype revision failed trusted verification.')
      if (typeof record.confirmedDesignSpecFingerprint === 'string' && await this.contracts.sha256Fingerprint(target.designSpec) !== record.confirmedDesignSpecFingerprint) throw new Error('The requested prototype revision does not use the confirmed design specification.')
      const targetBrief = productBrief(target.productBrief)
      const currentBrief = productBrief(record.productBrief)
      if (targetBrief === undefined && currentBrief !== undefined) {
        const issues = firstPrototypeQualityIssues(target.revision.document, currentBrief, { checkFirstVersionBaseline: false })
        if (issues.length > 0) throw new Error(`这个旧历史版本没有保存当时的产品需求，并且不满足当前需求，无法安全恢复：${issues[0]}`)
      }
      const restoredBrief = targetBrief ?? currentBrief
      const updated = await this.write({ ...record, ...(restoredBrief === undefined ? {} : { productBrief: restoredBrief }), currentRevisionId: target.revision.id, lastAttempt: undefined, updatedAt: new Date().toISOString() }, projectFence)
      const readback = updated.revisions.find(item => item.revision.id === updated.currentRevisionId)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype revision restore read-back verification failed.')
      if (restoredBrief !== undefined && (productBrief(updated.productBrief) === undefined || await this.contracts.sha256Fingerprint(updated.productBrief) !== await this.contracts.sha256Fingerprint(restoredBrief))) throw new Error('Prototype requirement restore read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: readback.revision.id, documentFingerprint: readback.revision.documentFingerprint, changeSummary: readback.revision.changeSummary }
    })
  }
  async confirmCandidate({ projectId, capability, candidateId, expectedCurrentRevisionId }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId); this.authorize(record, capability)
      if (typeof candidateId !== 'string' || !/^candidate-[0-9a-f-]{36}$/i.test(candidateId) || !optionalRevisionId(expectedCurrentRevisionId)) throw new Error('Prototype candidate confirmation is invalid.')
      const candidate = pendingCandidate(record)
      if (candidate === undefined || candidate.candidateId !== candidateId) throw new Error('Prototype candidate is no longer available.')
      if (!sameRevisionId(candidate.expectedRevisionId, expectedCurrentRevisionId) || !sameRevisionId(record.currentRevisionId, expectedCurrentRevisionId)) throw new Error(`Prototype revision conflict: current revision is ${record.currentRevisionId ?? 'empty'}. Refresh the candidate before applying it.`)
      if (candidate.designSpecFingerprint !== record.confirmedDesignSpecFingerprint || JSON.stringify(candidate.evidenceFingerprints) !== JSON.stringify(record.evidence.map(item => item.fingerprint))) throw new Error('Prototype candidate authority changed. Generate it again.')
      if (!(await this.contracts.verifyTrustedRevision(candidate.revision, candidate.designSpec, record.evidence))) throw new Error('Prototype candidate failed trusted verification.')
      const checkedDesignSpec = this.contracts.validateDesignSpec(candidate.designSpec, record.evidence.map(item => item.id))
      if (!checkedDesignSpec.ok || await this.contracts.sha256Fingerprint(checkedDesignSpec.value) !== candidate.designSpecFingerprint) throw new Error('Prototype candidate design specification is no longer valid.')
      const baseline = record.revisions.find(item => item.revision.id === record.currentRevisionId)
      if (candidate.localEditScope !== undefined) {
        if (baseline === undefined || await this.contracts.sha256Fingerprint(baseline.revision.document) !== candidate.localEditScope.baselineDocumentFingerprint) throw new Error('Local prototype edit baseline changed. Refresh and select the element again.')
        const issues = localEditScopeIssues({ baseline: baseline.revision.document, candidate: candidate.revision.document, selection: candidate.localEditScope.selection })
        if (issues.length > 0) throw new Error(issues[0])
      }
      const revisionId = `rev-${randomUUID()}`
      const created = await this.contracts.createTrustedRevision({ id: revisionId, ...(record.currentRevisionId === undefined ? {} : { parentRevisionId: record.currentRevisionId }), author: 'agent', document: candidate.revision.document, designSpec: checkedDesignSpec.value, evidence: record.evidence, changeSummary: candidate.revision.changeSummary })
      if (!created.ok) throw new Error(created.errors[0] ?? 'Prototype candidate could not be applied.')
      const nextBrief = productBrief(candidate.productBrief) ?? productBrief(record.productBrief)
      const nextCoverage = nextBrief === undefined ? undefined : productRequirementCoverage(created.value.document, nextBrief)
      const priorRevisions = record.revisions.map(item => item.revision.id === record.currentRevisionId && productBrief(item.productBrief) === undefined && productBrief(record.productBrief) !== undefined ? { ...item, productBrief: productBrief(record.productBrief) } : item)
      const revisions = [...priorRevisions, { revision: created.value, designSpec: checkedDesignSpec.value, ...(nextBrief === undefined ? {} : { productBrief: nextBrief }), ...(nextCoverage === undefined ? {} : { requirementCoverage: nextCoverage }) }].slice(-MAX_REVISIONS)
      const { pendingCandidate: _candidate, ...withoutCandidate } = record
      const updated = await this.write({ ...withoutCandidate, ...(nextBrief === undefined ? {} : { productBrief: nextBrief }), revisions, currentRevisionId: created.value.id, lastAttempt: undefined, updatedAt: new Date().toISOString() }, projectFence)
      const readback = updated.revisions.find(item => item.revision.id === created.value.id)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype candidate apply read-back verification failed.')
      if (nextBrief !== undefined && (productBrief(readback.productBrief) === undefined || await this.contracts.sha256Fingerprint(readback.productBrief) !== await this.contracts.sha256Fingerprint(nextBrief))) throw new Error('Prototype candidate requirement apply read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: created.value.id, documentFingerprint: created.value.documentFingerprint, changeSummary: created.value.changeSummary }
    })
  }
  async cancelCandidate({ projectId, capability, candidateId }) {
    return this.mutate(projectId, async projectFence => {
      const record = await this.read(projectId); this.authorize(record, capability)
      if (typeof candidateId !== 'string' || !/^candidate-[0-9a-f-]{36}$/i.test(candidateId)) throw new Error('Prototype candidate cancellation is invalid.')
      const candidate = pendingCandidate(record)
      if (candidate === undefined || candidate.candidateId !== candidateId) throw new Error('Prototype candidate is no longer available.')
      const { pendingCandidate: _candidate, ...withoutCandidate } = record
      const updated = await this.write({ ...withoutCandidate, lastAttempt: { status: 'error', requestId: candidate.requestId, message: '本次原型候选已放弃，未创建新版本。', at: new Date().toISOString() }, updatedAt: new Date().toISOString() }, projectFence)
      if (pendingCandidate(updated) !== undefined || updated.currentRevisionId !== record.currentRevisionId || updated.revisions.length !== record.revisions.length) throw new Error('Prototype candidate cancellation read-back verification failed.')
      return { status: 'candidate_cancelled', projectId, candidateId }
    })
  }
  async save({ projectId, sessionId, requestId, expectedRevisionId, designSpec, document, changeSummary }) {
    return this.mutate(projectId, async (projectFence) => {
      const record = await this.read(projectId)
      if (record.sessionId !== sessionId) throw new Error('Prototype project belongs to a different Harness session.')
      if (!REQUEST_ID.test(requestId)) throw new Error('Prototype generation request is invalid.')
      const active = generationAttempt(record)
      if (active === undefined || active.requestId !== requestId) throw new Error('Prototype generation request is no longer active.')
      const current = record.currentRevisionId
      if (!sameRevisionId(active.expectedRevisionId, expectedRevisionId)) throw new Error('Prototype generation baseline does not match its requested revision.')
      if ((expectedRevisionId ?? undefined) !== (current ?? undefined)) throw new Error(`Prototype revision conflict: current revision is ${current ?? 'empty'}. Read it before saving again.`)
      let confirmedDesignSpec = record.confirmedDesignSpec
      let confirmedDesignSpecFingerprint = record.confirmedDesignSpecFingerprint
      if (confirmedDesignSpec === undefined || typeof confirmedDesignSpecFingerprint !== 'string') {
        const legacyCurrent = record.revisions.find(item => item.revision.id === current)
        if (legacyCurrent === undefined || !(await this.contracts.verifyTrustedRevision(legacyCurrent.revision, legacyCurrent.designSpec, record.evidence))) throw new Error('The design specification must be confirmed before saving a prototype.')
        confirmedDesignSpec = legacyCurrent.designSpec
        confirmedDesignSpecFingerprint = await this.contracts.sha256Fingerprint(confirmedDesignSpec)
      }
      const checkedDesignSpec = this.contracts.validateDesignSpec(designSpec ?? confirmedDesignSpec, record.evidence.map(item => item.id))
      if (!checkedDesignSpec.ok) throw new Error(checkedDesignSpec.errors[0] ?? 'Prototype design specification validation failed.')
      if (await this.contracts.sha256Fingerprint(checkedDesignSpec.value) !== confirmedDesignSpecFingerprint) throw new Error('The prototype must use the exact design specification confirmed by the user.')
      // The model may only produce a validated, durable *candidate*.  It is
      // deliberately not a revision yet: applying it is a separate user
      // decision that rechecks the current revision under the same write fence.
      const candidateId = `candidate-${randomUUID()}`
      const created = await this.contracts.createTrustedRevision({ id: candidateId, ...(current === undefined ? {} : { parentRevisionId: current }), author: 'agent', document, designSpec: checkedDesignSpec.value, evidence: record.evidence, changeSummary })
      if (!created.ok) throw new Error(created.errors[0] ?? 'Prototype revision validation failed.')
      if (active.localEditScope !== undefined) {
        const baseline = record.revisions.find(item => item.revision.id === current)
        if (baseline === undefined || await this.contracts.sha256Fingerprint(baseline.revision.document) !== active.localEditScope.baselineDocumentFingerprint) throw new Error('Local prototype edit baseline changed. Refresh and select the element again.')
        const issues = localEditScopeIssues({ baseline: baseline.revision.document, candidate: created.value.document, selection: active.localEditScope.selection })
        if (issues.length > 0) throw new Error(issues[0])
      }
      if (current === undefined && !hasPrototypeInteraction(created.value.document)) throw new Error('首次原型至少需要一条可演示交互流程，例如页面跳转、弹窗、抽屉或标签页切换。')
      // A full-prototype generation can legitimately simplify visual details,
      // but it must never erase the product requirements the user confirmed.
      // Local edits have their own, stricter structural scope guard above.
      if (current === undefined || (active.localEditScope === undefined && productBrief(active.productBrief) !== undefined)) {
        const issues = firstPrototypeQualityIssues(created.value.document, active.productBrief, { checkFirstVersionBaseline: current === undefined })
        if (issues.length > 0) throw new Error(issues.join(' '))
      }
      if (record.revisions.length >= MAX_REVISIONS && active.allowRevisionEviction !== true) throw new Error('历史版本已满，且本次请求未确认替换最旧版本。')
      const storedBrief = productBrief(record.productBrief)
      const nextBrief = productBrief(active.productBrief) ?? storedBrief
      const nextCoverage = nextBrief === undefined ? undefined : productRequirementCoverage(created.value.document, nextBrief)
      // Legacy entries did not carry their requirement checklist. The current
      // baseline can be backfilled safely because record.productBrief is the
      // checklist that governed that exact current revision. Older non-current
      // entries remain explicitly unknown instead of being assigned a false
      // history.
      const candidate = {
        v: 1, candidateId, requestId, sessionId, ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }),
        designSpec: checkedDesignSpec.value, designSpecFingerprint: confirmedDesignSpecFingerprint,
        evidenceFingerprints: record.evidence.map(item => item.fingerprint), revision: created.value,
        ...(active.localEditScope === undefined ? {} : { localEditScope: active.localEditScope }),
        ...(nextBrief === undefined ? {} : { productBrief: nextBrief }),
        ...(nextCoverage === undefined ? {} : { requirementCoverage: nextCoverage }), createdAt: new Date().toISOString(),
      }
      const updated = await this.write({ ...record, confirmedDesignSpec, confirmedDesignSpecFingerprint, generationAttempt: undefined, pendingCandidate: candidate, lastAttempt: undefined, updatedAt: candidate.createdAt }, projectFence)
      const readback = pendingCandidate(updated)
      if (readback === undefined || readback.candidateId !== candidateId || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype candidate read-back verification failed.')
      if (nextBrief !== undefined && (productBrief(readback.productBrief) === undefined || await this.contracts.sha256Fingerprint(readback.productBrief) !== await this.contracts.sha256Fingerprint(nextBrief))) throw new Error('Prototype candidate requirement read-back verification failed.')
      if (nextCoverage !== undefined && (productRequirementCoverageValue(readback.requirementCoverage) === undefined || JSON.stringify(readback.requirementCoverage) !== JSON.stringify(nextCoverage))) throw new Error('Prototype candidate requirement coverage read-back verification failed.')
      return { status: 'candidate_ready', projectId, candidateId, documentFingerprint: created.value.documentFingerprint, changeSummary: created.value.changeSummary }
    })
  }
}

export function prototypeProjectId() { return `prototype-${randomUUID()}` }
