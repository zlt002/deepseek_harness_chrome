export const NATIVE_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 16_000] as const
export const NATIVE_UPDATE_HANDOFF_GRACE_MS = 15_000

export function shouldConsumeReleaseUpdateReload(targetVersion: unknown, nativeVersion: unknown): boolean {
  return typeof targetVersion === 'string' && /^\d+\.\d+\.\d+$/.test(targetVersion)
    && nativeVersion === targetVersion
}

type NativeReconnectOptions = {
  signal?: AbortSignal
  delaysMs?: readonly number[]
  initialDelayMs?: number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

function reconnectAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (reconnectAborted(signal)) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, delayMs)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Retry while Windows replaces and re-registers the Native Host during an upgrade. */
export async function retryNativeConnection(
  connect: () => Promise<boolean>,
  options: NativeReconnectOptions = {},
): Promise<boolean> {
  const delaysMs = options.delaysMs ?? NATIVE_RECONNECT_DELAYS_MS
  const wait = options.wait ?? waitForReconnect

  if ((options.initialDelayMs ?? 0) > 0) {
    await wait(options.initialDelayMs!, options.signal)
  }

  for (let attempt = 0; ; attempt += 1) {
    if (reconnectAborted(options.signal)) return false
    try {
      if (await connect()) return true
    } catch {
      // A missing Native Host is expected while the installer swaps releases.
    }
    if (reconnectAborted(options.signal) || attempt >= delaysMs.length) return false
    await wait(delaysMs[attempt]!, options.signal)
  }
}
