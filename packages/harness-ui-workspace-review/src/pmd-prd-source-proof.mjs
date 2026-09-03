import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const FROZEN_PRD_PATH = /^pmd-workspace\/spec\/([A-Za-z0-9_-]{3,160})\/([^/]+_PRD\.md)$/
const RECEIPT_KIND = 'pmd-prd-frozen-review'

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function within(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function frozenPrdPath(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('PMD review proof requires a frozen PRD path')
  const match = FROZEN_PRD_PATH.exec(relativePath)
  if (match === null || !match[2].startsWith(`${match[1]}_`)) {
    throw new Error('PMD review proof requires pmd-workspace/spec/<runRequirementId>/<runRequirementId>_*_PRD.md')
  }
  return { runRequirementId: match[1], fileName: match[2] }
}

async function regularFile(path, label) {
  let details
  try { details = await lstat(path) }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`PMD review proof ${label} is missing; validate the PRD before opening review`)
    throw error
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`PMD review proof ${label} must be a regular file`)
}

async function receiptFor(root, relativePath, fingerprint) {
  const { runRequirementId, fileName } = frozenPrdPath(relativePath)
  const manifestPath = resolve(root, 'pmd-workspace', 'spec', runRequirementId, 'manifest.json')
  if (!within(root, manifestPath)) throw new Error('PMD review proof manifest escapes the workspace')
  await regularFile(manifestPath, 'manifest')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { throw new Error('PMD review proof manifest is invalid JSON') }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.workflow !== 'pmd-prd' || manifest.runRequirementId !== runRequirementId
    || typeof manifest.businessRequirementId !== 'string' || manifest.businessRequirementId.trim() === ''
  ) {
    throw new Error('PMD review proof manifest does not bind this pmd-prd requirement')
  }
  const receipt = manifest.reviewReceipt
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('PMD review proof receipt is missing')
  const prd = receipt.prd
  if (receipt.v !== 1 || receipt.kind !== RECEIPT_KIND || prd === null || typeof prd !== 'object' || Array.isArray(prd)
    || prd.path !== fileName || prd.fingerprint !== fingerprint) {
    throw new Error('PMD review proof receipt does not match the frozen PRD')
  }
}

async function fingerprint(root, relativePath) {
  const candidate = resolve(root, relativePath)
  if (!within(root, candidate)) throw new Error('PMD review proof PRD escapes the workspace')
  await regularFile(candidate, 'PRD')
  const canonical = await realpath(candidate)
  if (!within(root, canonical)) throw new Error('PMD review proof PRD escapes the workspace')
  return { path: canonical, value: digest(await readFile(canonical)) }
}

/**
 * Host-side proof for the only path allowed to opt into PRD rating telemetry.
 * The receipt is a frozen-file binding; the Host still reruns the mechanical
 * identity check so a hand-written `source: "pmd-prd"` cannot mint it.
 */
export async function verifyPmdPrdSourceProof({ cwd, relativePath, validatorPath }) {
  frozenPrdPath(relativePath)
  const root = await realpath(cwd)
  const before = await fingerprint(root, relativePath)
  await receiptFor(root, relativePath, before.value)
  const validator = await import(pathToFileURL(validatorPath).href)
  if (typeof validator.validateDeliverable !== 'function') throw new Error('PMD review proof validator is unavailable')
  const result = await validator.validateDeliverable({ prdPath: before.path })
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    const detail = Array.isArray(result?.errors) ? result.errors.join('; ') : 'unknown validation failure'
    throw new Error(`PMD review proof validation failed: ${detail}`)
  }
  const after = await fingerprint(root, relativePath)
  if (after.path !== before.path || after.value !== before.value) throw new Error('PMD frozen PRD changed during validation; regenerate the review receipt')
  return { fingerprint: after.value }
}
