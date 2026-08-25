(function () {
  const root = document.getElementById('root')
  const buildId = document.documentElement?.dataset.prototypeStudioBuild || '未知'
  const localDevScripts = Array.from(document.scripts).filter(script =>
    /(?:127\.0\.0\.1|localhost):\d+/.test(script.src),
  )
  const needsLocalDevServer = localDevScripts.length > 0
  const startupTimeoutMs = Number.parseInt(root?.dataset.prototypeStartupTimeout || '1500', 10)
  let startupFailed = false
  let startupFailureMessage = ''
  let startupReady = root?.dataset.prototypeStudioMounted === 'true'
  let failureRendered = false
  let observer

  function stopWatchingStartup() {
    window.removeEventListener('error', recordStartupFailure, true)
    window.removeEventListener('unhandledrejection', recordStartupFailure)
    window.removeEventListener('prototype-studio-startup-failure', recordStartupFailure)
    observer?.disconnect()
  }

  function errorMessage(value) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 600)
    if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim() !== '') return value.message.trim().slice(0, 600)
    return ''
  }

  function renderStartupFailure(reason) {
    if (root === null || failureRendered || root.querySelector('[data-prototype-startup-guard="failed"]') !== null) return
    failureRendered = true
    stopWatchingStartup()

    const shell = document.createElement('main')
    shell.setAttribute('role', 'alert')
    shell.setAttribute('aria-live', 'assertive')
    shell.dataset.prototypeStartupGuard = 'failed'
    Object.assign(shell.style, {
      boxSizing: 'border-box',
      width: 'min(560px, calc(100% - 48px))',
      margin: '96px auto',
      padding: '24px',
      border: '1px solid #e5e7eb',
      borderRadius: '12px',
      color: '#172033',
      background: '#ffffff',
      boxShadow: '0 12px 32px rgba(15, 23, 42, 0.08)',
      font: '14px/1.6 system-ui, sans-serif',
    })

    const title = document.createElement('strong')
    title.textContent = 'AI 原型工具启动失败'
    Object.assign(title.style, { display: 'block', marginBottom: '8px', fontSize: '18px' })

    const detail = document.createElement('p')
    const cause = document.createElement('span')
    cause.textContent = errorMessage(reason) || (needsLocalDevServer
      ? '页面脚本加载失败：可能是 Edge 仍在加载旧扩展页面或旧端口，也可能是本地开发服务不可达。'
      : '页面组件没有成功加载。')
    detail.append(cause, document.createTextNode(' 你的参考网页和已保存版本没有丢失。'))
    Object.assign(detail.style, { margin: '0 0 16px', color: '#5b6474' })

    const build = document.createElement('small')
    build.textContent = `构建版本：${buildId}`
    Object.assign(build.style, { display: 'block', marginBottom: '12px', color: '#7b8494', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' })

    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重新加载页面'
    Object.assign(retry.style, {
      padding: '8px 14px',
      border: '1px solid #2563eb',
      borderRadius: '8px',
      color: '#ffffff',
      background: '#2563eb',
      cursor: 'pointer',
    })
    retry.addEventListener('click', () => location.reload())

    const hint = document.createElement('small')
    hint.textContent = needsLocalDevServer
      ? '处理顺序：先打开 edge://extensions，点击本扩展“重新加载”；关闭当前旧原型页面并重新打开；如果仍失败，再恢复本地开发服务。'
      : '如果仍然失败，请保留控制台第一条红色错误，便于定位。'
    Object.assign(hint.style, { display: 'block', marginTop: '12px', color: '#7b8494' })

    shell.append(title, detail, build, retry, hint)
    root.replaceChildren(shell)
  }

  function recordStartupFailure(event) {
    if (startupReady && root?.childElementCount !== 0 && event?.type !== 'prototype-studio-startup-failure') return
    startupFailed = true
    const detail = event?.detail
    startupFailureMessage = errorMessage(detail?.message) || errorMessage(event?.error) || errorMessage(event?.reason) || errorMessage(event?.message) || startupFailureMessage
    window.setTimeout(() => renderStartupFailure(startupFailureMessage), 0)
  }

  function inspectRoot() {
    if (failureRendered || root === null) return
    const mounted = root.dataset.prototypeStudioMounted === 'true'
    startupReady = startupReady || mounted
    if (startupReady && root.childElementCount === 0) renderStartupFailure('编辑器根节点被清空，React 没有留下可显示的页面。')
  }

  window.addEventListener('error', recordStartupFailure, true)
  window.addEventListener('unhandledrejection', recordStartupFailure)
  window.addEventListener('prototype-studio-startup-failure', recordStartupFailure)
  if (root !== null && typeof window.MutationObserver === 'function') {
    observer = new window.MutationObserver(inspectRoot)
    observer.observe(root, { childList: true })
  }
  const timeout = Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0 ? startupTimeoutMs : 1_500
  window.setTimeout(() => {
    startupReady = startupReady || root?.dataset.prototypeStudioMounted === 'true'
    if (!startupReady) {
      renderStartupFailure(startupFailureMessage || (startupFailed ? '页面脚本启动失败。' : '页面脚本未完成启动。'))
      return
    }
    inspectRoot()
  }, timeout)
})()
