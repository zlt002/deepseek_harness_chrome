import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function bundleTypescript(source, sourceUrl) {
  const result = await build({
    stdin: {
      contents: source,
      loader: 'ts',
      resolveDir: dirname(fileURLToPath(sourceUrl)),
      sourcefile: fileURLToPath(sourceUrl),
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}
