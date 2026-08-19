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

test('composer takeover must leave the scope strip outside the hidden input card', async () => {
  const [readme, seam] = await Promise.all([
    source('README.md'),
    readFile(new URL('../../../upstream-contributions/0016-composer-takeover-keeps-above-strip.patch', import.meta.url), 'utf8'),
  ])
  assert.match(readme, /takeover must hide only the input card/)
  assert.match(seam, /fallback: inputBar/)
  assert.match(seam, /data-composer-stack/)
  assert.match(seam, /data-question-collapsed/)
  assert.match(seam, /keeps the composer-above strip outside a takeover-hidden input card/)
})

test('scope pickers use the shared upward overlay and preserve the accepted e327 geometry', async () => {
  const [control, styles] = await Promise.all([
    readFile(new URL('../src/client/KnowledgeScope.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/KnowledgeScope.module.css', import.meta.url), 'utf8'),
  ])

  assert.match(control, /useComposerOverlay\('repository-scope'/)
  assert.match(control, /useComposerOverlay\('knowledge-scope'/)
  assert.match(control, /catalog\.systems\.filter\(system => system\.domainId === domain\.id\)/)
  assert.match(control, /当前账号暂无可用领域和系统/)
  assert.match(control, /selectKnowledgeSystem/)
  assert.match(control, /selectKnowledgeDomain/)
  assert.doesNotMatch(control, /type="radio"/)
  assert.doesNotMatch(control, /disabled=\{!selected\}/)
  assert.equal(control.match(/data-composer-overlay-trigger/g)?.length, 2)
  assert.match(styles, /\.strip\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(0, 1fr\)/s)
  assert.match(styles, /\.panel\s*\{[^}]*left:\s*50%[^}]*width:\s*min\(100%, var\(--dsh-composer-card-max-width\)\)[^}]*max-height:\s*calc\(100dvh - 140px\)[^}]*overflow:\s*auto[^}]*transform:\s*translateX\(-50%\)/s)
  assert.doesNotMatch(styles, /max-height:\s*min\(480px/)
  assert.match(control, /useScopePanelMaxHeight/)
  assert.match(control, /data-testid="compact-header"/)
  assert.match(control, /data-conversation-presentation/)
  assert.match(control, /ResizeObserver/)
  assert.match(control, /style=\{maxHeight === undefined \? undefined : \{ maxHeight \}\}/)
  assert.match(control, /const \[rememberOpen, setRememberOpen\] = useState\(false\)/)
  assert.match(control, /className=\{css\.remember\}/)
  assert.match(control, />是否记住<\/label>/)
  assert.match(control, /className=\{css\.repositoryToggle\}/)
  assert.equal(control.match(/className=\{css\.scopeTrigger\}/g)?.length, 2)
  assert.doesNotMatch(control, /关闭范围选择/)
  assert.match(styles, /\.remember\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 6px\)/s)
})
