import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('keeps the accepted e327 composer and compact-header interactions in an out-of-tree plugin', async () => {
  await access(new URL('package.json', root))
  const [manifest, client, handoff] = await Promise.all([source('package.json'), source('src/client/index.ts'), source('src/client/session-handoff.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-browser-target"/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.match(client, /sidebar\.compact\.action/)
  assert.match(client, /@deepseek-ai\/dsh-client-ui-sidebar/)
  assert.match(client, /HarnessReconnectAction/)
  assert.match(client, /open-fullscreen/)
  assert.match(client, /open-fullscreen-tab\/v1/)
  assert.match(client, /dshBrowserTargetFullscreenTabSupported/)
  assert.match(client, /config !== undefined && !fullscreenTabSupported/)
  assert.match(client, /id: 'fullscreen-unavailable'/)
  assert.match(client, /全屏模式需 Chrome 141\+（仍可使用侧边栏）/)
  assert.match(client, /window\.alert\('全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。'\)/)
  assert.match(client, /close-fullscreen/)
  assert.match(client, /关闭全屏/)
  assert.match(client, /return-to-sidepanel\/v1/)
  assert.match(client, /conversation\.session\.header\.utilities/)
  assert.match(client, /id: 'fullscreen-return'/)
  assert.match(client, /order: 0/)
  assert.match(client, /FullscreenReturnControl/)
  assert.match(client, /config\?\.surface === 'fullscreen-tab'/)
  assert.match(client, /sessionId: String\(sessionId\)/)
  assert.match(client, /restore handed-off session/)
  assert.match(client, /restoreHandoffSession/)
  assert.match(client, /config\.surface === 'sidepanel'/)
  assert.match(client, /id: 'prototype-studio'/)
  assert.match(client, /label: '原型'/)
  assert.match(client, /requiresSession: false/)
  assert.match(client, /open-recent-prototypes\/v1/)
  assert.match(client, /nonce: config\.nonce/)
  assert.match(client, /config\.parentOrigin/)
  assert.match(handoff, /if \(snapshot\.current !== sessionId\) open\(sessionId\)/)
  assert.match(client, /session-handoff-applied\/v1/)
  assert.match(client, /const reportSelectedSession/, 'the iframe reports the selected Harness session to its side-panel parent')
  assert.match(client, /ctx\.sessions\.list\.subscribe\(reportSelectedSession\)/, 'the session report follows selection changes')
  assert.doesNotMatch(client, /if \(fullscreenTab\) \{\s*ctx\.effect\(\(\) => \{\s*const reportSelectedSession/s, 'the ordinary side panel must report its session too, not only the full-screen surface')
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})

test('declares every client context service it reads', async () => {
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  const declared = [...client.matchAll(/export const inject\s*=\s*\[([\s\S]*?)\]/g)][0]?.[1]
  assert.ok(declared, 'client must declare its Cordis injections')
  const inject = [...declared.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1])
  const directServices = [...client.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)]
    .map(match => match[1])
    .filter(name => !['effect', 'get', 'on'].includes(name))
  const getServices = [...client.matchAll(/\bctx\.get\(['"]([^'"]+)['"]\)/g)].map(match => match[1])
  for (const service of new Set([...directServices, ...getServices])) {
    assert.ok(inject.includes(service), `ctx.${service} is read but missing from export const inject`)
  }
  assert.match(manifest, /"inject"\s*:/)
})

test('awaits the follow-mode lock acknowledgement, preserves accepted locks across surface disposal, then reconciles every idle session', async () => {
  const [client, runLock] = await Promise.all([source('src/client/index.ts'), source('src/client/session-run-lock.ts')])
  assert.match(client, /'composerSubmissionTransforms'/)
  assert.match(client, /id: 'browser-target-run-lock'/)
  assert.match(client, /prepare: async/)
  assert.match(client, /targetSnapshot\?\.settings\.mode === 'follow-active-tab' && targetSnapshot\.activeTab !== undefined/)
  assert.match(client, /type: 'browser-target-lock\/v1'/)
  assert.match(client, /browser-target-lock-ack\/v1/)
  assert.match(client, /submissionId/)
  assert.match(client, /pendingLockAcks/)
  assert.match(client, /new BrowserTargetSessionRunLock\(lock\.submissionId\)/)
  assert.match(runLock, /accepted = false/)
  assert.match(runLock, /observedRunning = false/)
  assert.match(runLock, /this\.accepted && this\.observedRunning && !snapshot\.running && snapshot\.queue\.length === 0/)
  assert.match(client, /if \(!lock\.state\.accepted\) postUnlock\(sessionId, lock\.state\.submissionId\)/)
  assert.match(client, /const sessionIds = ctx\.sessions\.list\.getSnapshot\(\)\.ids/)
  assert.match(client, /sessionSubscriptions\.set\(id, session\.subscribe\(onSnapshot\)\)/)
  assert.match(client, /browser-target-reconcile\/v1/)
  assert.match(client, /type: 'browser-target-unlock\/v1'/)
  assert.match(client, /Browser Target locking was cancelled because the Harness surface closed/)
})

test('Browser Target DOM and surface geometry match the e327 reference', async () => {
  const [control, styles] = await Promise.all([
    source('src/client/BrowserTargetControl.tsx'),
    source('src/client/ActiveTabDock.module.css'),
  ])

  assert.equal(control.match(/data-browser-target-control data-composer-overlay-trigger/g)?.length, 2)
  assert.match(control, /role="radiogroup" aria-label="工作目标模式"/)
  assert.match(control, /发送后，本次运行会固定发送瞬间的 Browser Target；运行结束后恢复跟随。/)
  assert.match(control, /command: 'toggle-pinned-tab'/)
  assert.match(control, /command: 'set-primary'/)
  assert.match(styles, /\.trigger\s*\{[^}]*position:\s*relative[^}]*width:\s*28px[^}]*border:\s*1px solid[^}]*border-radius:\s*50%/s)
  assert.match(styles, /\.badge\s*\{[^}]*top:\s*-5px[^}]*right:\s*-7px/s)
  assert.match(styles, /\.panel\s*\{[^}]*left:\s*0[^}]*width:\s*100%[^}]*max-height:\s*min\(500px, calc\(100vh - 144px\)\)[^}]*overflow:\s*hidden/s)
  assert.match(styles, /\.tabList\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s)
})
