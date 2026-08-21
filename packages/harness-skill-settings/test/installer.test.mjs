import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'
import { SKILL_INSTALL_MAX_FILE_BYTES, deleteInstalledSkill, installSkill, waitForInstalledSkill, waitForRemovedSkill } from '../src/installer.mjs'

const encode = (text) => new TextEncoder().encode(text)
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const skill = (name = 'safe-skill') => `---\nname: ${name}\ndescription: 安全的测试技能\n---\n# ${name}\n`

test('installs one validated folder into a name-owned skill directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await installSkill(root, { kind: 'folder', files: [
    { path: 'SKILL.md', data: b64(encode(skill())) },
    { path: 'references/checklist.md', data: b64(encode('check')) },
  ] })
  assert.deepEqual(result, { name: 'safe-skill', description: '安全的测试技能' })
  assert.equal(await readFile(join(root, 'safe-skill', 'SKILL.md'), 'utf8'), skill())
  assert.equal(await readFile(join(root, 'safe-skill', 'references', 'checklist.md'), 'utf8'), 'check')
})

test('rejects traversal, multiple roots, invalid names, and collisions without replacing data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(installSkill(root, { kind: 'folder', files: [{ path: '../SKILL.md', data: b64(encode(skill())) }] }), /路径不安全/)
  await assert.rejects(installSkill(root, { kind: 'folder', files: [
    { path: 'a/SKILL.md', data: b64(encode(skill())) }, { path: 'b/extra.md', data: b64(encode('x')) },
  ] }), /同一个技能根目录/)
  await assert.rejects(installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(skill('Bad_Name'))) }] }), /kebab-case/)
  await assert.rejects(installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode('---\nname: valid-skill\ndescription: [\n---\n')) }] }), /frontmatter 无效/)
  await assert.rejects(installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(skill('reserved-marker-skill'))) }, { path: '.accrui-installed-skill.json', data: b64(encode('{}')) }] }), /保留文件/)
  await installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(skill())) }] })
  await writeFile(join(root, 'safe-skill', 'keep.txt'), 'keep')
  await assert.rejects(installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(skill())) }] }), /已存在，未覆盖/)
  assert.equal(await readFile(join(root, 'safe-skill', 'keep.txt'), 'utf8'), 'keep')
})

test('accepts a legal multiline YAML description before handing the skill to Harness discovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = '---\r\nname: multiline-skill\r\ndescription: |\r\n  这是多行\r\n  描述\r\n---\r\n# multiline\r\n'
  const result = await installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(manifest)) }] })
  assert.deepEqual(result, { name: 'multiline-skill', description: '这是多行\n描述' })
})

test('installs a stored ZIP and rejects zip-slip and symbolic-link entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = zip([{ path: 'archive-skill/SKILL.md', bytes: encode(skill('archive-skill')) }, { path: 'archive-skill/guide.md', bytes: encode('guide') }])
  assert.deepEqual(await installSkill(root, { kind: 'zip', data: b64(archive) }), { name: 'archive-skill', description: '安全的测试技能' })
  assert.equal(await readFile(join(root, 'archive-skill', 'guide.md'), 'utf8'), 'guide')
  await assert.rejects(installSkill(root, { kind: 'zip', data: b64(zip([{ path: '../SKILL.md', bytes: encode(skill()) }])) }), /路径不安全/)
  await assert.rejects(installSkill(root, { kind: 'zip', data: b64(zip([{ path: 'link', bytes: encode('x'), mode: 0o120777 }])) }), /符号链接/)
})

test('bounds deflate output before trusting archive size metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bomb = new Uint8Array(deflateRawSync(Buffer.alloc(SKILL_INSTALL_MAX_FILE_BYTES + 1, 0)))
  const archive = zip([{ path: 'bomb-skill/SKILL.md', bytes: bomb, compressed: true, uncompressedSize: 1 }])
  await assert.rejects(installSkill(root, { kind: 'zip', data: b64(archive) }))
})

test('waits for the Host registry to discover the installed name and fails within a bound', async () => {
  let reads = 0
  await waitForInstalledSkill('eventual-skill', async () => {
    reads += 1
    return reads === 3 ? [{ name: 'eventual-skill' }] : []
  }, '/workspace', { attempts: 3, delayMs: 0 })
  assert.equal(reads, 3)
  await assert.rejects(waitForInstalledSkill('missing-skill', async () => [], '/workspace', { attempts: 2, delayMs: 0 }), /限定时间内发现/)
})

test('deletes only a real product-managed name directory and waits for the registry to lose it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-delete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await installSkill(root, { kind: 'folder', files: [{ path: 'SKILL.md', data: b64(encode(skill('removable-skill'))) }] })

  assert.deepEqual(await deleteInstalledSkill(root, 'removable-skill'), { name: 'removable-skill' })
  await assert.rejects(lstat(join(root, 'removable-skill')), { code: 'ENOENT' })
  let reads = 0
  await waitForRemovedSkill('removable-skill', async () => {
    reads += 1
    return reads === 1 ? [{ name: 'removable-skill' }] : []
  }, '/workspace', { attempts: 2, delayMs: 0 })
  assert.equal(reads, 2)
  assert.deepEqual(await waitForRemovedSkill('shadowed-skill', async () => [{ name: 'shadowed-skill' }], '/workspace', { attempts: 1, delayMs: 0 }), { disappeared: false })
})

test('refuses deletion outside a product-managed directory without following links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accr-skill-delete-'))
  const outside = await mkdtemp(join(tmpdir(), 'accr-skill-outside-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await writeFile(join(outside, 'SKILL.md'), skill('outside-skill'))
  await symlink(outside, join(root, 'linked-skill'))
  await writeFile(join(root, 'not-a-directory'), 'not a skill')
  await mkdir(join(root, 'bundled-skill'))
  await writeFile(join(root, 'bundled-skill', 'SKILL.md'), skill('bundled-skill'))

  await assert.rejects(deleteInstalledSkill(root, '../outside-skill'), /name 必须是 kebab-case/)
  await assert.rejects(deleteInstalledSkill(root, 'linked-skill'), /符号链接/)
  await assert.rejects(deleteInstalledSkill(root, 'not-a-directory'), /不是产品管理的技能目录/)
  await assert.rejects(deleteInstalledSkill(root, 'bundled-skill'), /不是由本产品安装/)
  await assert.rejects(deleteInstalledSkill(root, 'missing-skill'), /不是产品安装的技能/)
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), skill('outside-skill'))
})

function zip(entries) {
  let offset = 0
  const locals = []
  const central = []
  for (const entry of entries) {
    const name = encode(entry.path)
    const method = entry.compressed === true ? 8 : 0
    const uncompressedSize = entry.uncompressedSize ?? entry.bytes.byteLength
    const local = concat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(entry.bytes.byteLength), u32(uncompressedSize), u16(name.byteLength), u16(0), name, entry.bytes])
    locals.push(local)
    central.push(concat([u32(0x02014b50), u16(3 << 8 | 20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(entry.bytes.byteLength), u32(uncompressedSize), u16(name.byteLength), u16(0), u16(0), u16(0), u16(0), u32((entry.mode ?? 0) << 16), u32(offset), name]))
    offset += local.byteLength
  }
  const directory = concat(central)
  return concat([...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.byteLength), u32(offset), u16(0)])
}

function concat(parts) { const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.byteLength } return result }
function u16(value) { return Uint8Array.of(value & 0xff, value >>> 8 & 0xff) }
function u32(value) { return Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff) }
