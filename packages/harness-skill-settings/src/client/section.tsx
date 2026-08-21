import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillSettingsInjected } from './index.ts'
import { enableInstalledSkill } from './enable-installed-skill.mjs'
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILE_BYTES, MAX_FOLDER_FILES, readSelectedFolderFiles } from './folder-upload.mjs'
import { modesForSelection, refreshAfterDeletedSkill, updateSkillModes } from './update-skill-modes.mjs'
import css from './section.module.css'

type Mode = 'enabled' | 'manual-only' | 'disabled'
type Origin = 'system' | 'installed' | 'project' | 'user'
type OriginFilter = 'all' | Origin
type DisplaySkill = SkillEntry & { origin: Origin, stateEditable: boolean, deletable: boolean }
type View = { writable: boolean, revision: number, modes: Record<string, Mode>, skills: readonly DisplaySkill[] }
type InstallNotice = { kind: 'success' | 'warning' | 'error', text: string }
type ActionNotice = { kind: 'success' | 'warning' | 'error', text: string }
type UploadFile = { path: string, data: string }
type FileSystemDropItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
const NS = 'skill-settings'
const INSTALL_PATH = '/api/settings.skill.install'
const CATALOG_PATH = '/api/settings.skill.catalog'
function modesOf(value: unknown): Record<string, Mode> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const modes = (value as { modes?: unknown }).modes
  if (modes === null || typeof modes !== 'object' || Array.isArray(modes)) return {}
  return Object.fromEntries(Object.entries(modes).filter((entry): entry is [string, Mode] => entry[1] === 'enabled' || entry[1] === 'manual-only' || entry[1] === 'disabled'))
}

async function loadOrigins(sessionId: string): Promise<readonly { name: string, origin: Origin }[]> {
  const response = await fetch(CATALOG_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
  })
  const body = await response.json() as { skills?: unknown, error?: string }
  if (!response.ok || !Array.isArray(body.skills)) throw new Error(body.error ?? `技能来源加载失败：HTTP ${String(response.status)}`)
  return body.skills.filter((item): item is { name: string, origin: Origin } => item !== null && typeof item === 'object'
    && typeof (item as { name?: unknown }).name === 'string'
    && ((item as { origin?: unknown }).origin === 'system' || (item as { origin?: unknown }).origin === 'installed' || (item as { origin?: unknown }).origin === 'project' || (item as { origin?: unknown }).origin === 'user'))
}

