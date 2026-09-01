import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path, { dirname } from 'node:path'

export const ACCRUI_EXTENSION_ID = 'cmgjacoohdgjedoekbdbhbelpmboankg'
const REQUIRED_OUTER = ['install.ps1', 'install.vbs', 'install-ui.ps1', 'payload.zip']

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function compareVersion(left, right) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`更新包版本必须是三段式 x.y.z，收到 ${String(value)}`)
    return value.split('.').map(Number)
  }
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

function entries(bytes) {
  let eocd = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break }
  }
  if (eocd < 0) throw new Error('更新包不是有效 ZIP：缺少目录记录')
  const count = bytes.readUInt16LE(eocd + 10); let offset = bytes.readUInt32LE(eocd + 16); const output = new Map()
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('更新包 ZIP 目录损坏')
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10)
    const compressed = bytes.readUInt32LE(offset + 20); const uncompressed = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32); const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/')
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`更新包包含不安全 ZIP 路径：${name}`)
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error(`更新包 ZIP 条目不受支持：${name}`)
    output.set(name, { name, method, compressed, uncompressed, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return output
}

export function zipEntries(bytes) { return [...entries(bytes).keys()] }

function commonRoot(names, expectedPath) {
  const roots = new Set(names.map(name => name.split('/')[0]).filter(Boolean))
  if (roots.size !== 1) return ''
  const root = [...roots][0]
  return names.includes(`${root}/${expectedPath}`) ? `${root}/` : ''
}

function packageEntryName(bytes, name) {
  const names = zipEntries(bytes)
  const root = commonRoot(names, name)
  return root ? `${root}${name}` : name
}

export function readZipEntry(bytes, name) {
  const entry = entries(bytes).get(name)
  if (entry === undefined) throw new Error(`更新包缺少 ${name}`)
  const offset = entry.localOffset
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error(`更新包 ZIP 本地记录损坏：${name}`)
  const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28)
  const packed = bytes.subarray(start, start + entry.compressed)
  if (packed.length !== entry.compressed) throw new Error(`更新包 ZIP 条目被截断：${name}`)
  const result = entry.method === 0 ? packed : inflateRawSync(packed)
  if (result.length !== entry.uncompressed) throw new Error(`更新包 ZIP 条目长度不匹配：${name}`)
  return result
}

export function resolveExtractionTarget(destination, name, pathApi = path) {
  const root = pathApi.resolve(destination)
  const target = pathApi.resolve(root, name)
  const relativeTarget = pathApi.relative(root, target)
  if (
    relativeTarget === ''
    || relativeTarget === '..'
    || relativeTarget.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relativeTarget)
  ) throw new Error(`更新包解压目标不安全：${name}`)
  return target
}

export async function extractZip(bytes, destination, { stripCommonRoot = false } = {}) {
  const names = zipEntries(bytes); const root = stripCommonRoot ? commonRoot(names, 'install.ps1') : ''
  for (const originalName of names) {
    const name = root && originalName.startsWith(root) ? originalName.slice(root.length) : originalName
    if (name.endsWith('/')) continue
    const target = resolveExtractionTarget(destination, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, readZipEntry(bytes, originalName))
  }
}

export function verifyWindowsLitePackage(bytes, { currentVersion, expectedSha256, expectedVersion } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new Error('更新包内容无效')
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) throw new Error('更新源包含无效 SHA256')
  const digest = sha256(bytes)
  if (expectedSha256 !== undefined && expectedSha256 !== digest) throw new Error(`更新包 SHA256 不匹配：预期 ${expectedSha256}，实际 ${digest}`)
  const outerNames = zipEntries(bytes); const root = commonRoot(outerNames, 'install.ps1')
  const outer = new Set(outerNames.map(name => root && name.startsWith(root) ? name.slice(root.length) : name)); const missing = REQUIRED_OUTER.filter(name => !outer.has(name))
  if (missing.length > 0) throw new Error(`更新包结构不完整：缺少 ${missing.join(', ')}`)
  const payload = readZipEntry(bytes, packageEntryName(bytes, 'payload.zip'))
  const manifest = JSON.parse(readZipEntry(payload, 'extension/manifest.json').toString('utf8'))
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) throw new Error('更新包扩展 manifest 缺少固定身份 key')
  if (manifest.version === undefined || typeof manifest.version !== 'string') throw new Error('更新包扩展 manifest 缺少版本')
  compareVersion(manifest.version, manifest.version)
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) throw new Error(`更新包版本不匹配：版本 manifest 为 ${expectedVersion}，更新包为 ${manifest.version}`)
  const actualId = extensionId(manifest.key)
  if (actualId !== ACCRUI_EXTENSION_ID) throw new Error(`更新包扩展身份不匹配：${actualId}`)
  if (currentVersion !== undefined && compareVersion(manifest.version, currentVersion) <= 0) throw new Error(`更新包版本 ${manifest.version} 未高于当前版本 ${currentVersion}`)
  return { sha256: digest, version: manifest.version, extensionId: ACCRUI_EXTENSION_ID }
}

function extensionId(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest()
  return [...digest.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0').replace(/[0-9a-f]/g, char => String.fromCharCode(97 + Number.parseInt(char, 16)))).join('')
}
