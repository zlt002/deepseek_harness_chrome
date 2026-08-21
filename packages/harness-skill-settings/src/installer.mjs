import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'

const inflateRawAsync = promisify(inflateRaw)
export const SKILL_INSTALL_PATH = '/api/settings.skill.install'
export const SKILL_INSTALL_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
export const SKILL_INSTALL_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const SKILL_INSTALL_MAX_FILE_BYTES = 8 * 1024 * 1024
export const SKILL_INSTALL_MAX_FILES = 128

/** Install one browser-supplied ZIP or folder into the product-owned skill root. */
export async function installSkill(root, request) {
  const source = await sourceFiles(request)
  const skill = validateSkill(source)
  await writeSkill(resolve(root), skill)
  return { name: skill.name, description: skill.description }
}

async function sourceFiles(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('技能安装请求必须是对象')
  if (request.kind === 'zip') {
    if (typeof request.data !== 'string') throw new Error('技能压缩包缺少数据')
    const archive = decodeBase64(request.data, '技能压缩包')
    if (archive.byteLength > SKILL_INSTALL_MAX_ARCHIVE_BYTES) throw new Error('技能压缩包超过 16MB')
    return await unzip(archive)
  }
  if (request.kind === 'folder') {
    if (!Array.isArray(request.files)) throw new Error('技能文件夹缺少文件')
    return request.files.map((file) => {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.data !== 'string') {
        throw new Error('技能文件夹包含无效文件')
      }
      return { path: normalizePath(file.path), bytes: decodeBase64(file.data, `文件 ${file.path}`) }
    })
  }
  throw new Error('仅支持 ZIP 压缩包或技能文件夹')
}

async function unzip(archive) {
  const directory = centralDirectory(archive)
  if (directory.count > SKILL_INSTALL_MAX_FILES) throw new Error(`技能压缩包文件数量超过 ${String(SKILL_INSTALL_MAX_FILES)}`)
  const files = []
  let offset = directory.offset
  let total = 0
  for (let index = 0; index < directory.count; index += 1) {
    if (readU32(archive, offset) !== 0x02014b50) throw new Error('技能压缩包目录损坏')
    const madeBy = readU16(archive, offset + 4)
    const flags = readU16(archive, offset + 8)
    const method = readU16(archive, offset + 10)
    const compressedSize = readU32(archive, offset + 20)
    const uncompressedSize = readU32(archive, offset + 24)
    const nameLength = readU16(archive, offset + 28)
    const extraLength = readU16(archive, offset + 30)
    const commentLength = readU16(archive, offset + 32)
    const externalAttributes = readU32(archive, offset + 38)
    const localOffset = readU32(archive, offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd + extraLength + commentLength > archive.byteLength) throw new Error('技能压缩包目录越界')
    const path = decodeName(archive.subarray(offset + 46, nameEnd))
    offset = nameEnd + extraLength + commentLength
    if (path.endsWith('/')) continue
    const normalized = normalizePath(path)
    if ((madeBy >>> 8) === 3 && ((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`技能压缩包不允许符号链接：${normalized}`)
    }
    if ((flags & 1) !== 0) throw new Error(`技能压缩包不支持加密文件：${normalized}`)
    if (compressedSize > SKILL_INSTALL_MAX_ARCHIVE_BYTES || uncompressedSize > SKILL_INSTALL_MAX_FILE_BYTES) {
      throw new Error(`技能文件过大：${normalized}`)
    }
    total += uncompressedSize
    if (total > SKILL_INSTALL_MAX_TOTAL_BYTES) throw new Error('技能解包后超过 32MB')
    files.push({ path: normalized, bytes: await unzipEntry(archive, localOffset, compressedSize, uncompressedSize, method, normalized) })
  }
  return files
}

async function unzipEntry(archive, offset, compressedSize, uncompressedSize, method, path) {
  if (readU32(archive, offset) !== 0x04034b50) throw new Error(`技能压缩包本地条目损坏：${path}`)
  const nameLength = readU16(archive, offset + 26)
  const extraLength = readU16(archive, offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + compressedSize
  if (end > archive.byteLength) throw new Error(`技能压缩包文件越界：${path}`)
  const compressed = archive.subarray(start, end)
  let bytes
  if (method === 0) bytes = compressed
  else if (method === 8) bytes = new Uint8Array(await inflateRawAsync(compressed, { maxOutputLength: SKILL_INSTALL_MAX_FILE_BYTES }))
  else throw new Error(`技能压缩包不支持该压缩方式：${path}`)
  if (bytes.byteLength !== uncompressedSize || bytes.byteLength > SKILL_INSTALL_MAX_FILE_BYTES) {
    throw new Error(`技能文件大小异常：${path}`)
  }
  return bytes
}

/** Wait for the same Host Skill Registry view that serves a session to discover one installed name. */
export async function waitForInstalledSkill(name, list, cwd, { attempts = 20, delayMs = 100 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await list({ cwd })).some(skill => skill.name === name)) return
    } catch (error) { lastError = error }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`Harness 未在限定时间内发现 /${name}${detail}`)
}

