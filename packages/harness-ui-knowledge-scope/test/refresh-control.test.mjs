import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('both scope panels refresh the authorized catalog once and expose the request state', async () => {
  const [control, styles] = await Promise.all([
    source('src/client/KnowledgeScope.tsx'),
    source('src/client/KnowledgeScope.module.css'),
  ])

  assert.match(control, /const \[refreshRequestSequence, setRefreshRequestSequence\] = useState<number \| undefined>\(undefined\)/)
  assert.match(control, /setRefreshRequestSequence\(request\(id, undefined, \{ action: 'retry' \}\)\)/)
  assert.match(control, /\(snapshot\.requestSequence \?\? 0\) >= refreshRequestSequence/)
  assert.match(control, /disabled=\{refreshing\}/)
  assert.match(control, /aria-busy=\{refreshing\}/)
  assert.match(control, /正在刷新…/)
  assert.match(control, /刷新\$\{label\}/)
  assert.match(control, /section === 'knowledge' \? '知识库范围' : '代码库范围'/)
  assert.match(styles, /\.refreshIconBusy\s*\{[^}]*animation:\s*scopeRefresh 1s linear infinite/s)
})

test('the scope chooser keeps the backend failure message visible', async () => {
  const control = await source('src/client/KnowledgeScope.tsx')
  assert.match(control, /snapshot\?\.error !== undefined && <p className=\{css\.error\} role="alert">\{snapshot\.error\}<\/p>/)
})
