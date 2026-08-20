import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Session copy is a product plugin using only public slots and the host export endpoint', async () => {
  const [manifest, source, controller] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/controller.ts', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-session-log-copy/)
  assert.match(source, /settingsQuickActions/)
  assert.match(source, /copy-session-log/)
  assert.match(source, /download-session-log/)
  assert.match(source, /下载 Session log/)
  assert.match(source, /sessionLogDownload\.download\(sessionId\)/)
  assert.match(source, /sessionLogDownload/)
  assert.match(source, /conversation\.session\.header\.utilities/)
  assert.match(controller, /includeDescendants', 'false'/)
  assert.match(controller, /unzipSync/)
  assert.doesNotMatch(source + controller, /upstream\/deepseek-harness/)
})
