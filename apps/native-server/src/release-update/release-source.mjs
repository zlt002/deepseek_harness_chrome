import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OFFICIAL_RELEASE_ROOT = 'https://github.com/zlt002/deepseek_harness_chrome/releases'
export const DEFAULT_WINDOWS_LITE_MANIFEST_URL = `${OFFICIAL_RELEASE_ROOT}/download/windows-lite-current/accr-ui-windows-lite-update.json`
const SOURCE_FILE = '.accrui-update-source.json'
const MAX_RELEASE_BYTES = 1024 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const RELEASE_MANIFEST_FORMAT = 'accr-ui-windows-lite-update-v1'
const MANIFEST_TIMEOUT_MS = 15_000
const PACKAGE_TIMEOUT_MS = 5 * 60_000

export async function resolveReleaseSource({ installRoot, env = process.env, fetchImpl = fetch, signal, manifestTimeoutMs } = {}) {
  const override = env.ACCRUI_WINDOWS_LITE_UPDATE_URL?.trim()
  if (override) return directSource(override, env.ACCRUI_WINDOWS_LITE_UPDATE_SHA256, '环境变量更新源')
  const manifestOverride = env.ACCRUI_WINDOWS_LITE_UPDATE_MANIFEST_URL?.trim()
  if (manifestOverride) return fetchReleaseManifest(manifestOverride, fetchImpl, { signal, timeoutMs: manifestTimeoutMs })
  if (typeof installRoot === 'string' && installRoot.trim() !== '') {
    try {
      const source = JSON.parse(await readFile(resolve(installRoot, SOURCE_FILE), 'utf8'))
      if (typeof source?.manifestUrl === 'string') return fetchReleaseManifest(source.manifestUrl, fetchImpl, { signal, timeoutMs: manifestTimeoutMs })
      if (typeof source?.packageUrl === 'string') return directSource(source.packageUrl, source.sha256, '安装目录更新源配置')
    } catch (error) { if (error?.code !== 'ENOENT') throw new Error(`无法读取更新源配置：${error.message}`) }
  }
  return fetchReleaseManifest(DEFAULT_WINDOWS_LITE_MANIFEST_URL, fetchImpl, { signal, timeoutMs: manifestTimeoutMs })
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https:\/\//.test(value)
}

function requiredSha256(value, label) {
  const sha256 = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}缺少或包含无效 SHA256；拒绝下载未校验更新包`)
  return sha256
}

function directSource(packageUrl, sha256, label) {
  if (!isHttpUrl(packageUrl)) throw new Error(`${label}必须使用 HTTPS package URL`)
  return { packageUrl, expectedSha256: requiredSha256(sha256, label) }
}

function requestController(signal, timeoutMs, timeoutLabel) {
  if (signal?.aborted) throw signal.reason ?? new Error(`${timeoutLabel}已取消`)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal.reason ?? new Error(`${timeoutLabel}已取消`))
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error(`${timeoutLabel}超时`)), timeoutMs)
  timeout.unref?.()
  return {
    controller,
    dispose() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

async function fetchReleaseManifest(manifestUrl, fetchImpl, { signal, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  if (!isHttpUrl(manifestUrl)) throw new Error('更新版本 manifest 必须使用 HTTPS URL')
  const request = requestController(signal, timeoutMs, '下载更新版本 manifest')
  const { controller } = request
  let response
  try {
    response = await fetchImpl(manifestUrl, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`下载更新版本 manifest 失败：HTTP ${response.status}`)
    const length = response.headers?.get('content-length')
    if (length !== null && length !== undefined && (!Number.isSafeInteger(Number(length)) || Number(length) <= 0 || Number(length) > MAX_MANIFEST_BYTES)) {
      try { await response.body?.cancel?.() } catch { /* the abort is already sufficient */ }
      controller.abort()
      throw new Error(`更新版本 manifest 大小无效或超过 ${MAX_MANIFEST_BYTES} 字节上限`)
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('更新版本 manifest 响应不支持受限流式读取')
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > MAX_MANIFEST_BYTES) {
        try { await reader.cancel() } catch { /* the abort below still terminates the request */ }
        controller.abort()
        throw new Error(`更新版本 manifest 大小无效或超过 ${MAX_MANIFEST_BYTES} 字节上限`)
      }
      chunks.push(chunk)
    }
    } finally {
      reader.releaseLock?.()
    }
    const bytes = Buffer.concat(chunks, totalBytes)
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) throw new Error(`更新版本 manifest 大小无效或超过 ${MAX_MANIFEST_BYTES} 字节上限`)
    let manifest
    try { manifest = JSON.parse(bytes.toString('utf8')) } catch (error) { throw new Error(`更新版本 manifest 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`) }
    if (manifest?.format !== RELEASE_MANIFEST_FORMAT) throw new Error(`更新版本 manifest 格式无效：${String(manifest?.format)}`)
    if (!isHttpUrl(manifest.releaseUrl)) throw new Error('更新版本 manifest 缺少公开 release URL')
    if (!isHttpUrl(manifest.packageUrl)) throw new Error('更新版本 manifest 缺少 HTTPS package URL')
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`更新版本 manifest 版本必须是三段式 x.y.z，收到 ${String(manifest.version)}`)
    return {
      packageUrl: manifest.packageUrl,
      expectedSha256: requiredSha256(manifest.sha256, '更新版本 manifest'),
      expectedVersion: manifest.version,
      releaseUrl: manifest.releaseUrl,
    }
  } finally {
    request.dispose()
  }
}

export async function fetchRelease(source, fetchImpl = fetch, { signal, timeoutMs = PACKAGE_TIMEOUT_MS } = {}) {
  const request = requestController(signal, timeoutMs, '下载更新包')
  let response
  try {
    response = await fetchImpl(source.packageUrl, { headers: { accept: 'application/zip' }, signal: request.controller.signal })
  if (!response.ok) throw new Error(`下载更新包失败：HTTP ${response.status}`)
  const advertisedLength = response.headers.get('content-length')
  const advertisedBytes = advertisedLength === null ? undefined : Number(advertisedLength)
  if (advertisedBytes !== undefined && (!Number.isFinite(advertisedBytes) || advertisedBytes <= 0 || advertisedBytes > MAX_RELEASE_BYTES)) throw new Error(`更新包大小无效或超过 ${MAX_RELEASE_BYTES} 字节上限`)
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_RELEASE_BYTES) throw new Error(`更新包大小无效或超过 ${MAX_RELEASE_BYTES} 字节上限`)
  if (contentType.includes('text/html') || bytes.subarray(0, 512).toString('utf8').toLowerCase().includes('<html')) throw new Error('更新地址返回 HTML，不是 ZIP raw 下载地址')
    return { bytes, etag: response.headers.get('etag') ?? undefined }
  } finally {
    request.dispose()
  }
}
