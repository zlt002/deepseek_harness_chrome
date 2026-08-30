import { randomUUID } from 'node:crypto'

const directoryImports = new WeakMap()

/** Create or safely append an already-parsed native history without prompting a model. */
export async function importNativeHistory(directory, ctx, input) {
  return serializeDirectoryImport(directory, () => performImport(directory, ctx, input))
}

async function performImport(directory, ctx, input) {
  const prepared = await directory.prepare(input)
  if (prepared.kind === 'existing') return { kind: 'existing', sessionId: prepared.sessionId, status: 'unchanged-source' }
  if (prepared.kind === 'conflict') return prepared
  const workspace = await ctx.workspaceRegistry.resolveByPath(input.workspacePath)
  if (workspace === undefined) throw new Error('目标 Harness Workspace 不存在或已不可用；请刷新侧边栏后重新选择。')
  if (prepared.kind === 'pending') return recoverPendingImport(directory, ctx, workspace, input, prepared)
  if (prepared.kind === 'append') {
    const persisted = await ctx.sessionPersistence.inspect(prepared.sessionId)
    const existing = (await directory.readRegistry())[prepared.sourceKey]
    if (!Number.isSafeInteger(existing?.harnessNextSeq) || !Number.isSafeInteger(existing?.seedEventCount)) {
      return conflict(prepared, '旧导入记录缺少安全增量所需的游标；请重新导入为副本。')
    }
    if (existing.harnessNextSeq !== persisted.events.length) return conflict(prepared, '现有 Harness 会话已继续对话，不能把旧来源增量插入其后；请重新导入为副本。')
    const rebased = rebaseSeed(prepared.seed, persisted.events)
    const finalEventCount = persisted.events.length + rebased.length
    // There is deliberately no await between this final live check and append().
    // The persistence coordinator serializes append against a concurrent resume;
    // an already-reserved resume rejects the append instead of diverging its log.
    if (ctx.sessions.get(prepared.sessionId) !== undefined) {
      return conflict(prepared, '现有 Harness 会话仍在运行，不能向其历史追加来源记录；请关闭后重试或重新导入为副本。')
    }
    await directory.reserve({
      sourceKey: prepared.sourceKey, sessionId: prepared.sessionId, sourceRoot: input.sourceRoot,
      source: prepared.revision, sourceIdentity: prepared.sourceIdentity,
      seedSignatureValue: prepared.seedSignature, seedEventCount: existing.seedEventCount + prepared.seed.length,
      harnessNextSeq: finalEventCount,
      pending: { mode: 'append', previousHarnessNextSeq: persisted.events.length, previousSeedEventCount: existing.seedEventCount },
    })
    try {
      await ctx.sessionPersistence.append(prepared.sessionId, rebased)
    } catch (error) {
      if (isConcurrentResume(error)) return conflict(prepared, '现有 Harness 会话正在打开或已经产生新记录；请重新导入为副本。')
      throw error
    }
    await directory.commit({
      sourceKey: prepared.sourceKey, sessionId: prepared.sessionId, sourceRoot: input.sourceRoot,
      source: prepared.revision, sourceIdentity: prepared.sourceIdentity,
      seedSignatureValue: prepared.seedSignature, seedEventCount: existing.seedEventCount + prepared.seed.length,
      harnessNextSeq: finalEventCount,
    })
    return { kind: 'imported', sessionId: prepared.sessionId, status: 'appended' }
  }
  const preset = await ctx.agentPresets.resolve()
  const sessionId = `claude-import-${randomUUID()}`
  const session = ctx.sessions.prepare(sessionId, {
    seed: prepared.seed,
    meta: {
      cwd: input.workspacePath,
      agentPreset: preset.id,
      seedLength: prepared.seed.length,
      ...Number.isSafeInteger(prepared.createdAt) ? { createdAt: prepared.createdAt } : {},
    },
  })
  await directory.reserve({
    sourceKey: prepared.sourceKey, sessionId, sourceRoot: input.sourceRoot,
    source: prepared.revision, sourceIdentity: prepared.sourceIdentity,
    seed: prepared.seed, seedEventCount: prepared.seed.length, harnessNextSeq: session.events.length,
    pending: { mode: 'seed' },
  })
  await ctx.sessionPersistence.create(session.header)
  await ctx.sessionPersistence.append(sessionId, session.events)
  await workspace.attachSession(sessionId)
  await directory.commit({
    sourceKey: prepared.sourceKey, sessionId, sourceRoot: input.sourceRoot,
    source: prepared.revision, sourceIdentity: prepared.sourceIdentity,
    seed: prepared.seed, seedEventCount: prepared.seed.length, harnessNextSeq: session.events.length,
  })
  return { kind: 'imported', sessionId, status: 'seeded', details: prepared.details }
}

