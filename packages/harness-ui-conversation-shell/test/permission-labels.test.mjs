import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'

async function labels() {
  const source = await readFile(new URL('../src/client/permission-labels.ts', import.meta.url), 'utf8')
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  return import(`data:text/javascript,${encodeURIComponent(compiled.code)}`)
}

test('permission labels localize only the three supported presets', async () => {
  const { permissionLabel } = await labels()

  assert.equal(permissionLabel('read-only'), '只读')
  assert.equal(permissionLabel('workspace-write'), '工作区写入')
  assert.equal(permissionLabel('danger-full-access'), '完全访问')
  assert.equal(permissionLabel('host-custom') ?? 'Host Custom', 'Host Custom')
})
