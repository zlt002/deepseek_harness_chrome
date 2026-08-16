import { defineConfig } from 'wxt'
import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const isDevCommand = !process.argv.some((argument) => ['build', 'zip', 'submit'].includes(argument))
const execFileAsync = promisify(execFile)

/**
 * The first browser surface is a sidepanel shell around the locally served
 * Harness Web UI. The UI stays on the loopback origin so its existing
 * same-origin HTTP and WebSocket transport remains unchanged.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  publicDir: isDevCommand ? '.wxt-public' : 'public',
  webExt: { disabled: true },
  hooks: {
    async 'build:done'(wxt) {
      if (wxt.config.command !== 'serve') return
      // WXT copies public assets serially. Copy the generated Harness tree in
      // a fresh process after the extension shell and manifest are ready.
      await execFileAsync(process.execPath, [
        resolve(wxt.config.root, 'scripts/copy-dev-public.mjs'),
        resolve(wxt.config.root, 'public'),
        wxt.config.outDir,
      ])
    },
    'vite:devServer:extendConfig'(config) {
      const root = resolve(config.root ?? '.')
      const watched = [
        resolve(root, 'entrypoints'),
        resolve(root, 'src'),
        resolve(root, '.wxt-public'),
        resolve(root, 'wxt.config.ts'),
      ]
      config.optimizeDeps = {
        ...config.optimizeDeps,
        noDiscovery: true,
        include: ['react', 'react-dom', 'react-dom/client'],
      }
      config.server ??= {}
      config.server.watch = {
        followSymlinks: false,
        ignored: (candidate) => {
          const path = resolve(candidate)
          if (path === root) return false
          return !watched.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`))
        },
      }
    },
  },
  dev: {
    server: {
      strictPort: true,
    },
  },
  manifest: {
    name: 'DeepSeek Harness',
    description: 'Use DeepSeek Harness from a Chrome side panel.',
    minimum_chrome_version: '120',
    permissions: ['sidePanel', 'nativeMessaging', 'storage', 'tabs', 'webNavigation', 'scripting', 'cookies'],
    host_permissions: [
      'http://127.0.0.1/*',
      'http://localhost/*',
      'https://doc.midea.com/*',
      'https://webedit.midea.com/*',
      '*://*.annto.com/*',
    ],
    web_accessible_resources: [{
      resources: [
        'office-read-runtime.js',
        'office-light-document-runtime.js',
        'office-spreadsheet-runtime.js',
      ],
      matches: ['https://webedit.midea.com/*'],
    }],
    action: {
      default_title: 'Open DeepSeek Harness',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    content_security_policy: {
      extension_pages: [
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'self'",
        "frame-src 'self' http://127.0.0.1:* http://localhost:*",
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://anapi-uat.annto.com",
        "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
      ].join('; '),
    },
  },
})
