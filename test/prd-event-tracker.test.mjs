import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrdEventTracker, normalizePrdTrackingEvent } from '../apps/native-server/src/prd-event-tracker.mjs'

test('PRD telemetry accepts only bounded structured metadata', () => {
  assert.deepEqual(normalizePrdTrackingEvent({ eventId: 'review:generated', eventType: 'review_generated', outcome: 'succeeded', occurredAt: '2026-08-31T07:59:00Z', sessionId: 'session-1', name: '需求_PRD.md' }), {
    eventId: 'review:generated', eventType: 'prd_generated', outcome: 'success', occurredAt: '2026-08-31T07:59:00.000Z', sessionId: 'session-1', name: '需求_PRD.md',
  })
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:failed', eventType: 'review_generated', outcome: 'failed', occurredAt: '2026-08-31T07:59:00Z', sessionId: 'session-1' }), undefined)
  assert.deepEqual(normalizePrdTrackingEvent({ eventId: 'review:1', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', action: 'accept', status: 'queued', name: 'should-not-escape.md', rawInput: 'must not pass' }), {
    eventId: 'review:1', eventType: 'markdown_review_accept', outcome: 'success', occurredAt: '2026-08-31T08:00:00.000Z', sessionId: 'session-1', status: 'queued',
  })
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:2', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', action: 'rewrite', status: 'queued' }), undefined)
  assert.deepEqual(normalizePrdTrackingEvent({ eventId: 'review:1:rating:request-1', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 4 }), {
    eventId: 'review:1:rating:request-1', eventType: 'prd_rating', outcome: 'success', occurredAt: '2026-08-31T08:00:00.000Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 4,
  })
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:1:rating:half', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 4.5 })?.rating, 4.5)
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:1:rating:minimum', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 0.5 })?.rating, 0.5)
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:1:rating:too-low', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 0.4 }), undefined)
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:1:rating:unsupported', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 4.4 }), undefined)
  assert.equal(normalizePrdTrackingEvent({ eventId: 'review:1:rating:bad', eventType: 'prd_rating', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', generationEventId: 'review:1:generated', rating: 0 }), undefined)
  assert.equal(normalizePrdTrackingEvent({ eventId: 'bad', eventType: 'document_published', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', runId: 'run-1', documentName: 'PRD' }), undefined)
})

test('PRD telemetry keeps a failed request in the durable outbox and retries it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prd-tracking-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outboxPath = join(root, 'outbox.json')
  const identityPath = join(root, 'identity.json')
  await writeFile(identityPath, JSON.stringify({ deviceInstallationId: 'device-1' }))
  let now = 1_000
  let succeed = false
  const requests = []
  const tracker = new PrdEventTracker({
    outboxPath, endpoint: 'http://127.0.0.1:8793/api/tracking/prd-events', apiKey: 'write-key', productVersion: '1.1.76', now: () => now,
    environment: { ACCR_TRACKING_IDENTITY_PATH: identityPath },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: succeed, status: succeed ? 201 : 503 } },
  })
  t.after(() => tracker.stop())
  await tracker.report({ eventId: 'review:1', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', action: 'rewrite', status: 'draft_ready' })
  assert.equal(JSON.parse(await readFile(outboxPath, 'utf8')).length, 1)
  now += 20_000
  succeed = true
  await tracker.flush()
  assert.equal(JSON.parse(await readFile(outboxPath, 'utf8')).length, 0)
  assert.equal(requests.at(-1).deviceInstallationId, 'device-1')
  assert.equal(requests.at(-1).productVersion, '1.1.76')
  assert.equal(requests.at(-1).skillName, 'pmd-prd')
  assert.equal(requests.at(-1).status, 'draft_ready')
  assert.equal('rawInput' in requests.at(-1), false)
})

test('document publishing telemetry accepts every AI Verified Write and preserves an optional PRD link', () => {
  assert.deepEqual(normalizePrdTrackingEvent({ eventId: 'document:ai-write:42', eventType: 'document_published', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', runId: 'run-1', sessionId: 'session-1', generationEventId: 'review:1:generated', documentName: '需求_PRD', documentCatalogId: '42', documentUrl: 'https://doc.midea.com/teamKnowledge/detail/docOnline/42?id=42' }), {
    eventId: 'document:ai-write:42', eventType: 'online_document_verified_write', outcome: 'success', occurredAt: '2026-08-31T08:00:00.000Z', sessionId: 'session-1', runId: 'run-1', generationEventId: 'review:1:generated', name: '需求_PRD', catalogId: '42', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/42?id=42',
  })
})

test('PRD telemetry does not queue an event without a product version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prd-tracking-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tracker = new PrdEventTracker({
    outboxPath: join(root, 'outbox.json'),
    environment: {},
    fetchImpl: async () => ({ ok: true, status: 201 }),
  })
  t.after(() => tracker.stop())
  assert.equal(await tracker.report({ eventId: 'review:missing-version', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', action: 'rewrite', status: 'draft_ready' }), false)
})

test('PRD telemetry rejects a new event at outbox capacity without evicting old events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prd-tracking-capacity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outboxPath = join(root, 'outbox.json')
  const identityPath = join(root, 'identity.json')
  await writeFile(identityPath, JSON.stringify({ deviceInstallationId: 'device-1' }))
  const events = Array.from({ length: 1_000 }, (_, index) => ({
    event: {
      eventId: `review:${index + 1}`,
      eventType: 'markdown_review_rewrite',
      outcome: 'success',
      occurredAt: '2026-08-31T08:00:00.000Z',
      sessionId: 'session-1',
      status: 'draft_ready',
      productVersion: '1.1.76',
      skillName: 'pmd-prd',
    },
    attempts: 1,
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
  }))
  await writeFile(outboxPath, `${JSON.stringify(events)}\n`)
  let requests = 0
  const tracker = new PrdEventTracker({
    outboxPath, endpoint: 'http://127.0.0.1:8793/api/tracking/prd-events', apiKey: 'write-key', productVersion: '1.1.76',
    environment: { ACCR_TRACKING_IDENTITY_PATH: identityPath },
    fetchImpl: async () => { requests += 1; return { ok: false, status: 503 } },
  })
  t.after(() => tracker.stop())

  assert.equal(await tracker.report({ eventId: 'review:1001', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:00:00Z', sessionId: 'session-1', action: 'rewrite', status: 'draft_ready' }), false)
  const retained = JSON.parse(await readFile(outboxPath, 'utf8'))
  assert.equal(retained.length, 1_000)
  assert.equal(retained[0].event.eventId, 'review:1')
  assert.equal(retained.at(-1).event.eventId, 'review:1000')
  assert.equal(retained.some(item => item.event.eventId === 'review:1001'), false)
  assert.equal(requests, 0)
})

test('PRD telemetry updates a duplicate eventId at capacity without adding an item', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prd-tracking-capacity-duplicate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outboxPath = join(root, 'outbox.json')
  const events = Array.from({ length: 1_000 }, (_, index) => ({
    event: {
      eventId: `review:${index + 1}`,
      eventType: 'markdown_review_rewrite',
      outcome: 'success',
      occurredAt: '2026-08-31T08:00:00.000Z',
      sessionId: 'session-1',
      status: 'draft_ready',
      productVersion: '1.1.76',
      skillName: 'pmd-prd',
    },
    attempts: 1,
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
  }))
  await writeFile(outboxPath, `${JSON.stringify(events)}\n`)
  const tracker = new PrdEventTracker({
    outboxPath, endpoint: 'http://127.0.0.1:8793/api/tracking/prd-events', apiKey: 'write-key', productVersion: '1.1.76',
    environment: {},
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  t.after(() => tracker.stop())

  assert.equal(await tracker.report({ eventId: 'review:1', eventType: 'review_action', outcome: 'succeeded', occurredAt: '2026-08-31T08:01:00Z', sessionId: 'session-1', action: 'rewrite', status: 'draft_ready' }), true)
  const retained = JSON.parse(await readFile(outboxPath, 'utf8'))
  assert.equal(retained.length, 1_000)
  assert.equal(retained[0].event.eventId, 'review:1')
})
