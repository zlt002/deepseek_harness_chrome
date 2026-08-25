import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PRESENTATION_WRITE_ACTIONS } from '../apps/native-server/src/connector-tool-catalog.mjs'

async function skill(name) {
  return readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8')
}

test('online spreadsheet skill routes by Browser Target and exposes the complete verified-write gate', async () => {
  const source = await skill('webedit-spreadsheet')
  assert.match(source, /documentIdentity\.kind=webedit_spreadsheet/)
  for (const tool of ['spreadsheet_get_context', 'spreadsheet_read_range', 'spreadsheet_search', 'spreadsheet_inspect', 'spreadsheet_write_preview', 'spreadsheet_write_commit']) assert.match(source, new RegExp(`mcp__chrome__${tool}`))
  assert.match(source, /spreadsheet_write_preview\(\{ operation, payload \}\)/)
  assert.match(source, /展示给用户，等待明确确认/)
  assert.match(source, /spreadsheet_write_commit\(\{ challenge \}\)/)
  assert.match(source, /同一 Browser Target.*回读|同一 Browser Target 的上下文和目标范围回读/)
  assert.match(source, /xlsx.*Skill/)
  assert.doesNotMatch(source, /只读参考|不再提供表格写入工具/)
})

test('local xlsx skill keeps the OOXML workflow separate from online WebEdit', async () => {
  const source = await skill('xlsx')
  assert.match(source, /local spreadsheet files|本地 spreadsheet/i)
  assert.match(source, /documentIdentity\.kind is webedit_spreadsheet/)
  for (const tool of ['spreadsheet_get_context', 'spreadsheet_read_range', 'spreadsheet_search', 'spreadsheet_inspect', 'spreadsheet_write_preview', 'spreadsheet_write_commit']) assert.match(source, new RegExp(tool))
  assert.match(source, /webedit-spreadsheet/)
  assert.match(source, /same-target structured readback/)
})

test('PPTX skill routes online presentations through model-facing tools and local files through OOXML', async () => {
  const source = await skill('pptx')
  assert.match(source, /documentIdentity\.kind=webedit_presentation/)
  for (const tool of ['presentation_get_capabilities', 'presentation_get_context', 'presentation_get_selection', 'presentation_get_text_boxes', 'presentation_write_preview', 'presentation_write_commit']) assert.match(source, new RegExp(`mcp__chrome__${tool}`))
  assert.match(source, /presentation_get_capabilities\(\{\}\).*before planning an advanced write/)
  assert.match(source, /Plan only an operation\/action listed in the returned `operations`/)
  assert.match(source, /presentation_write_preview` tool schema is the payload source of truth/)
  for (const [operation, actions] of Object.entries(PRESENTATION_WRITE_ACTIONS)) {
    assert.ok(source.includes(`\`${operation}\``), `missing ${operation} payload contract`)
    for (const action of actions) assert.ok(source.includes(`action:\"${action}`) || source.includes(`\\|\"${action}`), `missing ${operation}/${action} action contract`)
  }
  for (const field of ['slideIndex', 'objectIndex', 'elements', 'fileName', 'rows', 'columns', 'chartType', 'replyer', 'sectionIndex', 'toPos', 'textBoxIndex']) assert.match(source, new RegExp(field))
  assert.match(source, /edit_selection` \| `\{action:"update", slideIndex/)
  assert.match(source, /columnClustered.*doughnut.*scatter/)
  assert.match(source, /WPS numeric enum/)
  assert.match(source, /numeric strings are normalized/)
  assert.match(source, /never infer the first slide, object, or text box/)
  assert.match(source, /no Browser Target, resource, precondition, or generic script/)
  assert.match(source, /summary\.confirmation/)
  assert.match(source, /table rows\/columns\/position.*every scene element type and bounded text preview/)
  assert.match(source, /Show the preview to the user and wait for explicit confirmation|展示给用户并等待明确确认/)
  assert.match(source, /presentation_write_commit\(\{ challenge \}\)/)
  assert.match(source, /same-target structured readback/)
  assert.match(source, /local `\.pptx`\/`\.potx`|本地 `\.pptx`/) 
  assert.match(source, /OOXML.*pptxgenjs|OOXML\/pptxgenjs/)
})
