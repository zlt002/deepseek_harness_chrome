import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { issuePmdPrdReviewReceipt } from '../../../skills/pmd-prd/scripts/issue-review-receipt.mjs'
import { verifyPmdPrdSourceProof } from '../src/pmd-prd-source-proof.mjs'

const projectRoot = resolve(import.meta.dirname, '../../..')
const authorityPath = resolve(projectRoot, 'skills/pmd-prd/references/templates.md')
const validatorPath = resolve(projectRoot, 'skills/pmd-prd/scripts/validate-deliverables.mjs')

function prdTemplate(authority) {
  return [...authority.matchAll(/```markdown\s*\n([\s\S]*?)\n```/g)].map(match => match[1]).find(body => body.includes('# PRD:'))
}

function validPrd(authority) {
  return prdTemplate(authority)
    .replaceAll('{编号}', 'req-proof-1')
    .replaceAll('{编号及链接}', 'req-proof-1（需求链接待确认）')
    .replaceAll('{主题}', '评分凭据')
    .replaceAll('{功能名称}', '客户维护')
    .replace(/\{[^{}\n]+\}/g, '[待确认]')
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-proof-'))
  const directory = join(root, 'pmd-workspace', 'spec', 'req-proof-1')
  await writeFile(join(root, 'README.md'), '# ordinary markdown')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ requirementId: 'req-proof-1', workflow: 'pmd-prd' }))
  await writeFile(join(directory, 'req-proof-1_评分凭据_PRD.md'), validPrd(await readFile(authorityPath, 'utf8')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, relativePath: 'pmd-workspace/spec/req-proof-1/req-proof-1_评分凭据_PRD.md', manifestPath: join(directory, 'manifest.json') }
}

test('ordinary Markdown cannot obtain PMD provenance merely by sending source pmd-prd', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath: 'README.md', validatorPath }),
    /requires pmd-workspace\/spec/,
  )
})

test('accepts only a validator-issued receipt bound to the current frozen PRD', async (t) => {
  const { root, relativePath, manifestPath } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt is missing/,
  )
  const receipt = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), manifestPath, now: '2026-09-01T00:00:00.000Z' })
  assert.equal(receipt.path, 'req-proof-1_评分凭据_PRD.md')
  assert.equal((JSON.parse(await readFile(manifestPath, 'utf8'))).reviewReceipt.prd.fingerprint, receipt.fingerprint)
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: receipt.fingerprint })
  await writeFile(join(root, relativePath), '# replaced')
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt does not match/,
  )
})
