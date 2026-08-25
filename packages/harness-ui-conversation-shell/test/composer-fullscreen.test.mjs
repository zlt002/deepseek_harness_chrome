import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = await readFile(new URL('../src/client/composer-fullscreen.ts', import.meta.url), 'utf8')
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
const { ComposerFullscreen } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('composer fullscreen toggles and Escape can idempotently restore the normal composer', () => {
  const fullscreen = new ComposerFullscreen()
  const states = []
  fullscreen.active.subscribe(() => { states.push(fullscreen.active.getSnapshot()) })

  assert.equal(fullscreen.active.getSnapshot(), false)
  fullscreen.toggle()
  assert.equal(fullscreen.active.getSnapshot(), true)
  fullscreen.exit()
  fullscreen.exit()

  assert.equal(fullscreen.active.getSnapshot(), false)
  assert.deepEqual(states, [true, false])
})
