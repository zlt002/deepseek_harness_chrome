import { createSnapshotStore, type ClientContext, type SessionFace, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserTargetControl, BrowserTargetPanel, type BrowserTargetInjected } from './BrowserTargetControl.tsx'
import { FullscreenReturnControl, type FullscreenReturnControlInjected } from './FullscreenReturnControl.tsx'
import { HarnessReconnectAction, type HarnessReconnectActionInjected } from './HarnessReconnectAction.tsx'
import { activeTabBridgeConfig, createBrowserTargetBridge } from './active-tab-bridge.ts'
import { restoreHandoffSession } from './session-handoff.ts'
import { BrowserTargetSessionRunLock, shouldCaptureSessionRunTarget, shouldReconcileSessionRunTarget } from './session-run-lock.ts'

export const inject = ['slots', 'sessions', 'settingsQuickActions', 'composerSubmissionTransforms']

/** Mount the accepted e327 Browser Target UI through public slots. */
export function apply(ctx: ClientContext): void {
  const config = activeTabBridgeConfig()
  const quickActions = ctx.get('settingsQuickActions')!
  const fullscreenTab = config?.surface === 'fullscreen-tab'
  const fullscreenTabSupported = new URLSearchParams(window.location.search).get('dshBrowserTargetFullscreenTabSupported') !== 'false'
  if (!fullscreenTab && config !== undefined && !fullscreenTabSupported) {
    ctx.effect(() => quickActions.register({
      id: 'fullscreen-unavailable',
      label: '全屏模式需 Chrome 141+（仍可使用侧边栏）',
      order: 5,
      requiresSession: false,
      run: () => window.alert('全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。'),
    }), 'accrui-browser-target: full-screen compatibility notice')
  } else {
    ctx.effect(() => quickActions.register({
      id: fullscreenTab ? 'close-fullscreen' : 'open-fullscreen',
      label: fullscreenTab ? '关闭全屏' : '全屏',
      order: 5,
      requiresSession: false,
      run: (sessionId?: SessionId) => {
        if (config !== undefined) {
          window.parent.postMessage({ type: fullscreenTab ? 'return-to-sidepanel/v1' : 'open-fullscreen-tab/v1', nonce: config.nonce, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, config.parentOrigin)
        } else {
          window.open(window.location.href, '_blank')
        }
      },
    }), 'accrui-browser-target: open-fullscreen action')
  }
  if (config === undefined) return
  if (config.surface === 'sidepanel') {
    ctx.effect(() => quickActions.register({
      id: 'prototype-studio',
      label: '原型',
      order: 20,
      requiresSession: false,
      run: () => {
        window.parent.postMessage({ type: 'open-recent-prototypes/v1', nonce: config.nonce }, config.parentOrigin)
      },
    }), 'accrui-browser-target: open recent prototypes action')
  }
  ctx.effect(() => {
    const reportSelectedSession = (): void => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      window.parent.postMessage({ type: 'harness-session-selected/v1', nonce: config.nonce, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, config.parentOrigin)
    }
    reportSelectedSession()
    return ctx.sessions.list.subscribe(reportSelectedSession)
  }, 'accrui-browser-target: report selected session')
  if (config.sessionId !== undefined) {
    ctx.effect(() => restoreHandoffSession({
      sessionId: config.sessionId! as SessionId,
      list: ctx.sessions.list,
      open: id => ctx.sessions.open(id),
      reportApplied: () => window.parent.postMessage({ type: 'session-handoff-applied/v1', nonce: config.nonce, sessionId: config.sessionId }, config.parentOrigin),
    }), 'accrui-browser-target: restore handed-off session')
  }
  const bridge = createBrowserTargetBridge(config.nonce, config.parentOrigin)
  const panel = createSnapshotStore(false)
  const lifecycleLocks = new Map<string, { state: BrowserTargetSessionRunLock; unsubscribe?: () => void }>()
  const pendingLockAcks = new Map<string, { sessionId: string; resolve: (locked: boolean) => void; reject: (error: Error) => void; timeout: number }>()
  let disposed = false
  const postUnlock = (sessionId: string, submissionId: string): void => {
    window.parent.postMessage({ type: 'browser-target-unlock/v1', nonce: config.nonce, sessionId, submissionId }, config.parentOrigin)
  }
  const postReconcile = (sessionId: string, submissionId: string): void => {
    window.parent.postMessage({ type: 'browser-target-reconcile/v1', nonce: config.nonce, sessionId, submissionId }, config.parentOrigin)
  }
  const releaseLifecycleLock = (sessionId: string, submissionId?: string): void => {
    const lock = lifecycleLocks.get(sessionId)
    if (lock !== undefined && (submissionId === undefined || lock.state.submissionId === submissionId)) {
      lock.unsubscribe?.()
      lifecycleLocks.delete(sessionId)
    }
    if (submissionId === undefined && lock === undefined) return
    postUnlock(sessionId, submissionId ?? lock!.state.submissionId)
  }
  const restoreProjectedLifecycle = (): void => {
    const snapshot = bridge.source.getSnapshot()
    const projectedLocks = snapshot?.activeRunLocks ?? (snapshot?.activeRunLock === undefined ? [] : [snapshot.activeRunLock])
    for (const projected of projectedLocks) {
      if (lifecycleLocks.has(projected.sessionId)) continue
      const session = ctx.sessions.binding(projected.sessionId as SessionId)?.session
      if (session === undefined) continue
      const state = new BrowserTargetSessionRunLock(projected.submissionId)
      state.accept(session.getSnapshot())
      lifecycleLocks.set(projected.sessionId, { state })
    }
  }
  const lockSubmission = (sessionId: string, submissionId: string, browserTarget: { browser: 'chrome'; windowId: number; tabId: number; url: string }): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (pendingLockAcks.delete(submissionId) === false) return
        postUnlock(sessionId, submissionId)
        reject(new Error('Timed out waiting for the Browser Target lock acknowledgement.'))
      }, 20_000)
      pendingLockAcks.set(submissionId, {
        sessionId,
        timeout,
        resolve,
        reject,
      })
      window.parent.postMessage({ type: 'browser-target-lock/v1', nonce: config.nonce, sessionId, submissionId, browserTarget }, config.parentOrigin)
    })
  }
  const submissionTransforms = ctx.get('composerSubmissionTransforms')!
  ctx.effect(() => {
    const unregister = submissionTransforms.register({
      id: 'browser-target-run-lock',
      prepare: async (sessionId, text) => {
        const id = String(sessionId)
        const session = ctx.sessions.binding(sessionId)?.session
        const targetSnapshot = bridge.source.getSnapshot()
        if (session === undefined || !shouldCaptureSessionRunTarget(session.getSnapshot(), lifecycleLocks.has(id))) return { text }
        if (targetSnapshot?.settings.mode === 'follow-active-tab' && targetSnapshot.activeTab !== undefined) {
          const submissionId = crypto.randomUUID()
          const lifecycle = { state: new BrowserTargetSessionRunLock(submissionId), unsubscribe: undefined as (() => void) | undefined }
          lifecycleLocks.set(id, lifecycle)
          let locked: boolean
          try {
            locked = await lockSubmission(id, submissionId, { browser: 'chrome', windowId: targetSnapshot.activeTab.windowId, tabId: targetSnapshot.activeTab.tabId, url: targetSnapshot.activeTab.url })
          } catch (error) {
            if (lifecycleLocks.get(id) === lifecycle) lifecycleLocks.delete(id)
            throw error
          }
          if (locked) {
            const reconcile = (): void => {
              if (lifecycle.state.observe(session.getSnapshot())) releaseLifecycleLock(id, submissionId)
            }
            return {
              text,
              accept: () => {
                if (lifecycle.state.accept(session.getSnapshot())) {
                  releaseLifecycleLock(id, submissionId)
                  return
                }
                if (!disposed) lifecycle.unsubscribe = session.subscribe(reconcile)
              },
              reject: () => { releaseLifecycleLock(id, submissionId) },
            }
          }
          if (lifecycleLocks.get(id) === lifecycle) lifecycleLocks.delete(id)
        }
        return { text }
      },
    })
    return () => {
      disposed = true
      unregister()
      for (const [submissionId, pending] of pendingLockAcks) {
        window.clearTimeout(pending.timeout)
        pendingLockAcks.delete(submissionId)
        postUnlock(pending.sessionId, submissionId)
        pending.reject(new Error('Browser Target locking was cancelled because the Harness surface closed.'))
      }
      for (const [sessionId, lock] of [...lifecycleLocks]) {
        lock.unsubscribe?.()
        lifecycleLocks.delete(sessionId)
        if (!lock.state.accepted) postUnlock(sessionId, lock.state.submissionId)
      }
    }
  }, 'accrui-browser-target: lock follow target on composer submission')
  ctx.effect(() => {
    const sessionSubscriptions = new Map<string, () => void>()
    const reconcile = (sessionId: string, session: SessionFace): void => {
      const snapshot = session.getSnapshot()
      const lifecycle = lifecycleLocks.get(sessionId)
      if (lifecycle !== undefined && shouldReconcileSessionRunTarget(snapshot, lifecycle.state)) {
        lifecycleLocks.delete(sessionId)
        postReconcile(sessionId, lifecycle.state.submissionId)
      }
    }
    const syncSessionSubscriptions = (): void => {
      const sessionIds = ctx.sessions.list.getSnapshot().ids
      const expected = new Set(sessionIds.map(String))
      for (const sessionId of sessionIds) {
        const id = String(sessionId)
        if (sessionSubscriptions.has(id)) continue
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) continue
        restoreProjectedLifecycle()
        const onSnapshot = (): void => { reconcile(id, session) }
        sessionSubscriptions.set(id, session.subscribe(onSnapshot))
        onSnapshot()
      }
      for (const [sessionId, unsubscribe] of sessionSubscriptions) {
        if (expected.has(sessionId)) continue
        unsubscribe()
        sessionSubscriptions.delete(sessionId)
        releaseLifecycleLock(sessionId)
      }
    }
    const unsubscribeList = ctx.sessions.list.subscribe(syncSessionSubscriptions)
    syncSessionSubscriptions()
    return () => {
      unsubscribeList()
      for (const unsubscribe of sessionSubscriptions.values()) unsubscribe()
    }
  }, 'accrui-browser-target: reconcile stale idle locks')
  ctx.effect(() => {
    restoreProjectedLifecycle()
    return bridge.source.subscribe(restoreProjectedLifecycle)
  }, 'accrui-browser-target: restore remounted Run lock lifecycle')
  const injected = (): BrowserTargetInjected => ({
    hooks: { browserTarget: bridge.source, browserTargetPanel: panel },
    onBrowserTargetCommand: command => {
      if (command.command !== 'capture-design-reference' && command.command !== 'capture-responsive-design-reference' && command.command !== 'capture-design-references' && command.command !== 'html-workbench-select') { bridge.send(command, window.parent); return }
      const sessionId = ctx.sessions.list.getSnapshot().current
      bridge.send({ ...command, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, window.parent)
    },
    onBrowserTargetPanelChange: open => panel.set(open),
  })
  const reconnectInjected = (): HarnessReconnectActionInjected => ({
    reconnectHarness: () => bridge.reconnectHarness(window.parent),
  })
  const fullscreenReturnInjected = (): FullscreenReturnControlInjected => ({
    returnToSidePanel: sessionId => {
      window.parent.postMessage({ type: 'return-to-sidepanel/v1', nonce: config.nonce, sessionId: String(sessionId) }, config.parentOrigin)
    },
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source === window.parent && event.origin === config.parentOrigin && typeof event.data === 'object' && event.data !== null) {
        const message = event.data as { type?: unknown; nonce?: unknown; submissionId?: unknown; ok?: unknown; locked?: unknown; error?: unknown }
        if (message.type === 'browser-target-lock-ack/v1' && message.nonce === config.nonce && typeof message.submissionId === 'string') {
          const pending = pendingLockAcks.get(message.submissionId)
          if (pending === undefined) return
          pendingLockAcks.delete(message.submissionId)
          window.clearTimeout(pending.timeout)
          if (message.ok !== true) {
            pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Browser Target lock was not confirmed.'))
            return
          }
          pending.resolve(message.locked === true)
          return
        }
      }
      bridge.accept(event, window.parent)
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'browser-target-ready/v1', nonce: config.nonce }, config.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-browser-target: iframe bridge')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'browser-target-control', order: 10, inject: injected }, BrowserTargetControl))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'browser-target-panel', order: 10, inject: injected }, BrowserTargetPanel))
  if (fullscreenTab) ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'fullscreen-return', order: 0, inject: fullscreenReturnInjected,
  }, FullscreenReturnControl))
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({ name: 'sidebar.compact.action', id: 'harness-reconnect', order: 10, inject: reconnectInjected }, HarnessReconnectAction))
}

export { BrowserTargetControl, BrowserTargetPanel }
export { HarnessReconnectAction } from './HarnessReconnectAction.tsx'
export { FullscreenReturnControl } from './FullscreenReturnControl.tsx'
export type { BrowserTargetInjected } from './BrowserTargetControl.tsx'
export type { BrowserTarget, BrowserTargetCommand, BrowserTargetMode, BrowserTargetSettings, BrowserTargetSnapshot, BrowserTargetTab } from './active-tab-bridge.ts'
