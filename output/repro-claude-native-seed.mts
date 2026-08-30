import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../.generated/harness-product/vendor/cordis/lib/index.js'
import { SessionStore, SessionId } from '../.generated/harness-product/packages/core/session/lib/index.js'
import { JsonlSessionPersistence } from '../.generated/harness-product/packages/session/session-persistence-jsonl/lib/index.js'
import { parseClaudeSession } from '../packages/harness-ui-workspace-picker/src/claude-import.mjs'

const sessionId = SessionId('claude-native-seed-probe')
const parsed = parseClaudeSession([
  JSON.stringify({ type: 'user', timestamp: '2026-08-20T01:00:00.000Z', message: { content: '检查问题' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T01:01:00.000Z', message: { model: 'claude-test', content: [{ type: 'text', text: '已检查' }] } }),
].join('\n'))

const root = await mkdtemp(join(tmpdir(), 'claude-native-seed-'))
try {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', packChunks: false })
  const session = ctx.sessions.prepare(sessionId, {
    seed: parsed.seed,
    meta: { cwd: process.cwd(), createdAt: Date.parse('2026-08-20T01:00:00.000Z'), seedLength: parsed.seed.length, agentPreset: 'default' },
  })
  if (session.events.at(-1)?.type !== 'session/end-seed') throw new Error('missing session/end-seed')
  if (!session.events.every((event, index) => event.seq === index)) throw new Error('non-contiguous event seq')
  if (session.header.seedLength !== parsed.seed.length) throw new Error('seedLength mismatch')
  const roles = session.deriveMessages().map(message => message.role)
  if (roles.join(',') !== 'user,assistant') throw new Error(`unexpected derived roles: ${roles.join(',')}`)
  await ctx.sessionPersistence.create(session.header)
  await ctx.sessionPersistence.append(session.id, session.events)
  const inspected = await ctx.sessionPersistence.inspect(session.id)
  const listed = await ctx.sessionPersistence.list()
  if (!inspected.events.every((event, index) => event.seq === index)) throw new Error('persisted seq is non-contiguous')
  if (!listed.some(header => header.id === session.id)) throw new Error('persisted session missing from list')
  const persistedRoles = inspected.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').map(event => event.type === 'user/message' ? 'user' : 'assistant')
  console.log(JSON.stringify({ root, eventCount: session.events.length, finalEvent: session.events.at(-1)?.type, seq: session.events.map(event => event.seq), seedLength: session.header.seedLength, roles, persistence: { inspect: true, list: true, eventCount: inspected.events.length, roles: persistedRoles } }))
  await ctx.fiber.dispose()
} finally {
  await rm(root, { recursive: true, force: true })
}
