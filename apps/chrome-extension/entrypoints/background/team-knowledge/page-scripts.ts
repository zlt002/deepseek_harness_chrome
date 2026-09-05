/** Chrome serializes these functions for executeScript. Keep each body self-contained. */
export type TeamKnowledgeItemKind = 'light_document'

export interface TeamKnowledgeUserConfirmation {
  itemIndex: number
  totalItems: number
}

export async function inspectTeamDocParentInPage(catalogId: string, documentDetail = false, trustedLightDocument = false): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, error: 'team_doc_wrong_origin' }
  }
  type TeamDocAttempt = { stage: string; httpStatus: number; errorCode: string | null }
  type TeamDocReply = { response: Response; payload: Record<string, unknown> | null }
  type TeamDocStageResult = { reply: TeamDocReply | null; diagnostic: TeamDocAttempt }
  const parse = async (response: Response): Promise<TeamDocReply> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const payload = JSON.parse(lossless) as unknown
      return { response, payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null }
    } catch { return { response, payload: null } }
  }
  const stageRequest = async (path: string, stage: string, headers?: Record<string, string>): Promise<TeamDocStageResult> => {
    try {
      const reply = await parse(await fetch(`/g-kmp${path}`, { credentials: 'include', ...(headers ? { headers } : {}) }))
      return { reply, diagnostic: { stage, httpStatus: reply.response.status, errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null } }
    } catch {
      return { reply: null, diagnostic: { stage, httpStatus: 0, errorCode: null } }
    }
  }
  const stagePost = async (path: string, stage: string, body: Record<string, string>, headers?: Record<string, string>): Promise<TeamDocStageResult> => {
    try {
      const reply = await parse(await fetch(`/g-kmp${path}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      }))
      return { reply, diagnostic: { stage, httpStatus: reply.response.status, errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null } }
    } catch {
      return { reply: null, diagnostic: { stage, httpStatus: 0, errorCode: null } }
    }
  }
  const successful = (result: TeamDocStageResult | null): result is TeamDocStageResult & { reply: TeamDocReply } =>
    result !== null && result.reply !== null && result.reply.response.ok && result.reply.payload?.errorCode === '00000'
  const dataRecord = (result: TeamDocStageResult | null): Record<string, unknown> | null => {
    const data = result?.reply?.payload?.data
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  }
  const bookIdFromData = (result: TeamDocStageResult | null): string | null => {
    const data = result?.reply?.payload?.data
    if (typeof data === 'string' && /^\d+$/.test(data)) return data
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).bookId === 'string'
      && /^\d+$/.test((data as Record<string, unknown>).bookId as string)) return (data as Record<string, unknown>).bookId as string
    return null
  }
  const failedInspection = (diagnostic: TeamDocAttempt, attempts?: TeamDocAttempt[]) => ({
    ok: false, error: 'team_doc_parent_inspection_failed', diagnostic: { ...diagnostic, ...(attempts ? { attempts } : {}) },
  })
  const capabilities = async (): Promise<Record<string, unknown>> => {
    const attempt = await stageRequest('/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', 'capabilities')
    if (!successful(attempt)) return { diagnostic: attempt.diagnostic }
    const records = Array.isArray(attempt.reply.payload?.data) ? attempt.reply.payload.data : null
    if (records === null) return { diagnostic: attempt.diagnostic }
    const supports = (pattern: RegExp) => records.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return [record.value, record.name, record.icon, record.format]
        .filter((item): item is string => typeof item === 'string')
        .join(' ')
        .match(pattern) !== null
    })
    return { light_document: supports(/newword|lightdoc|轻文档/i), spreadsheet: supports(/newexcel|excel|spreadsheet|表格|xlsx/i) }
  }
  try {
    let resolvedCatalogId = catalogId
    let detailSourceBookId: string | null = null
    const sourceAttempts: TeamDocAttempt[] = []
    if (documentDetail) {
      const openApiAttempt = await stageRequest(
        `/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(catalogId)}`,
        'source_openapi', { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      )
      sourceAttempts.push(openApiAttempt.diagnostic)
      let selectedAttempt = openApiAttempt
      let requireFileType = true
      if (!successful(openApiAttempt)) {
        const catalogAttempt = await stageRequest(
          `/team-knowledge-main/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(catalogId)}`,
          'source_catalog',
        )
        sourceAttempts.push(catalogAttempt.diagnostic)
        if (successful(catalogAttempt)) {
          selectedAttempt = catalogAttempt
        } else {
          const internalAttempt = await stageRequest(
            `/team-knowledge-main/teamKnowledge/get?catalogId=${encodeURIComponent(catalogId)}`,
            'source_internal',
          )
          sourceAttempts.push(internalAttempt.diagnostic)
          if (!successful(internalAttempt)) {
            return failedInspection(internalAttempt.diagnostic, sourceAttempts)
          }
          selectedAttempt = internalAttempt
          requireFileType = false
        }
      }
      const sourceRecord = dataRecord(selectedAttempt) ?? {}
      const sourceId = typeof sourceRecord.catalogId === 'string' ? sourceRecord.catalogId : null
      const sourceParentId = typeof sourceRecord.parentId === 'string' ? sourceRecord.parentId : null
      detailSourceBookId = typeof sourceRecord.bookId === 'string' && /^\d+$/.test(sourceRecord.bookId) ? sourceRecord.bookId : null
      const fileType = sourceRecord.fileType
      if (sourceId !== catalogId || !sourceParentId || !/^\d+$/.test(sourceParentId) || sourceParentId === catalogId
        || (requireFileType && !trustedLightDocument && !((typeof fileType === 'string' && fileType.length > 0) || typeof fileType === 'number'))) {
        return { ok: false, error: 'team_doc_directory_required' }
      }
      const sourceName = [sourceRecord.name, sourceRecord.catalogName, sourceRecord.title]
        .find((value) => typeof value === 'string' && value.trim())
      // `teamKnowledge/get` is the authenticated document-identity fallback
      // for a docOnline URL. Its successful exact catalogId/parentId response
      // does not always expose fileType, so do not discard that verified
      // document merely because the directory-node APIs reject its parent.
      // Permission, bookId and document-children readback still gate use.
      const isLightDocument = trustedLightDocument || !requireFileType || fileType === 4 || (typeof fileType === 'string' && /^(4|newword)$/i.test(fileType.trim()))
      let currentDocumentBookId = detailSourceBookId
      if (currentDocumentBookId === null) {
        const sourceBookAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getBookId?catalogId=${encodeURIComponent(catalogId)}`, 'source_book')
        sourceAttempts.push(sourceBookAttempt.diagnostic)
        if (successful(sourceBookAttempt)) currentDocumentBookId = bookIdFromData(sourceBookAttempt)
      }
      if (isLightDocument && currentDocumentBookId !== null && typeof sourceName === 'string') {
        const permissionAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getPermission?catalogId=${encodeURIComponent(catalogId)}`, 'source_permission')
        sourceAttempts.push(permissionAttempt.diagnostic)
        const sourcePermission = permissionAttempt.reply?.payload?.data
        const sourcePermissionRecord = sourcePermission && typeof sourcePermission === 'object' && !Array.isArray(sourcePermission) ? sourcePermission as Record<string, unknown> : {}
        const sourceCanRead = sourcePermissionRecord.canRead === true
        const sourceCanCreate = sourcePermissionRecord.canAddOrUpload === true
        if (successful(permissionAttempt) && sourceCanRead && sourceCanCreate) {
          const childrenAttempt = await stagePost(
            '/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId', 'source_children',
            { bookId: currentDocumentBookId, parentId: catalogId },
          )
          sourceAttempts.push(childrenAttempt.diagnostic)
          if (successful(childrenAttempt)) {
            const fingerprintSource = `${location.href}|${currentDocumentBookId}|${catalogId}|${sourceName}|${sourceCanRead}|${sourceCanCreate}`
            let hash = 2166136261
            for (let index = 0; index < fingerprintSource.length; index += 1) {
              hash ^= fingerprintSource.charCodeAt(index); hash = Math.imul(hash, 16777619)
            }
            return { ok: true, parent: {
              parentId: catalogId, bookId: currentDocumentBookId, parentName: sourceName, canRead: true, canCreate: true, parentType: 'document',
              fingerprint: `team-doc-parent-v2-${(hash >>> 0).toString(16).padStart(8, '0')}`,
            }, capabilities: await capabilities() }
          }
        }
      }
      resolvedCatalogId = sourceParentId
    }
    let nodeAttempt = await stageRequest(`/team-knowledge-main/teamKnowledge/get?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'node_internal')
    if (!successful(nodeAttempt) && documentDetail) {
      const openApiNodeAttempt = await stageRequest(
        `/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(resolvedCatalogId)}`,
        'node_openapi', { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      )
      if (!successful(openApiNodeAttempt)) {
        const attempts = [...sourceAttempts, nodeAttempt.diagnostic, openApiNodeAttempt.diagnostic]
        return failedInspection(openApiNodeAttempt.diagnostic, documentDetail ? attempts : undefined)
      }
      nodeAttempt = openApiNodeAttempt
    }
    if (!successful(nodeAttempt)) {
      const attempts = [...sourceAttempts, nodeAttempt.diagnostic]
      return failedInspection(nodeAttempt.diagnostic, documentDetail ? attempts : undefined)
    }
    const nodeRecord = dataRecord(nodeAttempt) ?? {}
    const nodeId = typeof nodeRecord.catalogId === 'string' ? nodeRecord.catalogId : resolvedCatalogId
    const parentName = [nodeRecord.name, nodeRecord.catalogName, nodeRecord.title].find((value) => typeof value === 'string' && value.trim())
    const sourceBookId = typeof nodeRecord.bookId === 'string' && /^\d+$/.test(nodeRecord.bookId) ? nodeRecord.bookId : null
    if (nodeId !== resolvedCatalogId || typeof parentName !== 'string') {
      return { ok: false, error: 'team_doc_parent_identity_missing' }
    }
    if (detailSourceBookId !== null && sourceBookId !== null && detailSourceBookId !== sourceBookId) {
      return { ok: false, error: 'team_doc_parent_book_id_mismatch', diagnostic: { ...nodeAttempt.diagnostic, attempts: [nodeAttempt.diagnostic] } }
    }
    const permissionAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getPermission?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'permission')
    if (!successful(permissionAttempt)) return failedInspection(permissionAttempt.diagnostic)
    const permission = permissionAttempt.reply.payload?.data
    const permissionRecord = permission && typeof permission === 'object' && !Array.isArray(permission) ? permission as Record<string, unknown> : {}
    const canRead = permissionRecord.canRead !== false
    const canCreate = permissionRecord.canAddOrUpload === true
    if (!canRead || !canCreate) return { ok: false, error: 'team_doc_parent_permission_denied' }
    const bookAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getBookId?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'book_internal')
    let bookId = successful(bookAttempt) ? bookIdFromData(bookAttempt) : null
    if (successful(bookAttempt) && bookId !== null
      && ((sourceBookId !== null && bookId !== sourceBookId) || (detailSourceBookId !== null && bookId !== detailSourceBookId))) {
      return { ok: false, error: 'team_doc_parent_book_id_mismatch', diagnostic: { ...bookAttempt.diagnostic, attempts: [bookAttempt.diagnostic] } }
    }
    if (bookId === null && sourceBookId !== null) bookId = sourceBookId
    if (bookId === null) {
      const derivationDiagnostic: TeamDocAttempt = { stage: 'book_derived', httpStatus: 0, errorCode: null }
      return failedInspection(derivationDiagnostic, [bookAttempt.diagnostic, derivationDiagnostic])
    }
    const fingerprintSource = `${location.href}|${bookId}|${resolvedCatalogId}|${parentName}|${canRead}|${canCreate}`
    let hash = 2166136261
    for (let index = 0; index < fingerprintSource.length; index += 1) {
      hash ^= fingerprintSource.charCodeAt(index); hash = Math.imul(hash, 16777619)
    }
    // Creation is deliberately limited to an existing catalog directory. A
    // document-detail URL is resolved to its parent above; do not treat the
    // document itself, or an untyped catalog response, as a creatable parent.
    const nodeType = [nodeRecord.fileType, nodeRecord.nodeType, nodeRecord.type, nodeRecord.format]
      .find((value) => (typeof value === 'string' && value.trim().length > 0) || typeof value === 'number')
    const isDirectory = nodeType === 11
      || (typeof nodeType === 'string' && /^(11|directory|folder)$/i.test(nodeType.trim()))
    if (!isDirectory) return { ok: false, error: 'team_doc_directory_required' }
    return { ok: true, parent: {
      parentId: resolvedCatalogId, bookId, parentName, canRead: true, canCreate: true,
      parentType: typeof nodeType === 'number' ? String(nodeType) : typeof nodeType === 'string' ? nodeType : 'catalog',
      fingerprint: `team-doc-parent-v2-${(hash >>> 0).toString(16).padStart(8, '0')}`,
    }, capabilities: await capabilities() }
  } catch {
    return { ok: false, error: 'team_doc_parent_inspection_failed' }
  }
}