function centralDirectory(archive) {
  const minimum = 22
  if (archive.byteLength < minimum) throw new Error('不是有效的 ZIP 压缩包')
  const start = Math.max(0, archive.byteLength - minimum - 0xffff)
  for (let offset = archive.byteLength - minimum; offset >= start; offset -= 1) {
    if (readU32(archive, offset) !== 0x06054b50) continue
    const count = readU16(archive, offset + 10)
    const size = readU32(archive, offset + 12)
    const directoryOffset = readU32(archive, offset + 16)
    if (count === 0xffff || size === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('技能压缩包不支持 ZIP64')
    if (directoryOffset + size > archive.byteLength) throw new Error('技能压缩包目录越界')
    return { count, offset: directoryOffset }
  }
  throw new Error('不是有效的 ZIP 压缩包')
}

function validateSkill(files) {
  if (files.length === 0) throw new Error('技能包为空')
  if (files.length > SKILL_INSTALL_MAX_FILES) throw new Error(`技能文件数量超过 ${String(SKILL_INSTALL_MAX_FILES)}`)
  const seen = new Set()
  let total = 0
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`技能包包含重复文件：${file.path}`)
    seen.add(file.path)
    if (file.bytes.byteLength > SKILL_INSTALL_MAX_FILE_BYTES) throw new Error(`技能文件过大：${file.path}`)
    total += file.bytes.byteLength
  }
  if (total > SKILL_INSTALL_MAX_TOTAL_BYTES) throw new Error('技能总大小超过 32MB')
  const skillFiles = files.filter((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
  if (skillFiles.length !== 1) throw new Error('技能包必须且只能包含一个 SKILL.md')
  const manifest = skillFiles[0]
  const root = manifest.path === 'SKILL.md' ? '' : manifest.path.slice(0, -'/SKILL.md'.length)
  for (const file of files) {
    if (root !== '' && !(file.path === root || file.path.startsWith(`${root}/`))) {
      throw new Error('技能包只能包含同一个技能根目录')
    }
  }
  const metadata = parseSkillFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes))
  return { ...metadata, files: files.map(file => ({ path: root === '' ? file.path : file.path.slice(root.length + 1), bytes: file.bytes })) }
}

function parseSkillFrontmatter(text) {
  const start = text.startsWith('---\r\n') ? 5 : text.startsWith('---\n') ? 4 : -1
  const closing = start < 0 ? -1 : text.indexOf('\n---', start)
  if (closing < 0) throw new Error('SKILL.md 缺少 YAML frontmatter')
  let fields
  try { fields = loadYaml(text.slice(start, closing)) } catch (error) { throw new Error(`SKILL.md frontmatter 无效：${error instanceof Error ? error.message : String(error)}`) }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('SKILL.md frontmatter 必须是对象')
  const name = fields.name
  const description = fields.description
  if (typeof name !== 'string' || name.trim() === '' || typeof description !== 'string' || description.trim() === '') {
    throw new Error('SKILL.md frontmatter 必须包含 name 和 description')
  }
  const normalizedName = name.trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalizedName)) throw new Error(`SKILL.md 的 name 必须是 kebab-case：${normalizedName}`)
  return { name: normalizedName, description: description.trim() }
}

async function writeSkill(root, skill) {
  await mkdir(root, { recursive: true })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('产品技能根目录不可用')
  const destination = join(root, skill.name)
  assertInside(root, destination)
  try { await lstat(destination); throw new Error(`技能 /${skill.name} 已存在，未覆盖。请先删除或更名后重试。`) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const lockPath = join(root, `.${skill.name}.install.lock`)
  let lock
  try { lock = await open(lockPath, 'wx') } catch (error) { throw new Error(`技能 /${skill.name} 正在安装，请稍后重试`) }
  const staging = join(root, `.${skill.name}.install-${process.pid}-${Date.now()}`)
  try {
    await mkdir(staging)
    for (const file of skill.files) {
      const target = join(staging, file.path)
      assertInside(staging, target)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.bytes, { flag: 'wx' })
    }
    try { await lstat(destination); throw new Error(`技能 /${skill.name} 已存在，未覆盖。请先删除或更名后重试。`) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await rename(staging, destination)
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

function normalizePath(value) {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new Error(`技能文件路径不安全：${value}`)
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`技能文件路径不安全：${value}`)
  return parts.join('/')
}

function assertInside(root, target) {
  const path = relative(root, target)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || path.includes(`${sep}..${sep}`)) throw new Error('技能安装路径越界')
}

function decodeBase64(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label}不是有效的 base64 数据`)
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function decodeName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('技能压缩包文件名不是 UTF-8') }
}

function readU16(bytes, offset) {
  if (offset + 2 > bytes.byteLength) throw new Error('技能压缩包损坏')
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.byteLength) throw new Error('技能压缩包损坏')
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0
}
