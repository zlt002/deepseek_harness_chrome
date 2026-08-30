import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'
import { isChildConversation, shouldShowKnowledgeScope } from '../src/client/session-visibility.js'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('knowledge scope is visible only for the parent conversation', () => {
  assert.equal(shouldShowKnowledgeScope(null), true)
  assert.equal(isChildConversation(null), false)
  for (const subagent of [
    { address: { mode: 'one-shot' }, parentAvailable: true },
    { address: { mode: 'continuable' }, parentAvailable: true },
    { address: { mode: 'one-shot' }, parentAvailable: false },
    { address: { mode: 'continuable' }, parentAvailable: false },
  ]) {
    assert.equal(isChildConversation(subagent), true)
    assert.equal(shouldShowKnowledgeScope(subagent), false)
  }
})

test('declares an out-of-tree scope plugin against public composer contracts only', async () => {
  await access(new URL('package.json', root))
  const [manifest, client] = await Promise.all([source('package.json'), source('src/client/index.ts')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-knowledge-scope"/)
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})

test('routes the compact pmd-prd Ask card through the public question and explicit overlay seams', async () => {
  const [manifest, client, card, seam] = await Promise.all([
    source('package.json'),
    source('src/client/index.ts'),
    source('src/client/SourceScopeQuestion.tsx'),
    readFile(new URL('../../../upstream-contributions/0009-composer-overlay-and-preset-presentation.patch', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@deepseek-ai\/dsh-client-runtime/)
  assert.match(client, /name: 'conversation\.composer', priority: -1/)
  assert.match(client, /sourceScopeQuestion\(item\.payload\.questions\)/)
  assert.match(card, /repositoryOverlay\.show\(\)/)
  assert.doesNotMatch(card, /repositoryOverlay\.toggle\(\)/)
  assert.doesNotMatch(card, /dsh-client-ui-user-questions/)
  assert.match(card, /hasSelectedSources\(scope\)/)
  assert.match(card, /SKIP_REMOTE_SOURCES_OPTION/)
  assert.match(seam, /show\(id: string\): void/)
  assert.match(seam, /show: \(\) => \{ api\?\.show\(id\) \}/)
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
  const [control, styles, sidepanel] = await Promise.all([
    readFile(new URL('../src/client/KnowledgeScope.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/KnowledgeScope.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8'),
  ])

  assert.equal(control.match(/useSession\(s => s\.subagent\)/g)?.length, 2)
  assert.match(control, /KnowledgeScopeStrip\(\{ session, useSession, useKnowledgeScope, request \}/)
  assert.match(control, /if \(shouldShowKnowledgeScope\(subagent\)\) request\(sessionId\)/)
  assert.match(control, /serviceState === 'ready' && snapshot\?\.notice/)
  assert.match(control, /role="status"/)
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
  assert.match(styles, /\.panel\s*\{[^}]*left:\s*50%[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*width:\s*min\(100%, var\(--dsh-composer-card-max-width\)\)[^}]*max-height:\s*calc\(100dvh - 140px\)[^}]*overflow:\s*hidden[^}]*padding:\s*8px 12px[^}]*transform:\s*translateX\(-50%\)/s)
  assert.match(styles, /\.panelHeader\s*\{[^}]*flex:\s*none[^}]*margin-bottom:\s*4px/s)
  assert.match(styles, /\.section\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*padding-top:\s*4px/s)
  assert.match(styles, /\.sectionHint\s*\{[^}]*margin:\s*0 0 6px/s)
  assert.match(control, /className=\{`\$\{css\.tree\} \$\{css\.knowledgeTree\}`\}/)
  assert.match(styles, /\.knowledgeTree\s*\{[^}]*gap:\s*0/s)
  assert.match(styles, /\.option\s*\{[^}]*font-size:\s*13px/s)
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
  assert.match(styles, /\.switchWrap::before\s*\{[^}]*bottom:\s*100%[^}]*height:\s*6px/s)
  assert.match(control, /optimisticScopeSwitch/)
  assert.match(control, /acknowledgeScopeSwitch/)
  assert.match(sidepanel, /knowledgeRequestSequenceBySessionRef\.current\.get\(sessionId\) !== requestSequence\) return/)
  assert.match(sidepanel, /knowledgeRequestSequenceBySessionRef\.current\.set\(value\.sessionId, value\.sequence\)/)
})

test('background preserves a saved V1 domain and serializes selected systems by category for retrieval', async () => {
  const background = await readFile(new URL('../../../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(background, /scope\.domainId === '' \|\| scope\.systemIds\.length === 0 \? \{\} : \{ \[scope\.domainId\]: \[\.\.\.new Set\(scope\.systemIds\)\] \}/)
  assert.match(background, /Object\.entries\(scope\.domainSystems\)\.map\(\(\[domainId, systems\]\) => \[domainId, \{ self: false, systems \}\]\)/)
})
