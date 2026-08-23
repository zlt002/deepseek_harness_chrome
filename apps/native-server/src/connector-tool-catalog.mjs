/**
 * Stable, model-facing Connector Tool catalog. The Browser Connector owns
 * dispatch and validation; this module owns only the published MCP surface.
 */
export const LIGHT_DOCUMENT_OPERATIONS = ['replace', 'delete', 'format', 'title', 'set_title', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format', 'blocks_insert', 'insert_drawing', 'selection_insert', 'selection_replace', 'selection_content_replace', 'selection_blocks_replace', 'selection_delete']
export const MODEL_LIGHT_DOCUMENT_OPERATIONS = LIGHT_DOCUMENT_OPERATIONS.filter((operation) => !['selection_replace', 'selection_content_replace', 'selection_blocks_replace', 'selection_delete'].includes(operation))

const knowledgeSearchTool = {
  name: 'knowledge_search', title: 'Search knowledge base',
  description: 'Search the knowledge range selected by the user for this Harness session. The selected range and continuation identity are not model-controlled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } } },
}
const codeSearchTool = {
  name: 'code_search', title: 'Search code base',
  description: 'Search the code repositories selected by the user for this Harness session. The selected repositories and continuation identity are not model-controlled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } } },
}
const selectedSourceScopeTool = {
  name: 'selected_source_scope', title: 'Read selected source scope',
  description: 'Read the repository and knowledge names currently selected in this Harness session composer. This is a read-only echo of the session selection. It does not search, retrieve, or authorize a query. Call it from the parent session with no arguments when you need to confirm what is selected. Never ask the user to read the two composer-strip labels.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}

const browserTargetSchema = {
  type: 'object', additionalProperties: false, required: ['browser', 'windowId', 'tabId', 'url'],
  properties: { browser: { const: 'chrome' }, windowId: { type: 'integer', minimum: 0 }, tabId: { type: 'integer', minimum: 0 }, url: { type: 'string', format: 'uri' } },
}
const officeContextSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'pageIdentity', 'documentIdentity'],
  properties: {
    status: { const: 'browser_target_verified' },
    pageIdentity: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } } },
    // The extension probes every WebEdit frame and reports the best ready
    // frame; null means no frame answered the probe, not no document.
    documentIdentity: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['kind', 'workbookName', 'sheetName', 'hasContent', 'webeditFrames'], properties: { kind: { enum: ['webedit_spreadsheet', 'webedit_light_document'] }, workbookName: { type: ['string', 'null'] }, sheetName: { type: ['string', 'null'] }, hasContent: { type: ['boolean', 'null'] }, webeditFrames: { type: 'integer', minimum: 1, maximum: 50 } } }] },
    primaryBrowserTarget: browserTargetSchema,
    pages: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'pageIdentity', 'documentIdentity', 'isPrimary'], properties: { browserTarget: browserTargetSchema, pageIdentity: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } } }, documentIdentity: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['kind', 'workbookName', 'sheetName', 'hasContent', 'webeditFrames'], properties: { kind: { enum: ['webedit_spreadsheet', 'webedit_light_document'] }, workbookName: { type: ['string', 'null'] }, sheetName: { type: ['string', 'null'] }, hasContent: { type: ['boolean', 'null'] }, webeditFrames: { type: 'integer', minimum: 1, maximum: 50 } } }] }, isPrimary: { type: 'boolean' } } } },
    unavailableBrowserTargets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'reason'], properties: { browserTarget: browserTargetSchema, reason: { const: 'closed_or_changed' } } } },
  },
}
const officeGetContextTool = {
  name: 'list_work_tabs', title: '列出工作标签',
  description: '列出这次会话绑定的工作标签（花名册），不是读正文。pages 里的每一页都是已勾选、可读的；isPrimary 只表示默认写目标，不是“只有这一页被选中”。返回每页的标题、网址、是轻文档还是表格、哪个已关闭。固定模式跟的是勾选的浏览器标签，同一标签换了文档会返回最新页。需要某一页正文时再调用 read_work_tab，tab 用本列表 pages 的序号。模型不能自己挑选未勾选的标签。documentIdentity 只表示探到的编辑器种类。null 只表示 WebEdit iframe 还没应答快探，不是“没有文档”。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: { type: 'object', additionalProperties: false, required: ['runId', 'requestId', 'generation', 'browserTarget', 'officeContext'], properties: { runId: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 }, browserTarget: browserTargetSchema, officeContext: officeContextSchema, primaryBrowserTarget: browserTargetSchema, browserTargets: { type: 'array', minItems: 1, items: browserTargetSchema }, unavailableBrowserTargets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'reason'], properties: { browserTarget: browserTargetSchema, reason: { const: 'closed_or_changed' } } } } } },
}
const readWorkTabTool = {
  name: 'read_work_tab', title: '读取工作标签内容',
  description: '按需读取 list_work_tabs 花名册里的某一页正文。tab 是该列表 pages 的序号，从 1 开始。pages 里每一页都可读，包括 isPrimary=false 的勾选页。轻文档读 WebEdit iframe 编辑器，表格读已用区域摘要，普通网页读可见文本。不能填写 tabId，也不能读未勾选的标签。本工具不改变主目标，不能写入。先调用 list_work_tabs 再读。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['tab'], properties: { tab: { type: 'integer', minimum: 1, maximum: 20, description: 'list_work_tabs 返回的 pages 序号，从 1 开始。' }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
}
const lightDocumentBlockSchema = { type: 'object', additionalProperties: false, properties: {
  type: { enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'table', 'codeblock'] },
  text: { type: 'string', maxLength: 20000 }, markdown: { type: 'string', maxLength: 20000 }, html: { type: 'string', maxLength: 20000 },
  items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 20000 } }, rows: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 2000 } } }, language: { type: 'string', minLength: 1, maxLength: 32 },
} }
const lightDocumentReadTool = { name: 'light_document_read', title: 'Read light document', description: 'Read a bounded page of the light document on this Browser Target. No target, tab, frame, or resource is model-controlled.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, payload: { type: 'object', additionalProperties: true } } } }
const lightDocumentSelectionReadTool = { name: 'light_document_selection_read', title: 'Read selected light-document content', description: 'Read the current light-document selection and its stable fingerprint. Use immediately before preparing a replacement.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, properties: {} } }
const lightDocumentSelectionReplacePreviewTool = { name: 'light_document_selection_replace_preview', title: 'Preview selected-content replacement', description: 'Preview a rich replacement or deletion for a stable non-collapsed selection. Supply the desired blocks; use an empty blocks array only to delete the selection. If the selection is a uniquely matched range inside a table and the replacement is one table, the preview explicitly scopes approval to that containing table so commit can replace it atomically instead of appending a duplicate. This performs one read-only selection snapshot, binds its fingerprint, checks the Browser Target, and returns a one-time approval challenge. It never changes the document; commit revalidates the resource and selection immediately before mutation.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['blocks'], properties: { blocks: { type: 'array', minItems: 0, maxItems: 50, items: lightDocumentBlockSchema } } } }
const lightDocumentSelectionReplaceCommitTool = { name: 'light_document_selection_replace_commit', title: 'Commit approved selected-content replacement', description: 'After user approval, commit exactly the structured replacement captured by preview. This tool intentionally accepts only the one-time challenge: the approved body and internal write identity are not model-controlled. On any failure, stop and report the exact error; do not retry through a different write tool or blocks_batch_edit. Success requires an atomic write and same-target structural readback.', annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['challenge'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 } } } }
const lightDocumentSearchTool = { name: 'light_document_search', title: 'Search light document', description: 'Search the bound light document for a query. This is read-only and does not change the page.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } }
const lightDocumentWritePreviewTool = { name: 'light_document_write_preview', title: 'Preview light-document write', description: 'Preview a non-selection light-document change on the current write target and return a one-time challenge. It does not change the document. After the user confirms, call light_document_write_commit with only that challenge.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['operation', 'payload'], properties: { operation: { enum: MODEL_LIGHT_DOCUMENT_OPERATIONS }, payload: { type: 'object', additionalProperties: true } } } }
const lightDocumentWriteCommitTool = { name: 'light_document_write_commit', title: 'Commit approved light-document write', description: 'After user approval, commit exactly the non-selection change captured by light_document_write_preview. Supply only the one-time challenge. On any failure, stop and report the exact error; do not retry through a different write tool.', annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['challenge'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 } } } }

const teamKnowledgeBatchItemSchema = { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 100000 } } }
const teamKnowledgeBatchPreviewTool = { name: 'team_knowledge_batch_preview', title: 'Preview one to ten Team Knowledge light documents', description: 'The first step for one to ten light documents. Provide a stable batchId and the exact ordered names and bodies. This inspects the currently bound parent and returns a model-visible one-time creation challenge plus expiresAt. Copy that exact challenge into team_knowledge_batch_create after explicit user confirmation. If it expired, preview the unchanged batch again before create. No online document is created in this step.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'items'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } } }
const teamKnowledgeBatchCreateTool = { name: 'team_knowledge_batch_create', title: 'Create the approved Team Knowledge light-document batch', description: 'After explicit approval, provide only the stable batchId and one-time challenge returned by preview. The Connector uses the exact in-memory preview snapshot, so names and bodies must not be sent again. Each item is written separately and the Browser Target shows a confirmation card; wait for the user to inspect and confirm that document before the tool leaves it or starts the next item. Success still requires business success, same-parent catalog rediscovery, persisted body readback, and every per-document confirmation. If the Native Host restarted or the Approval Grant expired, preview and confirm again. Reuse the same batchId to resume unfinished items; never fall back to opening a new tab or manual per-document writes.', annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'challenge'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, challenge: { type: 'string', minLength: 1, maxLength: 256 } } } }

export const CONNECTOR_TOOLS = [
  officeGetContextTool, readWorkTabTool, lightDocumentReadTool,
  lightDocumentSelectionReadTool, lightDocumentSelectionReplacePreviewTool,
  lightDocumentSelectionReplaceCommitTool, lightDocumentSearchTool,
  lightDocumentWritePreviewTool, lightDocumentWriteCommitTool,
  teamKnowledgeBatchPreviewTool, teamKnowledgeBatchCreateTool,
  knowledgeSearchTool, codeSearchTool, selectedSourceScopeTool,
]
