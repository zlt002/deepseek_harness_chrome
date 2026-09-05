import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

const sourceUrl = new URL('../apps/chrome-extension/entrypoints/background/team-knowledge/page-scripts.ts', import.meta.url)
const compiled = await bundleTypescript(await readFile(sourceUrl, 'utf8'), sourceUrl)
const pageScripts = await import(`data:text/javascript,${encodeURIComponent(compiled)}`)

// Chrome sends the function's source to another JS world, not its module scope.
const serializeIntoPage = (name, globals) => runInNewContext(`(${pageScripts[name].toString()})`, globals)

test('extracted Team Knowledge page scripts retain origin checks when serialized without their module', async () => {
  const globals = { location: { protocol: 'https:', hostname: 'untrusted.example' } }
  for (const [name, input, error] of [
    ['inspectTeamDocParentInPage', '42', 'team_doc_wrong_origin'],
    ['createTeamDocInPage', {}, 'team_doc_wrong_origin'],
    ['rediscoverTeamDocInPage', { documentId: '42' }, 'team_doc_wrong_origin'],
    ['writeTeamDocInWebEdit', '# Content', 'team_doc_wrong_webedit_origin'],
  ]) {
    const result = await serializeIntoPage(name, globals)(input)
    assert.equal(result.ok, false, name)
    assert.equal(result.error, error, name)
  }
  assert.equal((await serializeIntoPage('waitForTeamKnowledgeUserConfirmation', globals)({})).status, 'unavailable')
  assert.equal(serializeIntoPage('showTeamKnowledgeReadbackFailure', globals)({}).shown, false)
})

test('serialized WebEdit write and readback retain the same body and distinct runtime operations', async () => {
  const calls = []
  const body = '# Verified content\n\n| Name | Value |\n| --- | --- |\n| Example | 42 |'
  const operation = name => async value => {
    calls.push({ name, value })
    return { ok: true, observed: { observedBody: value } }
  }
  const execute = serializeIntoPage('writeTeamDocInWebEdit', {
    location: { protocol: 'https:', hostname: 'webedit.midea.com' },
    APP: { openApi: { editor: { canvas: { getDocXml() {} } } } },
    __deepseekHarnessLightDocumentRuntime: {
      teamKnowledgeBatchReplace: operation('replace'),
      teamKnowledgeBatchVerify: operation('verify'),
    },
    __DSH_TEAM_DOC_PERSISTENCE_SETTLE_MS: 0,
    setTimeout,
  })
  for (const readOnly of [false, true]) {
    const result = await execute(body, readOnly)
    assert.equal(result.ok, true)
    assert.equal(result.readbackMatches, true)
    assert.equal(result.observedBody, body)
  }
  assert.deepEqual(calls, [{ name: 'replace', value: body }, { name: 'verify', value: body }])
})
