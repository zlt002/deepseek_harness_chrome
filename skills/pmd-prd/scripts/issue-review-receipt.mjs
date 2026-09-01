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
    if (argument === '--prd' || argument === '--manifest') {
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

function expectedRequirement(prdPath, manifestPath) {
  const directory = dirname(prdPath)
  if (dirname(manifestPath) !== directory || basename(manifestPath) !== 'manifest.json') throw new Error('manifest.json must be beside the frozen PRD')
  const requirementId = basename(directory)
  const fileName = basename(prdPath)
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(requirementId) || !fileName.startsWith(`${requirementId}_`) || !fileName.endsWith('_PRD.md')) {
    throw new Error('frozen PRD must use pmd-workspace/spec/<requirementId>/<requirementId>_*_PRD.md')
  }
  return { requirementId, fileName }
}

/** Validate then atomically bind the exact frozen PRD hash into its PMD manifest. */
export async function issuePmdPrdReviewReceipt({ prdPath, manifestPath = resolve(dirname(prdPath), 'manifest.json'), now = new Date().toISOString() }) {
  const prd = requiredPath(prdPath, 'prd')
  const manifest = requiredPath(manifestPath, 'manifest')
  const { requirementId, fileName } = expectedRequirement(prd, manifest)
  await Promise.all([regularFile(prd, 'PRD'), regularFile(manifest, 'manifest')])
  const validation = await validateDeliverable({ prdPath: prd })
  if (!validation.ok) throw new Error(`PMD frozen PRD contract failed: ${validation.errors.join('; ')}`)
  let current
  try { current = JSON.parse(await readFile(manifest, 'utf8')) } catch { throw new Error('manifest is invalid JSON') }
  if (current === null || typeof current !== 'object' || Array.isArray(current) || current.workflow !== 'pmd-prd' || current.requirementId !== requirementId) {
    throw new Error('manifest does not bind this pmd-prd requirement')
  }
  const fingerprint = digest(await readFile(prd))
  const receipt = { v: 1, kind: RECEIPT_KIND, prd: { path: fileName, fingerprint }, validatedAt: now }
  const next = { ...current, reviewReceipt: receipt }
  const temporary = `${manifest}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: (await lstat(manifest)).mode })
  await rename(temporary, manifest)
  const readback = JSON.parse(await readFile(manifest, 'utf8'))
  if (readback?.reviewReceipt?.prd?.fingerprint !== fingerprint) throw new Error('PMD review receipt readback failed')
  return { path: fileName, fingerprint, manifestPath: manifest }
}

function usage() { return 'Usage: issue-review-receipt.mjs --prd <frozen-prd-file> [--manifest <same-directory-manifest.json>]' }

async function main() {
  let args
  try { args = parseArguments(process.argv.slice(2)) } catch (error) { console.error(`ERROR: ${error.message}\n${usage()}`); process.exitCode = 2; return }
  if (args.help) { console.log(usage()); return }
  try {
    const receipt = await issuePmdPrdReviewReceipt({ prdPath: args.prd, ...(args.manifest === undefined ? {} : { manifestPath: args.manifest }) })
    console.log(`PASS: PMD review receipt (${receipt.path})`)
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1 }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main()
