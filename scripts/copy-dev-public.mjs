#!/usr/bin/env node
import { cp } from 'node:fs/promises'

const [source, target] = process.argv.slice(2)
if (!source || !target) throw new Error('copy-dev-public requires source and target directories')

await cp(source, target, { recursive: true })
