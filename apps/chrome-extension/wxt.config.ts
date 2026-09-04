import { defineConfig } from 'wxt'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const projectRoot = resolve(extensionRoot, '..', '..')
const isDevCommand = !process.argv.some((argument) => ['build', 'zip', 'submit'].includes(argument))
const execFileAsync = promisify(execFile)
const extensionPackage = JSON.parse(readFileSync(resolve(extensionRoot, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof extensionPackage.version !== 'string' || extensionPackage.version.trim() === '') throw new Error('Chrome extension package.json must define a version.')
const extensionVersion = extensionPackage.version.trim()

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
        resolve(projectRoot, 'scripts/copy-dev-public.mjs'),
        resolve(extensionRoot, 'public'),
        wxt.config.outDir,
      ])
    },
    'vite:devServer:extendConfig'(config) {
      const root = resolve(config.root ?? extensionRoot)
      const startupGuardSource = resolve(extensionRoot, 'public', 'prototype-startup-guard.js')
      const startupGuardTarget = resolve(extensionRoot, '.output', 'chrome-mv3-dev', 'prototype-startup-guard.js')
      const watched = [
        resolve(root, 'entrypoints'),
        resolve(root, 'src'),
        resolve(root, '.wxt-public'),
        startupGuardSource,
        resolve(root, 'wxt.config.ts'),
      ]
      const syncStartupGuard = async (): Promise<void> => {
        await mkdir(dirname(startupGuardTarget), { recursive: true })
        await copyFile(startupGuardSource, startupGuardTarget)
      }
      config.plugins = [...(config.plugins ?? []), {
        name: 'accrui-prototype-startup-guard-sync',
        configureServer(server) {
          server.watcher.add(startupGuardSource)
          const syncChangedGuard = (path: string): void => {
            if (resolve(path) !== startupGuardSource) return
            void syncStartupGuard().catch(error => server.config.logger.error(`Failed to sync Prototype Studio startup guard: ${String(error)}`))
          }
          server.watcher.on('add', syncChangedGuard)
          server.watcher.on('change', syncChangedGuard)
          void syncStartupGuard().catch(error => server.config.logger.error(`Failed to sync Prototype Studio startup guard: ${String(error)}`))
        },
      }]
      config.optimizeDeps = {
        ...config.optimizeDeps,
        noDiscovery: true,
        include: [
          'react',
          'react-dom',
          'react-dom/client',
          '@milkdown/crepe',
          '@milkdown/kit',
          '@milkdown/kit/core',
          '@milkdown/kit/plugin/diff',
          '@milkdown/kit/plugin/history',
          '@milkdown/kit/plugin/streaming',
          '@milkdown/kit/prose/state',
          '@milkdown/kit/prose/view',
          '@milkdown/kit/utils',
          'react-markdown',
          'rehype-sanitize',
          'remark-gfm',
          'mermaid',
          'debug',
          // `superlock` is nested beneath WXT's storage package, so resolve it
          // from that package rather than this app's direct dependencies.
          'wxt > @wxt-dev/storage > superlock',
        ],
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
    'vite:build:extendConfig'(_entrypoints, config) {
      // Chrome extension worlds reject the generated modulepreload cross-world hint.
      config.build ??= {}
      config.build.modulePreload = false
    },
  },
  dev: {
    server: {
      // Chrome's service worker resolves ws://localhost to IPv4 first. WXT's
      // default localhost bind is IPv6-only on this host, so HMR gets
      // ERR_CONNECTION_REFUSED unless both listen address and injected origin
      // are the IPv4 loopback the rest of the stack already uses.
      host: '127.0.0.1',
      origin: '127.0.0.1',
      strictPort: true,
    },
  },
  manifest: {
    name: `accrui ${extensionVersion} beta`,
    description: 'Use ACCRUI from a Chrome side panel.',
    // Chrome 116 introduced the Side Panel API used by the normal workspace.
    // The optional full-screen handoff remains gated at runtime on
    // `chrome.sidePanel.close()`, which Chrome added in 141.
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'nativeMessaging', 'storage', 'tabs', 'webNavigation', 'scripting', 'cookies', 'notifications'],
    host_permissions: [
      'http://127.0.0.1/*',
      'http://localhost/*',
      'https://doc.midea.com/*',
      'https://webedit.midea.com/*',
      '*://*.annto.com/*',
      '<all_urls>',
    ],
    web_accessible_resources: [{
      resources: [
        'office-read-runtime.js',
        'office-light-document-runtime.js',
        'office-spreadsheet-runtime.js',
        'office-presentation-runtime.js',
      ],
      matches: ['https://webedit.midea.com/*'],
    }],
    action: {
      default_title: 'Open ACCRUI',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    content_security_policy: {
      extension_pages: [
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'self'",
        "frame-src 'self' http://127.0.0.1:* http://localhost:*",
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://anapi-uat.annto.com http://signinuat.midea.com https://signinuat.midea.com",
        "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
      ].join('; '),
    },
  },
})