async function recoverPendingImport(directory, ctx, workspace, input, prepared) {
  let persisted
  try {
    persisted = await ctx.sessionPersistence.inspect(prepared.sessionId)
  } catch (error) {
    if (!isMissingPersistence(error)) throw error
  }
  const expected = prepared.harnessNextSeq
  if (persisted === undefined) {
    if (prepared.pending.mode !== 'seed') return conflict(prepared, '上次增量导入的原生会话已不存在，不能安全恢复；请重新导入为副本。')
    const session = await prepareSeedSession(ctx, prepared.sessionId, input.workspacePath, prepared)
    await ctx.sessionPersistence.create(session.header)
    await ctx.sessionPersistence.append(prepared.sessionId, session.events)
  } else if (persisted.events.length === expected && (prepared.pending.mode === 'append' || persisted.events.at(-1)?.type === 'session/end-seed')) {
    // The prior request wrote the cold session but did not finish attaching it
    // to its Workspace or committing the final registry record.
  } else if (prepared.pending.mode === 'seed' && persisted.events.length === 0) {
    const session = await prepareSeedSession(ctx, prepared.sessionId, input.workspacePath, prepared)
    await ctx.sessionPersistence.append(prepared.sessionId, session.events)
  } else if (prepared.pending.mode === 'append' && persisted.events.length === prepared.pending.previousHarnessNextSeq) {
    if (ctx.sessions.get(prepared.sessionId) !== undefined) return conflict(prepared, '现有 Harness 会话仍在运行，不能恢复来源增量；请关闭后重试或重新导入为副本。')
    await ctx.sessionPersistence.append(prepared.sessionId, rebaseSeed(prepared.seed, persisted.events))
  } else {
    return conflict(prepared, '上次导入只写入了部分原生历史，不能安全恢复；请重新导入为副本。')
  }
  if (prepared.pending.mode === 'seed') await workspace.attachSession(prepared.sessionId)
  await directory.commit({
    sourceKey: prepared.sourceKey, sessionId: prepared.sessionId, sourceRoot: input.sourceRoot,
    source: prepared.revision, sourceIdentity: prepared.sourceIdentity,
    seedSignatureValue: prepared.seedSignature, seedEventCount: prepared.seedEventCount,
    harnessNextSeq: prepared.harnessNextSeq,
  })
  return { kind: 'imported', sessionId: prepared.sessionId, status: 'recovered', details: prepared.details }
}

async function prepareSeedSession(ctx, sessionId, workspacePath, prepared) {
  const preset = await ctx.agentPresets.resolve()
  return ctx.sessions.prepare(sessionId, {
    seed: prepared.seed,
    meta: {
      cwd: workspacePath,
      agentPreset: preset.id,
      seedLength: prepared.seed.length,
      ...Number.isSafeInteger(prepared.createdAt) ? { createdAt: prepared.createdAt } : {},
    },
  })
}

function isMissingPersistence(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|does not exist|unknown session|missing persistence/i.test(message)
}

function serializeDirectoryImport(directory, operation) {
  const previous = directoryImports.get(directory) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  directoryImports.set(directory, current.then(() => undefined, () => undefined))
  return current
}

function conflict(prepared, reason) {
  return { kind: 'conflict', sourceKey: prepared.sourceKey, sessionId: prepared.sessionId, reason }
}

function isConcurrentResume(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /persisted preparation is reserved|append seq mismatch|while it is live|already has a live persistence owner/i.test(message)
}

/** Rebase a source-only suffix over the persisted Harness log. */
export function rebaseSeed(seed, previous) {
  const seqOffset = previous.length
  const sourceOffset = seed[0]?.seq ?? seqOffset
  const seqDelta = seqOffset - sourceOffset
  return seed.map((event, index) => ({
    ...event,
    seq: seqOffset + index,
    // The parsed suffix already carries the final turn numbers from the full
    // Claude transcript. Only its event seqs move past the persisted
    // session/end-seed marker inserted after the original import.
    ...Array.isArray(event.sourceEventSeqs) ? {
      sourceEventSeqs: event.sourceEventSeqs.map(sourceSeq => sourceSeq < sourceOffset ? sourceSeq : sourceSeq + seqDelta),
    } : {},
  }))
}
