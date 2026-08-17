import type { ClientContext, ISessions, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, IApiClient, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SkillSettingsSection } from './section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'accrui.settings.skills': keyof typeof zh }
}

const zh = { nav: '技能', title: '技能管理', intro: '选择 Harness 如何使用已发现的技能。这里不会修改 SKILL.md，也不会影响其他 Agent。', loading: '正在加载技能…', noSession: '请先打开一个项目会话。', failed: '技能设置读取或保存失败。', enabled: '启用', manual: '仅手动', disabled: '停用', authorModel: '作者已禁止模型调用', authorUser: '作者已禁止手动调用' }
const en: typeof zh = { nav: 'Skills', title: 'Skill settings', intro: 'Choose how Harness may use each discovered skill. These choices do not modify SKILL.md or other agents.', loading: 'Loading skills…', noSession: 'Open a project session first.', failed: 'Could not load or save Skill settings.', enabled: 'Enabled', manual: 'Manual only', disabled: 'Disabled', authorModel: 'Author disabled model use', authorUser: 'Author disabled manual use' }
export type SkillSettingsInjected = { api: Pick<IApiClient, 'skills' | 'settings'>, t: (key: keyof typeof zh) => string, useSessions: SnapshotSelectorHook<SessionListState> }
export const inject = ['slots', 'locale', 'connection', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('accrui.settings.skills', { zh, en }), 'accrui skill settings locale')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const useSessions = bindSnapshotSelector((ctx.get('sessions') as ISessions).list)
  const t = ctx.locale.bind('accrui.settings.skills') as SkillSettingsInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'accrui-skills', order: 30, label: () => t('nav'),
    inject: (): SkillSettingsInjected => ({ api, t, useSessions }),
  }, SkillSettingsSection))
}

export type { SkillEntry }
