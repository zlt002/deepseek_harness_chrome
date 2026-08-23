import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const MAX_REVISIONS = 20

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function safeEqual(left, right) {
  const a = Buffer.from(hash(left)); const b = Buffer.from(hash(right))
  return timingSafeEqual(a, b)
}
function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export class PrototypeProjectStore {
  constructor(root, contracts) { this.root = root; this.contracts = contracts; this.queues = new Map() }
  file(projectId) { if (!PROJECT_ID.test(projectId)) throw new Error('Invalid prototype project id.'); return join(this.root, `${projectId}.json`) }
  async read(projectId) {
    const parsed = JSON.parse(await readFile(this.file(projectId), 'utf8'))
    if (!exactObject(parsed) || parsed.v !== 1 || parsed.id !== projectId || typeof parsed.sessionId !== 'string' || typeof parsed.capabilityHash !== 'string' || !Array.isArray(parsed.evidence) || !Array.isArray(parsed.revisions)) throw new Error('Stored prototype project is invalid.')
    return parsed
  }
  async write(record) {
    await mkdir(this.root, { recursive: true })
    const target = this.file(record.id); const temporary = `${target}.${randomUUID()}.tmp`; const body = JSON.stringify(record)
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    const readback = await this.read(record.id)
    if (hash(JSON.stringify(readback)) !== hash(body)) throw new Error('Prototype project write-back verification failed.')
    return readback
  }
  async exclusive(projectId, operation) {
    const previous = this.queues.get(projectId) ?? Promise.resolve(); const next = previous.then(operation); const marker = next.then(() => undefined, () => undefined)
    this.queues.set(projectId, marker)
    try { return await next } finally { if (this.queues.get(projectId) === marker) this.queues.delete(projectId) }
  }
  async open({ projectId, sessionId, capability, evidence }) {
    if (!PROJECT_ID.test(projectId) || typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 160 || typeof capability !== 'string' || capability.length < 32 || capability.length > 256) throw new Error('Invalid prototype project handoff.')
    if (!Array.isArray(evidence) || evidence.length !== 1) throw new Error('A prototype project requires exactly one captured reference in V1.')
    const checked = this.contracts.validateReferenceEvidence(evidence[0])
    if (!checked.ok || !(await this.contracts.verifyReferenceEvidenceFingerprint(checked.value))) throw new Error('Captured reference evidence failed trusted verification.')
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
      const record = { v: 1, id: projectId, sessionId, capabilityHash: hash(capability), evidence: storedEvidence, revisions: [], createdAt: now, updatedAt: now }
      return this.snapshot(await this.write(record))
    })
  }
  authorize(record, capability) {
    if (typeof capability !== 'string' || !safeEqual(record.capabilityHash, hash(capability))) throw new Error('Prototype project capability is invalid.')
  }
  snapshot(record) {
    const current = record.revisions.find(item => item.revision.id === record.currentRevisionId)
    return {
      v: 1, projectId: record.id, sessionId: record.sessionId, evidence: record.evidence,
      revisions: record.revisions.map(item => ({ id: item.revision.id, parentRevisionId: item.revision.parentRevisionId, createdAt: item.revision.createdAt, changeSummary: item.revision.changeSummary, current: item.revision.id === record.currentRevisionId })),
      ...(current === undefined ? {} : { designSpec: current.designSpec, document: current.revision.document, currentRevisionId: current.revision.id }),
    }
  }
  async authorizedSnapshot(projectId, capability) { const record = await this.read(projectId); this.authorize(record, capability); return this.snapshot(record) }
  async restore({ projectId, capability, targetRevisionId, expectedCurrentRevisionId }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      this.authorize(record, capability)
      if (typeof targetRevisionId !== 'string' || targetRevisionId.length === 0 || targetRevisionId.length > 160 || typeof expectedCurrentRevisionId !== 'string' || expectedCurrentRevisionId.length === 0 || expectedCurrentRevisionId.length > 160) throw new Error('Prototype Studio restore arguments are invalid.')
      if (record.currentRevisionId !== expectedCurrentRevisionId) throw new Error(`Prototype revision conflict: current revision is ${record.currentRevisionId ?? 'empty'}. Read it before restoring again.`)
      const target = record.revisions.find(item => item.revision.id === targetRevisionId)
      if (target === undefined) throw new Error('The requested prototype revision does not exist.')
      if (!(await this.contracts.verifyTrustedRevision(target.revision, target.designSpec, record.evidence))) throw new Error('The requested prototype revision failed trusted verification.')
      const updated = await this.write({ ...record, currentRevisionId: target.revision.id, updatedAt: new Date().toISOString() })
      const readback = updated.revisions.find(item => item.revision.id === updated.currentRevisionId)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype revision restore read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: readback.revision.id, documentFingerprint: readback.revision.documentFingerprint, changeSummary: readback.revision.changeSummary }
    })
  }
  async save({ projectId, sessionId, expectedRevisionId, designSpec, document, changeSummary }) {
    return this.exclusive(projectId, async () => {
      const record = await this.read(projectId)
      if (record.sessionId !== sessionId) throw new Error('Prototype project belongs to a different Harness session.')
      const current = record.currentRevisionId
      if ((expectedRevisionId ?? undefined) !== (current ?? undefined)) throw new Error(`Prototype revision conflict: current revision is ${current ?? 'empty'}. Read it before saving again.`)
      const revisionId = `rev-${randomUUID()}`
      const created = await this.contracts.createTrustedRevision({ id: revisionId, ...(current === undefined ? {} : { parentRevisionId: current }), author: 'agent', document, designSpec, evidence: record.evidence, changeSummary })
      if (!created.ok) throw new Error(created.errors[0] ?? 'Prototype revision validation failed.')
      const revisions = [...record.revisions, { revision: created.value, designSpec }].slice(-MAX_REVISIONS)
      const updated = await this.write({ ...record, revisions, currentRevisionId: created.value.id, updatedAt: new Date().toISOString() })
      const readback = updated.revisions.find(item => item.revision.id === created.value.id)
      if (readback === undefined || !(await this.contracts.verifyTrustedRevision(readback.revision, readback.designSpec, updated.evidence))) throw new Error('Prototype revision read-back verification failed.')
      return { status: 'verified_write', projectId, revisionId: created.value.id, documentFingerprint: created.value.documentFingerprint, changeSummary: created.value.changeSummary }
    })
  }
}

export function prototypeProjectId() { return `prototype-${randomUUID()}` }
