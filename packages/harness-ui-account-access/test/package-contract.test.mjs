import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const source = path => readFile(new URL(path, root), 'utf8')

test('declares an out-of-tree account settings plugin without upstream source imports', async () => {
  await access(new URL('package.json', root))
  const [manifest, client, section, gateway, onboarding] = await Promise.all([source('package.json'), source('src/client/index.ts'), source('src/client/AccountAccessSection.tsx'), source('src/client/company-gateway.ts'), source('src/client/CompanyGatewayOnboarding.tsx')])
  assert.match(manifest, /"name": "@accrui\/harness-ui-account-access"/)
  assert.match(client, /settings\.section/)
  assert.match(section, /账号、网关与模型统一管理/)
  assert.match(section, /className=\{css\.titleRow\}/)
  assert.match(section, /className=\{css\.headingActions\}/)
  assert.match(section, />登录<\/button>/)
  assert.match(section, />检测<\/button>/)
  assert.doesNotMatch(section, />登录公司账号<\/button>/)
  assert.doesNotMatch(section, />重新检测<\/button>/)
  assert.doesNotMatch(section, /游客模式/)
  assert.match(section, /authenticated \? <strong className=\{css\.accountName\}>\{account\.displayName \?\? '公司账号'\}<\/strong> : null/)
  assert.match(section, /验证 Key 并加载/)
  assert.match(section, />退出<\/button>/)
  assert.doesNotMatch(section, /退出公司账号/)
  assert.match(section, /退出会清除 wb-uat\.annto\.com 与公司 API 的登录状态/)
  assert.match(section, /account\.status === 'unavailable' \? <p className=\{css\.error\} role="alert">\{account\.message \?\? '账号状态暂时无法验证，请检查网络后重试。'\}<\/p> : null/)
  assert.match(gateway, /COMPANY_GATEWAY_ANTHROPIC_BASE_URL/)
  assert.match(gateway, /COMPANY_GATEWAY_OPENAI_BASE_URL/)
  assert.match(section, /Anthropic URL/)
  assert.match(section, /OpenAI URL/)
  assert.match(section, /编辑公司网关/)
  assert.match(section, /模型目录/)
  assert.match(section, /公司网关模型目录/)
  assert.match(section, /modelDrafts/)
  assert.match(section, /模型 ID/)
  assert.match(section, /显示名称（留空使用模型 ID）/)
  assert.match(section, /支持图片输入/)
  assert.match(section, /input: event\.target\.checked \? \['text', 'image'\] : undefined/)
  assert.match(section, /companyGatewayModelDraftFailure/)
  assert.match(section, /capability\.protocol !== protocol/)
  assert.match(section, /capability\.modelId !== currentModelId/)
  assert.match(section, /verifySelectedModel/)
  assert.match(section, /验证首个模型的 Agent 工具能力/)
  assert.match(section, /请先验证首个模型是否支持 Agent 工具调用/)
  assert.match(section, /setKeyDraft\(event\.target\.value\); setProbedGateway\(undefined\); setProbedKey\(undefined\); setRequest\(undefined\)/)
  assert.match(section, /setProtocol\(event\.target\.value as CompanyGatewayProtocol\); setProbedGateway\(undefined\); setProbedKey\(undefined\); setRequest\(undefined\)/)
  assert.match(section, /自定义设置/)
  assert.match(section, /gatewayBeforeEdit/)
  assert.match(section, /cancelGatewayEditor/)
  assert.match(section, /setEditingGateway\(false\)/)
  assert.match(client, /settings\.onboarding/)
  assert.match(client, /accrui-company-gateway/)
  assert.match(client, /modelDirectories/)
  assert.match(onboarding, /稍后配置/)
  assert.match(onboarding, /hasUsableModelProvider/)
  assert.match(onboarding, /selectInitialModel/)
  assert.match(onboarding, /capability\.modelId !== selectedModel/)
  assert.match(onboarding, /verifySelectedModel/)
  assert.match(onboarding, /验证所选模型的 Agent 工具能力/)
  assert.match(onboarding, /请先验证所选模型是否支持 Agent 工具调用/)
  assert.match(onboarding, /setKeyDraft\(event\.target\.value\); setGateway\(undefined\); setLoadedKey\(undefined\); setRequest\(undefined\)/)
  assert.match(onboarding, /setProtocol\(event\.target\.value as CompanyGatewayProtocol\); setGateway\(undefined\); setLoadedKey\(undefined\); setRequest\(undefined\)/)
  assert.doesNotMatch(section, /selectedModel|type="radio"|设为默认模型/)
  assert.doesNotMatch(gateway, /默认模型必须在模型目录中/)
  assert.doesNotMatch(gateway, /agent-default-model/)
  assert.match(section, /if \(probe === undefined \|\| probe\.requestId !== request\?\.id\) return/)
  assert.doesNotMatch(gateway, /displayName:/)
  assert.match(gateway, /api\.settings\.mutate/)
  assert.match(gateway, /api\.credentials\.set/)
  assert.match(section, /capability\.tools !== true/)
  assert.ok(gateway.indexOf('api.settings.mutate') < gateway.indexOf('api.credentials.set'))
  assert.doesNotMatch(`${client}\n${section}`, /deepseek-harness\/packages\/.*\/src/)
})

