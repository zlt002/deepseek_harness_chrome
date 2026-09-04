import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchRelease, probeRelease, resolveReleaseSource } from './release-source.mjs'
import { compareVersion, extractZip, verifyWindowsLitePackage } from './package-verifier.mjs'

export { launchPreparedUpdate } from './handoff-launcher.mjs'

function updateIdentity(source) {
  if (typeof source.expectedVersion !== 'string') return undefined
  return Object.freeze({ version: source.expectedVersion, sha256: source.expectedSha256, packageUrl: source.packageUrl })
}

function sameUpdateIdentity(left, right) {
  return left?.version === right?.version && left?.sha256 === right?.sha256 && left?.packageUrl === right?.packageUrl
}

function packageIdentity(source, metadata) {
  if (typeof metadata?.packageId !== 'string') return undefined
  return Object.freeze({ packageId: metadata.packageId, packageUrl: source.packageUrl })
}

function samePackageIdentity(left, right) {
  return left?.packageId === right?.packageId && left?.packageUrl === right?.packageUrl
}

export async function checkUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const identity = updateIdentity(source)
  if (identity !== undefined) {
    const available = options.currentVersion === undefined || compareVersion(identity.version, options.currentVersion) > 0
    return { available, ...identity, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }) }
  }
  const metadata = await probeRelease(source, options.fetchImpl, options)
  const candidate = packageIdentity(source, metadata)
  if (candidate === undefined) throw new Error('更新包缺少可比较的文件标识')
  const available = typeof options.currentPackageId !== 'string' || options.currentPackageId !== candidate.packageId
  return { available, ...candidate, ...(metadata.lastModified === undefined ? {} : { lastModified: metadata.lastModified }), ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }) }
}

export async function prepareUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const identity = updateIdentity(source)
  if (options.candidate !== undefined && identity !== undefined && !sameUpdateIdentity(identity, options.candidate)) throw new Error('更新候选已变化；请重新检查更新后再安装')
  if (options.candidate !== undefined && identity === undefined && source.packageUrl !== options.candidate.packageUrl) throw new Error('更新候选已变化；请重新检查更新后再安装')
  const { bytes, etag, lastModified, packageId } = await fetchRelease(source, options.fetchImpl, options)
  if (options.candidate !== undefined && identity === undefined && !samePackageIdentity({ packageId, packageUrl: source.packageUrl }, options.candidate)) throw new Error('下载的 GitLab ZIP 已变化；请重新检查更新后再安装')
  const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256, expectedVersion: source.expectedVersion })
  if (options.candidate !== undefined && identity !== undefined && !sameUpdateIdentity({ version: verified.version, sha256: verified.sha256, packageUrl: source.packageUrl }, options.candidate)) throw new Error('下载的更新包与已检查候选不一致；已拒绝安装')
  const root = await mkdtemp(join(tmpdir(), 'accrui-release-update-'))
  const packagePath = join(root, 'accr-ui-windows-lite-x64.zip')
  await writeFile(packagePath, bytes)
  const extractRoot = join(root, 'package')
  await extractZip(bytes, extractRoot, { stripCommonRoot: true })
  return { ...verified, packagePath, extractRoot, packageUrl: source.packageUrl, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }), ...(packageId === undefined ? {} : { packageId }), ...(etag === undefined ? {} : { etag }), ...(lastModified === undefined ? {} : { lastModified }) }
}