export async function createTeamDocInPage(input: { bookId: string; parentId: string; name: string; kind?: TeamKnowledgeItemKind; parentType?: string }): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'create', error: 'team_doc_wrong_origin' }
  }
  const parse = async (response: Response): Promise<{ response: Response; payload: Record<string, unknown> | null }> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const payload = JSON.parse(lossless) as unknown
      return { response, payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null }
    } catch { return { response, payload: null } }
  }
  const diagnostic = (reply: { response: Response; payload: Record<string, unknown> | null }) => ({
    httpStatus: reply.response.status,
    errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null,
  })
  const recordsFrom = (data: unknown): unknown[] => {
    if (Array.isArray(data)) return data
    const pending = data && typeof data === 'object' ? [data as Record<string, unknown>] : []
    const seen = new Set<object>()
    while (pending.length > 0 && seen.size < 32) {
      const record = pending.shift()!
      if (seen.has(record)) continue
      seen.add(record)
      for (const key of ['records', 'list', 'items', 'content', 'rows', 'page']) {
        const value = record[key]
        if (Array.isArray(value)) return value
        if (value && typeof value === 'object') pending.push(value as Record<string, unknown>)
      }
      if (typeof record.catalogId === 'string') return [record]
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
      }
    }
    return []
  }
  const listChildren = async () => {
    const documentParent = input.parentType === 'document'
    const reply = await parse(await fetch(documentParent ? '/g-kmp/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId' : '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(documentParent ? {} : { businessSystem: 'TEAM_KNOWLEDGE_BOOK' }) },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
    }))
    return { reply, records: recordsFrom(reply.payload?.data) }
  }
  const exactId = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? [
        (value as Record<string, unknown>).catalogId,
        (value as Record<string, unknown>).id,
        (value as Record<string, unknown>).pid,
      ].find((candidate): candidate is string => typeof candidate === 'string' && /^\d+$/.test(candidate)) ?? null
    : null
  const recordName = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const name = [record.name, record.fileName, record.catalogName, record.title].find((candidate) => typeof candidate === 'string')
    return typeof name === 'string' ? name : null
  }
  const documentUrl = (record: Record<string, unknown>, documentId: string, fallback?: unknown) => {
    const rawUrl = typeof record.url === 'string' ? record.url : typeof fallback === 'string' ? fallback : `/teamKnowledge/detail/docOnline/${documentId}?id=${documentId}`
    const url = new URL(rawUrl, 'https://doc.midea.com').href
    return new URL(url).origin === 'https://doc.midea.com' ? url : null
  }
  const lightDocumentRecordStatus = (value: unknown): boolean | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const values = [record.fileType, record.fileTypeName, record.fileTypeValue, record.type, record.format, record.fileFormat, record.kind, record.value]
    for (const candidate of values) {
      if (candidate === 4 || candidate === '4') return true
      if (candidate === 8 || candidate === '8') return false
      if (typeof candidate !== 'string') continue
      const normalized = candidate.trim().toLowerCase()
      if (/^(newword|lightdoc|light_document|light-document|轻文档)$/.test(normalized)) return true
      if (/^(newexcel|spreadsheet|excel|xlsx|表格)$/.test(normalized)) return false
    }
    return null
  }
  const exactTypeRecord = async (documentId: string): Promise<Record<string, unknown> | null> => {
    try {
      const reply = await parse(await fetch(`/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(documentId)}`, {
        credentials: 'include', headers: { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      }))
      const record = reply.payload?.data
      return reply.response.ok && reply.payload?.errorCode === '00000' && exactId(record) === documentId && record && typeof record === 'object' && !Array.isArray(record)
        ? record as Record<string, unknown>
        : null
    } catch { return null }
  }
  try {
    const initialChildren = await listChildren()
    if (!initialChildren.reply.response.ok || initialChildren.reply.payload?.errorCode !== '00000') {
      return { ok: false, failedAt: 'create', error: 'team_doc_name_check_failed', diagnostic: diagnostic(initialChildren.reply) }
    }
    const exactName = initialChildren.records.find((value) => recordName(value) === input.name)
    if (exactName) {
      return { ok: false, failedAt: 'create', error: 'team_doc_exact_name_conflict', documentId: null, diagnostic: diagnostic(initialChildren.reply) }
    }
    const fileTypes = await parse(await fetch('/g-kmp/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', { credentials: 'include' }))
    const fileTypeRecords = Array.isArray(fileTypes.payload?.data) ? fileTypes.payload.data : []
    const selectedType = fileTypeRecords.find((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      const descriptor = [record.value, record.name, record.icon, record.format].filter((item) => typeof item === 'string').join(' ')
      return /newword|lightdoc|轻文档/i.test(descriptor)
    }) as Record<string, unknown> | undefined
    const fileType = selectedType?.type
    if (!fileTypes.response.ok || fileTypes.payload?.errorCode !== '00000' || (typeof fileType !== 'number' && typeof fileType !== 'string')) {
      return { ok: false, failedAt: 'create', error: 'team_doc_file_type_unavailable', diagnostic: diagnostic(fileTypes) }
    }
    const createReply = await parse(await fetch('https://apiprod.midea.com/g-kmp/team-knowledge-main/teamKnowledge/add', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-cache', 'X-Original-Referer': document.referrer, 'x-app-id': '' },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId, fileName: input.name, fileType }),
    }))
    const data = createReply.payload?.data
    const created = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
    const documentId = exactId(created)
    if (!createReply.response.ok || createReply.payload?.errorCode !== '00000' || !documentId || !/^\d+$/.test(documentId)) {
      return { ok: false, failedAt: 'create', error: 'team_doc_create_failed', diagnostic: diagnostic(createReply) }
    }
    let children = await listChildren()
    let match = children.records.find((value) => exactId(value) === documentId && recordName(value) === input.name) as Record<string, unknown> | undefined
    if (!match && children.reply.response.ok && children.reply.payload?.errorCode === '00000') {
      const renamed = await parse(await fetch('/g-kmp/team-knowledge-main/teamKnowledgeCatalog/rename', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: documentId, name: input.name }),
      }))
      if (!renamed.response.ok || renamed.payload?.errorCode !== '00000') {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rename_failed', documentId, diagnostic: diagnostic(renamed) }
      }
      children = await listChildren()
      match = children.records.find((value) => exactId(value) === documentId && recordName(value) === input.name) as Record<string, unknown> | undefined
    }
    if (!children.reply.response.ok || children.reply.payload?.errorCode !== '00000' || !match) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId, diagnostic: diagnostic(children.reply) }
    }
    const url = documentUrl(match, documentId, created.url)
    if (!url) return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId }
    // A document-parent listing may omit its child's file type or expose a
    // symbolic alias (for example `newword`). Keep the exact same-parent
    // lookup, then use the exact child record when the listing cannot identify
    // the dynamically created light-document kind.
    const actualIsLightDocument = lightDocumentRecordStatus(match) ?? lightDocumentRecordStatus(await exactTypeRecord(documentId))
    if (actualIsLightDocument === null) {
      return { ok: true, documentId, catalogId: documentId, kind: 'light_document', provisionalKind: true, url }
    }
    if (!actualIsLightDocument) {
      return { ok: false, failedAt: 'rediscover', error: 'team_knowledge_item_type_mismatch', documentId, catalogId: documentId, url, diagnostic: diagnostic(children.reply) }
    }
    return { ok: true, documentId, catalogId: documentId, kind: 'light_document', url }
  } catch {
    return { ok: false, failedAt: 'create', error: 'team_doc_create_failed' }
  }
}

