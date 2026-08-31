import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function runTargetLockProjection() {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('export class BrowserTargetRunLockProjection')
  const end = source.indexOf('\n\nfunction isBrowserTargetCommand', start)
  assert.ok(start >= 0 && end > start, 'the side panel exposes an isolated Run-target lock projection')
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}-${Math.random()}`)
}

test('the side panel accepts the iframe session report before enabling prototype capture', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /value\.type === 'harness-session-selected\/v1'/)
  assert.match(source, /selectedSessionId === undefined \|\| isHarnessSessionIdentity\(selectedSessionId\)/)
  assert.match(source, /setObservedHarnessSessionId\(selectedSessionId\)/)
  assert.match(source, /command: 'capture-design-reference', tabId: activeTab\.tab\.tabId, sessionId: activeHarnessSessionId/)
})

test('observing the selected session cannot reload the side-panel iframe', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /const \[observedHarnessSessionId, setObservedHarnessSessionId\]/)
  assert.match(source, /const activeHarnessSessionId = observedHarnessSessionId/)
  assert.match(source, /setObservedHarnessSessionId\(selectedSessionId\)/)
  assert.match(source, /sessionId: sidePanelHandoff\.sessionId/)
  assert.doesNotMatch(source, /sessionId: activeHarnessSessionId \}\), \[activeHarnessSessionId, frameNonce/, 'the observed session must never be an iframe URL dependency')
})

test('changing the observed session refreshes recent prototypes without reconnecting Harness', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /void connect\(\); void loadTargetSettings\(\)/)
  assert.match(source, /void loadRecentPrototypes\(\)/)
  assert.doesNotMatch(source, /void connect\(\); void loadTargetSettings\(\); void loadRecentPrototypes\(\)/, 'session-scoped recent projects must not share the Harness initialization effect')
})

test('projects all acknowledged Browser Target locks and clears only the matching submission', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /const \[lockedRunTargets, setLockedRunTargets\] = useState/)
  assert.match(source, /lockedRunTarget: lockedRunTargets\[0\]\.target/)
  assert.match(source, /activeRunLock: lockedRunTargets\[0\]/)
  assert.match(source, /activeRunLocks: lockedRunTargets/)
  assert.match(source, /response\?\.ok === true && response\?\.locked === true/)
  assert.match(source, /runTargetLockProjectionRef\.current\.unlock\(value\.sessionId, value\.submissionId\)/)
  assert.match(source, /runTargetLockProjectionRef\.current\.acknowledge\(sessionId, submissionId, locked\)/)
  assert.match(source, /value\.type === 'browser-target-reconcile\/v1/)
})

test('isolates pending and current Browser Target locks by session and submission identity', async () => {
  const { BrowserTargetRunLockProjection } = await runTargetLockProjection()
  const a = { browser: 'chrome', windowId: 1, tabId: 1, url: 'https://a.example.test', title: 'A' }
  const a2 = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://a2.example.test', title: 'A2' }

  const projection = new BrowserTargetRunLockProjection()
  projection.start('session-a', 'a1', a)
  projection.reconcile('session-b', 'b1')
  assert.deepEqual(projection.acknowledge('session-a', 'a1', true), [{ sessionId: 'session-a', submissionId: 'a1', target: a }], 'an unrelated session must not invalidate A pending ACK')

  projection.start('session-a', 'a2', a2)
  assert.deepEqual(projection.acknowledge('session-a', 'a2', true), [{ sessionId: 'session-a', submissionId: 'a1', target: a }, { sessionId: 'session-a', submissionId: 'a2', target: a2 }])
  assert.deepEqual(projection.unlock('session-a', 'a1'), [{ sessionId: 'session-a', submissionId: 'a2', target: a2 }], 'old A1 unlock must not clear current A2')
  assert.deepEqual(projection.reconcile('session-a', 'a1'), [{ sessionId: 'session-a', submissionId: 'a2', target: a2 }], 'late A1 reconciliation must not clear current A2')

  const first = new BrowserTargetRunLockProjection()
  first.start('session-a', 'a3', a)
  first.start('session-a', 'a4', a2)
  assert.deepEqual(first.acknowledge('session-a', 'a4', false), [])
  assert.deepEqual(first.acknowledge('session-a', 'a3', true), [{ sessionId: 'session-a', submissionId: 'a3', target: a }], 'a rejected peer request must not erase the first pending lock')
})

test('hydrates every authoritative active Run owner after sidepanel reconstruction', async () => {
  const { BrowserTargetRunLockProjection } = await runTargetLockProjection()
  const a = { browser: 'chrome', windowId: 1, tabId: 1, url: 'https://a.example.test', title: 'A' }
  const projection = new BrowserTargetRunLockProjection()
  const b = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://b.example.test', title: 'B' }
  assert.deepEqual(projection.hydrate([{ sessionId: 'session-a', submissionId: 'a1', target: a }, { sessionId: 'session-b', submissionId: 'b1', target: b }]), [{ sessionId: 'session-a', submissionId: 'a1', target: a }, { sessionId: 'session-b', submissionId: 'b1', target: b }])
  assert.deepEqual(projection.hydrate([]), [], 'a later authoritative empty response clears every recovered lock')
})

test('reconnect clears stale Browser Target state before ready hydrates the authority again', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')
  const { BrowserTargetRunLockProjection } = await runTargetLockProjection()
  const a = { browser: 'chrome', windowId: 1, tabId: 1, url: 'https://a.example.test', title: 'A' }
  const projection = new BrowserTargetRunLockProjection()
  projection.start('session-a', 'a1', a)
  assert.deepEqual(projection.acknowledge('session-a', 'a1', true), [{ sessionId: 'session-a', submissionId: 'a1', target: a }])
  assert.deepEqual(projection.reset(), [], 'a reconnect drops pending and acknowledged locks from the disconnected Harness')
  assert.match(source, /const connect = useCallback\(async \(\) => \{[\s\S]*?clearBrowserTargetLockProjection\(\)/)
  assert.match(source, /value\.type === 'browser-target-ready\/v1'[\s\S]*?hydrateActiveBrowserTargetLock\(\)/)
})
