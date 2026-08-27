import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS,
  DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES,
  classifyDocuments,
  documentDraftLine,
  documentKindOf,
} from '../src/formats.mjs'
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

test('does not leave a persistent success notice after a document upload', async () => {
  const intake = await source('src/client/intake.ts')
  // The draft already carries the actionable upload feedback. A success
  // input notice is persistent in the stock composer, so it would survive
  // the send and leave the attachment bar behind; failures must still notify.
  assert.doesNotMatch(intake, /input\.notify\('info'/)
  assert.match(intake, /input\?\.notify\('error'/)
})

test('uses the public Harness paperclip icon and composer toolbar geometry', async () => {
  const [manifest, control, intake, styles] = await Promise.all([
    source('package.json'),
    source('src/client/AttachDocumentControl.tsx'),
    source('src/client/intake.ts'),
    source('src/client/AttachDocumentControl.module.css'),
  ])
  assert.match(manifest, /"@deepseek-ai\/dsh-client-ui-primitives"/)
  assert.match(control, /from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(control, /<IconPaperclipOutline16 size=\{14\} \/>/)
  assert.match(intake, /DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS/)
  assert.match(intake, /DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES/)
  assert.match(control, /accept=\{ACCEPT\}/)
  assert.doesNotMatch(control, /📎|paperclip\s*=/i)
  assert.match(styles, /\.trigger\s*\{[\s\S]*display:\s*grid[\s\S]*width:\s*28px[\s\S]*height:\s*28px[\s\S]*border:\s*none[\s\S]*border-radius:\s*999px[\s\S]*background:\s*var\(--dsw-specific-selector\)[\s\S]*color:\s*var\(--dsw-alias-label-primary\)/)
  assert.match(styles, /\.trigger:hover\s*\{[\s\S]*background:\s*var\(--dsw-alias-interactive-bg-hover-solid\)/)
})

test('classifies office and common text documents, including JSON and JSONL, and refuses other files', () => {
  assert.equal(documentKindOf('brief.docx', ''), 'docx')
  assert.equal(documentKindOf('slides.pptx', ''), 'pptx')
  assert.equal(documentKindOf('sheet.xlsx', ''), 'xlsx')
  assert.equal(documentKindOf('paper.pdf', 'application/pdf'), 'pdf')
  assert.equal(documentKindOf('notes.markdown', ''), 'md')
  assert.equal(documentKindOf('readme.txt', 'text/plain'), 'txt')
  assert.equal(documentKindOf('data.json', 'application/json'), 'txt')
  assert.equal(documentKindOf('events.jsonl', 'application/x-ndjson'), 'txt')
  assert.equal(documentKindOf('notebook.ipynb', 'application/json'), 'txt')
  assert.equal(documentKindOf('settings.yaml', ''), 'txt')
  assert.equal(documentKindOf('app.properties', ''), 'txt')
  assert.equal(documentKindOf('build.gradle', ''), 'txt')
  assert.equal(documentKindOf('schema.proto', ''), 'txt')
  assert.equal(documentKindOf('package.lock', ''), 'txt')
  assert.equal(documentKindOf('change.patch', ''), 'txt')
  assert.equal(documentKindOf('.gitignore', ''), 'txt')
  assert.equal(documentKindOf('.editorconfig', ''), 'txt')
  assert.equal(documentKindOf('README', 'text/plain'), 'txt')
  assert.equal(documentKindOf('Makefile', 'text/plain'), 'txt')
  assert.equal(documentKindOf('Dockerfile', 'text/plain'), 'txt')
  assert.equal(documentKindOf('component.tsx', ''), 'txt')
  assert.equal(documentKindOf('virus.exe', 'text/plain'), undefined)
  assert.ok(DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS.includes('.jsonl'))
  assert.ok(DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS.includes('.ipynb'))
  assert.ok(DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES.includes('application/json'))
  assert.equal(documentKindOf('photo.png', 'image/png'), undefined)
  assert.equal(classifyDocuments([]), '没有可附加的文档')
  assert.match(classifyDocuments([{ name: 'virus.exe', type: '', size: 12 }]) ?? '', /暂不支持 virus\.exe/)
  assert.match(classifyDocuments([{ name: 'huge.pdf', type: 'application/pdf', size: 33 * 1024 * 1024 }]) ?? '', /超过 32MB/)
  assert.equal(classifyDocuments([{ name: 'ok.pdf', type: 'application/pdf', size: 12 }]), null)
  assert.equal(classifyDocuments([{ name: 'data.json', type: 'application/json', size: 12 }]), null)
  assert.equal(classifyDocuments([{ name: 'events.jsonl', type: 'application/x-ndjson', size: 12 }]), null)
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
  await assert.rejects(
    saveSessionDocuments(cwd, [{ name: 'not-text.json', mediaType: 'application/json', bytes: new Uint8Array([0, 159, 146, 150]) }]),
    /not valid UTF-8 text/,
  )
})
