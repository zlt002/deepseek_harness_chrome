import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = await readFile(new URL('../src/client/process-visibility.ts', import.meta.url), 'utf8')
const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
const output = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: clientDir },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [{
    name: 'snapshot-store',
    setup(plugin) {
      plugin.onResolve({ filter: /^@deepseek-ai\/dsh-client-runtime\/client$/ }, () => ({ path: 'snapshot-store', namespace: 'test' }))
      plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        loader: 'js',
        contents: `
          export function createSnapshotStore(initial) {
            let value = initial
            const listeners = new Set()
            return {
              getSnapshot: () => value,
              set(next) { if (Object.is(value, next)) return; value = next; for (const listener of listeners) listener() },
              subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
            }
          }
        `,
      }))
    },
  }],
})
const { ProcessVisibility } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

class FakeSettingsScope {
  #value
  #listeners = new Set()
  writes = []

  constructor(value) { this.#value = value }
  getSnapshot() { return { value: this.#value } }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  set(field, value) { this.writes.push([field, value]); return Promise.resolve() }
  publish(value) { this.#value = value; for (const listener of this.#listeners) listener() }
}

test('process visibility defaults visible, persists switches, and adopts Host snapshots', () => {
  const scope = new FakeSettingsScope(undefined)
  const visibility = new ProcessVisibility(scope)
  const published = []
  visibility.showProcess.subscribe(() => { published.push(visibility.showProcess.getSnapshot()) })

  assert.equal(visibility.showProcess.getSnapshot(), true)

  visibility.setShowProcess(false)
  assert.equal(visibility.showProcess.getSnapshot(), false)
  assert.deepEqual(scope.writes, [['showProcess', false]])
  assert.deepEqual(published, [false])

  scope.publish({ showProcess: true })
  assert.equal(visibility.showProcess.getSnapshot(), true)
  assert.deepEqual(published, [false, true])
})
