import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fetchRelease, resolveReleaseSource } from './release-source.mjs'
import { extractZip, verifyWindowsLitePackage } from './package-verifier.mjs'

export async function checkUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl)
  try {
    const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256 })
    return { available: true, ...verified, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('未高于当前版本')) throw error
    const verified = verifyWindowsLitePackage(bytes, { expectedSha256: source.expectedSha256 })
    return { available: false, ...verified, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
  }
}

export async function prepareUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl)
  const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256 })
  const root = await mkdtemp(join(tmpdir(), 'accrui-release-update-'))
  const packagePath = join(root, 'accr-ui-windows-lite-x64.zip')
  await writeFile(packagePath, bytes)
  const extractRoot = join(root, 'package')
  await extractZip(bytes, extractRoot, { stripCommonRoot: true })
  return { ...verified, packagePath, extractRoot, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
}

export function launchPreparedUpdate(prepared, { installRoot, nativePid, spawnImpl } = {}) {
  if (process.platform !== 'win32') throw new Error('在线更新仅支持 Windows Lite')
  if (!prepared?.extractRoot || !installRoot || !Number.isInteger(nativePid)) throw new Error('更新启动参数无效')
  const escapedRoot = String(installRoot).replaceAll("'", "''")
  const escapedScript = join(prepared.extractRoot, 'install.ps1').replaceAll("'", "''")
  const command = `$ErrorActionPreference = 'Stop'; while (Get-Process -Id ${nativePid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }; & '${escapedScript}' -InstallRoot '${escapedRoot}'`
  const child = (spawnImpl ?? spawn)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command], { detached: true, stdio: 'ignore' })
  child?.unref?.()
  return true
}
