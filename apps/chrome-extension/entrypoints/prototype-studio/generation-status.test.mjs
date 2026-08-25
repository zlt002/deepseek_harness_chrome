import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleUnderTest() {
  const source = await readFile(new URL('./generation-status.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(output)}#${Date.now()}-${Math.random()}`)
}

test('resolves only a new trusted revision, current failure, or request-bound cross-window stop', async () => {
  const { generationOutcome, hasStoppedGeneration } = await moduleUnderTest()
  const failure = { status: 'error', requestId: 'request-current', message: '当前请求失败', at: '2026-08-24T01:00:01.000Z' }
  const stopped = { status: 'error', requestId: 'request-current', message: '本次原型生成请求已取消。', at: '2026-08-24T01:00:30.000Z' }
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', undefined, undefined), { status: 'pending' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-two', undefined, undefined), { status: 'saved' })
  assert.deepEqual(generationOutcome('request-current', undefined, 'rev-first', undefined, undefined), { status: 'saved' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', failure, undefined, Date.parse('2026-08-24T01:00:40.000Z')), { status: 'repairing', message: '当前请求失败' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', failure, undefined, Date.parse('2026-08-24T01:01:40.000Z')), { status: 'failed', message: '当前请求失败' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', { ...failure, requestId: 'request-old' }, stopped, Date.parse('2026-08-24T01:01:40.000Z')), { status: 'pending' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-two', failure, stopped, Date.parse('2026-08-24T01:00:40.000Z')), { status: 'saved' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', undefined, stopped), { status: 'stopped', message: '本次原型生成请求已取消。' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', undefined, { ...stopped, requestId: 'request-old' }), { status: 'pending' })
  assert.deepEqual(generationOutcome('request-current', 'rev-one', 'rev-one', undefined, { status: 'error', message: '旧格式记录', at: stopped.at }), { status: 'pending' })
  assert.equal(hasStoppedGeneration('request-current', undefined), true)
  assert.equal(hasStoppedGeneration(undefined, undefined), false)
  assert.equal(hasStoppedGeneration('request-current', failure), false)
  assert.equal(hasStoppedGeneration('request-current', { ...failure, status: 'pending' }), false)
})
