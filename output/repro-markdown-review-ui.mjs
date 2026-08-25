import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const chromeBinary = process.env.MARKDOWN_REVIEW_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const appUrl = 'http://127.0.0.1:3101/entrypoints/markdown-review/index.html?reviewId=fixture-review'
const screenshotPath = new URL('./markdown-review-ui-smoke.png', import.meta.url)

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not allocate a CDP port')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function waitForJson(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {}
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.sequence = 0
    this.pending = new Map()
    this.events = []
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (typeof message.id !== 'number') {
        if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled') this.events.push(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() { this.socket.close() }
}

const fixtureMarkdown = `# 专业 Markdown 审阅

这是一个可直接编辑的可视化文档，不显示 Markdown 源码。

## 交付清单

- 选中标题、段落、列表、表格或代码块
- 就地添加批注并发送给 AI
- 在正文内保留批注高亮和投递状态

| 能力 | 状态 |
| --- | --- |
| 可视化编辑 | 已启用 |
| AI 修改对比 | 待候选 |

\`\`\`ts
const verifiedWrite = 'prepare -> confirm -> commit -> readback'
\`\`\`

## 状态流转

\`\`\`mermaid
flowchart TD
  A[进入产业带摸排列表] --> B{选择操作}
  B -->|新增| C [填写表单<br>必填校验 + 查重 + 天眼查名称校验]
  B -->|导入| D [下载模板填写<br>上传后逐行校验<br>撞重返回行号提示]
  C --> E[保存入库]
  D --> E
  B -->|导出| F[按当前筛选与本人权限导出<br>大批量走下载中心]
  B -->|转移| G [选择目标跟进人<br>确认后直接生效]
  B -->|废弃| H [仅创建人/管理员可操作<br>标记废弃留痕]
\`\`\`
`

const mockChrome = `(() => {
  const messageListeners = [];
  const disconnectListeners = [];
  const fixture = globalThis.__markdownReviewFixture = {
    deliveries: [],
    proposalStage: 0,
  };
  const emit = (message) => queueMicrotask(() => messageListeners.forEach((listener) => listener(message)));
  const port = {
    onMessage: {
      addListener(listener) { messageListeners.push(listener); },
      removeListener(listener) { const index = messageListeners.indexOf(listener); if (index >= 0) messageListeners.splice(index, 1); },
    },
    onDisconnect: {
      addListener(listener) { disconnectListeners.push(listener); },
      removeListener(listener) { const index = disconnectListeners.indexOf(listener); if (index >= 0) disconnectListeners.splice(index, 1); },
    },
    postMessage(message) {
      if (message.type === 'markdown-review-snapshot-request') {
        emit({
          v: 1,
          type: 'markdown-review-snapshot-response',
          requestId: message.requestId,
          ok: true,
          snapshot: {
            v: 1,
            type: 'markdown-review-snapshot',
            reviewId: 'fixture-review',
            harnessSessionId: 'fixture-session',
            resource: { resourceId: 'fixture-resource', displayPath: 'docs/professional-review.md', revision: '1', fingerprint: 'fixture-fingerprint' },
            content: ${JSON.stringify(fixtureMarkdown)},
            truncated: false,
            readOnly: false,
          },
        });
      } else if (message.type === 'markdown-review-proposals-request') {
        const proposals = [];
        const latest = fixture.deliveries[fixture.deliveries.length - 1];
        if (latest !== undefined && latest.anchor?.version === 2 && message.afterSequence < 1 && fixture.proposalStage === 0) {
          fixture.proposalStage = 1;
          proposals.push({
            proposalId: 'fixture-proposal-reject',
            selectionId: latest.id,
            sequence: 1,
            baseFingerprint: 'fixture-fingerprint',
            kind: 'selection',
            replacementMarkdown: '这是一个可直接编辑的可视化审阅文档（候选一）',
            editorRevision: latest.anchor.editorRevision,
            from: latest.anchor.from,
            to: latest.anchor.to,
            summary: '候选一：仅用于验证拒绝修改',
          });
        } else if (latest !== undefined && latest.anchor?.version === 2 && message.afterSequence < 2 && fixture.proposalStage === 1) {
          fixture.proposalStage = 2;
          proposals.push({
            proposalId: 'fixture-proposal-accept',
            selectionId: latest.id,
            sequence: 2,
            baseFingerprint: 'fixture-fingerprint',
            kind: 'selection',
            replacementMarkdown: '这是一个可直接编辑的可视化审阅文档（已接受）',
            editorRevision: latest.anchor.editorRevision,
            from: latest.anchor.from,
            to: latest.anchor.to,
            summary: '候选二：用于验证接受修改',
          });
        }
        emit({ v: 1, type: 'markdown-review-proposals-response', requestId: message.requestId, ok: true, reviewId: 'fixture-review', proposals });
      } else if (message.type === 'markdown-review-deliver-request') {
        fixture.deliveries.push(message.annotation);
        setTimeout(() => emit({ v: 1, type: 'markdown-review-deliver-response', requestId: message.requestId, ok: true, deliveryId: message.deliveryId }), 80);
      } else if (message.type === 'markdown-review-prepare-write-request') {
        emit({ v: 1, type: 'markdown-review-prepare-write-response', requestId: message.requestId, ok: true, preparation: { status: 'prepared', approval: 'fixture-approval', contentHash: 'fixture-content-hash', expiresAt: Date.now() + 60_000 } });
      } else if (message.type === 'markdown-review-commit-write-request') {
        fixture.commitContent = message.content;
        emit({ v: 1, type: 'markdown-review-commit-write-response', requestId: message.requestId, ok: true, result: { status: 'verified_write', resource: { resourceId: 'fixture-resource', displayPath: 'docs/professional-review.md', revision: '2', fingerprint: 'fixture-fingerprint-saved' }, contentHash: 'fixture-content-hash' } });
      }
    },
    disconnect() {},
  };
  globalThis.chrome.runtime = { connect: () => port };
})();`

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

