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

async function accountBackground(cookies, {
  remove = undefined,
  pageLogout = undefined,
  logoutNavigationTimeoutMs = undefined,
} = {}) {
  const end = source.lastIndexOf('\nexport default defineBackground')
  assert.notEqual(end, -1, 'account adapter source must remain before background bootstrap')
  const adapterSource = `${source.slice(0, end)}\nexport { locallySignOutAccount, companyBrowserAuthentication }\n`
  const compiled = ts.transpileModule(adapterSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const local = {}
  const portalTab = { id: 42, active: true, url: 'https://wb-uat.annto.com/index' }
  const executions = []
  const navigationListeners = new Set()
  const emitNavigation = (url) => {
    for (const listener of navigationListeners) listener({ tabId: portalTab.id, frameId: 0, url })
  }
  const pageLogoutHandler = pageLogout ?? (async (request) => {
    emitNavigation(request.args[0])
    return { ok: true }
  })
  globalThis.__ACCRUI_TEST_EMIT_COMPANY_LOGOUT_NAVIGATION = emitNavigation
  if (logoutNavigationTimeoutMs !== undefined) globalThis.__ACCRUI_COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS = logoutNavigationTimeoutMs
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
    tabs: {
      query: async () => [portalTab],
    },
    scripting: {
      executeScript: async (request) => {
        executions.push(request)
        return [{ result: await pageLogoutHandler(request) }]
      },
    },
    webNavigation: {
      onCommitted: { addListener: (listener) => navigationListeners.add(listener), removeListener: (listener) => navigationListeners.delete(listener) },
    },
  }
  const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}#account-access-${Date.now()}`)
  return {
    logout: module.locallySignOutAccount,
    isAuthenticated: module.companyBrowserAuthentication,
    executions,
    cleanup: () => {
      delete globalThis.__ACCRUI_COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS
      delete globalThis.__ACCRUI_TEST_EMIT_COMPANY_LOGOUT_NAVIGATION
      delete globalThis.chrome
    },
  }
}

test('logout removes every company authentication cookie before reporting guest mode', async () => {
  const cookies = [
    { name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' },
    { name: 'midea_auth_uat', domain: 'anapi-uat.annto.com', path: '/', secure: true, storeId: '0' },
    { name: 'midea_auth_uat', domain: 'anapi-uat.annto.com', path: '/api', secure: true, storeId: '0' },
    { name: 'OAM_ID', domain: '.annto.com', path: '/', secure: true, storeId: '0' },
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

test('logout invalidates the portal session before reporting guest mode', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  let portalSessionAuthenticated = true
  const background = await accountBackground(cookies, { pageLogout: async () => {
    portalSessionAuthenticated = false
    globalThis.__ACCRUI_TEST_EMIT_COMPANY_LOGOUT_NAVIGATION('http://signinuat.midea.com/logout?service=https://signinuat.midea.com/?service=https://wb-uat.annto.com')
    return { ok: true }
  } })
  try {
    const snapshot = await background.logout()
    assert.equal(portalSessionAuthenticated, false, 'portal must not remain authenticated after the side panel becomes guest')
    assert.equal(snapshot.status, 'guest')
    assert.deepEqual(background.executions[0], {
      target: { tabId: 42 },
      world: 'MAIN',
      func: background.executions[0].func,
      args: ['http://signinuat.midea.com/logout?service=https://signinuat.midea.com/?service=https://wb-uat.annto.com'],
    })
  } finally {
    background.cleanup()
  }
})

test('logout runs the portal-owned logout contract with the exact single-sign-on return service', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const background = await accountBackground(cookies)
  try {
    await background.logout()
    assert.equal(background.executions[0].world, 'MAIN')
    assert.equal(background.executions[0].func.name, 'logoutCompanyPortalInPage')
    assert.deepEqual(background.executions[0].args, ['http://signinuat.midea.com/logout?service=https://signinuat.midea.com/?service=https://wb-uat.annto.com'])
  } finally {
    background.cleanup()
  }
})

test('logout performs the authenticated request in the portal main world and then navigates top-level to SSO logout', () => {
  assert.match(source, /async function logoutCompanyPortalInPage[\s\S]*fetch\('\/api-auth\/ssoLogout', \{[\s\S]*credentials: 'include'/)
  assert.match(source, /logoutCompanyPortalInPage[\s\S]*window\.location\.assign\(singleSignOnLogoutUrl\)/)
})

test('logout waits for the same tab to commit the single-sign-on navigation before reporting guest mode', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const background = await accountBackground(cookies, { pageLogout: async () => ({ ok: true }), logoutNavigationTimeoutMs: 0 })
  try {
    await assert.rejects(background.logout(), /公司账号退出失败：统一登录状态未退出（统一登录退出跳转未发生/)
    assert.equal(await background.isAuthenticated(), true, 'an unobserved SSO redirect must not turn the side panel into guest mode')
    assert.equal(cookies.length, 1, 'local authentication cookies must remain when the SSO redirect does not commit')
  } finally {
    background.cleanup()
  }
})

test('injected page logout requires a confirmed response before navigating to single-sign-on logout', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const navigations = []
  globalThis.window = { location: { assign: (url) => { navigations.push(url); globalThis.__ACCRUI_TEST_EMIT_COMPANY_LOGOUT_NAVIGATION(url) } } }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: '0' }) })
  const background = await accountBackground(cookies, { pageLogout: async (request) => request.func(...request.args) })
  try {
    await background.logout()
    assert.deepEqual(navigations, ['http://signinuat.midea.com/logout?service=https://signinuat.midea.com/?service=https://wb-uat.annto.com'])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    background.cleanup()
  }
})

test('injected page logout does not navigate when the portal does not confirm logout', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const navigations = []
  globalThis.window = { location: { assign: (url) => navigations.push(url) } }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: '1' }) })
  const background = await accountBackground(cookies, { pageLogout: async (request) => request.func(...request.args) })
  try {
    await assert.rejects(background.logout(), /公司账号退出失败：门户会话未退出（服务未确认退出/)
    assert.deepEqual(navigations, [])
    assert.equal(await background.isAuthenticated(), true)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    background.cleanup()
  }
})

test('logout preserves the authenticated state when portal session invalidation fails', async () => {
  const cookies = [{ name: 'MAS_TGC_UAT', domain: '.annto.com', path: '/', secure: true, storeId: '0' }]
  const background = await accountBackground(cookies, { pageLogout: async () => ({ ok: false, error: 'network unavailable' }) })
  try {
    await assert.rejects(background.logout(), /公司账号退出失败：门户会话未退出/)
    assert.equal(await background.isAuthenticated(), true, 'a failed portal logout must not turn the side panel into guest mode')
    assert.equal(cookies.length, 1, 'local authentication cookies must remain for a retry after portal logout fails')
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
