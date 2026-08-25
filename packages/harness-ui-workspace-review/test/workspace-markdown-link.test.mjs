import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceMarkdownLink } from '../src/client/workspace-markdown-link.mjs'

test('resolves relative and same-workspace absolute Markdown conversation links', () => {
  assert.equal(workspaceMarkdownLink('/work/project', 'docs/guide.md'), 'docs/guide.md')
  assert.equal(workspaceMarkdownLink('/work/project', './docs/My%20Guide.markdown#intro'), 'docs/My Guide.markdown')
  assert.equal(workspaceMarkdownLink('/work/project', '/work/project/README.md?raw=1'), 'README.md')
  assert.equal(workspaceMarkdownLink('C:\\work\\project', 'C:\\work\\project\\docs\\guide.md'), 'docs/guide.md')
})

test('leaves external, non-Markdown, and escaping links to the official fallback', () => {
  for (const href of ['https://example.com/a.md', '../secret.md', '/work/other/a.md', 'docs/file.txt', '#section', 'docs/%ZZ.md']) {
    assert.equal(workspaceMarkdownLink('/work/project', href), undefined)
  }
})
