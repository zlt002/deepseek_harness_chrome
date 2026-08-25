import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localEditScopeIssues, localEditSelection } from './local-edit-scope.mjs'
import { productBrief } from './product-brief.mjs'
import { directRequirementMatch, meaningfulRequirementMatch, productRequirementCoverage, productRequirementCoverageValue, unmatchedRequirements } from './requirement-coverage.mjs'

const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const MAX_REVISIONS = 20
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,160}$/
const HASH = /^[0-9a-f]{64}$/
const RECOVERY_LOCK_WAIT_MS = 8_000
const RECOVERY_LOCK_STALE_MS = 30_000
const RECOVERY_LOCK_RETRY_MS = 20

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function safeEqual(left, right) {
  const a = Buffer.from(hash(left)); const b = Buffer.from(hash(right))
  return timingSafeEqual(a, b)
}
function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function optionalRevisionId(value) { return value === undefined || value === null || (typeof value === 'string' && value.length > 0 && value.length <= 160) }
function sameRevisionId(left, right) { return (left ?? undefined) === (right ?? undefined) }
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
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
    if (summary.actionControls.length < brief.requiredFlows.length) issues.push(`需求清单包含 ${brief.requiredFlows.length} 条必须演示流程，当前原型至少需要 ${brief.requiredFlows.length} 个独立交互入口，不能用一个按钮里的动作序列充数。`)
    const missingFlows = unmatchedRequirements(brief.requiredFlows, summary.actionControls, meaningfulRequirementMatch)
    if (missingFlows.length > 0) issues.push(`以下必须演示流程还没有对应的可操作入口：${missingFlows.join('、')}。`)
  }
  return issues
}

