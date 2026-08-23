/**
 * Read-only model-picker guard for a running Harness Web Host.
 *
 * Usage:
 *   DSH_WEB_URL=http://127.0.0.1:53566 node output/repro-company-gateway-model-picker.mjs
 *
 * It deliberately reads `llm.models`, the complete host catalog that feeds
 * the picker, rather than inspecting the visible (and possibly scrolled)
 * portion of the menu. No settings, credentials, or session state is written.
 */
import assert from 'node:assert/strict'

const base = new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:53566')
const provider = 'annto-company-gateway'

async function rpc(method, payload = {}) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(new URL(`/api/${method}`, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`)
  const body = await response.json()
  assert.equal(body.type, 'server-response', `${method} did not return a server response`)
  assert.equal(body.rpcId, rpcId, `${method} returned a mismatched rpc id`)
  assert.equal(body.result?.ok, true, `${method} failed: ${body.result?.error?.code ?? 'unknown'}`)
  return body.result.value
}

const catalog = await rpc('llm.models')
const group = catalog.groups.find(candidate => candidate.id === provider)

// Exact symptom guard: this is the provider/model pair ModelSelect can render.
assert.ok(group, `model picker catalog is missing provider ${provider}`)
assert.ok(group.models.length > 0, `model picker catalog has no models for ${provider}`)

// Do not print catalog payloads: provider IDs and counts are sufficient, and
// no diagnostic path here ever reads credentials.
console.log(JSON.stringify({
  provider,
  companyModelCount: group.models.length,
  providerIds: catalog.groups.map(candidate => candidate.id),
  providerFailures: catalog.failures.map(failure => failure.id),
}))
