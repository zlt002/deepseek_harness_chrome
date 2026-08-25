export type ExampleTab = 'overview' | 'components'

export function nextExampleTab(current: ExampleTab, key: string): ExampleTab | undefined {
  if (key === 'Home') return 'overview'
  if (key === 'End') return 'components'
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(key)) return current === 'overview' ? 'components' : 'overview'
  return undefined
}
