function switchValues(value) {
  return { enabled: value?.enabled === true, remember: value?.remember === true }
}

/** Keep switch feedback visible until the extension acknowledges the same command. */
export function optimisticScopeSwitch(sequence, sessionId, current, update) {
  return { sequence, sessionId, ...switchValues(current), ...update }
}

export function shownScopeSwitch(snapshot, pending) {
  return pending === undefined || pending.sessionId !== snapshot?.sessionId ? switchValues(snapshot) : switchValues(pending)
}

export function acknowledgeScopeSwitch(pending, snapshot) {
  const requestSequence = snapshot?.requestSequence
  return pending !== undefined && pending.sessionId === snapshot?.sessionId && requestSequence !== undefined && requestSequence >= pending.sequence ? undefined : pending
}
