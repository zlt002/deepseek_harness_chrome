#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { materializeWindowsNativeAssets, parseWindowsNativeAssetsArgs } from './windows-native-assets.mjs'

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  materializeWindowsNativeAssets(parseWindowsNativeAssetsArgs(process.argv.slice(2))).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1) },
  )
}