export class PrototypeProjectStore {
  constructor(root, contracts) { this.root = root; this.contracts = contracts; this.queues = new Map() }
  file(projectId) { if (!PROJECT_ID.test(projectId)) throw new Error('Invalid prototype project id.'); return join(this.root, `${projectId}.json`) }
  recoveryLockFile(projectId) { if (!PROJECT_ID.test(projectId)) throw new Error('Invalid prototype project id.'); return join(this.root, `.${projectId}.recover.lock`) }
  async read(projectId) {
    const parsed = JSON.parse(await readFile(this.file(projectId), 'utf8'))
    if (!exactObject(parsed) || parsed.v !== 1 || parsed.id !== projectId || typeof parsed.sessionId !== 'string' || typeof parsed.capabilityHash !== 'string' || !Array.isArray(parsed.evidence) || !Array.isArray(parsed.revisions)) throw new Error('Stored prototype project is invalid.')
    return parsed
  }
  async write(record, recoveryFence) {
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
  async withRecoveryLock(projectId, operation) {
    const lockFile = this.recoveryLockFile(projectId)
    const owner = randomUUID()
    const deadline = Date.now() + RECOVERY_LOCK_WAIT_MS
    await mkdir(this.root, { recursive: true })
    while (true) {
      try {
        const handle = await open(lockFile, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ v: 1, owner, createdAt: Date.now() }), 'utf8') } finally { await handle.close() }
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let lockedAt = 0; let lockOwner
        try {
          const text = await readFile(lockFile, 'utf8')
          try {
            const raw = JSON.parse(text)
            if (exactObject(raw) && raw.v === 1 && typeof raw.owner === 'string' && /^[0-9a-f-]{36}$/i.test(raw.owner) && Number.isSafeInteger(raw.createdAt)) { lockOwner = raw.owner; lockedAt = raw.createdAt }
            else lockedAt = (await stat(lockFile)).mtimeMs
          } catch { lockedAt = (await stat(lockFile)).mtimeMs }
        } catch (readError) {
          if (readError?.code === 'ENOENT') continue
          throw readError
        }
        if (lockedAt > 0 && Date.now() - lockedAt >= RECOVERY_LOCK_STALE_MS) {
          try {
            const text = await readFile(lockFile, 'utf8')
            let latest
            try { latest = JSON.parse(text) } catch { latest = undefined }
            if (exactObject(latest) && latest.v === 1 && latest.owner === lockOwner && latest.createdAt === lockedAt) await unlink(lockFile)
            else if (lockOwner === undefined && (await stat(lockFile)).mtimeMs <= lockedAt) await unlink(lockFile)
          } catch (removeError) { if (removeError?.code !== 'ENOENT') throw removeError }
          continue
        }
        if (Date.now() >= deadline) throw new Error('Prototype project recovery is busy; retry.')
        await sleep(RECOVERY_LOCK_RETRY_MS)
      }
    }
    const assertOwnership = async () => {
      let current
      try { current = JSON.parse(await readFile(lockFile, 'utf8')) } catch { throw new Error('Prototype project recovery lock ownership was lost.') }
      if (!exactObject(current) || current.v !== 1 || current.owner !== owner) throw new Error('Prototype project recovery lock ownership was lost.')
    }
    try { return await operation({ owner, assertOwnership }) } finally {
      try {
        const current = JSON.parse(await readFile(lockFile, 'utf8'))
        if (exactObject(current) && current.v === 1 && current.owner === owner) await unlink(lockFile)
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }
  async open({ projectId, sessionId, capability, evidence }) {
    if (!PROJECT_ID.test(projectId) || typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 160 || typeof capability !== 'string' || capability.length < 32 || capability.length > 256) throw new Error('Invalid prototype project handoff.')
    if (!Array.isArray(evidence) || evidence.length !== 1) throw new Error('A prototype project requires exactly one captured reference in V1.')
    const checked = this.contracts.validateReferenceEvidence(evidence[0])
    if (!checked.ok) throw new Error('Captured reference evidence failed trusted verification.')
    if (!(await this.contracts.verifyReferenceEvidenceFingerprint(checked.value))) throw new Error('Captured reference evidence failed trusted verification.')
    return this.exclusive(projectId, async () => {
      try {
        const existing = await this.read(projectId)
        if (existing.sessionId !== sessionId || !safeEqual(existing.capabilityHash, hash(capability)) || existing.evidence[0]?.fingerprint !== checked.value.fingerprint) throw new Error('Prototype project already exists with different authority.')
        return this.snapshot(existing)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const now = new Date().toISOString()
      const storedEvidence = [{ ...checked.value, screenshotDataUrl: undefined }]
      const record = { v: 1, id: projectId, sessionId, capabilityHash: hash(capability), evidence: storedEvidence, revisions: [], recoveryEpoch: 0, consumedRecoveryNonces: [], createdAt: now, updatedAt: now }
      return this.snapshot(await this.write(record))
    })
  }
  authorize(record, capability) {
    if (typeof capability !== 'string' || !safeEqual(record.capabilityHash, hash(capability))) throw new Error('Prototype project capability is invalid.')
  }
  snapshot(record) {
    const current = record.revisions.find(item => item.revision.id === record.currentRevisionId)
    const confirmedDesignSpec = record.confirmedDesignSpec ?? current?.designSpec
    const currentBrief = productBrief(current?.productBrief) ?? productBrief(record.productBrief)
    const currentCoverage = current === undefined || currentBrief === undefined ? undefined : productRequirementCoverage(current.revision.document, currentBrief)
    return {
      v: 1, projectId: record.id, sessionId: record.sessionId, evidence: record.evidence,
      recoveryEpoch: Number.isSafeInteger(record.recoveryEpoch) && record.recoveryEpoch >= 0 ? record.recoveryEpoch : 0,
      revisions: record.revisions.map(item => ({ id: item.revision.id, parentRevisionId: item.revision.parentRevisionId, createdAt: item.revision.createdAt, changeSummary: item.revision.changeSummary, current: item.revision.id === record.currentRevisionId })),
      designConfirmed: confirmedDesignSpec !== undefined,
      ...(confirmedDesignSpec === undefined ? {} : { confirmedDesignSpec }),
      ...(current === undefined ? {} : { designSpec: current.designSpec, document: current.revision.document, currentRevisionId: current.revision.id }),
      ...(currentBrief === undefined ? {} : { productBrief: currentBrief }),
      ...(currentCoverage === undefined ? {} : { requirementCoverage: currentCoverage }),
      ...(generationAttempt(record) === undefined ? {} : { generationAttempt: generationAttempt(record) }),
      // Legacy consumers still read this field. New generation state is the
      // request-bound generationAttempt above.
      ...(exactObject(record.lastAttempt) && record.lastAttempt.status === 'error' && typeof record.lastAttempt.message === 'string' && typeof record.lastAttempt.at === 'string' ? { lastAttempt: record.lastAttempt } : {}),
    }
  }
  async authorizedSnapshot(projectId, capability) { const record = await this.read(projectId); this.authorize(record, capability); return this.snapshot(record) }
  async recoverCapability({ projectId, expectedSessionId, referenceId, evidenceFingerprint, capability, expectedRecoveryEpoch, nonce, expiresAt }) {
    if (!PROJECT_ID.test(projectId) || typeof expectedSessionId !== 'string' || expectedSessionId.length < 1 || expectedSessionId.length > 160 || typeof referenceId !== 'string' || referenceId.length < 1 || referenceId.length > 160 || !HASH.test(evidenceFingerprint) || typeof capability !== 'string' || capability.length < 32 || capability.length > 256 || !Number.isSafeInteger(expectedRecoveryEpoch) || expectedRecoveryEpoch < 0 || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce) || !Number.isSafeInteger(expiresAt)) throw new Error('Invalid prototype project recovery request.')
    return this.exclusive(projectId, () => this.withRecoveryLock(projectId, async (recoveryFence) => {
      const record = await this.read(projectId)
      const evidence = record.evidence[0]
      const recoveryEpoch = Number.isSafeInteger(record.recoveryEpoch) && record.recoveryEpoch >= 0 ? record.recoveryEpoch : 0
      if (record.sessionId !== expectedSessionId || evidence?.id !== referenceId || evidence?.fingerprint !== evidenceFingerprint) throw new Error('Prototype project recovery authority does not match the stored project.')
      const now = Date.now()
      const retainedNonces = Array.isArray(record.consumedRecoveryNonces) ? record.consumedRecoveryNonces.filter(item => exactObject(item) && typeof item.nonce === 'string' && Number.isSafeInteger(item.expiresAt) && item.expiresAt >= now).slice(-31) : []
      if (retainedNonces.some(item => item.nonce === nonce)) {
        if (safeEqual(record.capabilityHash, hash(capability)) && recoveryEpoch === expectedRecoveryEpoch + 1) return { status: 'verified_write', projectId, sessionId: record.sessionId, referenceId, evidenceFingerprint, capabilityFingerprint: hash(capability), recoveryEpoch }
        throw new Error('Prototype project recovery assertion was already used.')
      }
      if (recoveryEpoch !== expectedRecoveryEpoch) throw new Error('Prototype project recovery authority does not match the stored project.')
      record.capabilityHash = hash(capability)
      record.recoveryEpoch = recoveryEpoch + 1
      record.consumedRecoveryNonces = [...retainedNonces, { nonce, expiresAt }]
      record.updatedAt = new Date().toISOString()
      const readback = await this.write(record, recoveryFence)
      this.authorize(readback, capability)
      if (readback.sessionId !== expectedSessionId || readback.evidence[0]?.id !== referenceId || readback.evidence[0]?.fingerprint !== evidenceFingerprint || readback.recoveryEpoch !== recoveryEpoch + 1 || !readback.consumedRecoveryNonces?.some(item => item.nonce === nonce)) throw new Error('Prototype project recovery write-back verification failed.')
      return { status: 'verified_write', projectId, sessionId: readback.sessionId, referenceId, evidenceFingerprint, capabilityFingerprint: hash(capability), recoveryEpoch: readback.recoveryEpoch }
    }))
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
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('The design specification is already locked by the saved prototype history.')
      const checked = this.contracts.validateDesignSpec(designSpec, record.evidence.map(item => item.id))
      if (!checked.ok) throw new Error(checked.errors[0] ?? 'Confirmed design specification validation failed.')
      const fingerprint = await this.contracts.sha256Fingerprint(checked.value)
      if (record.confirmedDesignSpecFingerprint !== undefined && record.confirmedDesignSpecFingerprint !== fingerprint) throw new Error('A different design specification was already confirmed for this prototype project.')
      const updated = await this.write({ ...record, confirmedDesignSpec: checked.value, confirmedDesignSpecFingerprint: fingerprint, updatedAt: new Date().toISOString() })
      if (updated.confirmedDesignSpecFingerprint !== fingerprint || await this.contracts.sha256Fingerprint(updated.confirmedDesignSpec) !== fingerprint) throw new Error('Confirmed design specification read-back verification failed.')
      return { status: 'verified_write', projectId, designSpecFingerprint: fingerprint }
    })
  }
  async reopenDesign({ projectId, capability }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (generationAttempt(record) !== undefined) throw new Error('A prototype generation request is still active. Stop it before adjusting the design specification.')
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('This prototype already has saved history. Create a new prototype project before changing its design specification.')
      if (record.confirmedDesignSpec === undefined || typeof record.confirmedDesignSpecFingerprint !== 'string') throw new Error('The design specification is not currently confirmed.')
      const { confirmedDesignSpec: _designSpec, confirmedDesignSpecFingerprint: _fingerprint, ...unconfirmed } = record
      const updated = await this.write({ ...unconfirmed, updatedAt: new Date().toISOString() })
      if (updated.confirmedDesignSpec !== undefined || updated.confirmedDesignSpecFingerprint !== undefined || updated.currentRevisionId !== undefined || updated.revisions.length !== 0 || generationAttempt(updated) !== undefined) throw new Error('Design specification reopening read-back verification failed.')
      return { status: 'verified_write', projectId, designConfirmed: false }
    })
  }
  async confirmProductBrief({ projectId, capability, brief }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (record.confirmedDesignSpec === undefined || typeof record.confirmedDesignSpecFingerprint !== 'string') throw new Error('Confirm the design specification before confirming product requirements.')
      if (generationAttempt(record) !== undefined) throw new Error('A prototype generation request is still active. Stop it before changing product requirements.')
      if (record.currentRevisionId !== undefined || record.revisions.length !== 0) throw new Error('The product requirement checklist is already bound to saved prototype history.')
      const checked = productBrief(brief)
      if (checked === undefined) throw new Error('Product requirement checklist is invalid.')
      const fingerprint = await this.contracts.sha256Fingerprint(checked)
      const updated = await this.write({ ...record, productBrief: checked, updatedAt: new Date().toISOString() })
      const readback = productBrief(updated.productBrief)
      if (readback === undefined || await this.contracts.sha256Fingerprint(readback) !== fingerprint) throw new Error('Product requirement checklist read-back verification failed.')
      return { status: 'verified_write', projectId, productBrief: readback, productBriefFingerprint: fingerprint }
    })
  }
  async beginGeneration({ projectId, capability, requestId, expectedRevisionId, prompt, selection, brief, allowRevisionEviction }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (!REQUEST_ID.test(requestId) || !optionalRevisionId(expectedRevisionId)) throw new Error('Prototype generation request is invalid.')
      if (prompt !== undefined && (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 6_000)) throw new Error('Prototype generation prompt is invalid.')
      if (generationAttempt(record) !== undefined) throw new Error('A prototype generation request is already active for this project.')
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
      const updated = await this.write({ ...record, generationAttempt: attempt, lastAttempt: undefined, updatedAt: at })
      if (generationAttempt(updated)?.status !== 'pending' || generationAttempt(updated)?.requestId !== requestId || !sameRevisionId(generationAttempt(updated)?.expectedRevisionId, expectedRevisionId) || (checkedSelection !== undefined && generationAttempt(updated)?.localEditScope?.selection?.elementId !== checkedSelection.elementId)) throw new Error('Prototype generation begin read-back verification failed.')
      return { status: 'verified_write', projectId, requestId, ...(expectedRevisionId === undefined || expectedRevisionId === null ? {} : { expectedRevisionId }) }
    })
  }
  async cancelGeneration({ projectId, capability, requestId, expectedRevisionId, message = '本次原型生成请求已取消。' }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (!REQUEST_ID.test(requestId) || !optionalRevisionId(expectedRevisionId)) throw new Error('Prototype generation cancellation is invalid.')
      const active = generationAttempt(record)
      if (active === undefined || active.requestId !== requestId || !sameRevisionId(active.expectedRevisionId, expectedRevisionId)) throw new Error('Prototype generation request is no longer active.')
      const at = new Date().toISOString(); const cancelled = String(message).replace(/\s+/g, ' ').trim().slice(0, 600) || '本次原型生成请求已取消。'
      const updated = await this.write({ ...record, generationAttempt: undefined, lastAttempt: { status: 'error', requestId, message: cancelled, at }, updatedAt: at })
      if (generationAttempt(updated) !== undefined || updated.lastAttempt?.message !== cancelled) throw new Error('Prototype generation cancellation read-back verification failed.')
      return { status: 'verified_write', projectId, requestId }
    })
  }
  async recordFailure({ projectId, sessionId, requestId, error }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      if (record.sessionId !== sessionId) throw new Error('Prototype project belongs to a different Harness session.')
      if (!REQUEST_ID.test(requestId)) throw new Error('Prototype generation request is invalid.')
      const active = generationAttempt(record)
      if (active === undefined || active.requestId !== requestId) throw new Error('Prototype generation request is no longer active.')
      const message = String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 600) || '原型保存失败。'
      const at = new Date().toISOString(); const attempt = { status: 'error', requestId, ...(active.expectedRevisionId === undefined ? {} : { expectedRevisionId: active.expectedRevisionId }), message, at }
      const updated = await this.write({ ...record, generationAttempt: { ...attempt, ...(active.prompt === undefined ? {} : { prompt: active.prompt }), ...(active.localEditScope === undefined ? {} : { localEditScope: active.localEditScope }), ...(active.productBrief === undefined ? {} : { productBrief: active.productBrief }), ...(active.allowRevisionEviction === true ? { allowRevisionEviction: true } : {}) }, lastAttempt: { status: 'error', requestId, message, at }, updatedAt: at })
      if (generationAttempt(updated)?.status !== 'error' || generationAttempt(updated)?.requestId !== requestId) throw new Error('Prototype generation failure read-back verification failed.')
    })
  }
  async restore({ projectId, capability, targetRevisionId, expectedCurrentRevisionId }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (typeof targetRevisionId !== 'string' || targetRevisionId.length === 0 || targetRevisionId.length > 160 || typeof expectedCurrentRevisionId !== 'string' || expectedCurrentRevisionId.length === 0 || expectedCurrentRevisionId.length > 160) throw new Error('Prototype Studio restore arguments are invalid.')
      if (generationAttempt(record) !== undefined) throw new Error('A prototype generation request is still active. Cancel it before restoring a version.')
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
      const updated = await this.write({ ...record, ...(restoredBrief === undefined ? {} : { productBrief: restoredBrief }), currentRevisionId: target.revision.id, lastAttempt: undefined, updatedAt: new Date().toISOString() })
      const readback = updated.revisions.find(item => item.revision.id === updated.currentRevisionId)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype revision restore read-back verification failed.')
      if (restoredBrief !== undefined && (productBrief(updated.productBrief) === undefined || await this.contracts.sha256Fingerprint(updated.productBrief) !== await this.contracts.sha256Fingerprint(restoredBrief))) throw new Error('Prototype requirement restore read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: readback.revision.id, documentFingerprint: readback.revision.documentFingerprint, changeSummary: readback.revision.changeSummary }
    })
  }
  async save({ projectId, sessionId, requestId, expectedRevisionId, designSpec, document, changeSummary }) {
    return this.exclusive(projectId, async () => {
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
      const revisionId = `rev-${randomUUID()}`
      const created = await this.contracts.createTrustedRevision({ id: revisionId, ...(current === undefined ? {} : { parentRevisionId: current }), author: 'agent', document, designSpec: checkedDesignSpec.value, evidence: record.evidence, changeSummary })
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
      const priorRevisions = record.revisions.map(item => item.revision.id === current && productBrief(item.productBrief) === undefined && storedBrief !== undefined ? { ...item, productBrief: storedBrief } : item)
      const revisions = [...priorRevisions, { revision: created.value, designSpec: checkedDesignSpec.value, ...(nextBrief === undefined ? {} : { productBrief: nextBrief }), ...(nextCoverage === undefined ? {} : { requirementCoverage: nextCoverage }) }].slice(-MAX_REVISIONS)
      const updated = await this.write({ ...record, confirmedDesignSpec, confirmedDesignSpecFingerprint, ...(nextBrief === undefined ? {} : { productBrief: nextBrief }), revisions, currentRevisionId: created.value.id, generationAttempt: undefined, lastAttempt: undefined, updatedAt: new Date().toISOString() })
      const readback = updated.revisions.find(item => item.revision.id === created.value.id)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype revision read-back verification failed.')
      if (nextBrief !== undefined && (productBrief(readback.productBrief) === undefined || await this.contracts.sha256Fingerprint(readback.productBrief) !== await this.contracts.sha256Fingerprint(nextBrief))) throw new Error('Prototype revision requirement read-back verification failed.')
      if (nextCoverage !== undefined && (productRequirementCoverageValue(readback.requirementCoverage) === undefined || JSON.stringify(readback.requirementCoverage) !== JSON.stringify(nextCoverage))) throw new Error('Prototype revision requirement coverage read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: created.value.id, documentFingerprint: created.value.documentFingerprint, changeSummary: created.value.changeSummary }
    })
  }
}

export function prototypeProjectId() { return `prototype-${randomUUID()}` }
