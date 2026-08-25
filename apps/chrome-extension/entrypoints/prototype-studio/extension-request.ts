const DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS = 35_000

export function extensionRequest<T>(message: unknown, timeoutMs = DEFAULT_EXTENSION_RESPONSE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('扩展后台响应超时，请点击重试。'))
    }, timeoutMs)

    try {
      chrome.runtime.sendMessage(message, (response: T | undefined) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        const error = chrome.runtime.lastError
        if (error !== undefined) reject(new Error(error.message))
        else if (response === undefined) reject(new Error('扩展后台没有响应。'))
        else resolve(response)
      })
    } catch (cause) {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeout)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}
