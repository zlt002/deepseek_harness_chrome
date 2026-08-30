/** Stable Ask payload reserved for /pmd-prd reference-source selection. */
export const PMD_PRD_SOURCE_QUESTION_ID = 'pmd_prd_reference_sources'
export const SELECT_SOURCES_OPTION = '选择资料（推荐）'
export const SELECTED_SOURCES_CONTINUE_MESSAGE = '已选好资料，立即重新读取范围并继续'
export const SKIP_REMOTE_SOURCES_OPTION = '本轮不使用远程资料'

/** Only the exact two-option Ask request receives the compact product treatment. */
export function sourceScopeQuestion(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return undefined
  const question = questions[0]
  const labels = question?.options?.map(option => option?.label)
  if (question?.id !== PMD_PRD_SOURCE_QUESTION_ID
    || labels?.length !== 2
    || labels[0] !== SELECT_SOURCES_OPTION
    || labels[1] !== SKIP_REMOTE_SOURCES_OPTION) return undefined
  return question
}

/** A choice opens the picker or explicitly continues without remote sources. */
export function sourceScopeAction(label) {
  if (label === SELECT_SOURCES_OPTION) return 'open-repository-picker'
  if (label === SKIP_REMOTE_SOURCES_OPTION) return 'continue-without-remote-sources'
  return undefined
}

/** The Ask resolves only after the Connector snapshot confirms a real selection. */
export function hasSelectedSources(scope) {
  if (scope === undefined) return false
  if (scope.repositoryIds.length > 0) return true
  return Object.values(scope.domainSystems).some(systemIds => systemIds.length > 0)
}
