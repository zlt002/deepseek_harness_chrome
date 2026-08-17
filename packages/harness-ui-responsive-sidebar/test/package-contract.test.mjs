import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('responsive sidebar uses the public compact presentation seam without owning runtime stores', async () => {
  const [manifest, source, presentation, styles, buildScript, nativeRegistration] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ResponsiveSidebarPresentation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ResponsiveSidebarPresentation.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/build-harness-client-plugins.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/register-native-host.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-responsive-sidebar/)
  assert.match(source, /sidebar\.compact\.presentation/)
  assert.match(
    source,
    /name:\s*'sidebar\.compact\.presentation'[\s\S]*?select:\s*owner\s*=>\s*owner[\s\S]*?ResponsiveSidebarPresentation/,
    'chain presentation registration must select the matched owner',
  )
  assert.match(presentation, /owner\.renderWorkspace\(\)/)
  assert.match(presentation, /owner\.renderSettings\(\)/)
  assert.match(presentation, /owner\.renderDetailActions\(\)/)
  assert.match(presentation, /owner\.startSession\(\)/)
  assert.doesNotMatch(presentation, /useSessions|useView|Controller|upstream\/deepseek-harness/)
  assert.match(styles, /flex: 0 0 50%/)
  assert.match(buildScript, /'harness-ui-responsive-sidebar'/)
  assert.match(nativeRegistration, /'harness-ui-responsive-sidebar'/)
})
