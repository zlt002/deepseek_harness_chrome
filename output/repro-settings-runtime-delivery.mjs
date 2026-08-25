#!/usr/bin/env node
/**
 * Fast, read-only delivery check for the two settings labels the side panel
 * renders inside the Native Host iframe. It intentionally follows the live
 * launch chain rather than treating a rebuilt extension bundle as proof.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = homedir()
const expectedRoot = resolve(projectRoot, '.generated/harness-product')
const launcher = resolve(home, 'Library/Application Support/DeepSeekHarness/com.deepseek.harness.chrome')
const installedPlugins = resolve(home, 'Library/Application Support/DeepSeekHarness/native-server/product-plugins')
const wxtDev = resolve(projectRoot, 'apps/chrome-extension/.output/chrome-mv3-dev')
const chromeProfilePreferences = resolve(home, 'Library/Application Support/Google/Chrome/Profile 1/Secure Preferences')
const devExtensionId = 'lmignogiadonjcpigkehfnmdindgfckn'

function content(path) {
  if (!existsSync(path)) throw new Error(`Missing required delivery artifact: ${path}`)
  return readFileSync(path, 'utf8')
}

function expectText(path, required, forbidden) {
  const value = content(path)
  if (!value.includes(required)) throw new Error(`${path} is missing ${JSON.stringify(required)}`)
  if (forbidden !== undefined && value.includes(forbidden)) throw new Error(`${path} still contains ${JSON.stringify(forbidden)}`)
}

function launchRoot() {
  const match = /^export DSH_ROOT='([^']+)'$/m.exec(content(launcher))
  if (match === null) throw new Error(`No DSH_ROOT export found in ${launcher}`)
  return resolve(match[1])
}

function activeCliCommands() {
  const output = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  return output.split('\n').filter(line => line.includes('/apps/cli/lib/bin.js --patch'))
}

function verifyLoadedExtensionTarget() {
  const preferences = JSON.parse(content(chromeProfilePreferences))
  const configuredPath = preferences.extensions?.settings?.[devExtensionId]?.path
  if (configuredPath !== wxtDev) {
    throw new Error(`Chrome Profile 1 dev extension ${devExtensionId} is registered from ${String(configuredPath)}, expected ${wxtDev}`)
  }
  const wxt = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  if (!wxt.includes('wxt/bin/wxt.mjs --port 3101')) throw new Error('No WXT development server is running on port 3101')
}

// Source -> built plugin -> public copy -> the WXT directory Chrome Profile 1
// has registered as its unpacked extension.
expectText(resolve(projectRoot, 'packages/harness-ui-account-access/src/client/AccountAccessSection.tsx'), '>退出<', '退出公司账号')
expectText(resolve(projectRoot, 'packages/harness-ui-account-access/lib/client.js'), 'children: "退出"', '退出公司账号')
expectText(resolve(projectRoot, 'apps/chrome-extension/public/plugins/@accrui/harness-ui-account-access/client.js'), 'children: "退出"', '退出公司账号')
expectText(resolve(wxtDev, 'plugins/@accrui/harness-ui-account-access/client.js'), 'children: "退出"', '退出公司账号')
expectText(resolve(wxtDev, 'plugins/@deepseek-ai/dsh-client-ui-settings-general/client.js'), '"openDocument": "配置文件"', '"openDocument": "打开配置文件"')
verifyLoadedExtensionTarget()

const root = launchRoot()
if (root !== expectedRoot) throw new Error(`Native Host launches ${root}, expected ${expectedRoot}`)
expectText(resolve(root, 'packages/client/ui-settings-general/lib/client.js'), '"openDocument": "配置文件"', '"openDocument": "打开配置文件"')
expectText(resolve(installedPlugins, 'harness-ui-account-access/lib/client.js'), 'children: "退出"', '退出公司账号')

const active = activeCliCommands()
if (active.length > 0 && !active.every(command => command.includes(`${expectedRoot}/apps/cli/lib/bin.js`))) {
  throw new Error(`An active Harness Web process is not using ${expectedRoot}: ${active.join(' | ')}`)
}

console.log(`PASS: Chrome Profile 1 extension=${devExtensionId}; WXT dev=${wxtDev}; Native Host root=${root}; active Harness process(es)=${active.length}`)
