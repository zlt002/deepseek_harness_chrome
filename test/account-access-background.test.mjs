import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')

function cookieMatchesUrl(cookie, rawUrl) {
  const url = new URL(rawUrl)
  const domain = cookie.domain.replace(/^\./, '')
  return (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    && url.pathname.startsWith(cookie.path)
    && (!cookie.secure || url.protocol === 'https:')
}

async function accountBackground(cookies, { remove = undefined } = {}) {
  const end = source.lastIndexOf('\nexport default defineBackground')
  assert.notEqual(end, -1, 'account adapter source must remain before background bootstrap')
  const adapterSource = `${source.slice(0, end)}\nexport { locallySignOutAccount, companyBrowserAuthentication }\n`
  const compiled = ts.transpileModule(adapterSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const local = {}
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => ({ [key]: local[key] }),
        set: async value => Object.assign(local, value),
        remove: async key => { delete local[key] },
      },
      session: { remove: async () => {} },
    },
    cookies: {
      getAll: async ({ url, domain }) => typeof url === 'string'
        ? cookies.filter(cookie => cookieMatchesUrl(cookie, url))
        : cookies.filter(cookie => cookie.domain.replace(/^\./, '') === domain || cookie.domain.endsWith(`.${domain}`)),
      remove: async ({ url, name, storeId }) => {
        if (remove !== undefined) return remove({ url, name, storeId })
        const index = cookies.findIndex(cookie => cookie.name === name && cookie.storeId === storeId && cookieMatchesUrl(cookie, url))
        if (index === -1) return null
        const [removed] = cookies.splice(index, 1)
        return { name: removed.name, domain: removed.domain, path: removed.path, storeId: removed.storeId }
      },
    },
  }
  const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}#account-access-${Date.now()}`)
  return { logout: module.locallySignOutAccount, isAuthenticated: module.companyBrowserAuthentication, cleanup: () => { delete globalThis.chrome } }
}

test('logout removes every company authentication cookie before reporting guest mode', async () => {
  const cookies = [
    { name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' },
    { name: 'midea_auth_uat', domain: 'anapi-uat.annto.com', path: '/', secure: true, storeId: '0' },
    { name: 'midea_auth_uat', domain: 'anapi-uat.annto.com', path: '/api', secure: true, storeId: '0' },
    { name: 'unrelated', domain: '.annto.com', path: '/', secure: true, storeId: '0' },
  ]
  const background = await accountBackground(cookies)
  try {
    const snapshot = await background.logout()
    assert.equal(snapshot.status, 'guest')
    assert.equal(await background.isAuthenticated(), false, 'post-logout authentication detection must remain guest without the local flag')
    assert.deepEqual(cookies.map(({ name, domain, path }) => ({ name, domain, path })), [
      { name: 'unrelated', domain: '.annto.com', path: '/' },
    ], 'logout must not leave company authentication cookies behind')
  } finally {
    background.cleanup()
  }
})

test('logout reports the surviving cookie metadata when Chrome cannot clear it', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const background = await accountBackground(cookies, { remove: async () => null })
  try {
    await assert.rejects(background.logout(), /公司账号退出失败：认证 Cookie 仍存在（MAS_TGC_UAT @ \.annto\.com\/）。/)
  } finally {
    background.cleanup()
  }
})

test('logout invalidates protected continuation and active queries', () => {
  assert.match(source, /for \(const controller of activeKnowledgeQueries\.values\(\)\) controller\.abort\(\)/)
  assert.match(source, /remove\(KNOWLEDGE_SESSION_STORAGE_KEY\)/)
})

test('knowledge and code connector paths enforce account access in the background', () => {
  const selected = source.indexOf('async function respondToSelectedSourceScope')
  const query = source.indexOf('async function respondToKnowledge')
  assert.ok(selected >= 0 && source.indexOf('await assertAccountAccessForProtectedSource()', selected) > selected)
  assert.ok(query >= 0 && source.indexOf('await assertAccountAccessForProtectedSource()', query) > query)
})

test('account access exposes the personal-key company gateway flow', () => {
  assert.match(source, /modelMode: 'company-pending'/)
  assert.match(source, /可使用个人 Key 配置公司网关模型/)
  assert.match(source, /company-gateway-probe\/v1/)
})
