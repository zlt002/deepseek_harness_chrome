import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_WINDOWS_LITE_SOURCE = 'https://git.midea.com/zhanglt21/claudecodeuibox/-/raw/main/accr-ui-windows-lite-x64.zip'
const SOURCE_FILE = '.accrui-update-source.json'
const MAX_RELEASE_BYTES = 1024 * 1024 * 1024

export async function resolveReleaseSource({ installRoot, env = process.env } = {}) {
  const override = env.ACCRUI_WINDOWS_LITE_UPDATE_URL?.trim()
  if (override) return { packageUrl: override, expectedSha256: env.ACCRUI_WINDOWS_LITE_UPDATE_SHA256?.trim() || undefined }
  if (typeof installRoot !== 'string' || installRoot.trim() === '') {
    return { packageUrl: DEFAULT_WINDOWS_LITE_SOURCE }
  }
  try {
    const source = JSON.parse(await readFile(resolve(installRoot, SOURCE_FILE), 'utf8'))
    if (typeof source?.packageUrl === 'string' && /^https?:\/\//.test(source.packageUrl)) {
      return { packageUrl: source.packageUrl, expectedSha256: typeof source.sha256 === 'string' ? source.sha256.toLowerCase() : undefined }
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw new Error(`无法读取更新源配置：${error.message}`) }
  return { packageUrl: DEFAULT_WINDOWS_LITE_SOURCE }
}

export async function fetchRelease(source, fetchImpl = fetch) {
  const response = await fetchImpl(source.packageUrl, { headers: { accept: 'application/zip' } })
  if (!response.ok) throw new Error(`下载更新包失败：HTTP ${response.status}`)
  const advertisedLength = response.headers.get('content-length')
  const advertisedBytes = advertisedLength === null ? undefined : Number(advertisedLength)
  if (advertisedBytes !== undefined && (!Number.isFinite(advertisedBytes) || advertisedBytes <= 0 || advertisedBytes > MAX_RELEASE_BYTES)) throw new Error(`更新包大小无效或超过 ${MAX_RELEASE_BYTES} 字节上限`)
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_RELEASE_BYTES) throw new Error(`更新包大小无效或超过 ${MAX_RELEASE_BYTES} 字节上限`)
  if (contentType.includes('text/html') || bytes.subarray(0, 512).toString('utf8').toLowerCase().includes('<html')) throw new Error('更新地址返回 HTML，不是 ZIP raw 下载地址')
  return { bytes, etag: response.headers.get('etag') ?? undefined }
}
