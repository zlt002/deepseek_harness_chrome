/** Invalidates every in-flight tree request when its workspace session changes. */
export class WorkspaceTreeRequestGeneration {
  #value = 0

  get value(): number { return this.#value }

  reset(): number {
    this.#value += 1
    return this.#value
  }

  isCurrent(value: number): boolean { return value === this.#value }
}