test('account, gateway, and onboarding styles use the settings design tokens', async () => {
  const css = await source('src/client/AccountAccessSection.module.css')

  // `--dsh-color-*` has no dark-theme contract in Harness. Pairing it with a
  // light literal makes the account card look white inside a dark shell.
  assert.doesNotMatch(css, /--dsh-color-|#[0-9a-f]{3,8}|rgba?\(/i)
  for (const token of [
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-module-platform',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l2',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-error-primary',
  ]) assert.match(css, new RegExp(token))

  assert.match(css, /\.gatewayField input, \.gatewayField select,[\s\S]*?\.modelInput \{[^}]*height: 32px;[^}]*font-size: 14px;[^}]*line-height: 22px;/)
  assert.match(css, /\.gatewayEditButton, \.gatewaySecondaryButton, \.gatewayCancelButton, \.gatewaySaveButton \{[^}]*height: 28px;[^}]*border-radius: 14px;/)
  assert.match(css, /\.headingActions button, \.keyRow button \{[^}]*height: 32px;[^}]*border-radius: 16px;/)
  assert.match(css, /\.heading h2 \{[^}]*--accrui-settings-page-title-size/)
  assert.match(css, /\.heading \{[^}]*align-items: center;/)
  assert.match(css, /\.accountName \{ font-size: 14px; line-height: 22px; font-weight: 500; \}/)
  assert.match(css, /\.modelCatalog \{[^}]*overflow-y: auto;[^}]*--dsh-scrollbar-thumb: var\(--dsw-alias-scrollbar-bg-l2\);/)
  assert.match(css, /:focus-visible[^}]*box-shadow: 0 0 0 2px var\(--dsw-alias-border-l3\)/)
})

test('is registered in the product plugin manifest and release closure', async () => {
  const [productPluginManifest, macRelease, windowsRelease, productUiSmoke] = await Promise.all([
    source('../../apps/native-server/src/product-plugin-manifest.mjs'),
    source('../../release/mac-lite/build-mac-production.mjs'),
    source('../../release/windows-lite/windows-release.mjs'),
    source('../../release/windows-lite/product-ui-smoke.mjs'),
  ])
  assert.match(productPluginManifest, /harness-ui-account-access/)
  assert.match(macRelease, /PRODUCT_UI_PLUGIN_DIRECTORIES/)
  assert.match(windowsRelease, /PRODUCT_UI_PLUGIN_DIRECTORIES/)
  assert.match(productUiSmoke, /PRODUCT_UI_PLUGIN_PACKAGE_NAMES/)
})
