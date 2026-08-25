import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

process.env.NODE_PATH = new URL('../../../.generated/harness-product/node_modules/', import.meta.url).pathname
createRequire(import.meta.url)('node:module').Module._initPaths()

const require = createRequire(import.meta.url)
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')

function icon() { return React.createElement('i') }
function PrimitiveButton({ children, ...props }) { return React.createElement('button', props, children) }
function HoverCard({ anchor }) { return anchor }
function Tooltip({ children }) { return children }
function Menu({ anchor }) { return anchor }
function Modal({ open, children }) { return open ? React.createElement('div', null, children) : null }

const primitives = {
  Button: PrimitiveButton, HoverCard, Menu, Modal, StateDot: icon, Tooltip,
  IconArchiveOutline20: icon, IconBranchOutline16: icon, IconChevronDownOutline14: icon,
  IconEditOutline16: icon, IconEllipsisOutline16: icon, IconFolderClose16: icon,
  IconFolderOpenOutline16: icon, IconNewChatOutline16: icon, IconPlusOutline16: icon,
  IconTrashOutline16: icon, IconDownloadOutline16: icon, IconCloseOutline16: icon,
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

test('compact picker measures its popover and routes the selected workspace into the directory slot', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const prior = new Map(['window', 'document', 'Node', 'Element', 'HTMLElement'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(dom.window, 'visualViewport', { value: new dom.window.EventTarget() })
  Object.defineProperty(dom.window.visualViewport, 'height', { value: 700 })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ bottom: 123 })
  let client
  dom.window.__ModuleLoader__ = {
    load: ({ factory }) => {
      client = factory(specifier => specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(specifier))
    },
  }
  try {
    require('../lib/client.js')
    const { CompactWorkspacePicker } = client
    const slotCalls = []
    const sessionsA = [
      { id: 'a-first', title: 'A 首条', blank: false, state: 'done', time: '刚刚' },
      { id: 'a-current', title: 'A 当前', blank: false, state: 'done', time: '刚刚' },
    ]
    const owner = {
      currentSessionId: 'a-current', workspaceTitle: '工作区 A', sessionTitle: 'A 当前',
      workspaces: [
        { id: 'workspace-a', title: '工作区 A', path: '/a', createdAt: 0, sessionCount: sessionsA.length, sessions: sessionsA },
        { id: 'workspace-b', title: '工作区 B', path: '/b', createdAt: 0, sessionCount: 2, sessions: [
          { id: 'b-first', title: 'B 首条', blank: false, state: 'done', time: '刚刚' },
          { id: 'b-later', title: 'B 后续', blank: false, state: 'done', time: '刚刚' },
        ] },
      ],
      labels: {
        workspaces: '工作区', sessions: '会话', addWorkspace: '添加工作区', newSession: '新建会话', rename: '重命名',
        deleteWorkspace: '删除工作区', deletePending: '删除中', renameTitle: '重命名', sessionRenameTitle: '重命名会话',
        workspaceName: '工作区名', sessionName: '会话名', fork: '分叉', archiveSession: '归档', cancel: '取消', close: '关闭',
        copied: '已复制', copy: '复制', openFolder: '打开文件夹',
      },
      workspaceActionsAria: name => name, sessionActionsAria: name => name, newSessionAria: name => name,
      createdLabel: () => '', deleteDesc: () => '', conflictNamed: () => '',
      openSession: () => {}, startSession: () => {}, renameWorkspace: async () => {}, renameSession: async () => {},
      forkSession: () => {}, deleteWorkspace: async () => {}, openPath: async () => {}, archiveSession: async () => {},
      directoryFlowAvailable: false, workspaceAddAnchor: { current: null }, requestWorkspaceAdd: () => {}, directoryFlow: null,
      renderSlot: (_name, props) => {
        slotCalls.push(props)
        return React.createElement('div', { 'data-directory-session': props.sessionId })
      },
    }
    const container = dom.window.document.getElementById('root')
    const root = createRoot(container)
    await act(async () => { root.render(React.createElement(CompactWorkspacePicker, owner)) })
    await act(async () => { click(dom.window, container.querySelector('button[aria-expanded]')) })

    const popover = [...container.querySelectorAll('div')].find(node => node.style.getPropertyValue('--accrui-workspace-picker-max-height') !== '')
    assert.equal(popover.style.getPropertyValue('--accrui-workspace-picker-max-height'), '565px')
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    assert.deepEqual(tabs.map(tab => tab.textContent), ['会话', '目录'])
    const panels = [...container.querySelectorAll('[role="tabpanel"]')]
    assert.equal(panels.find(panel => panel.getAttribute('aria-labelledby') === tabs[0].id).hidden, false)
    assert.equal(panels.find(panel => panel.getAttribute('aria-labelledby') === tabs[1].id).hidden, true)

    await act(async () => { click(dom.window, tabs[1]) })
    assert.equal(slotCalls.at(-1).sessionId, 'a-current')
    assert.equal(slotCalls.at(-1).workspacePath, '/a')
    assert.ok(slotCalls.some(props => props.workspacePath === '/a' && typeof props.refreshDirectory === 'function'))
    assert.equal(container.querySelector('[data-directory-session]').getAttribute('data-directory-session'), 'a-current')
    assert.equal(panels.find(panel => panel.getAttribute('aria-labelledby') === tabs[0].id).hidden, true)
    assert.equal(panels.find(panel => panel.getAttribute('aria-labelledby') === tabs[1].id).hidden, false)

    const workspaceB = [...container.querySelectorAll('[role="button"]')].find(node => node.textContent.includes('工作区 B'))
    await act(async () => { click(dom.window, workspaceB) })
    assert.equal(slotCalls.at(-1).sessionId, 'b-first')
    assert.equal(slotCalls.at(-1).workspacePath, '/b')
    assert.equal(container.querySelector('[data-directory-session]').getAttribute('data-directory-session'), 'b-first')
    await act(async () => { root.unmount() })
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    dom.window.close()
    for (const [key, value] of prior) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
