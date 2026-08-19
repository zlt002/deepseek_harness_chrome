export { saveSessionDocuments } from './save.mjs'

export interface SavedDocument {
  readonly name: string
  readonly relativePath: string
  readonly kind: 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt'
  readonly skill?: string
}

export interface DocumentUpload {
  readonly name: string
  readonly mediaType?: string
  readonly bytes: Uint8Array
}
