import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the emitted Session copy client bundle embeds its browser-only ZIP reader', async (t) => {
  let code
  try {
    code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return t.skip('bundle first with pnpm --filter @accrui/harness-ui-session-log-copy bundle')
    throw error
  }

  let handoff
  const window = { __ModuleLoader__: { load(value) { handoff = value } } }
  // Execute the real generated browser wrapper; it must not reach Node builtins
  // or leave fflate as a runtime module-table dependency.
  new Function('window', code)(window)
  assert.equal(handoff?.id, '@accrui/harness-ui-session-log-copy')

  const platform = new Set([
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-primitives',
    'react/jsx-runtime',
  ])
  assert.doesNotThrow(() => handoff.factory((specifier) => {
    if (platform.has(specifier)) return {}
    throw new Error(`unexpected module-table require: ${specifier}`)
  }))
  assert.doesNotMatch(code, /require\(["'](?:node:)?(?:fs|path|zlib)[/"']/)
  assert.doesNotMatch(code, /require\(["']fflate(?:\/browser)?["']\)/)
})