async function waitFor(client, expression, label, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(client, `Boolean(${expression})`)) return
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const profile = await mkdtemp(path.join(tmpdir(), 'markdown-review-cdp-'))
const port = await freePort()
const browser = spawn(chromeBinary, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

let client
try {
  await waitForJson(`http://127.0.0.1:${port}/json/version`)
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((target) => target.type === 'page')
  if (page === undefined) throw new Error('No headless page target was created')

  client = new CdpClient(page.webSocketDebuggerUrl)
  await client.open()
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'Win32',
  })
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: mockChrome })
  await client.send('Page.navigate', { url: appUrl })

  try {
    await waitFor(client, `document.querySelector('.ProseMirror')`, 'visual editor')
  } catch (error) {
    const diagnostics = await evaluate(client, `({
      url: location.href,
      title: document.title,
      body: document.body?.innerText,
      html: document.body?.innerHTML?.slice(0, 4000),
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    })`)
    console.error(JSON.stringify({ diagnostics, events: client.events }, null, 2))
    throw error
  }
  await waitFor(client, `document.body.textContent.includes('专业 Markdown 审阅')`, 'fixture document')
  await waitFor(client, `document.querySelector('.mermaid-preview svg')`, 'Mermaid visual preview')
  const initial = await evaluate(client, `({
    hasRightPanel: Boolean(document.querySelector('.annotation-panel')),
    hasSourceEditor: Boolean(document.querySelector('.source-editor')),
    hasVisualEditor: Boolean(document.querySelector('.ProseMirror')),
    visualEditorCount: document.querySelectorAll('.ProseMirror').length,
    toolbar: document.querySelector('.workspace-toolbar')?.textContent?.trim(),
    mermaid: (() => {
      const block = document.querySelector('.mermaid-block');
      const preview = block?.querySelector('.mermaid-preview');
      const source = block?.parentElement?.querySelector('.milkdown-code-block[data-mermaid-source]');
      const svg = preview?.querySelector('svg');
      const rect = preview?.getBoundingClientRect();
      const proseRect = document.querySelector('.ProseMirror')?.getBoundingClientRect();
      const blockRect = block?.getBoundingClientRect();
      return {
        previewVisible: preview ? getComputedStyle(preview).display !== 'none' : false,
        fallbackVisible: block?.querySelector('.mermaid-fallback') !== null,
        sourceHidden: source?.classList.contains('mermaid-source-hidden') ?? false,
        labelHasLiteralEscape: svg?.textContent?.includes('\\\\n') ?? true,
        hasIndustryLabels: svg?.textContent?.includes('进入产业带摸排列表') && svg.textContent.includes('必填校验') && svg.textContent.includes('标记废弃留痕'),
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        proseWidth: proseRect?.width ?? 0,
        contentWidth: blockRect?.width ?? 0,
        widthRatio: rect !== undefined && blockRect !== undefined && blockRect.width > 0 ? rect.width / blockRect.width : 0,
        proseWidthRatio: rect !== undefined && proseRect !== undefined && proseRect.width > 0 ? rect.width / proseRect.width : 0,
        overflowsProse: rect !== undefined && proseRect !== undefined
          ? rect.left < proseRect.left - 2 || rect.right > proseRect.right + 2
          : true,
        sourceTag: source?.tagName ?? '',
        sourceClass: source?.className ?? '',
        sourceParentClass: source?.parentElement?.className ?? '',
        sourceGrandparentClass: source?.parentElement?.parentElement?.className ?? '',
      };
    })(),
  })`)
  if (initial.hasRightPanel || initial.hasSourceEditor || !initial.hasVisualEditor || initial.visualEditorCount !== 1 || !initial.mermaid.previewVisible || initial.mermaid.fallbackVisible || !initial.mermaid.sourceHidden || initial.mermaid.labelHasLiteralEscape || !initial.mermaid.hasIndustryLabels || initial.mermaid.contentWidth < 100 || initial.mermaid.widthRatio < 0.9 || initial.mermaid.overflowsProse || initial.mermaid.height < 100 || initial.mermaid.height > 622) {
    throw new Error(`Unexpected review layout: ${JSON.stringify(initial)}`)
  }
  await evaluate(client, `document.querySelector('.mermaid-block')?.scrollIntoView({ block: 'center' })`)
  await wait(100)
  const sourceView = await evaluate(client, `(() => {
    const block = document.querySelector('.mermaid-block');
    const toolbar = block?.querySelector('.mermaid-toolbar');
    const source = block?.parentElement?.querySelector('.milkdown-code-block[data-mermaid-source]');
    block?.querySelector('.mermaid-view-toggle button:last-child')?.click();
    return {
      toolbarBeforeSource: Boolean(toolbar && source && (toolbar.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING)),
      sourceVisible: source ? getComputedStyle(source).display !== 'none' : false,
      previewHidden: getComputedStyle(block?.querySelector('.mermaid-preview')).display === 'none',
    };
  })()`)
  if (!sourceView.toolbarBeforeSource || !sourceView.sourceVisible || !sourceView.previewHidden) throw new Error(`Mermaid source switch moved or overlapped its toolbar: ${JSON.stringify(sourceView)}`)
  const panStart = await evaluate(client, `(() => {
    const block = document.querySelector('.mermaid-block');
    block?.querySelector('.mermaid-view-toggle button:first-child')?.click();
    block?.querySelector('button[aria-label="放大流程图"]')?.click();
    const rect = block?.querySelector('.mermaid-preview')?.getBoundingClientRect();
    return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (panStart === null) throw new Error('Mermaid viewer did not expose a pannable preview')
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panStart.x, y: panStart.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panStart.x + 42, y: panStart.y + 28, button: 'left', buttons: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panStart.x + 42, y: panStart.y + 28, button: 'left', buttons: 0, clickCount: 1 })
  const viewerTransform = await evaluate(client, `document.querySelector('.mermaid-canvas')?.style.transform ?? ''`)
  if (!viewerTransform.includes('scale(1.2)') || viewerTransform.includes('translate(0px, 0px)')) throw new Error(`Mermaid viewer did not zoom and pan: ${viewerTransform}`)
  const mermaidZoomScreenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('./markdown-review-ui-mermaid-zoom.png', import.meta.url), Buffer.from(mermaidZoomScreenshot.data, 'base64'))
  await evaluate(client, `document.querySelector('button[aria-label="重置并适应流程图"]')?.click()`)
  const resetTransform = await evaluate(client, `document.querySelector('.mermaid-canvas')?.style.transform ?? ''`)
  if (resetTransform !== 'translate(0px, 0px) scale(1)') throw new Error(`Mermaid viewer did not reset: ${resetTransform}`)
  await evaluate(client, `document.querySelector('button[aria-label="放大流程图"]')?.click()`)
  const fullscreenBeforeTransform = await evaluate(client, `document.querySelector('.mermaid-canvas')?.style.transform ?? ''`)
  await evaluate(client, `document.querySelector('button[aria-label="全屏查看流程图"]')?.click()`)
  await waitFor(client, `document.fullscreenElement === document.querySelector('.mermaid-block') || document.querySelector('.mermaid-block')?.classList.contains('is-fullscreen-fallback')`, 'Mermaid fullscreen')
  const fullscreenState = await evaluate(client, `(() => {
    const block = document.querySelector('.mermaid-block')
    return {
      native: document.fullscreenElement === block,
      fallback: block?.classList.contains('is-fullscreen-fallback') ?? false,
      closeVisible: block?.querySelector('button[aria-label="退出全屏查看流程图"]')?.hidden === false,
      transform: block?.querySelector('.mermaid-canvas')?.style.transform ?? '',
    }
  })()`)
  if ((!fullscreenState.native && !fullscreenState.fallback) || !fullscreenState.closeVisible || fullscreenState.transform !== fullscreenBeforeTransform) {
    throw new Error(`Mermaid fullscreen did not preserve the viewer state: ${JSON.stringify(fullscreenState)}`)
  }
  const mermaidFullscreenScreenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('./markdown-review-ui-mermaid-fullscreen.png', import.meta.url), Buffer.from(mermaidFullscreenScreenshot.data, 'base64'))
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await waitFor(client, `document.fullscreenElement !== document.querySelector('.mermaid-block') && !document.querySelector('.mermaid-block')?.classList.contains('is-fullscreen-fallback')`, 'Mermaid fullscreen exit')
  const fullscreenAfterTransform = await evaluate(client, `document.querySelector('.mermaid-canvas')?.style.transform ?? ''`)
  if (fullscreenAfterTransform !== fullscreenBeforeTransform) throw new Error(`Mermaid fullscreen exit reset the viewer state: ${fullscreenAfterTransform}`)
  const mermaidScreenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(new URL('./markdown-review-ui-mermaid.png', import.meta.url), Buffer.from(mermaidScreenshot.data, 'base64'))
  await evaluate(client, `document.querySelector('.visual-markdown-editor')?.scrollTo(0, 0)`)
  const initialScreenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(new URL('./markdown-review-ui-initial.png', import.meta.url), Buffer.from(initialScreenshot.data, 'base64'))

  const drag = await evaluate(client, `(() => {
    const root = document.querySelector('.ProseMirror');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const target = '这是一个可直接编辑的可视化文档';
      const index = node.data.indexOf(target);
      if (index < 0) continue;
      const start = document.createRange();
      start.setStart(node, index);
      start.setEnd(node, index + 1);
      const end = document.createRange();
      end.setStart(node, index + target.length - 1);
      end.setEnd(node, index + target.length);
      const startRect = start.getBoundingClientRect();
      const endRect = end.getBoundingClientRect();
      const selected = document.createRange();
      selected.setStart(node, index);
      selected.setEnd(node, index + target.length);
      const domSelection = getSelection();
      domSelection.removeAllRanges();
      domSelection.addRange(selected);
      document.dispatchEvent(new Event('selectionchange'));
      return {
        startX: startRect.left + Math.min(4, startRect.width * 0.25),
        startY: startRect.top + startRect.height / 2,
        endX: endRect.right - 1,
        endY: endRect.top + endRect.height / 2,
        length: target.length,
        hit: document.elementFromPoint(startRect.left + 4, startRect.top + startRect.height / 2)?.outerHTML?.slice(0, 300),
      };
    }
    return null;
  })()`)
  if (drag === null) throw new Error('Could not locate selection fixture text')
  await wait(80)
  await evaluate(client, `document.querySelector('.ProseMirror').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${drag.endX}, clientY: ${drag.endY} }))`)
  try {
    await waitFor(client, `document.querySelector('.selection-action')`, 'selection action', 20)
  } catch (error) {
    const diagnostics = await evaluate(client, `({
      drag: ${JSON.stringify({})},
      domSelection: getSelection()?.toString(),
      proseSelection: (() => {
        const view = document.querySelector('.ProseMirror')?.pmViewDesc?.view;
        if (!view) return null;
        const selection = view.state.selection;
        return { from: selection.from, to: selection.to, empty: selection.empty, text: view.state.doc.textBetween(selection.from, selection.to, '\\n') };
      })(),
      proseMirrorOwnKeys: Object.getOwnPropertyNames(document.querySelector('.ProseMirror') ?? {}),
      viewDescOwnKeys: Object.getOwnPropertyNames(document.querySelector('.ProseMirror')?.pmViewDesc ?? {}),
      activeElement: document.activeElement?.outerHTML?.slice(0, 500),
      selectionStyles: (() => {
        const root = document.querySelector('.ProseMirror');
        const paragraph = [...root.querySelectorAll('p')].find((node) => node.textContent.includes('这是一个可直接编辑'));
        return { root: getComputedStyle(root).userSelect, paragraph: paragraph && getComputedStyle(paragraph).userSelect, pointerEvents: paragraph && getComputedStyle(paragraph).pointerEvents };
      })(),
      editorRect: (() => { const rect = document.querySelector('.ProseMirror')?.getBoundingClientRect(); return rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; })(),
      actions: document.querySelectorAll('.selection-action').length,
      body: document.body.innerText,
    })`)
    console.error(JSON.stringify({ drag, diagnostics, events: client.events }, null, 2))
    throw error
  }
  await evaluate(client, `document.querySelector('.selection-action').click()`)
  await waitFor(client, `document.querySelector('.annotation-composer textarea')`, 'annotation composer')
  await evaluate(client, `(() => {
    const textarea = document.querySelector('.annotation-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '把这句话改得更专业，并保持原意');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(client, `!document.querySelector('.annotation-composer button[type="submit"]').disabled`, 'enabled submit')
  await evaluate(client, `document.querySelector('.annotation-composer button[type="submit"]').click()`)
  await waitFor(client, `document.querySelector('.review-annotation-highlight.is-delivered')`, 'delivered highlight')

  const finalState = await evaluate(client, `({
    rightPanelCount: document.querySelectorAll('.annotation-panel').length,
    deliveredHighlights: document.querySelectorAll('.review-annotation-highlight.is-delivered').length,
    composerOpen: Boolean(document.querySelector('.annotation-composer')),
    bodyText: document.body.textContent,
  })`)
  if (finalState.rightPanelCount !== 0 || finalState.deliveredHighlights < 1 || finalState.composerOpen) {
    throw new Error(`Annotation flow did not complete: ${JSON.stringify(finalState)}`)
  }
  await evaluate(client, `document.querySelector('.review-annotation-highlight.is-delivered')?.click()`)
  await waitFor(client, `document.querySelector('.annotation-status-popover')`, 'delivered annotation details')
  const annotationDetails = await evaluate(client, `({
    text: document.querySelector('.annotation-status-popover')?.textContent ?? '',
    ariaLabel: document.querySelector('.annotation-status-popover')?.getAttribute('aria-label'),
  })`)
  if (annotationDetails.ariaLabel !== '批注详情' || !annotationDetails.text.includes('把这句话改得更专业，并保持原意') || !annotationDetails.text.includes('已提交给 AI')) {
    throw new Error(`Delivered annotation details are incomplete: ${JSON.stringify(annotationDetails)}`)
  }
  await evaluate(client, `document.querySelector('.annotation-status-popover button[aria-label="关闭批注详情"]')?.click()`)
  await waitFor(client, `!document.querySelector('.annotation-status-popover')`, 'closed delivered annotation details')

  // The first local proposal is deliberately rejected. This proves the
  // visible diff is a review surface, not an eager overwrite of the document.
  await waitFor(client, `document.querySelector('.diff-review-dock') && document.querySelector('.diff-review-dock').textContent.includes('修改前')`, 'first AI diff')
  const firstDiff = await evaluate(client, `({
    text: document.querySelector('.diff-review-dock')?.textContent ?? '',
    before: document.querySelector('.diff-review-dock pre')?.textContent ?? '',
    after: document.querySelectorAll('.diff-review-dock pre')[1]?.textContent ?? '',
    hasAccept: [...document.querySelectorAll('.diff-review-dock button')].some((button) => button.textContent.includes('接受修改')),
    hasReject: [...document.querySelectorAll('.diff-review-dock button')].some((button) => button.textContent.includes('拒绝修改')),
    builtInDiffControls: [...document.querySelectorAll('.milkdown-diff-controls, .milkdown-diff-controls-block')].map((node) => ({
      className: node.className,
      text: node.textContent,
      display: getComputedStyle(node).display,
      visibility: getComputedStyle(node).visibility,
      opacity: getComputedStyle(node).opacity,
      rect: (() => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height }; })(),
    })),
  })`)
  if (!firstDiff.text.includes('修改前') || !firstDiff.text.includes('修改后') || !firstDiff.hasAccept || !firstDiff.hasReject) {
    throw new Error(`AI diff controls are incomplete: ${JSON.stringify(firstDiff)}`)
  }
  if (firstDiff.before !== '这是一个可直接编辑的可视化文档' || !firstDiff.after.includes('候选一')) {
    throw new Error(`Unexpected first AI diff content: ${JSON.stringify(firstDiff)}`)
  }
  const visibleBuiltInDiffControls = firstDiff.builtInDiffControls.filter((control) => control.display !== 'none' && control.visibility !== 'hidden' && control.opacity !== '0' && control.rect.width > 0 && control.rect.height > 0)
  if (visibleBuiltInDiffControls.length > 0) {
    throw new Error(`Milkdown built-in diff controls are visible; expected only the product-level Chinese review dock: ${JSON.stringify({ builtInDiffControls: firstDiff.builtInDiffControls, visibleBuiltInDiffControls })}`)
  }
  const firstDiffScreenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(new URL('./markdown-review-ui-diff-reject.png', import.meta.url), Buffer.from(firstDiffScreenshot.data, 'base64'))
  await evaluate(client, `document.querySelector('.diff-review-dock button.secondary').click()`)
  await waitFor(client, `!document.querySelector('.diff-review-dock')`, 'rejected AI diff')
  const afterReject = await evaluate(client, `document.querySelector('.ProseMirror')?.textContent ?? ''`)
  if (!afterReject.includes('这是一个可直接编辑的可视化文档') || afterReject.includes('候选一')) {
    throw new Error(`Reject changed the document: ${JSON.stringify({ afterReject })}`)
  }

  // The mock then exposes a second proposal for the same anchored selection.
  // Accepting it must change the visual document only after review confirmation.
  try {
    await waitFor(client, `document.querySelector('.diff-review-dock') && [...document.querySelectorAll('.diff-review-dock pre')].some((node) => node.textContent.includes('已接受'))`, 'second AI diff')
  } catch (error) {
    const diagnostics = await evaluate(client, `({
      fixture: globalThis.__markdownReviewFixture,
      notice: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent),
      body: document.body.innerText,
    })`)
    console.error(JSON.stringify({ diagnostics, events: client.events }, null, 2))
    throw error
  }
  await evaluate(client, `document.querySelector('.diff-review-dock button:not(.secondary)').click()`)
  await waitFor(client, `document.querySelector('.ProseMirror')?.textContent.includes('这是一个可直接编辑的可视化审阅文档（已接受）')`, 'accepted AI proposal')
  const afterAccept = await evaluate(client, `({
    editorText: document.querySelector('.ProseMirror')?.textContent ?? '',
    diffVisible: Boolean(document.querySelector('.diff-review-dock')),
  })`)
  if (!afterAccept.editorText.includes('这是一个可直接编辑的可视化审阅文档（已接受）') || afterAccept.diffVisible) {
    throw new Error(`Accept did not commit the reviewed change: ${JSON.stringify(afterAccept)}`)
  }

  // Exercise native visual editing history. The insertion goes through the
  // contenteditable surface, then Ctrl+Z / Ctrl+Y exercise Milkdown's
  // actual history commands (rather than merely changing React state).
  await evaluate(client, `(() => {
    const root = document.querySelector('.ProseMirror');
    if (!root) throw new Error('visual editor disappeared before manual history check');
    const target = [...root.querySelectorAll('p')].find((node) => node.textContent.includes('已接受'));
    const walker = target && document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const text = walker?.nextNode();
    if (!text) return false;
    const selection = getSelection();
    const range = document.createRange();
    range.setStart(text, text.textContent.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();
    return true;
  })()`)
  await client.send('Input.insertText', { text: ' 手工编辑' })
  await waitFor(client, `document.querySelector('.ProseMirror')?.textContent.includes('手工编辑')`, 'manual visual edit')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 })
  await waitFor(client, `!document.querySelector('.ProseMirror')?.textContent.includes('手工编辑')`, 'undo manual visual edit')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 })
  await waitFor(client, `document.querySelector('.ProseMirror')?.textContent.includes('手工编辑')`, 'redo manual visual edit')

  // Verified Write must not destroy the visual editor's history. Save the
  // dirty draft through the real two-step UI, then make a fresh edit and prove
  // it can still be undone and redone after the verified response.
  await waitFor(client, ` [...document.querySelectorAll('button')].some((button) => button.textContent.includes('保存草稿') && !button.disabled)`, 'save draft action')
  await evaluate(client, `[...document.querySelectorAll('button')].find((button) => button.textContent.includes('保存草稿'))?.click()`)
  await waitFor(client, `document.querySelector('.save-confirm') && document.querySelector('.save-confirm').textContent.includes('确认写入')`, 'verified write confirmation')
  await evaluate(client, `[...document.querySelectorAll('.save-confirm button')].find((button) => button.textContent.includes('确认写入'))?.click()`)
  await waitFor(client, `document.body.textContent.includes('已保存，并已按同一资源回读验证')`, 'verified write completion')
  await waitFor(client, `document.querySelector('.ProseMirror')`, 'editor after verified write')
  await evaluate(client, `(() => {
    const root = document.querySelector('.ProseMirror');
    const target = [...root.querySelectorAll('p')].find((node) => node.textContent.includes('已接受'));
    const walker = target && document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const text = walker?.nextNode();
    if (!text) return false;
    const range = document.createRange();
    range.setStart(text, text.textContent.length);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();
    return true;
  })()`)
  await client.send('Input.insertText', { text: ' 再次编辑' })
  await waitFor(client, `document.querySelector('.ProseMirror')?.textContent.includes('再次编辑')`, 'post-save visual edit')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 })
  await waitFor(client, `!document.querySelector('.ProseMirror')?.textContent.includes('再次编辑')`, 'undo after verified write')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 })
  await waitFor(client, `document.querySelector('.ProseMirror')?.textContent.includes('再次编辑')`, 'redo after verified write')
  const verifiedWriteState = await evaluate(client, `({
    verifiedNotice: document.body.textContent.includes('已保存，并已按同一资源回读验证'),
    hasPostSaveEdit: document.querySelector('.ProseMirror')?.textContent.includes('再次编辑') ?? false,
    commitContent: globalThis.__markdownReviewFixture?.commitContent ?? null,
  })`)
  if (!verifiedWriteState.verifiedNotice || !verifiedWriteState.hasPostSaveEdit || typeof verifiedWriteState.commitContent !== 'string') {
    throw new Error(`Verified Write history check failed: ${JSON.stringify(verifiedWriteState)}`)
  }

  // A range spanning two different rendered blocks must still produce the
  // same floating annotation action and a multi-block visual anchor.
  const crossBlock = await evaluate(client, `(() => {
    const root = document.querySelector('.ProseMirror');
    const paragraph = [...root.querySelectorAll('p')].find((node) => node.textContent.includes('已接受'));
    const item = root.querySelector('li');
    const startText = paragraph?.firstChild;
    const endWalker = item && document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let endText = endWalker?.nextNode();
    while (endWalker) {
      const next = endWalker.nextNode();
      if (!next) break;
      endText = next;
    }
    if (!startText || !endText) return null;
    const range = document.createRange();
    range.setStart(startText, 0);
    range.setEnd(endText, endText.textContent.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const rect = range.getBoundingClientRect();
    return { quote: selection.toString(), startX: rect.left + 5, startY: rect.top + 5 };
  })()`)
  if (crossBlock === null || !crossBlock.quote.includes('选中标题')) {
    const crossDiagnostics = await evaluate(client, `({ li: document.querySelector('.ProseMirror li')?.outerHTML, lists: [...document.querySelectorAll('.ProseMirror ul, .ProseMirror ol')].map((node) => node.outerHTML.slice(0, 600)), paragraphs: [...document.querySelectorAll('.ProseMirror p')].map((node) => node.textContent) })`)
    throw new Error(`Could not create paragraph-to-list cross-block selection: ${JSON.stringify({ crossBlock, crossDiagnostics })}`)
  }
  await evaluate(client, `document.querySelector('.ProseMirror').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${crossBlock.startX}, clientY: ${crossBlock.startY} }))`)
  await waitFor(client, `document.querySelector('.selection-action')`, 'cross-block selection action')
  await evaluate(client, `document.querySelector('.selection-action').click()`)
  await waitFor(client, `document.querySelector('.annotation-composer textarea')`, 'cross-block annotation composer')
  await evaluate(client, `(() => {
    const textarea = document.querySelector('.annotation-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '请同时检查这段文字和清单');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.annotation-composer button[type="submit"]').click();
  })()`)
  await waitFor(client, `document.querySelectorAll('.review-annotation-highlight.is-delivered').length >= 2`, 'cross-block delivered highlight')
  const crossBlockState = await evaluate(client, `({
    deliveries: globalThis.__markdownReviewFixture?.deliveries ?? [],
    highlightCount: document.querySelectorAll('.review-annotation-highlight.is-delivered').length,
  })`)
  const crossAnchor = crossBlockState.deliveries[crossBlockState.deliveries.length - 1]?.anchor
  const crossKinds = crossAnchor?.blocks?.map((block) => block.kind) ?? []
  if (!Array.isArray(crossAnchor?.blocks) || crossAnchor.blocks.length < 2 || !crossKinds.includes('paragraph') || !crossKinds.includes('list_item')) {
    throw new Error(`Cross-block anchor did not preserve block context: ${JSON.stringify({ crossAnchor, crossKinds })}`)
  }

  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify({ ok: true, initial, sourceView, viewerTransform, resetTransform, fullscreenState, fullscreenAfterTransform, finalState: { ...finalState, bodyText: undefined }, firstDiff, afterReject, afterAccept, crossBlock: { quote: crossBlock.quote, kinds: crossKinds }, screenshots: [screenshotPath.pathname, new URL('./markdown-review-ui-initial.png', import.meta.url).pathname, new URL('./markdown-review-ui-mermaid.png', import.meta.url).pathname, new URL('./markdown-review-ui-mermaid-zoom.png', import.meta.url).pathname, new URL('./markdown-review-ui-mermaid-fullscreen.png', import.meta.url).pathname, new URL('./markdown-review-ui-diff-reject.png', import.meta.url).pathname] }, null, 2))
} finally {
  client?.close()
  browser.kill('SIGTERM')
  await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), wait(2_000)])
  await rm(profile, { recursive: true, force: true })
}
