export interface Scope { domainId: string; systemIds: string[]; repositoryIds: string[] }
export interface Catalog {
  domains: Array<{ id: string; name: string }>
  systems: Array<{ id: string; name: string; domainId?: string }>
  repositories: Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }>
}
export type ServiceState = 'checking' | 'ready' | 'unauthenticated' | 'unavailable'
export type ScopeOptions = { enabled?: boolean; remember?: boolean; action?: 'login' | 'retry' }
export interface ScopeSnapshot { sessionId: string; scope?: Scope; enabled?: boolean; remember?: boolean; requestSequence?: number; serviceState?: ServiceState; error?: string; notice?: string; catalog: Catalog }