export async function rediscoverTeamDocInPage(input: {
  bookId: string
  parentId: string
  documentId: string
  name?: string
  kind?: TeamKnowledgeItemKind
  parentType?: string
  renameOnMismatch?: boolean
}): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_wrong_origin', documentId: input.documentId }
  }
  try {
    const documentParent = input.parentType === 'document'
    const recordsFrom = (data: unknown): unknown[] => {
      if (Array.isArray(data)) return data
      const pending = data && typeof data === 'object' ? [data as Record<string, unknown>] : []
      const seen = new Set<object>()
      while (pending.length > 0 && seen.size < 32) {
        const record = pending.shift()!
        if (seen.has(record)) continue
        seen.add(record)
      for (const key of ['records', 'list', 'items', 'content', 'rows', 'page']) {
        const value = record[key]
        if (Array.isArray(value)) return value
        if (value && typeof value === 'object') pending.push(value as Record<string, unknown>)
      }
      if (typeof record.catalogId === 'string') return [record]
      for (const value of Object.values(record)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
        }
      }
      return []
    }
    const readChildren = async () => {
      const response = await fetch(documentParent ? '/g-kmp/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId' : '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(documentParent ? {} : { businessSystem: 'TEAM_KNOWLEDGE_BOOK' }) },
        body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
      })
      const text = await response.text()
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const parsed = JSON.parse(lossless) as unknown
      const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      return { response, payload, records: recordsFrom(payload?.data), diagnostic: { httpStatus: response.status, errorCode: typeof payload?.errorCode === 'string' ? payload.errorCode : null } }
    }
    const recordName = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      return [record.name, record.fileName, record.catalogName, record.title]
        .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0) ?? null
    }
    const requestedName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name : null
    const matchingRecord = (records: unknown[]) => records.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && [
        (value as Record<string, unknown>).catalogId,
        (value as Record<string, unknown>).id,
        (value as Record<string, unknown>).pid,
      ].some((candidate) => candidate === input.documentId)
      && (requestedName === null || recordName(value) === requestedName)) as Record<string, unknown> | undefined
    const lightDocumentStatus = (value: unknown): boolean | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      const values = [record.fileType, record.fileTypeName, record.fileTypeValue, record.type, record.format, record.fileFormat, record.kind, record.value]
      for (const candidate of values) {
        if (candidate === 4 || candidate === '4') return true
        if (candidate === 8 || candidate === '8') return false
        if (typeof candidate !== 'string') continue
        const normalized = candidate.trim().toLowerCase()
        if (/^(newword|lightdoc|light_document|light-document|轻文档)$/.test(normalized)) return true
        if (/^(newexcel|spreadsheet|excel|xlsx|表格)$/.test(normalized)) return false
      }
      return null
    }
    const exactTypeRecord = async (): Promise<Record<string, unknown> | null> => {
      try {
        const response = await fetch(`/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(input.documentId)}`, {
          credentials: 'include', headers: { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
        })
        const text = await response.text()
        const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
          .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
        const payload = JSON.parse(lossless) as { errorCode?: unknown; data?: unknown }
        const record = payload.data
        const recordId = record && typeof record === 'object' && !Array.isArray(record)
          ? [(record as Record<string, unknown>).catalogId, (record as Record<string, unknown>).id, (record as Record<string, unknown>).pid]
            .find((candidate): candidate is string => candidate === input.documentId)
          : null
        return response.ok && payload.errorCode === '00000' && recordId && record && typeof record === 'object' && !Array.isArray(record)
          ? record as Record<string, unknown>
          : null
      } catch { return null }
    }
    let children = await readChildren()
    if (!children.response.ok || children.payload?.errorCode !== '00000') {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
    }
    const located = children.records.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && [(value as Record<string, unknown>).catalogId, (value as Record<string, unknown>).id, (value as Record<string, unknown>).pid]
        .some((candidate) => candidate === input.documentId)) as Record<string, unknown> | undefined
    if (!located) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
    }
    let match = matchingRecord(children.records)
    if (!match) {
      // A readback is strictly read-only. It may identify the child by
      // catalogId alone, but it must never rename a remotely stored item just
      // to satisfy a stale or omitted caller-provided name.
      if (input.renameOnMismatch !== true || requestedName === null) {
        return {
          ok: false,
          failedAt: 'rediscover',
          error: requestedName === null ? 'team_doc_rediscover_mismatch' : 'team_doc_name_mismatch',
          documentId: input.documentId,
          name: recordName(located),
          diagnostic: children.diagnostic,
        }
      }
      const renameResponse = await fetch('/g-kmp/team-knowledge-main/teamKnowledgeCatalog/rename', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: input.documentId, name: input.name }),
      })
      const renameText = await renameResponse.text()
      const renamePayload = JSON.parse(renameText) as { errorCode?: unknown }
      const renameDiagnostic = { httpStatus: renameResponse.status, errorCode: typeof renamePayload?.errorCode === 'string' ? renamePayload.errorCode : null }
      if (!renameResponse.ok || renamePayload?.errorCode !== '00000') {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rename_failed', documentId: input.documentId, diagnostic: renameDiagnostic }
      }
      children = await readChildren()
      match = matchingRecord(children.records)
      if (!children.response.ok || children.payload?.errorCode !== '00000' || !match) {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
      }
    }
    const rawUrl = typeof match.url === 'string' ? match.url : `/teamKnowledge/detail/docOnline/${input.documentId}?id=${input.documentId}`
    const url = new URL(rawUrl, 'https://doc.midea.com').href
    if (new URL(url).origin !== 'https://doc.midea.com') return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId: input.documentId }
    if (input.kind !== undefined) {
      const fileTypesResponse = await fetch('/g-kmp/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', { credentials: 'include' })
      const fileTypesText = await fileTypesResponse.text()
      const fileTypesPayload = JSON.parse(fileTypesText) as { errorCode?: unknown; data?: unknown }
      const fileTypes = Array.isArray(fileTypesPayload.data) ? fileTypesPayload.data : []
      const expected = fileTypes.find((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const record = value as Record<string, unknown>
        const descriptor = [record.value, record.name, record.icon, record.format].filter((item) => typeof item === 'string').join(' ')
        return /newword|lightdoc|轻文档/i.test(descriptor)
      }) as Record<string, unknown> | undefined
      if (!fileTypesResponse.ok || fileTypesPayload.errorCode !== '00000' || !expected) {
        return { ok: true, recovered: true, documentId: input.documentId, catalogId: input.documentId, kind: input.kind, name: recordName(match) ?? recordName(located), provisionalKind: true, url }
      }
      const actualIsLightDocument = lightDocumentStatus(match) ?? lightDocumentStatus(await exactTypeRecord())
      if (actualIsLightDocument === null) return { ok: true, recovered: true, documentId: input.documentId, catalogId: input.documentId, kind: input.kind, name: recordName(match) ?? recordName(located), provisionalKind: true, url }
      if (!actualIsLightDocument) {
        return { ok: false, failedAt: 'rediscover', error: 'team_knowledge_item_type_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
      }
    }
    return {
      ok: true,
      recovered: true,
      documentId: input.documentId,
      catalogId: input.documentId,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      name: recordName(match) ?? recordName(located),
      url,
    }
  } catch {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_failed', documentId: input.documentId }
  }
}

