import { defineConfig } from 'wxt'

/**
 * The first browser surface is a sidepanel shell around the locally served
 * Harness Web UI. The UI stays on the loopback origin so its existing
 * same-origin HTTP and WebSocket transport remains unchanged.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DeepSeek Harness',
    description: 'Use DeepSeek Harness from a Chrome side panel.',
    minimum_chrome_version: '120',
    permissions: ['sidePanel', 'nativeMessaging', 'storage'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
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
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
        "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
      ].join('; '),
    },
  },
})