export function SkillSettingsSection({ api, t, useSessions }: SkillSettingsInjected): ReactNode {
  const sessionId = useSessions(state => state.current)
  const [view, setView] = useState<View>()
  const [failure, setFailure] = useState(false)
  const [request, setRequest] = useState(0)
  const [pending, setPending] = useState<string>()
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [originMenuOpen, setOriginMenuOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState<string>()
  const [actionNotice, setActionNotice] = useState<ActionNotice>()
  const [installing, setInstalling] = useState(false)
  const [installNotice, setInstallNotice] = useState<InstallNotice>()
  const [dragOver, setDragOver] = useState(false)
  const zipInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (menuOpen === undefined && !originMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-skill-menu], [data-origin-filter-menu]') !== null) return
      setMenuOpen(undefined); setOriginMenuOpen(false)
    }
    const closeEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setMenuOpen(undefined); setOriginMenuOpen(false) } }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [menuOpen, originMenuOpen])
  useEffect(() => { setSelected(new Set()); setOriginFilter('all'); setOriginMenuOpen(false); setMenuOpen(undefined) }, [sessionId])
  useEffect(() => {
    let active = true
    if (sessionId === undefined) { setView(undefined); setFailure(false); return () => { active = false } }
    setFailure(false)
    void Promise.all([api.skills.list({ sessionId, includeUnavailable: true }), api.settings.describe({}), loadOrigins(sessionId)]).then(([skills, settings, origins]) => {
      if (!active) return
      const section = settings.result.ok ? settings.result.value.namespaces.find(item => item.ns === NS) : undefined
      if (!skills.result.ok || section === undefined) { setFailure(true); return }
      const originByName = new Map(origins.map(skill => [skill.name, skill.origin]))
      const catalog = skills.result.value.skills.map(skill => {
        const origin = originByName.get(skill.name) ?? 'user'
        return { ...skill, origin, stateEditable: origin !== 'system', deletable: origin === 'installed' }
      })
      setView({ writable: settings.result.value.writable, revision: section.revision, modes: modesOf(section.value), skills: catalog })
      setSelected(current => new Set([...current].filter(name => catalog.some(skill => skill.name === name && skill.stateEditable))))
    }, () => { if (active) setFailure(true) })
    return () => { active = false }
  }, [api, request, sessionId])
  if (sessionId === undefined) return <p className={css.status}>{t('noSession')}</p>
  if (failure) return <div className={css.status}><p role="alert">{view === undefined ? t('loadFailed') : t('saveFailed')}</p><button type="button" onClick={() => setRequest(value => value + 1)}>{t('retry')}</button></div>
  if (view === undefined) return <p className={css.status}>{t('loading')}</p>
  const updateModes = (modes: Record<string, Mode>, activity: string, clearSelection = false): void => {
    if (!view.writable || pending !== undefined) return
    setPending(activity); setActionNotice({ kind: 'success', text: activity })
    void updateSkillModes(api, NS, modes, view.revision).then(
      () => { setActionNotice(undefined); if (clearSelection) setSelected(new Set()); setRequest(value => value + 1) },
      error => setActionNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }),
    ).finally(() => setPending(undefined))
  }
  const change = (skill: DisplaySkill, mode: Mode): void => {
    if (!skill.stateEditable) return
    updateModes({ [skill.name]: mode }, t(mode === 'enabled' ? 'enabling' : mode === 'disabled' ? 'disabling' : 'manualing').replace('{name}', skill.name))
  }
  const visibleSkills = originFilter === 'all' ? view.skills : view.skills.filter(skill => skill.origin === originFilter)
  const selectedCount = visibleSkills.filter(skill => skill.stateEditable && selected.has(skill.name)).length
  const changeSelected = (mode: Mode): void => {
    if (selectedCount === 0) return
    const modes = modesForSelection(visibleSkills, selected, mode) as Record<string, Mode>
    updateModes(modes, t(mode === 'enabled' ? 'enablingAll' : mode === 'disabled' ? 'disablingAll' : 'manualingAll'), true)
  }
  const toggleSelected = (skill: DisplaySkill): void => {
    if (!skill.stateEditable) return
    setSelected(current => {
    const next = new Set(current)
    if (next.has(skill.name)) next.delete(skill.name)
    else next.add(skill.name)
    return next
    })
  }
  const changeOriginFilter = (value: string): void => {
    if (value !== 'all' && value !== 'system' && value !== 'installed' && value !== 'project' && value !== 'user') return
    setOriginFilter(value)
    setSelected(new Set())
    setOriginMenuOpen(false)
  }
  const originFilterLabel = originFilter === 'all' ? t('allSkills') : t(originFilter === 'system' ? 'sourceSystem' : originFilter === 'installed' ? 'sourceInstalled' : originFilter === 'project' ? 'sourceProject' : 'sourceUser')
  const remove = (skill: DisplaySkill): void => {
    if (!skill.deletable || !view.writable || pending !== undefined) return
    setMenuOpen(undefined); setPending(`delete:${skill.name}`); setActionNotice({ kind: 'success', text: t('deleting').replace('{name}', skill.name) })
    void fetch('/api/settings.skill.delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: String(sessionId), name: skill.name }),
    }).then(async response => {
      const body = await response.json() as { name?: string, error?: string, refreshWarning?: string }
      if (!response.ok || body.name !== skill.name) throw new Error(body.error ?? `技能删除失败：HTTP ${String(response.status)}`)
      setRequest(value => value + 1)
      try {
        const refreshed = await refreshAfterDeletedSkill(api, NS, view.revision)
        if (!refreshed.result.ok) throw new Error(refreshed.result.error.message)
        setActionNotice(body.refreshWarning === undefined
          ? { kind: 'success', text: t('deleteSuccess').replace('{name}', skill.name) }
          : { kind: 'warning', text: body.refreshWarning })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setActionNotice({ kind: 'warning', text: `技能 /${skill.name} 的文件夹已删除，但菜单刷新失败：${detail}` })
      }
    }, error => { throw error }).catch(error => {
      setActionNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }).finally(() => setPending(undefined))
  }
  const install = async (payload: unknown): Promise<void> => {
    if (installing) return
    if (!view.writable) { setInstallNotice({ kind: 'error', text: t('installReadOnly') }); return }
    setInstalling(true); setInstallNotice(undefined)
    let installedName: string | undefined
    try {
      const response = await fetch(INSTALL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload as object, sessionId: String(sessionId) }) })
      const body = await response.json() as { name?: string; error?: string; refreshWarning?: string }
      if (!response.ok || body.name === undefined) throw new Error(body.error ?? `技能安装失败：HTTP ${String(response.status)}`)
      installedName = body.name
      await enableInstalledSkill(api, NS, body.name, view.revision)
      setInstallNotice(body.refreshWarning === undefined
        ? { kind: 'success', text: t('installSuccess').replace('{name}', body.name) }
        : { kind: 'warning', text: body.refreshWarning })
      setRequest(value => value + 1)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setInstallNotice(installedName === undefined
        ? { kind: 'error', text: detail }
        : { kind: 'warning', text: `技能 /${installedName} 已落盘，但启用设置失败：${detail}` })
    } finally { setInstalling(false) }
  }
  const installZip = (file: File): void => {
    if (!file.name.toLowerCase().endsWith('.zip')) { setInstallNotice({ kind: 'error', text: t('zipOnly') }); return }
    if (file.size > 16 * 1024 * 1024) { setInstallNotice({ kind: 'error', text: t('zipTooLarge') }); return }
    void file.arrayBuffer().then(bytes => install({ kind: 'zip', data: bytesToBase64(new Uint8Array(bytes)) }), error => setInstallNotice({ kind: 'error', text: String(error) }))
  }
  const installFolder = (directory: FileSystemDirectoryHandle): void => {
    void readFolder(directory).then(files => install({ kind: 'folder', files }), error => setInstallNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }))
  }
  const installFolderFiles = (files: readonly File[]): void => {
    void readSelectedFolderFiles(files).then(payload => install({ kind: 'folder', files: payload }), error => setInstallNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }))
  }
  const selectFolder = (): void => {
    const input = folderInput.current
    if (input === null) { setInstallNotice({ kind: 'error', text: t('folderUnavailable') }); return }
    input.setAttribute('webkitdirectory', '')
    input.click()
  }
  const drop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragOver(false)
    if (installing) return
    const handles = [...event.dataTransfer.items].map(item => (item as FileSystemDropItem).getAsFileSystemHandle?.()).filter((value): value is Promise<FileSystemHandle | null> => value !== undefined)
    if (handles.length > 0) {
      void Promise.all(handles).then(items => {
        const directories = items.filter((item): item is FileSystemDirectoryHandle => item?.kind === 'directory')
        const files = items.filter((item): item is FileSystemFileHandle => item?.kind === 'file')
        if (directories.length === 1 && files.length === 0) return installFolder(directories[0])
        if (directories.length === 0 && files.length === 1) return void files[0].getFile().then(installZip)
        setInstallNotice({ kind: 'error', text: t('oneItem') })
      }, error => setInstallNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }))
      return
    }
    const files = [...event.dataTransfer.files]
    if (files.length === 1) installZip(files[0])
    else setInstallNotice({ kind: 'error', text: t('oneItem') })
  }
  return <section className={css.section}><h2>{t('title')}</h2><p className={css.intro}>{t('intro')}</p>
    <div className={css.toolbar} aria-label={t('bulkActions')}><div className={css.toolbarActions}><span className={css.selectedCount}>{t('selectedCount').replace('{count}', String(selectedCount))}</span><button className={css.secondaryButton} type="button" disabled={!view.writable || pending !== undefined || selectedCount === 0} onClick={() => changeSelected('enabled')}>{t('enableAll')}</button><button className={css.secondaryButton} type="button" disabled={!view.writable || pending !== undefined || selectedCount === 0} onClick={() => changeSelected('disabled')}>{t('disableAll')}</button><button className={css.secondaryButton} type="button" disabled={!view.writable || pending !== undefined || selectedCount === 0} onClick={() => changeSelected('manual-only')}>{t('manualAll')}</button></div><div className={css.originFilter} data-origin-filter-menu><button className={css.originFilterTrigger} type="button" aria-haspopup="listbox" aria-expanded={originMenuOpen} aria-controls="skill-origin-filter-options" onClick={() => { setMenuOpen(undefined); setOriginMenuOpen(open => !open) }}><span className={css.originFilterLabel}>{originFilterLabel}</span><span className={css.originFilterChevron} aria-hidden>▾</span></button>{!originMenuOpen ? null : <div id="skill-origin-filter-options" className={css.originFilterMenu} role="listbox" aria-label={t('filterLabel')}><button className={css.originFilterOption} type="button" role="option" aria-selected={originFilter === 'all'} onClick={() => changeOriginFilter('all')}>{t('allSkills')}</button><button className={css.originFilterOption} type="button" role="option" aria-selected={originFilter === 'system'} onClick={() => changeOriginFilter('system')}>{t('sourceSystem')}</button><button className={css.originFilterOption} type="button" role="option" aria-selected={originFilter === 'installed'} onClick={() => changeOriginFilter('installed')}>{t('sourceInstalled')}</button><button className={css.originFilterOption} type="button" role="option" aria-selected={originFilter === 'project'} onClick={() => changeOriginFilter('project')}>{t('sourceProject')}</button><button className={css.originFilterOption} type="button" role="option" aria-selected={originFilter === 'user'} onClick={() => changeOriginFilter('user')}>{t('sourceUser')}</button></div>}</div></div>
    {actionNotice === undefined ? null : <p className={actionNotice.kind === 'error' ? css.error : actionNotice.kind === 'warning' ? css.warning : css.status} role={actionNotice.kind === 'error' ? 'alert' : 'status'}>{actionNotice.text}</p>}
    <div
      className={css.install}
      data-drag-over={dragOver ? 'true' : undefined}
      onDragEnter={event => { event.preventDefault(); setDragOver(true) }}
      onDragOver={event => { event.preventDefault(); setDragOver(true) }}
      onDragLeave={event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDragOver(false)
      }}
      onDrop={drop}
    >
      <div className={css.installCopy}><strong>{t('installTitle')}</strong><p>{t('installHint')}</p></div>
      <div className={css.installActions}><button className={css.secondaryButton} type="button" disabled={installing || !view.writable} onClick={() => zipInput.current?.click()}>{t('chooseZip')}</button><button className={css.secondaryButton} type="button" disabled={installing || !view.writable} onClick={selectFolder}>{t('chooseFolder')}</button></div>
      <input ref={zipInput} className={css.hiddenInput} type="file" accept=".zip,application/zip" tabIndex={-1} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) installZip(file) }} />
      <input ref={element => { folderInput.current = element; element?.setAttribute('webkitdirectory', '') }} className={css.hiddenInput} type="file" multiple tabIndex={-1} onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; if (files.length > 0) installFolderFiles(files) }} />
      {installing ? <p className={css.status}>{t('installing')}</p> : null}
      {installNotice === undefined ? null : <p className={installNotice.kind === 'error' ? css.error : installNotice.kind === 'warning' ? css.warning : css.success} role={installNotice.kind === 'error' ? 'alert' : 'status'}>{installNotice.text}</p>}
    </div>
    {visibleSkills.length === 0 ? <p className={css.status}>{t(view.skills.length === 0 ? 'empty' : 'emptyFiltered')}</p> : <ul className={css.rows}>{visibleSkills.map(skill => {
    const mode = view.modes[skill.name] ?? 'enabled'
    const disabled = !skill.stateEditable || !view.writable || pending !== undefined
    const sourceLabel = t(skill.origin === 'system' ? 'sourceSystem' : skill.origin === 'installed' ? 'sourceInstalled' : skill.origin === 'project' ? 'sourceProject' : 'sourceUser')
    const statusLabel = skill.origin === 'system' ? t('tagSystemDefault') : t(mode === 'enabled' ? 'tagEnabled' : mode === 'disabled' ? 'tagDisabled' : 'tagManual')
    return <li key={skill.name} className={css.row}><div className={css.skillCopy}><div className={css.cardHeader}><div className={css.skillMeta}><div className={css.skillTitle}>{skill.stateEditable ? <label className={css.selectionControl}><input type="checkbox" checked={selected.has(skill.name)} disabled={disabled} aria-label={t('selectSkill').replace('{name}', skill.name)} onChange={() => toggleSelected(skill)} /></label> : null}<strong>{skill.name}</strong></div><div className={css.skillTags}><span className={`${css.skillTag} ${css.sourceTag}`} data-origin={skill.origin}>{sourceLabel}</span><span className={`${css.skillTag} ${css.statusTag}`} data-status={mode}>{statusLabel}</span>{skill.authoredModelInvocable === false ? <span className={css.skillTag}>{t('tagAuthorModel')}</span> : null}{skill.authoredUserInvocable === false ? <span className={css.skillTag}>{t('tagAuthorUser')}</span> : null}</div></div><div className={css.cardActions} data-skill-menu>{!skill.stateEditable ? null : <><button className={css.secondaryButton} type="button" disabled={disabled} aria-pressed={mode === 'enabled'} onClick={() => change(skill, 'enabled')}>{t('enabled')}</button><button className={css.secondaryButton} type="button" disabled={disabled} aria-pressed={mode === 'disabled'} onClick={() => change(skill, 'disabled')}>{t('disabled')}</button><button className={css.secondaryButton} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={menuOpen === skill.name} onClick={() => { setOriginMenuOpen(false); setMenuOpen(open => open === skill.name ? undefined : skill.name) }}>{t('more')}</button>{menuOpen !== skill.name ? null : <div className={css.moreMenu} role="menu" aria-label={`${skill.name} ${t('more')}`}><button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuOpen(undefined); change(skill, 'manual-only') }}>{t('manual')}</button>{!skill.deletable ? null : <button className={css.deleteButton} type="button" role="menuitem" disabled={disabled} onClick={() => remove(skill)}>{t('delete')}</button>}</div>}</>}</div></div><p className={css.skillDescription}>{skill.description}</p></div>
    </li>
  })}</ul>}</section>
}

async function readFolder(directory: FileSystemDirectoryHandle): Promise<readonly UploadFile[]> {
  const files: UploadFile[] = []
  let total = 0
  const visit = async (current: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of current.entries()) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (handle.kind === 'directory') { await visit(handle, path); continue }
      const file = await (handle as FileSystemFileHandle).getFile()
      if (file.size > MAX_FOLDER_FILE_BYTES) throw new Error(`技能文件过大：${path}`)
      total += file.size
      if (total > MAX_FOLDER_BYTES) throw new Error('技能文件夹总大小超过 32MB')
      if (files.length >= MAX_FOLDER_FILES) throw new Error(`技能文件数量超过 ${String(MAX_FOLDER_FILES)}`)
      files.push({ path, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) })
    }
  }
  await visit(directory, '')
  return files
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
