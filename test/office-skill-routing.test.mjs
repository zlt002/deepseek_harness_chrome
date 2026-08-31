import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PRESENTATION_WRITE_ACTIONS } from '../apps/native-server/src/connector-tool-catalog.mjs'

async function skill(name) {
  return readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8')
}

test('light-document skill separates blank, bounded-block, and whole-document writes by the supported contract', async () => {
  const source = await skill('webedit-light-document')
  assert.match(source, /空白文档[\s\S]*blocks_insert[\s\S]*\{ position: "end", blocks: \[\.\.\.\] \}/)
  assert.match(source, /Mermaid[\s\S]*insert_drawing[\s\S]*\{ mermaid, position: "end" \}/)
  assert.match(source, /光标处写纯正文[\s\S]*读取当前选区[\s\S]*selection_insert[\s\S]*text.*markdown.*html[\s\S]*expectedSelectionFingerprint/)
  assert.match(source, /稳定旧块[\s\S]*blocks_batch_replace[\s\S]*\{ replacements: \[\{ id, \.\.\. \}\] \}[\s\S]*最多 50/)
  assert.match(source, /删除完整稳定块用 `blocks_delete` 的公开 `id`；只改标题用 `set_title`/)
  assert.match(source, /不能接受 `\{ blocks: \[\.\.\.\] \}`[\s\S]*不能用来重建整篇文档/)
  assert.match(source, /全文重写[\s\S]*精确、稳定、非折叠的全文[\s\S]*replaceStrategy[\s\S]*选区 preview\/commit/)
  assert.match(source, /全文\/选区替换分支不得猜测 `blocks_delete`、`blocks_insert`/)
  assert.match(source, /editor not ready[\s\S]*刷新页面、重新绑定 Browser Target/)
  assert.match(source, /preview → 用户确认 → commit → 同一 Browser Target 回读/)
})

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
