import type { ClientContext, ISessions, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, IApiClient, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SkillSettingsSection } from './section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'accrui.settings.skills': keyof typeof zh }
}

const zh = { nav: '技能', title: '技能管理', intro: '选择 Harness 如何使用已发现的技能。这里不会修改 SKILL.md，也不会影响其他 Agent。', loading: '正在加载技能…', noSession: '请先打开一个项目会话。', loadFailed: '技能设置加载失败。', saveFailed: '技能设置保存失败。', retry: '重试', empty: '没有发现可用技能。', enabled: '启用', manual: '仅手动', disabled: '停用', more: '更多', delete: '删除', enableAll: '批量启用', disableAll: '批量停用', bulkActions: '批量操作', enabling: '正在启用 /{name}…', disabling: '正在停用 /{name}…', manualing: '正在将 /{name} 设为仅手动…', enablingAll: '正在批量启用…', disablingAll: '正在批量停用…', deleting: '正在删除 /{name}…', deleteSuccess: '已删除 /{name}，技能列表已确认刷新。', authorModel: '作者已禁止模型调用', authorUser: '作者已禁止手动调用', installTitle: '安装技能', installHint: '拖入一个 .zip 技能包或一个技能文件夹。安装不会覆盖同名技能。', chooseZip: '选择 ZIP', chooseFolder: '选择文件夹', installing: '正在安全安装技能…', installSuccess: '已安装 /{name}，正在刷新技能列表。', installReadOnly: '当前设置不可写，无法安装技能。', zipOnly: '请选择 .zip 技能压缩包。', zipTooLarge: '技能压缩包超过 16MB。', folderUnavailable: '当前浏览器不支持选择文件夹；请将技能文件夹拖入此区域。', oneItem: '一次只能安装一个技能压缩包或一个技能文件夹。' }
const en: typeof zh = { nav: 'Skills', title: 'Skill settings', intro: 'Choose how Harness may use each discovered skill. These choices do not modify SKILL.md or other agents.', loading: 'Loading skills…', noSession: 'Open a project session first.', loadFailed: 'Could not load Skill settings.', saveFailed: 'Could not save Skill settings.', retry: 'Retry', empty: 'No skills were discovered.', enabled: 'Enable', manual: 'Manual only', disabled: 'Disable', more: 'More', delete: 'Delete', enableAll: 'Enable all', disableAll: 'Disable all', bulkActions: 'Bulk actions', enabling: 'Enabling /{name}…', disabling: 'Disabling /{name}…', manualing: 'Making /{name} manual only…', enablingAll: 'Enabling all…', disablingAll: 'Disabling all…', deleting: 'Deleting /{name}…', deleteSuccess: 'Deleted /{name}; the Skill list has been confirmed refreshed.', authorModel: 'Author disabled model use', authorUser: 'Author disabled manual use', installTitle: 'Install skill', installHint: 'Drop one .zip skill package or one skill folder. Existing skills are never overwritten.', chooseZip: 'Choose ZIP', chooseFolder: 'Choose folder', installing: 'Installing skill safely…', installSuccess: 'Installed /{name}; refreshing the skill list.', installReadOnly: 'Skill settings are read-only, so installation is unavailable.', zipOnly: 'Choose a .zip skill package.', zipTooLarge: 'The skill package exceeds 16MB.', folderUnavailable: 'This browser cannot choose a folder; drag the skill folder here instead.', oneItem: 'Install one skill package or folder at a time.' }
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
