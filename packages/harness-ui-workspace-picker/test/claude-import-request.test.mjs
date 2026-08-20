import assert from 'node:assert/strict'
import test from 'node:test'
import { claudeImportRequest } from '../src/client/claude-import-request.mjs'

test('a transport that never settles rejects at its action deadline instead of leaving preparing forever', async () => {
  const request = claudeImportRequest(
    { action: 'prepare' },
    undefined,
    { timeoutMs: 10, fetcher: () => new Promise(() => {}) },
  ).then(() => 'resolved', error => error instanceof Error ? error.message : String(error))
  const outcome = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve('still-pending'), 50))])
  assert.match(outcome, /准备所选会话.*超时/)
})

test('caller cancellation wins before the deadline with an action-specific message', async () => {
  const controller = new AbortController()
  const request = claudeImportRequest(
    { action: 'sessions' },
    controller.signal,
    { timeoutMs: 1_000, fetcher: () => new Promise(() => {}) },
  )
  controller.abort()
  await assert.rejects(request, /读取项目会话已取消/)
})

test('Native Host disconnect is a transparent action error rather than a TypeError', async () => {
  await assert.rejects(
    claudeImportRequest({ action: 'prepare' }, undefined, {
      timeoutMs: 100,
      fetcher: async () => { throw new TypeError('Native Host exited') },
    }),
    error => error instanceof Error
      && error.message === '准备所选会话失败：Native Host exited'
      && !error.message.includes('importSession'),
  )
})
