import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import test from 'node:test'
import { resolveExtractionTarget, verifyWindowsLitePackage } from '../apps/native-server/src/release-update/package-verifier.mjs'

function zip(files) {
  const locals = []; const central = []; let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const path = Buffer.from(name); const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(path.length, 26)
    locals.push(local, path, bytes)
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(path.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(directory, path); offset += local.length + path.length + bytes.length
  }
  const directoryBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directoryBytes, end])
}

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtjVzlR9cE9zV44l999YtraoKbQ77NfaFgwJmpeABPL2HxUK82pD0DFRSv/7FfZ4nEZRDlgZz1zj1yIF4HLnftCZyf/xYIrwhXDojQfYULE8miIGufKEJf/IUBkpFdFKHgfKgowV0M72wNzqaYd27MdR6DczCR5PQKwi5G2JKUJxx4xc2+KD3GOUjpE8DrhzliD3gYcwEZ8lphtOuCUIx5kI97etKEiixqrwFGRoUbHFLXT14+Fqg7jmSu/HaUVWbl/Dx1VbI1hgVZdnJI//UJY+T0qMLV8hcfHPpwBum0lf1rfP+FQwnqoV2wf4k+6f70dE/Xrlckddpkl0IWDSEdwIDAQAB'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('accepts the published Windows Lite common-root archive only when identity and version advance', () => {
  const payload = zip({ 'extension/manifest.json': JSON.stringify({ key: KEY, version: '1.1.76' }) })
  const archive = zip({
    'accr-ui-windows-lite-x64/install.ps1': 'installer',
    'accr-ui-windows-lite-x64/install.vbs': 'entry',
    'accr-ui-windows-lite-x64/install-ui.ps1': 'ui',
    'accr-ui-windows-lite-x64/payload.zip': payload,
  })
  const verified = verifyWindowsLitePackage(archive, { currentVersion: '1.1.75', expectedSha256: digest(archive), expectedVersion: '1.1.76' })
  assert.equal(verified.version, '1.1.76')
  assert.equal(verified.extensionId, 'cmgjacoohdgjedoekbdbhbelpmboankg')
  const expectedSha256 = digest(archive)
  assert.throws(() => verifyWindowsLitePackage(archive, { currentVersion: '1.1.76', expectedSha256, expectedVersion: '1.1.76' }), /未高于当前版本/)
  const missingKeyPayload = zip({ 'extension/manifest.json': JSON.stringify({ version: '1.1.76' }) })
  const missingKeyArchive = zip({ 'accr-ui-windows-lite-x64/install.ps1': 'installer', 'accr-ui-windows-lite-x64/install.vbs': 'entry', 'accr-ui-windows-lite-x64/install-ui.ps1': 'ui', 'accr-ui-windows-lite-x64/payload.zip': missingKeyPayload })
  assert.throws(() => verifyWindowsLitePackage(missingKeyArchive, { expectedSha256: digest(missingKeyArchive), expectedVersion: '1.1.76' }), /固定身份 key/)
  assert.throws(() => verifyWindowsLitePackage(archive, { expectedVersion: '1.1.76' }), /SHA256/)
  assert.throws(() => verifyWindowsLitePackage(archive, { expectedSha256, expectedVersion: '1.1.77' }), /版本不匹配/)
})

test('rejects path traversal before extraction', () => {
  const archive = zip({ '../install.ps1': 'bad' })
  assert.throws(() => verifyWindowsLitePackage(archive, { expectedSha256: digest(archive) }), /不安全 ZIP 路径/)
})

test('accepts safe Windows extraction targets and rejects escapes', () => {
  const destination = 'C:\\Users\\tester\\AppData\\Local\\Temp\\accr-update\\package'
  assert.equal(
    resolveExtractionTarget(destination, 'install.ps1', win32),
    `${destination}\\install.ps1`,
  )
  assert.equal(
    resolveExtractionTarget(destination, 'nested/payload.zip', win32),
    `${destination}\\nested\\payload.zip`,
  )
  assert.throws(
    () => resolveExtractionTarget(destination, '../escape.ps1', win32),
    /解压目标不安全/,
  )
})
