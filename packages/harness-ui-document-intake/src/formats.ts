export {
  DOCUMENT_INTAKE_MAX_BYTES,
  DOCUMENT_INTAKE_PATH,
  DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS,
  DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES,
  DOCUMENT_UPLOADS_DIR,
  classifyDocuments,
  documentBaseName,
  documentDraftLine,
  documentKindOf,
  isSafeTextDocumentBytes,
  isTextDocumentKind,
  skillForDocumentKind,
} from './formats.mjs'

export type DocumentKind = 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt'
