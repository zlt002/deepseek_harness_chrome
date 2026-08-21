import assert from 'node:assert/strict'
import test from 'node:test'
import { readSelectedFolderFiles } from '../src/client/folder-upload.mjs'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILES = 128

function file(path, size = 1, data = 'x') {
  return {
    name: path.split('/').at(-1),
    size,
    webkitRelativePath: path,
    async arrayBuffer() { return new TextEncoder().encode(data).buffer },
  }
}

test('reads selected files with their webkit relative paths into the folder payload', async () => {
  assert.deepEqual(await readSelectedFolderFiles([
    file('selected-skill/SKILL.md', 5, 'hello'),
    file('selected-skill/references/check.md', 3, 'ok'),
  ]), [
    { path: 'selected-skill/SKILL.md', data: 'aGVsbG8=' },
    { path: 'selected-skill/references/check.md', data: 'b2s=' },
  ])
})

test('enforces the per-file, total, and file-count folder limits', async () => {
  await assert.rejects(
    readSelectedFolderFiles([file('selected-skill/large.bin', MAX_FILE_BYTES + 1)]),
    /技能文件过大：selected-skill\/large\.bin/,
  )

  await assert.rejects(
    readSelectedFolderFiles(Array.from({ length: MAX_FILES + 1 }, (_, index) => file(`selected-skill/${index}.txt`))),
    /技能文件数量超过 128/,
  )

  await assert.rejects(
    readSelectedFolderFiles(Array.from({ length: 5 }, (_, index) => file(`selected-skill/${index}.bin`, index === 4 ? 1 : MAX_FILE_BYTES))),
    /技能文件夹总大小超过 32MB/,
  )

  assert.equal(MAX_TOTAL_BYTES, 32 * 1024 * 1024)
})
