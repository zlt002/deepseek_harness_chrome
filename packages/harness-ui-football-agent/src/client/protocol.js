export const FOOTBALL_AGENT_SOURCE = 'zqapp-football-agent'
export const FOOTBALL_AGENT_VERSION = 1

const ANALYSIS_STATUSES = new Set(['idle', 'running', 'completed', 'failed'])
const OUTBOUND_TYPES = new Set([
  'football-agent/ready',
  'football-agent/request-analysis',
  'football-agent/open-records',
])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value) {
  return value === undefined || typeof value === 'string'
}

function percentages(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100)
}

function validMatch(match) {
  return record(match)
    && typeof match.id === 'string'
    && typeof match.league === 'string'
    && typeof match.time === 'string'
    && typeof match.home === 'string'
    && typeof match.away === 'string'
    && typeof match.status === 'string'
    && optionalString(match.score)
    && (match.probabilities === undefined || percentages(match.probabilities))
}

function validPrediction(prediction) {
  return record(prediction)
    && typeof prediction.predictedScore === 'string'
    && percentages(prediction.probabilities)
    && typeof prediction.confidence === 'number'
    && Number.isFinite(prediction.confidence)
    && prediction.confidence >= 0
    && prediction.confidence <= 100
    && typeof prediction.verdict === 'string'
}

function validEvidence(evidence) {
  return Array.isArray(evidence) && evidence.every(item => record(item)
    && Number.isInteger(item.ordinal)
    && typeof item.title === 'string'
    && typeof item.summary === 'string'
    && typeof item.sourceName === 'string'
    && typeof item.sourceUrl === 'string'
    && typeof item.credibility === 'number'
    && Number.isFinite(item.credibility)
    && typeof item.verificationStatus === 'string')
}

function validAnalysis(analysis) {
  return record(analysis)
    && typeof analysis.status === 'string'
    && ANALYSIS_STATUSES.has(analysis.status)
    && optionalString(analysis.runId)
    && optionalString(analysis.executionMode)
    && optionalString(analysis.provider)
    && optionalString(analysis.modelVersion)
    && optionalString(analysis.errorMessage)
    && optionalString(analysis.summary)
    && (analysis.evidenceCount === undefined || (Number.isInteger(analysis.evidenceCount) && analysis.evidenceCount >= 0))
    && (analysis.conflictCount === undefined || (Number.isInteger(analysis.conflictCount) && analysis.conflictCount >= 0))
    && (analysis.prediction === undefined || validPrediction(analysis.prediction))
    && (analysis.evidence === undefined || validEvidence(analysis.evidence))
}

/** Return a concrete parent origin only when the embedding referrer is usable. */
export function parentOriginFromReferrer(referrer) {
  if (typeof referrer !== 'string' || referrer === '') return undefined
  try {
    const origin = new URL(referrer).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** Validate the only inbound product message after the caller checks its frame boundary. */
export function parseFootballContextMessage(event, parent, parentOrigin) {
  if (parentOrigin === undefined || event.source !== parent || event.origin !== parentOrigin) return undefined
  const message = event.data
  if (!record(message)
    || message.source !== FOOTBALL_AGENT_SOURCE
    || message.version !== FOOTBALL_AGENT_VERSION
    || message.type !== 'football-agent/context'
    || !record(message.payload)
    || !validMatch(message.payload.match)
    || !validAnalysis(message.payload.analysis)) return undefined
  return message
}

/** Build an allowlisted outbound message; callers still choose a concrete target origin. */
export function createFootballAgentMessage(type, payload = {}) {
  if (!OUTBOUND_TYPES.has(type)) throw new Error(`Unsupported football agent message: ${String(type)}`)
  return {
    source: FOOTBALL_AGENT_SOURCE,
    version: FOOTBALL_AGENT_VERSION,
    type,
    payload,
  }
}
