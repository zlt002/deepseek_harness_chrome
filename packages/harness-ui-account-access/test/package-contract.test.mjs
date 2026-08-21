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
  assert.match(section, /账号、公司网关模型和用量统一在这里管理/)
  assert.match(section, /验证 Key 并加载/)
  assert.match(section, /退出公司账号/)
  assert.match(section, /退出会清除 wb-uat\.annto\.com 与公司 API 的登录状态/)
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
  assert.doesNotMatch(section, /selectedModel|type="radio"|设为默认模型/)
  assert.doesNotMatch(gateway, /默认模型必须在模型目录中/)
  assert.doesNotMatch(gateway, /agent-default-model/)
  assert.match(section, /if \(probe === undefined \|\| probe\.requestId !== request\?\.id\) return/)
  assert.doesNotMatch(gateway, /displayName:/)
  assert.match(gateway, /api\.settings\.mutate/)
  assert.match(gateway, /api\.credentials\.set/)
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
  assert.match(css, /\.actions button, \.keyRow button \{[^}]*height: 36px;[^}]*border-radius: 18px;/)
  assert.match(css, /\.modelCatalog \{[^}]*overflow-y: auto;[^}]*--dsh-scrollbar-thumb: var\(--dsw-alias-scrollbar-bg-l2\);/)
  assert.match(css, /:focus-visible[^}]*box-shadow: 0 0 0 2px var\(--dsw-alias-border-l3\)/)
})

test('is registered in every product plugin manifest', async () => {
  const files = await Promise.all([
    source('../../scripts/register-native-host.mjs'),
    source('../../scripts/build-harness-client-plugins.mjs'),
    source('../../apps/native-server/src/harness-process.mjs'),
    source('../../release/mac-lite/build-mac-production.mjs'),
    source('../../release/windows-lite/windows-release.mjs'),
    source('../../release/windows-lite/product-ui-smoke.mjs'),
    source('../../package.json'),
  ])
  for (const contents of files) assert.match(contents, /harness-ui-account-access/)
})