export async function writeTeamDocInWebEdit(body: string, readOnly = false): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'webedit.midea.com') {
    return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_wrong_origin' : 'team_doc_wrong_webedit_origin' }
  }
  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  try {
    let app: any = null
    let batchRuntime: {
      teamKnowledgeBatchReplace?: (markdown: string) => Promise<unknown>
      teamKnowledgeBatchVerify?: (markdown: string) => Promise<unknown>
    } | undefined
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      app = (globalThis as typeof globalThis & { APP?: unknown }).APP
      batchRuntime = (globalThis as typeof globalThis & { __deepseekHarnessLightDocumentRuntime?: typeof batchRuntime }).__deepseekHarnessLightDocumentRuntime
      if (app?.openApi?.editor?.canvas?.getDocXml && typeof (readOnly ? batchRuntime?.teamKnowledgeBatchVerify : batchRuntime?.teamKnowledgeBatchReplace) === 'function') break
      await wait(100)
    }
    const batchOperation = readOnly ? batchRuntime?.teamKnowledgeBatchVerify : batchRuntime?.teamKnowledgeBatchReplace
    if (!app?.openApi?.editor?.canvas?.getDocXml || typeof batchOperation !== 'function') return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_unavailable' : 'team_doc_webedit_runtime_unavailable' }
    const outcome = await batchOperation(body) as {
      ok?: unknown; error?: { code?: unknown }; observed?: { observedBody?: unknown }
    }
    if (outcome?.ok !== true || typeof outcome.observed?.observedBody !== 'string') {
      const code = typeof outcome?.error?.code === 'string' ? outcome.error.code : 'runtime_error'
      const failedAt = code === 'readback_mismatch' ? 'readback' : readOnly ? 'readback' : 'write'
      return { ok: false, failedAt, error: readOnly ? `team_knowledge_document_persisted_${code}` : `team_doc_batch_replace_${code}` }
    }
    if (!readOnly) {
      // An XML change proves only the editor's in-memory state. Give WebEdit's
      // asynchronous save/sync cycle a bounded chance to settle before the
      // caller leaves this page. The caller still reopens the same catalogId
      // and performs a fresh read, which remains the authoritative gate.
      const configuredSettleMs = Number((globalThis as typeof globalThis & { __DSH_TEAM_DOC_PERSISTENCE_SETTLE_MS?: unknown }).__DSH_TEAM_DOC_PERSISTENCE_SETTLE_MS)
      const minimumSettleMs = Number.isFinite(configuredSettleMs) && configuredSettleMs >= 0 ? Math.min(configuredSettleMs, 10_000) : 1_500
      const settleStartedAt = Date.now()
      const settleDeadline = settleStartedAt + Math.max(minimumSettleMs, 10_000)
      const booleanSignal = async (names: string[]) => {
        for (const name of names) {
          const candidate = app?.[name]
          try {
            const value = typeof candidate === 'function' ? await candidate.call(app) : candidate
            if (typeof value === 'boolean') return value
          } catch { /* an optional save signal must not replace reopen readback */ }
        }
        return undefined
      }
      while (Date.now() < settleDeadline) {
        const saving = await booleanSignal(['isSaving', 'getIsSaving', 'IsSaving'])
        const syncing = await booleanSignal(['isSyncing', 'getIsSyncing', 'IsSyncing'])
        const busy = saving === true || syncing === true
        if (!busy && Date.now() - settleStartedAt >= minimumSettleMs) break
        await wait(100)
      }
    }
    return { ok: true, readbackMatches: true, observedBody: outcome.observed.observedBody }
  } catch {
    return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_failed' : 'team_doc_webedit_write_failed' }
  }
}

