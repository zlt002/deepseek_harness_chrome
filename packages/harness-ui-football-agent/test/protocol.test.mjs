import assert from 'node:assert/strict'
import test from 'node:test'
import { FOOTBALL_AGENT_SOURCE, FOOTBALL_AGENT_VERSION, createFootballAgentMessage, parentOriginFromReferrer, parseFootballContextMessage } from '../src/client/protocol.js'

const parent = {}
const origin = 'http://localhost:3100'
const payload = {
  match: {
    id: 'match-1', league: '英超', time: '2026-08-29T20:00:00+08:00', home: '主队', away: '客队', status: 'scheduled', probabilities: [0.4, 0.3, 0.3],
  },
  analysis: { status: 'idle' },
}

test('accepts only the versioned football context from the declared parent origin', () => {
  const message = parseFootballContextMessage({
    source: parent,
    origin,
    data: { source: FOOTBALL_AGENT_SOURCE, version: FOOTBALL_AGENT_VERSION, type: 'football-agent/context', payload },
  }, parent, origin)
  assert.deepEqual(message?.payload, payload)
  assert.equal(parseFootballContextMessage({ source: {}, origin, data: message }, parent, origin), undefined)
  assert.equal(parseFootballContextMessage({ source: parent, origin: 'http://evil.example', data: message }, parent, origin), undefined)
  assert.equal(parseFootballContextMessage({ source: parent, origin, data: { ...message, version: 2 } }, parent, origin), undefined)
})

test('derives a concrete parent origin and emits only allowlisted outbound messages', () => {
  assert.equal(parentOriginFromReferrer('http://localhost:3100/agent?match=1'), origin)
  assert.equal(parentOriginFromReferrer('not a url'), undefined)
  assert.deepEqual(createFootballAgentMessage('football-agent/request-analysis', { matchId: 'match-1' }), {
    source: FOOTBALL_AGENT_SOURCE,
    version: FOOTBALL_AGENT_VERSION,
    type: 'football-agent/request-analysis',
    payload: { matchId: 'match-1' },
  })
  assert.throws(() => createFootballAgentMessage('football-agent/unknown'), /Unsupported football agent message/)
})

test('accepts percentage probabilities only in the 0 to 100 contract range', () => {
  const context = {
    source: parent,
    origin,
    data: { source: FOOTBALL_AGENT_SOURCE, version: FOOTBALL_AGENT_VERSION, type: 'football-agent/context', payload: {
      ...payload,
      analysis: {
        status: 'completed',
        prediction: { predictedScore: '2 : 1', probabilities: [51, 23, 26], confidence: 51, verdict: '主胜' },
      },
    } },
  }
  assert.ok(parseFootballContextMessage(context, parent, origin))
  context.data.payload.analysis.prediction.probabilities = [1.1, 0, 0]
  assert.equal(parseFootballContextMessage(context, parent, origin), undefined)
})
