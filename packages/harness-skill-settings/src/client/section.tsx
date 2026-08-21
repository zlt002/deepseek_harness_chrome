import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillSettingsInjected } from './index.ts'
import { enableInstalledSkill } from './enable-installed-skill.mjs'
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILE_BYTES, MAX_FOLDER_FILES, readSelectedFolderFiles } from './folder-upload.mjs'
import css from './section.module.css'

type Mode = 'enabled' | 'manual-only' | 'disabled'
type View = { writable: boolean, revision: number, modes: Record<string, Mode>, skills: readonly SkillEntry[] }
type InstallNotice = { kind: 'success' | 'warning' | 'error', text: string }
type UploadFile = { path: string, data: string }
type FileSystemDropItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
const NS = 'skill-settings'
const INSTALL_PATH = '/api/settings.skill.install'
const MODE_OPTIONS = [
  { value: 'enabled', label: 'enabled' },
  { value: 'manual-only', label: 'manual' },
  { value: 'disabled', label: 'disabled' },
] as const
function modesOf(value: unknown): Record<string, Mode> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const modes = (value as { modes?: unknown }).modes
  if (modes === null || typeof modes !== 'object' || Array.isArray(modes)) return {}
  return Object.fromEntries(Object.entries(modes).filter((entry): entry is [string, Mode] => entry[1] === 'enabled' || entry[1] === 'manual-only' || entry[1] === 'disabled'))
}

export function SkillSettingsSection({ api, t, useSessions }: SkillSettingsInjected): ReactNode {
  const sessionId = useSessions(state => state.current)
  const [view, setView] = useState<View>()
  const [failure, setFailure] = useState(false)
  const [request, setRequest] = useState(0)
  const [pending, setPending] = useState<string>()
  const [installing, setInstalling] = useState(false)
  const [installNotice, setInstallNotice] = useState<InstallNotice>()
  const [dragOver, setDragOver] = useState(false)
  const zipInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    if (sessionId === undefined) { setView(undefined); setFailure(false); return () => { active = false } }
    setFailure(false)
    void Promise.all([api.skills.list({ sessionId, includeUnavailable: true }), api.settings.describe({})]).then(([skills, settings]) => {
      if (!active) return
      const section = settings.result.ok ? settings.result.value.namespaces.find(item => item.ns === NS) : undefined
      if (!skills.result.ok || section === undefined) { setFailure(true); return }
      setView({ writable: settings.result.value.writable, revision: section.revision, modes: modesOf(section.value), skills: skills.result.value.skills })
    }, () => { if (active) setFailure(true) })
    return () => { active = false }
  }, [api, request, sessionId])
  if (sessionId === undefined) return <p className={css.status}>{t('noSession')}</p>
  if (failure) return <div className={css.status}><p role="alert">{view === undefined ? t('loadFailed') : t('saveFailed')}</p><button type="button" onClick={() => setRequest(value => value + 1)}>{t('retry')}</button></div>
  if (view === undefined) return <p className={css.status}>{t('loading')}</p>
  const change = (skill: SkillEntry, mode: Mode): void => {
    if (!view.writable || pending !== undefined) return
    setPending(skill.name)
    void api.settings.update({ ns: NS, patch: { modes: { [skill.name]: mode } }, expectedRevision: view.revision }).then(result => {
      if (!result.result.ok) setFailure(true)
      else setRequest(value => value + 1)
    }, () => setFailure(true)).finally(() => setPending(undefined))
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
      <div className={css.installActions}><button className={css.installButton} type="button" disabled={installing || !view.writable} onClick={() => zipInput.current?.click()}>{t('chooseZip')}</button><button className={css.installButton} type="button" disabled={installing || !view.writable} onClick={selectFolder}>{t('chooseFolder')}</button></div>
      <input ref={zipInput} className={css.hiddenInput} type="file" accept=".zip,application/zip" tabIndex={-1} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) installZip(file) }} />
      <input ref={element => { folderInput.current = element; element?.setAttribute('webkitdirectory', '') }} className={css.hiddenInput} type="file" multiple tabIndex={-1} onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; if (files.length > 0) installFolderFiles(files) }} />
      {installing ? <p className={css.status}>{t('installing')}</p> : null}
      {installNotice === undefined ? null : <p className={installNotice.kind === 'error' ? css.error : installNotice.kind === 'warning' ? css.warning : css.success} role={installNotice.kind === 'error' ? 'alert' : 'status'}>{installNotice.text}</p>}
    </div>
    {view.skills.length === 0 ? <p className={css.status}>{t('empty')}</p> : <ul className={css.rows}>{view.skills.map(skill => {
    const mode = view.modes[skill.name] ?? 'enabled'
    const disabled = !view.writable || pending !== undefined
    return <li key={skill.name} className={css.row}><div><strong>{skill.name}</strong><p>{skill.description}</p>{skill.authoredModelInvocable === false ? <span>{t('authorModel')}</span> : null}{skill.authoredUserInvocable === false ? <span>{t('authorUser')}</span> : null}</div>
      <div className={css.modeControl} role="radiogroup" aria-label={skill.name}>{MODE_OPTIONS.map(option => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={mode === option.value}
        tabIndex={mode === option.value ? 0 : -1}
        className={css.modeButton}
        disabled={disabled}
        onClick={() => change(skill, option.value)}
        onKeyDown={(event) => {
          const index = MODE_OPTIONS.findIndex(candidate => candidate.value === option.value)
          let next = index
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODE_OPTIONS.length
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + MODE_OPTIONS.length - 1) % MODE_OPTIONS.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = MODE_OPTIONS.length - 1
          else return
          event.preventDefault()
          const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
          buttons?.[next]?.focus()
          change(skill, MODE_OPTIONS[next].value)
        }}
      >{t(option.label)}</button>)}</div>
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
