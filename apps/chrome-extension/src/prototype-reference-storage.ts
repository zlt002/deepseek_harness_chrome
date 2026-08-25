import { MAX_OPEN_PROTOTYPE_STUDIOS } from './prototype-studio-authorization'

export const MAX_STORED_PROTOTYPE_REFERENCES = MAX_OPEN_PROTOTYPE_STUDIOS

// chrome.storage.local has a shared, finite quota. Keep Prototype Studio at
// roughly half of the default allowance so preferences and other product data
// still have room. One maximum-size (2 MB) screenshot plus its evidence fits.
export const PROTOTYPE_REFERENCE_STORAGE_BUDGET_BYTES = 5_000_000

interface RetentionOptions {
  maximum?: number
  budgetBytes?: number
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capturedAt(value: unknown): number {
  if (!object(value) || !object(value.source) || typeof value.source.capturedAt !== 'string') return 0
  return Date.parse(value.source.capturedAt) || 0
}

export function prototypeReferenceStorageBytes(references: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify({ v: 1, references })).byteLength
}

/**
 * Keeps recent evidence recoverable without allowing screenshots to exhaust
 * chrome.storage.local. Screenshot fingerprints remain after image removal, so
 * the evidence and its integrity check are still useful on an old tab reload.
 */
export function retainedPrototypeReferences(
  references: Record<string, unknown>,
  options: RetentionOptions = {},
): Record<string, unknown> {
  const maximum = Math.max(0, Math.floor(options.maximum ?? MAX_STORED_PROTOTYPE_REFERENCES))
  const budgetBytes = Math.max(0, Math.floor(options.budgetBytes ?? PROTOTYPE_REFERENCE_STORAGE_BUDGET_BYTES))
  const retained = Object.entries(references)
    .sort((left, right) => capturedAt(right[1]) - capturedAt(left[1]) || left[0].localeCompare(right[0]))
    .slice(0, maximum)

  const current = (): Record<string, unknown> => Object.fromEntries(retained)
  for (let index = retained.length - 1; index >= 0 && prototypeReferenceStorageBytes(current()) > budgetBytes; index -= 1) {
    const entry = retained[index]
    if (entry === undefined || !object(entry[1]) || !Object.hasOwn(entry[1], 'screenshotDataUrl')) continue
    const { screenshotDataUrl: _screenshot, ...withoutScreenshot } = entry[1]
    retained[index] = [entry[0], withoutScreenshot]
  }
  while (retained.length > 0 && prototypeReferenceStorageBytes(current()) > budgetBytes) retained.pop()
  return current()
}
