import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('keeps the accepted e327 composer and compact-header interactions in an out-of-tree plugin', async () => {
  await access(new URL('package.json', root))
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-browser-target"/)
  assert.match(client, /conversation\.input\.left/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.match(client, /sidebar\.compact\.action/)
  assert.match(client, /@deepseek-ai\/dsh-client-ui-sidebar/)
  assert.match(client, /HarnessReconnectAction/)
  assert.match(client, /open-fullscreen/)
  assert.match(client, /open-fullscreen-tab\/v1/)
  assert.match(client, /close-fullscreen/)
  assert.match(client, /关闭全屏/)
  assert.match(client, /return-to-sidepanel\/v1/)
  assert.match(client, /config\?\.surface === 'fullscreen-tab'/)
  assert.match(client, /sessionId: String\(sessionId\)/)
  assert.match(client, /restore handed-off session/)
  assert.match(client, /ctx\.sessions\.open\(config\.sessionId! as SessionId\)/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})

test('Browser Target DOM and surface geometry match the e327 reference', async () => {
  const [control, styles] = await Promise.all([
    source('src/client/BrowserTargetControl.tsx'),
    source('src/client/ActiveTabDock.module.css'),
  ])

  assert.equal(control.match(/data-browser-target-control data-composer-overlay-trigger/g)?.length, 2)
  assert.match(control, /role="radiogroup" aria-label="工作目标模式"/)
  assert.match(control, /command: 'toggle-pinned-tab'/)
  assert.match(control, /command: 'set-primary'/)
  assert.match(styles, /\.trigger\s*\{[^}]*position:\s*relative[^}]*width:\s*28px[^}]*border:\s*1px solid[^}]*border-radius:\s*50%/s)
  assert.match(styles, /\.badge\s*\{[^}]*top:\s*-5px[^}]*right:\s*-7px/s)
  assert.match(styles, /\.panel\s*\{[^}]*left:\s*0[^}]*width:\s*100%[^}]*max-height:\s*min\(500px, calc\(100vh - 144px\)\)[^}]*overflow:\s*hidden/s)
  assert.match(styles, /\.tabList\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s)
})
