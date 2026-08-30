import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const unsupportedMessage = '全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。'

async function loadHandoff() {
  const source = await readFile(new URL('./fullscreen-handoff.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

test('Chrome 116–140 keeps the side panel and rejects the full-screen handoff before it messages the background', async () => {
  const { openFullscreenTab } = await loadHandoff()
  let messages = 0

  await assert.rejects(
    openFullscreenTab({ runtime: { sendMessage: async () => { messages += 1; return { ok: true } } }, sidePanel: {} }, 7),
    new Error(unsupportedMessage),
  )
  assert.equal(messages, 0, 'an unsupported browser must not ask background to create a full-screen Tab')
})

test('Chrome 141+ keeps the existing full-screen handoff request', async () => {
  const { openFullscreenTab } = await loadHandoff()
  const requests = []

  await openFullscreenTab({
    runtime: { sendMessage: async (request) => { requests.push(request); return { ok: true } } },
    sidePanel: { close: async () => {} },
  }, 7, 'session-current')

  assert.deepEqual(requests, [{ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId: 7, sessionId: 'session-current' }])
})

test('the manifest supports Chrome 116 while background rejects full-screen requests without close before creating a Tab', async () => {
  const [config, background, frame, sidepanel] = await Promise.all([
    readFile(new URL('../../wxt.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../background.ts', import.meta.url), 'utf8'),
    readFile(new URL('./harness-frame.ts', import.meta.url), 'utf8'),
    readFile(new URL('./main.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(config, /minimum_chrome_version:\s*'116'/)
  const closeGuard = background.indexOf("if (chrome.sidePanel?.close === undefined)")
  const create = background.indexOf('await chrome.tabs.create', closeGuard)
  assert.ok(closeGuard >= 0)
  assert.ok(create > closeGuard, 'background must reject without close before it can create a full-screen Tab')
  assert.match(background, new RegExp(unsupportedMessage))
  assert.match(frame, /dshBrowserTargetFullscreenTabSupported/)
  assert.match(sidepanel, /fullscreenTabSupported: chrome\.sidePanel\?\.close !== undefined/)
})
