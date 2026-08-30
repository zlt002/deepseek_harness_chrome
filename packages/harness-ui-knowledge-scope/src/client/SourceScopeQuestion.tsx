import { useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import {
  SELECT_SOURCES_OPTION,
  SELECTED_SOURCES_CONTINUE_MESSAGE,
  SKIP_REMOTE_SOURCES_OPTION,
  hasSelectedSources,
  sourceScopeAction,
} from './source-scope-question.js'
import type { KnowledgeScopeInjected } from './KnowledgeScope.tsx'
import css from './SourceScopeQuestion.module.css'

type QuestionWait = PendingWait<'question'>
type Props = PropsRuntime<'conversation.composer'> & { matched: QuestionWait } & InjectFace<KnowledgeScopeInjected>

async function answerQuestion(wait: QuestionWait, selected: string[], custom?: string): Promise<void> {
  const receipt = await wait.respond({
    ok: true,
    value: { sessionId: wait.sessionId, answer: { answers: [{ id: wait.payload.questions[0]!.id, selected, ...(custom === undefined ? {} : { custom }) }] } },
  })
  if (!receipt.accepted) throw new Error(`question response rejected: ${receipt.reason}`)
}

/** A two-choice /pmd-prd Ask card that can open the real repository picker. */
export function SourceScopeQuestion({ matched, useKnowledgeScope }: Props) {
  return <SourceScopeQuestionRequest key={matched.key} matched={matched} useKnowledgeScope={useKnowledgeScope} />
}

/** Request-keyed state prevents a newer Ask from inheriting an older Ask's pending response. */
function SourceScopeQuestionRequest({ matched, useKnowledgeScope }: Props) {
  const question = matched.payload.questions[0]!
  const repositoryOverlay = useComposerOverlay('repository-scope')
  const snapshot = useKnowledgeScope(value => value)
  const scope = snapshot?.sessionId === String(matched.sessionId) ? snapshot.scope : undefined
  const [selectingSources, setSelectingSources] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitted = useRef(false)
  const submit = (selected: string[], custom?: string): void => {
    if (submitted.current || busy) return
    submitted.current = true
    setBusy(true)
    void answerQuestion(matched, selected, custom).catch(() => { submitted.current = false; setBusy(false) })
  }
  const choose = (label: string): void => {
    if (busy) return
    if (sourceScopeAction(label) !== 'open-repository-picker') return submit([label])
    setSelectingSources(true)
    repositoryOverlay.show()
  }
  const selected = hasSelectedSources(scope)

  return <div className={css.frame} data-pmd-prd-source-question>
    <section className={css.card} aria-labelledby={`pmd-prd-source-question-${matched.key}`}>
      {selectingSources ? <div className={css.waiting}>
        <span>{selected ? '已选资料' : '请勾选资料'}</span>
        <div className={css.waitingActions}>
          <button type="button" className={css.useSources} disabled={busy || !selected} onClick={() => submit([], SELECTED_SOURCES_CONTINUE_MESSAGE)}>使用已选资料</button>
          <button type="button" disabled={busy} onClick={() => submit([SKIP_REMOTE_SOURCES_OPTION])}>本轮跳过</button>
        </div>
      </div> : <>
        <h2 id={`pmd-prd-source-question-${matched.key}`}>要用参考资料吗？</h2>
        <div className={css.options}>
          <button type="button" className={css.option} disabled={busy} onClick={() => choose(SELECT_SOURCES_OPTION)}>
            <strong>选择资料 <span>推荐</span></strong>
            <small>选代码库或知识库</small>
          </button>
          <button type="button" className={css.option} disabled={busy} onClick={() => choose(SKIP_REMOTE_SOURCES_OPTION)}>
            <strong>本轮跳过</strong>
            <small>不使用资料，直接继续</small>
          </button>
        </div>
      </>}
    </section>
  </div>
}
