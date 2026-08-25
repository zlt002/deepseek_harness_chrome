import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('product prototype skill never asks the model to rewrite the locked design specification', async () => {
  const [skill, designSystem, revision] = await Promise.all([
    readFile(new URL('../skills/product-prototype/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/product-prototype/references/design-system-schema.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/product-prototype/references/revision-verification.md', import.meta.url), 'utf8'),
  ])
  assert.match(skill, /省略 `design_spec`/)
  assert.match(skill, /页面 `title`、模块可见标题\/标签应直接保留清单中的名称/)
  assert.match(skill, /每条流程都要有自己可识别、可点击或可填写的交互入口/)
  assert.match(skill, /不能用一个按钮中的动作序列给多条流程充数/)
  assert.match(designSystem, /不得自行修改、补写或重新提交 `design_spec`/)
  assert.match(revision, /省略 `design_spec`/)
  assert.doesNotMatch(revision, /传入完整 `design_spec`/)
})
