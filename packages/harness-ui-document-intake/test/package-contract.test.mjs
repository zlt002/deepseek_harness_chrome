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
import { documentSubmissionPrompt, PendingDocuments } from '../src/client/pending-documents.mjs'

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
  // A success notice is persistent in the stock composer, so it would survive
  // the send and leave an obsolete attachment bar behind; failures must still notify.
  assert.doesNotMatch(intake, /input\.notify\('info'/)
  assert.match(intake, /input\?\.notify\('error'/)
})

test('keeps uploaded document instructions out of the visible draft and delivers them through the submit transform', async () => {
  const [client, intake] = await Promise.all([
    source('src/client/index.ts'),
    source('src/client/intake.ts'),
  ])
  assert.match(client, /composerSubmissionTransforms/)
  assert.match(client, /id: 'document-intake'/)
  assert.match(intake, /documents\.resolve\(sessionId, ids, body\.files\)/)
  assert.doesNotMatch(intake, /setDraft\(/)
})

test('renders session documents as composer-adjacent removable cards instead of silently hiding them', async () => {
  const [client, strip, styles] = await Promise.all([
    source('src/client/index.ts'),
    source('src/client/DocumentAttachmentStrip.tsx'),
    source('src/client/DocumentAttachmentStrip.module.css'),
  ])
  assert.match(client, /conversation\.composer\.above/)
  assert.match(client, /id: 'accrui-document-intake-strip',[\s\S]*order: 30/)
  assert.match(client, /DocumentAttachmentStrip/)
  assert.match(strip, /useSyncExternalStore/)
  assert.match(strip, /documents\.remove\(sessionId, file\.id\)/)
  assert.match(strip, /正在添加/)
  assert.match(strip, /添加失败/)
  assert.match(styles, /\.card\s*\{[\s\S]*min-width:\s*156px[\s\S]*min-height:\s*48px[\s\S]*border-radius:\s*12px/)
  assert.match(styles, /\.icon\s*\{[\s\S]*width:\s*32px[\s\S]*height:\s*32px/)
  assert.match(styles, /\.remove\s*\{[\s\S]*width:\s*18px[\s\S]*height:\s*18px/)
  assert.match(styles, /--dsw-alias-button-contrast-fill/)
  assert.doesNotMatch(styles, /button-contrast-hover/)
})

test('accumulates single and multi-select uploads for one hidden submission and clears only accepted files', () => {
  const documents = new PendingDocuments()
  documents.add('session-1', [
    { relativePath: '.dsh-uploads/first.txt', kind: 'txt' },
    { relativePath: '.dsh-uploads/second.md', kind: 'md' },
  ])
  documents.add('session-1', [
    { relativePath: '.dsh-uploads/third.pdf', kind: 'pdf' },
  ])
  const submitted = documents.snapshot('session-1')
  const prompt = documentSubmissionPrompt('请比较这些文件', submitted)
  assert.match(prompt, /first\.txt/)
  assert.match(prompt, /second\.md/)
  assert.match(prompt, /third\.pdf/)
  assert.equal(documents.availability('session-1').getSnapshot(), true)

  documents.add('session-1', [{ relativePath: '.dsh-uploads/during-send.xlsx', kind: 'xlsx' }])
  documents.accept('session-1', submitted.map(file => file.id))
  assert.deepEqual(documents.snapshot('session-1').map(file => file.relativePath), ['.dsh-uploads/during-send.xlsx'])

  documents.add('session-2', [{ relativePath: '.dsh-uploads/only.md', kind: 'md' }])
  const single = documents.snapshot('session-2')
  assert.match(documentSubmissionPrompt('', single), /only\.md/)
  documents.accept('session-2', single.map(file => file.id))
  assert.equal(documents.availability('session-2').getSnapshot(), false)
})

test('keeps upload progress and failures visible, excludes removed files from the hidden submission, and clears accepted cards', () => {
  const documents = new PendingDocuments()
  const [first, second] = documents.begin('session-1', [
    { name: 'events.jsonl', size: 120 },
    { name: 'broken.json', size: 48 },
  ])
  assert.deepEqual(documents.snapshot('session-1').map(file => file.status), ['uploading', 'uploading'])

  documents.resolve('session-1', [first.id], [{ name: 'events.jsonl', relativePath: '.dsh-uploads/events.jsonl', kind: 'txt' }])
  documents.fail('session-1', [second.id], new Error('网络中断'))
  assert.deepEqual(documents.ready('session-1').map(file => file.name), ['events.jsonl'])
  assert.equal(documents.snapshot('session-1')[1]?.status, 'error')
  assert.match(documents.snapshot('session-1')[1]?.error ?? '', /网络中断/)

  documents.remove('session-1', first.id)
  assert.equal(documentSubmissionPrompt('', documents.ready('session-1')), '')
  assert.equal(documents.availability('session-1').getSnapshot(), false)

  const [accepted] = documents.begin('session-1', [{ name: 'brief.md', size: 21 }])
  documents.resolve('session-1', [accepted.id], [{ name: 'brief.md', relativePath: '.dsh-uploads/brief.md', kind: 'md' }])
  const submitting = documents.ready('session-1')
  assert.match(documentSubmissionPrompt('', submitting), /brief\.md/)
  documents.accept('session-1', submitting.map(file => file.id))
  assert.equal(documents.snapshot('session-1').length, 1)
  assert.equal(documents.snapshot('session-1')[0]?.status, 'error')
})

test('keeps the empty session snapshot referentially stable for React subscriptions', () => {
  const documents = new PendingDocuments()

  assert.strictEqual(documents.snapshot('missing-session'), documents.snapshot('missing-session'))
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
