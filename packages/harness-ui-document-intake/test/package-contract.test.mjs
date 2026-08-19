import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classifyDocuments, documentDraftLine, documentKindOf } from '../src/formats.mjs'
import { saveSessionDocuments } from '../src/save.mjs'

const root = new URL('../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('declares an out-of-tree document intake plugin against public composer contracts only', async () => {
  const [manifest, host, client] = await Promise.all([
    source('package.json'),
    source('src/index.ts'),
    source('src/client/index.ts'),
  ])
  assert.match(manifest, /"name": "@accrui\/harness-ui-document-intake"/)
  assert.match(host, /kind: 'exact'/)
  assert.match(host, /\/api\/composer\.document/)
  assert.match(client, /composerFileIntake/)
  assert.match(client, /conversation\.input\.left/)
  assert.doesNotMatch(client, /deepseek-harness\/packages\/.*\/src/)
})

test('classifies office and text documents and refuses other files', () => {
  assert.equal(documentKindOf('brief.docx', ''), 'docx')
  assert.equal(documentKindOf('slides.pptx', ''), 'pptx')
  assert.equal(documentKindOf('sheet.xlsx', ''), 'xlsx')
  assert.equal(documentKindOf('paper.pdf', 'application/pdf'), 'pdf')
  assert.equal(documentKindOf('notes.markdown', ''), 'md')
  assert.equal(documentKindOf('readme.txt', 'text/plain'), 'txt')
  assert.equal(documentKindOf('photo.png', 'image/png'), undefined)
  assert.equal(classifyDocuments([]), '没有可附加的文档')
  assert.match(classifyDocuments([{ name: 'virus.exe', type: '', size: 12 }]) ?? '', /暂不支持 virus\.exe/)
  assert.match(classifyDocuments([{ name: 'huge.pdf', type: 'application/pdf', size: 33 * 1024 * 1024 }]) ?? '', /超过 32MB/)
  assert.equal(classifyDocuments([{ name: 'ok.pdf', type: 'application/pdf', size: 12 }]), null)
  assert.match(documentDraftLine('.dsh-uploads/brief.docx', 'docx'), /\/docx/)
  assert.match(documentDraftLine('.dsh-uploads/notes.md', 'md'), /请先读取该文件/)
})

test('writes classified documents under the session workspace and rejects escapes', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'accr-document-intake-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const saved = await saveSessionDocuments(cwd, [
    { name: 'brief.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: new Uint8Array([1, 2, 3]) },
    { name: '../escape.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('plain') },
  ])
  assert.equal(saved[0]?.relativePath, '.dsh-uploads/brief.docx')
  assert.equal(saved[0]?.skill, 'docx')
  assert.equal(saved[1]?.relativePath, '.dsh-uploads/escape.txt')
  assert.equal(saved[1]?.skill, undefined)
  const written = await readFile(join(cwd, '.dsh-uploads', 'brief.docx'))
  assert.deepEqual([...written], [1, 2, 3])
  await assert.rejects(
    saveSessionDocuments(cwd, [{ name: 'photo.png', mediaType: 'image/png', bytes: new Uint8Array([9]) }]),
    /unsupported document/,
  )
})
