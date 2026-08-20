import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('keeps message annotation UI and prompt enrichment in an out-of-tree product plugin', async () => {
  const [manifest, client, view, seam, selectionSeam, close] = await Promise.all([
    source('../package.json'),
    source('../src/client/index.ts'),
    source('../src/client/MessageAnnotations.tsx'),
    source('../../../upstream-contributions/0017-composer-submission-transforms.patch'),
    source('../../../upstream-contributions/0018-assistant-message-selection-marker.patch'),
    source('../src/client/popover-close.js'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-message-annotations/)
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /conversation\.input\.overlay/)
  assert.match(client, /composerSubmissionTransforms/)
  assert.match(client, /accept: \(\) => annotations\.accept/)
  assert.match(view, /添加批注/)
  assert.match(view, /selectionchange/)
  assert.match(view, /pointerdown/)
  assert.match(close, /Escape/)
  assert.match(view, /assistantMessageIdForRange/)
  assert.match(view, /popoverPosition/)
  assert.match(view, /保存批注/)
  assert.match(view, /删除第/)
  assert.match(seam, /ComposerSubmissionTransforms/)
  assert.match(selectionSeam, /data-assistant-message-id/)
  assert.doesNotMatch(`${client}\n${view}`, /deepseek-harness\/packages\/.*\/src/)
})

test('renders the selection popover through a page-level portal instead of the composer overlay stacking context', async () => {
  const view = await source('../src/client/MessageAnnotations.tsx')
  assert.match(view, /createPortal\(/)
  assert.match(view, /popoverPortalHost\(document\)/)
})