export async function waitForTeamKnowledgeUserConfirmation(input: TeamKnowledgeUserConfirmation & { name: string }): Promise<{ status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded' | 'unavailable' }> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com' || !document.body) return { status: 'unavailable' }
  const stateKey = '__dshTeamKnowledgeUserConfirmation'
  type ConfirmationState = { finish: (status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded') => void }
  const hostWindow = window as Window & { [stateKey]?: ConfirmationState }
  hostWindow[stateKey]?.finish('unloaded')

  return new Promise((resolve) => {
    const previous = document.querySelector('[data-dsh-team-knowledge-confirmation="card"]')
    previous?.remove()
    const card = document.createElement('section')
    card.dataset.dshTeamKnowledgeConfirmation = 'card'
    card.setAttribute('role', 'status')
    card.setAttribute('aria-live', 'polite')
    card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:14px 16px;border:1px solid #d9e2f2;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 12px 32px rgba(15,23,42,.18);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    const title = document.createElement('strong')
    title.dataset.dshTeamKnowledgeConfirmation = 'title'
    title.textContent = `第 ${input.itemIndex} 份 / 共 ${input.totalItems} 份已写入`
    const description = document.createElement('div')
    description.dataset.dshTeamKnowledgeConfirmation = 'document-name'
    description.style.cssText = 'margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    description.textContent = input.name
    const hint = document.createElement('div')
    hint.dataset.dshTeamKnowledgeConfirmation = 'hint'
    hint.style.cssText = 'margin-top:8px;color:#52606d;font-size:12px;'
    hint.textContent = '请确认内容；编辑器会继续自动保存。'
    const actions = document.createElement('div')
    actions.dataset.dshTeamKnowledgeConfirmation = 'actions'
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;'
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.dataset.dshTeamKnowledgeConfirmationAction = 'stop'
    stop.textContent = '停止并留在此文档'
    stop.style.cssText = 'border:0;background:transparent;color:#52606d;cursor:pointer;padding:6px 8px;'
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.dataset.dshTeamKnowledgeConfirmationAction = 'confirm'
    confirm.textContent = '已确认并继续'
    confirm.style.cssText = 'border:0;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;padding:6px 10px;'
    actions.append(stop, confirm)
    card.append(title, description, hint, actions)
    document.body.append(card)

    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      stop.removeEventListener('click', onStop)
      confirm.removeEventListener('click', onConfirm)
      card.remove()
      if (hostWindow[stateKey]?.finish === finish) delete hostWindow[stateKey]
    }
    const finish = (status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded') => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ status })
    }
    const onStop = () => finish('stopped')
    const onConfirm = () => finish('confirmed')
    const onPageHide = () => finish('unloaded')
    const timeout = setTimeout(() => finish('timeout'), 10 * 60 * 1_000)
    hostWindow[stateKey] = { finish }
    stop.addEventListener('click', onStop)
    confirm.addEventListener('click', onConfirm)
    window.addEventListener('pagehide', onPageHide, { once: true })
    window.addEventListener('beforeunload', onPageHide, { once: true })
  })
}

