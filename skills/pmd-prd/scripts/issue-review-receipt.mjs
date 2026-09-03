#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDeliverable } from './validate-deliverables.mjs'

const RECEIPT_KIND = 'pmd-prd-frozen-review'

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return resolve(value)
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--prd') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a path`)
      values[argument.slice(2)] = value; index += 1
    } else if (argument === '--help' || argument === '-h') return { help: true }
    else throw new Error(`unknown option: ${argument}`)
  }
  if (values.prd === undefined) throw new Error('--prd is required')
  return values
}

async function regularFile(path, label) {
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular file`)
}

function expectedPrdBinding(prdPath) {
  const directory = dirname(prdPath)
  const runRequirementId = basename(directory)
  const fileName = basename(prdPath)
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(runRequirementId) || !fileName.startsWith(`${runRequirementId}_`) || !fileName.endsWith('_PRD.md')) {
    throw new Error('frozen PRD must use pmd-workspace/spec/<runRequirementId>/<runRequirementId>_*_PRD.md')
  }
  return { runRequirementId, fileName, manifestPath: resolve(directory, 'manifest.json') }
}

function businessRequirementId(body) {
  const match = /^# PRD: (.+?) - .+$/m.exec(body)
  if (match === null || match[1].trim() === '') throw new Error('frozen PRD title must contain its business requirement ID')
  return match[1].trim()
}

/** Validate the PRD file, then atomically create or refresh the hidden review binding. */
export async function issuePmdPrdReviewReceipt({ prdPath, now = new Date().toISOString() }) {
  const prd = requiredPath(prdPath, 'prd')
  const { runRequirementId, fileName, manifestPath } = expectedPrdBinding(prd)
  await regularFile(prd, 'PRD')
  const validation = await validateDeliverable({ prdPath: prd })
  if (!validation.ok) throw new Error(`PMD frozen PRD check failed: ${validation.errors.join('; ')}`)
  const body = await readFile(prd, 'utf8')
  const expected = { workflow: 'pmd-prd', runRequirementId, businessRequirementId: businessRequirementId(body) }
  let current
  try { current = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') current = expected
    else throw new Error('manifest is invalid JSON')
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)
    || current.workflow !== 'pmd-prd' || current.runRequirementId !== runRequirementId) {
    throw new Error('manifest does not bind this pmd-prd requirement')
  }
  const fingerprint = digest(body)
  const receipt = { v: 1, kind: RECEIPT_KIND, prd: { path: fileName, fingerprint }, validatedAt: now }
  const next = { ...expected, reviewReceipt: receipt }
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`
  let mode
  try { mode = (await lstat(manifestPath)).mode } catch (error) { if (error?.code !== 'ENOENT') throw error }
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, mode === undefined ? {} : { mode })
  await rename(temporary, manifestPath)
  const readback = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (readback?.reviewReceipt?.prd?.fingerprint !== fingerprint) throw new Error('PMD review receipt readback failed')
  return { path: fileName, fingerprint, manifestPath }
}

function usage() { return 'Usage: issue-review-receipt.mjs --prd <frozen-prd-file>' }

async function main() {
  let args
  try { args = parseArguments(process.argv.slice(2)) } catch (error) { console.error(`ERROR: ${error.message}\n${usage()}`); process.exitCode = 2; return }
  if (args.help) { console.log(usage()); return }
  try {
    const receipt = await issuePmdPrdReviewReceipt({ prdPath: args.prd })
    console.log(`PASS: PMD review receipt (${receipt.path})`)
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1 }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main()
