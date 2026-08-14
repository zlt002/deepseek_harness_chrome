import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { HarnessFrameSource } from './harness-frame'
import './style.css'

type HarnessStatus = 'idle' | 'starting' | 'ready' | 'error'

interface HarnessResponse {
  ok: boolean
  url?: string
  error?: string
}

function requestHarness(): Promise<HarnessResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ensure-harness' }, (response: HarnessResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError !== undefined) {
        resolve({ ok: false, error: runtimeError.message })
        return
      }
      resolve(response ?? { ok: false, error: 'Background did not return a response.' })
    })
  })
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<HarnessStatus>('starting')
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()

  const connect = useCallback(async () => {
    setStatus('starting')
    setError(undefined)
    const response = await requestHarness()
    if (response.ok && response.url !== undefined) {
      setUrl(response.url)
      setStatus('ready')
      return
    }
    setStatus('error')
    setError(response.error ?? 'Unable to start the DeepSeek Harness native server.')
  }, [])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: unknown; url?: unknown; error?: unknown }
      if (value.type === 'harness-ready' && typeof value.url === 'string') {
        setUrl(value.url)
        setStatus('ready')
        setError(undefined)
      }
      if (value.type === 'harness-disconnected') {
        setStatus('error')
        setError(typeof value.error === 'string' ? value.error : 'Native server disconnected.')
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  return (
    <main className="shell">
      <header className="toolbar">
        <div>
          <p className="eyebrow">DEEPSEEK HARNESS</p>
          <h1>Browser workspace</h1>
        </div>
        <button className="secondary" onClick={() => void connect()} disabled={status === 'starting'}>
          {status === 'starting' ? 'Starting…' : 'Reconnect'}
        </button>
      </header>

      {status === 'ready' && url !== undefined ? (
        <iframe
          className="harness-frame"
          src={HarnessFrameSource(url)}
          title="DeepSeek Harness Web UI"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <section className="status-card" aria-live="polite">
          <div className={`status-dot status-${status}`} />
          <h2>{status === 'starting' ? '正在启动本地 Harness…' : 'Harness 尚未连接'}</h2>
          <p>
            {status === 'starting'
              ? '扩展正在通过 Native Messaging 启动 native-server，并等待本地 Web UI 就绪。'
              : '请确认已构建 DeepSeek Harness，并完成 native host 注册。'}
          </p>
          {error !== undefined && <pre className="error">{error}</pre>}
          {status === 'error' && <button onClick={() => void connect()}>再次连接</button>}
        </section>
      )}
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