export function showTeamKnowledgeReadbackFailure(input: { name: string; error: string }): { shown: boolean } {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com' || !document.body) return { shown: false }
  document.querySelector('[data-dsh-team-knowledge-readback-failure="card"]')?.remove()
  const card = document.createElement('section')
  card.dataset.dshTeamKnowledgeReadbackFailure = 'card'
  card.setAttribute('role', 'alert')
  card.setAttribute('aria-live', 'assertive')
  card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:14px 16px;border:1px solid #f0c9c4;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 12px 32px rgba(15,23,42,.18);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
  const title = document.createElement('strong')
  title.textContent = '内容尚未完成验证'
  const description = document.createElement('div')
  description.style.cssText = 'margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  description.textContent = input.name
  const hint = document.createElement('div')
  hint.style.cssText = 'margin-top:8px;color:#8a3b32;font-size:12px;'
  hint.textContent = '文档已保留在当前页，但未能完整回读；检查后请返回原目录，再在侧边栏重试此项。'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '知道了'
  dismiss.style.cssText = 'display:block;margin:12px 0 0 auto;border:0;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;padding:6px 10px;'
  dismiss.addEventListener('click', () => card.remove())
  card.append(title, description, hint, dismiss)
  document.body.append(card)
  return { shown: true }
}
