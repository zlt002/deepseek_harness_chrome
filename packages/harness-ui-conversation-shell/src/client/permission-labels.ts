const chinesePermissionLabels: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
}

/** Keep unrecognised host-provided permission values on the official fallback. */
export function permissionLabel(value: string): string | undefined {
  return chinesePermissionLabels[value]
}
