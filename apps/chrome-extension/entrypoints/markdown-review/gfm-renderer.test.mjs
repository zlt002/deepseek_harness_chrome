import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const root = new URL('.', import.meta.url)
const visualEditor = await readFile(new URL('./visual-markdown-editor.tsx', root), 'utf8')
const main = await readFile(new URL('./main.tsx', root), 'utf8')

test('visual surface uses only bundled Milkdown assets and does not re-enable executable Mermaid', () => {
  assert.match(visualEditor, /from '@milkdown\/crepe'/)
  assert.match(visualEditor, /@milkdown\/crepe\/theme\/classic\.css/)
  assert.doesNotMatch(visualEditor, /https?:\/\//)
  assert.doesNotMatch(main, /MermaidDiagram|mermaid\.render/)
})
