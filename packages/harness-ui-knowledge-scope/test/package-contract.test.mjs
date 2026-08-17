import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('declares an out-of-tree scope plugin against public composer contracts only', async () => {
  await access(new URL('package.json', root))
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-knowledge-scope"/)
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})

test('scope pickers use the shared upward overlay and preserve the accepted e327 geometry', async () => {
  const [control, styles] = await Promise.all([
    readFile(new URL('../src/client/KnowledgeScope.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/KnowledgeScope.module.css', import.meta.url), 'utf8'),
  ])

  assert.match(control, /useComposerOverlay\('repository-scope'/)
  assert.match(control, /useComposerOverlay\('knowledge-scope'/)
  assert.equal(control.match(/data-composer-overlay-trigger/g)?.length, 2)
  assert.match(styles, /\.strip\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(0, 1fr\)/s)
  assert.match(styles, /\.panel\s*\{[^}]*left:\s*50%[^}]*width:\s*min\(100%, var\(--dsh-composer-card-max-width\)\)[^}]*max-height:\s*min\(480px, calc\(100vh - 140px\)\)[^}]*overflow:\s*auto[^}]*transform:\s*translateX\(-50%\)/s)
})
