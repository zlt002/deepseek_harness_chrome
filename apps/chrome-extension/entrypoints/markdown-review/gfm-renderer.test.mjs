import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

test('the preview renderer emits GFM tables while leaving raw HTML inert', () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSanitize],
  }, '| Owner | Status |\n| --- | --- |\n| Ada | ready |\n\n<script>window.bad = true</script>'))

  assert.match(html, /<table>/)
  assert.match(html, /<th>Owner<\/th>/)
  assert.match(html, /<td>ready<\/td>/)
  assert.doesNotMatch(html, /window\.bad/)
})
