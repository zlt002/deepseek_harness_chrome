import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeSkillsPatch, harnessArgs, resolveHarnessCwd, resolveHarnessCli } from '../native-server/src/harness-process.mjs'

test('uses an explicit DSH_CWD before the Harness root', () => {
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: '/opt/deepseek-harness', DSH_CWD: '/tmp/workspace' }),
    '/tmp/workspace',
  )
})

test('uses DSH_ROOT as the default Harness working directory', () => {
  assert.equal(
    resolveHarnessCwd({ DSH_ROOT: '/opt/deepseek-harness' }),
    '/opt/deepseek-harness',
  )
})

test('resolves the CLI from DSH_ROOT when no explicit CLI path is set', () => {
  assert.equal(
    resolveHarnessCli({ DSH_ROOT: '/opt/deepseek-harness' }),
    '/opt/deepseek-harness/apps/cli/lib/bin.js',
  )
})

test('passes the Native Host-owned MCP patch to the official Harness client', () => {
  assert.deepEqual(
    harnessArgs(0, '/private/tmp/connector.cordis.yml'),
    ['--patch', '/private/tmp/connector.cordis.yml', '--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
  )
})

test('adds Claude Code skills as a host-level catalog without replacing the preset roots', () => {
  assert.equal(
    claudeSkillsPatch({ HOME: '/Users/alice' }),
    `- insert:
    - id: deepseek-harness-chrome-claude-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        includeDefaultRoots: false
        customSkillDirs:
          - '/Users/alice/.claude/skills'
`,
  )
})
