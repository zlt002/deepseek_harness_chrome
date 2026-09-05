import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeProductSkills } from '../scripts/skills/materialize-product-skills.mjs'

const sourceRoot = fileURLToPath(new URL('../skills/', import.meta.url))
const officeSkills = ['docx', 'pptx', 'xlsx']
const python = process.env.DSH_SKILL_TEST_PYTHON || 'python'
const pythonAvailable = spawnSync(python, ['--version']).status === 0
const xmlAvailable = pythonAvailable && spawnSync(python, ['-c', 'import lxml, defusedxml']).status === 0

async function files(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  return (await Promise.all(entries.filter((entry) => entry.name !== '__pycache__').map(async (entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? files(root, name) : [name]
  }))).flat().sort()
}

function runPython(args) {
  const result = spawnSync(python, ['-B', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
  return result.stdout
}

async function assertOriginalOffice(root) {
  const names = await files(root)
  assert.equal(names.length, 50)
  const hash = createHash('sha256')
  for (const name of names) {
    hash.update(`${name}\0`)
    hash.update((await readFile(join(root, name), 'utf8')).replaceAll('\r\n', '\n'))
  }
  // Characterization of all 50 original common files, including every XSD.
  assert.equal(hash.digest('hex'), 'e10f1b967de229f8d9c5c624472dd0363f27aecef33ce4a5a4386ad620b2b39d')
}

test('common Office implementation preserves all original files byte for byte', async () => {
  await assertOriginalOffice(join(sourceRoot, '_shared/office'))
})

test('materialized skills remain independently distributable and can be copied again', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-skill-layout-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const output = join(temp, 'skills')
  await materializeProductSkills(sourceRoot, output)
  assert.deepEqual((await readdir(output)).sort(), ['docx', 'pdf', 'pmd-prd', 'pptx', 'product-prototype', 'webedit-light-document', 'webedit-spreadsheet', 'xlsx'])
  for (const name of officeSkills) await assertOriginalOffice(join(output, name, 'scripts/office'))
  const copied = join(temp, 'copied')
  await materializeProductSkills(output, copied)
  for (const name of officeSkills) await assertOriginalOffice(join(copied, name, 'scripts/office'))
  const isolated = join(temp, 'isolated-docx')
  await cp(join(output, 'docx'), isolated, { recursive: true })
  await rm(output, { recursive: true })
  if (pythonAvailable) {
    runPython(['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from office.helpers import opc_target; assert opc_target("../media/image.png", "word/document.xml") == "media/image.png"', join(isolated, 'scripts')])
  }
  if (xmlAvailable) runPython([join(isolated, 'scripts/office/validate.py'), '--help'])
})

test('source-tree Python imports and original script entry points remain usable', { skip: !pythonAvailable && 'Python is unavailable' }, () => {
  for (const name of officeSkills) {
    runPython(['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from office.helpers import opc_target; from office.helpers import pptx_chart, pptx_slide, pptx_theme; from office.soffice import get_soffice_env; assert callable(get_soffice_env); assert opc_target("../media/image.png", "word/document.xml") == "media/image.png"', join(sourceRoot, name, 'scripts')])
  }
})

test('source-tree validators resolve shared schemas and retain error exit codes', { skip: !xmlAvailable && 'Python lxml and defusedxml are unavailable' }, () => {
  for (const name of officeSkills) {
    const office = join(sourceRoot, name, 'scripts/office')
    runPython([join(office, 'validate.py'), '--help'])
    runPython(['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from validators.base import BaseSchemaValidator, _load_schema; v = BaseSchemaValidator(sys.argv[1]); assert (v.schemas_dir / "ISO-IEC29500-4_2016/wml.xsd").is_file(); _load_schema(str(v.schemas_dir / "ecma/fouth-edition/opc-contentTypes.xsd"))', office])
    const result = spawnSync(python, ['-B', join(office, 'validate.py'), join(office, 'does-not-exist.docx')], { encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /does not exist/)
  }
})

test('missing common resources fail before an incomplete skill is written', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-skill-missing-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const source = join(temp, 'source')
  await cp(sourceRoot, source, { recursive: true })
  await rm(join(source, '_shared/office/schemas/ISO-IEC29500-4_2016/wml.xsd'))
  const output = join(temp, 'output')
  await assert.rejects(materializeProductSkills(source, output), /wml\.xsd/)
  await assert.rejects(stat(output), { code: 'ENOENT' })
  await rm(join(source, '_shared'), { recursive: true })
  await assert.rejects(materializeProductSkills(source, output), /shared Office/)
})

test('materialization rejects overlapping source and destination directories', async () => {
  await assert.rejects(materializeProductSkills(sourceRoot, sourceRoot), /overlap/)
  await assert.rejects(materializeProductSkills(sourceRoot, join(sourceRoot, 'generated')), /overlap/)
})
