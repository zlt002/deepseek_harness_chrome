import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

test('keeps the e327 compact picker in an out-of-tree public workspace seat', async () => {
  const [client, picker, css] = await Promise.all([
    read('src/client/index.ts'), read('src/client/CompactWorkspacePicker.tsx'), read('src/client/CompactWorkspacePicker.module.css'),
  ])
  assert.match(client, /sidebar\.workspaces\.compact/)
  assert.match(picker, /requestWorkspaceAdd/)
  assert.match(picker, /owner\.directoryFlow/)
  assert.match(picker, /document\.addEventListener\('pointerdown'/)
  assert.match(picker, /event\.key === 'Escape'/)
  assert.match(picker, /function classes\(/)
  assert.doesNotMatch(picker, /from 'clsx'/)
  assert.match(css, /grid-template-columns: minmax\(130px, 0\.8fr\) minmax\(180px, 1\.2fr\)/)
  assert.match(css, /@media \(max-width: 360px\)/)
})
