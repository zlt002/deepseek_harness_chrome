export {
  DOCUMENT_INTAKE_MAX_BYTES,
  DOCUMENT_INTAKE_PATH,
  DOCUMENT_UPLOADS_DIR,
  classifyDocuments,
  documentBaseName,
  documentDraftLine,
  documentKindOf,
  skillForDocumentKind,
} from './formats.mjs'

export type DocumentKind = 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt'
