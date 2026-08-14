export const name = 'profile-tool-probe'
export const inject = ['tools']

export async function apply(ctx, config) {
  const deadline = Date.now() + 10_000
  while (!ctx.tools.schemas().some((schema) => schema.name === config.toolName)) {
    if (Date.now() >= deadline) throw new Error(`Profile did not register ${config.toolName}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'profile-mcp-tool-probe',
    name: config.toolName,
    arguments: {},
  })
  await fetch(config.resultUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  })
}
