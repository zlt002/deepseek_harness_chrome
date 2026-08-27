import { documentDraftLine } from '../formats.mjs'

const EMPTY_DOCUMENTS = Object.freeze([])

/** Session-local documents saved for the next successful composer submission. */
export class PendingDocuments {
  #nextId = 1
  #sessions = new Map()
  #listeners = new Set()

  add(sessionId, files) {
    const key = String(sessionId)
    const current = this.#sessions.get(key) ?? []
    const added = files.map(file => ({ ...file, id: this.#nextId++, status: 'ready' }))
    this.#sessions.set(key, [...current, ...added])
    this.#emit()
  }

  /** Show browser files immediately, before their workspace write completes. */
  begin(sessionId, files) {
    const key = String(sessionId)
    const current = this.#sessions.get(key) ?? []
    const added = files.map(file => ({
      id: this.#nextId++,
      name: file.name,
      size: file.size,
      status: 'uploading',
    }))
    this.#sessions.set(key, [...current, ...added])
    this.#emit()
    return added
  }

  /** Promote exactly the browser files whose Host write was accepted. */
  resolve(sessionId, ids, savedFiles) {
    const key = String(sessionId)
    const savedById = new Map(ids.map((id, index) => [id, savedFiles[index]]))
    const next = this.snapshot(key).map(file => {
      const saved = savedById.get(file.id)
      if (saved === undefined || file.status !== 'uploading') return file
      if (saved.relativePath === undefined || saved.kind === undefined) {
        return { ...file, status: 'error', error: '文档未能完成保存' }
      }
      return {
        ...file,
        ...saved,
        name: saved.name ?? file.name,
        status: 'ready',
      }
    })
    this.#sessions.set(key, next)
    this.#emit()
  }

  /** Keep the failed card visible until the user explicitly removes it. */
  fail(sessionId, ids, error) {
    const key = String(sessionId)
    const message = error instanceof Error ? error.message : String(error)
    const failed = new Set(ids)
    const next = this.snapshot(key).map(file => file.status === 'uploading' && failed.has(file.id)
      ? { ...file, status: 'error', error: message }
      : file)
    this.#sessions.set(key, next)
    this.#emit()
  }

  snapshot(sessionId) {
    return this.#sessions.get(String(sessionId)) ?? EMPTY_DOCUMENTS
  }

  ready(sessionId) {
    return this.snapshot(sessionId).filter(file => file.status === 'ready')
  }

  remove(sessionId, id) {
    const key = String(sessionId)
    const remaining = this.snapshot(key).filter(file => file.id !== id)
    if (remaining.length === 0) this.#sessions.delete(key)
    else this.#sessions.set(key, remaining)
    this.#emit()
  }

  accept(sessionId, ids) {
    const key = String(sessionId)
    const accepted = new Set(ids)
    const remaining = this.snapshot(key).filter(file => !accepted.has(file.id))
    if (remaining.length === 0) this.#sessions.delete(key)
    else this.#sessions.set(key, remaining)
    this.#emit()
  }

  availability(sessionId) {
    return {
      getSnapshot: () => this.ready(sessionId).length > 0,
      subscribe: listener => {
        this.#listeners.add(listener)
        return () => { this.#listeners.delete(listener) }
      },
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}

/** Add every saved document to the model-bound prompt without changing the visible draft. */
export function documentSubmissionPrompt(text, files) {
  if (files.length === 0) return text
  const instructions = files.map(file => documentDraftLine(file.relativePath, file.kind)).join('\n')
  return text.trim() === '' ? instructions : `${text.replace(/\s+$/u, '')}\n${instructions}`
}
