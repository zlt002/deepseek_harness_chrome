/**
 * Mac production-package proof of concept.
 *
 * This bundles the Harness CLI closure into one ESM file, omits source maps
 * and node_modules, and carries only the small native binaries required by the
 * current Mac architecture. Dynamic third-party plugins remain a separate
 * runtime concern.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleHarnessRuntimePlugin, bundleHarnessTrackingPlugin } from '../../scripts/bundle-harness-runtime-plugin.mjs'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..')
const GENERATED_HARNESS_ROOT = path.join(PROJECT_ROOT, '.generated', 'harness-product')
const EXPLICIT_HARNESS_ROOT = process.env.DSH_ROOT?.trim()
const HARNESS_ROOT = path.resolve(EXPLICIT_HARNESS_ROOT || GENERATED_HARNESS_ROOT)
const PACKAGE_NAME = 'accr-ui-mac-production-poc'
const EXTENSION_VERSION = '1.1.63'
const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtjVzlR9cE9zV44l999YtraoKbQ77NfaFgwJmpeABPL2HxUK82pD0DFRSv/7FfZ4nEZRDlgZz1zj1yIF4HLnftCZyf/xYIrwhXDojQfYULE8miIGufKEJf/IUBkpFdFKHgfKgowV0M72wNzqaYd27MdR6DczCR5PQKwi5G2JKUJxx4xc2+KD3GOUjpE8DrhzliD3gYcwEZ8lphtOuCUIx5kI97etKEiixqrwFGRoUbHFLXT14+Fqg7jmSu/HaUVWbl/Dx1VbI1hgVZdnJI//UJY+T0qMLV8hcfHPpwBum0lf1rfP+FQwnqoV2wf4k+6f70dE/Xrlckddpkl0IWDSEdwIDAQAB'
export const STATIC_REGISTRY_PACKAGE_OVERRIDES = [
  '@deepseek-ai/dsh-client-ui-skill-settings',
  '@deepseek-ai/dsh-client-ui-browser-target',
  '@deepseek-ai/dsh-client-ui-knowledge-scope',
]
export const PRODUCT_UI_PACKAGE_NAMES = [
  'harness-ui-agent-preset',
  'harness-ui-browser-target',
  'harness-ui-conversation-shell',
  'harness-ui-responsive-sidebar',
  'harness-ui-workspace-picker',
  'harness-ui-knowledge-scope',
  'harness-ui-subagent-compact',
  'harness-ui-session-log-copy',
  'harness-ui-settings-shell',
  'harness-skill-settings',
]
export const PRODUCT_UI_PLUGIN_PACKAGES = PRODUCT_UI_PACKAGE_NAMES.map(name => `@accrui/${name}`)
export const RUNTIME_SELECTED_PLUGIN_PACKAGES = [
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-mcp-client',
  ...PRODUCT_UI_PLUGIN_PACKAGES,
]

function assertHarnessProductAvailable() {
  if (!EXPLICIT_HARNESS_ROOT && !existsSync(path.join(GENERATED_HARNESS_ROOT, '.harness-product.json'))) {
    throw new Error(`Generated product Harness is missing: ${GENERATED_HARNESS_ROOT}. Run pnpm build:harness-product first, or set DSH_ROOT explicitly for a different Harness checkout.`)
  }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return result
}

function pluginNamesFromConfig(config) {
  return [...config.matchAll(/^\s*name:\s+['"]([^'"]+)['"]\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith('cordis:'))
}

function rewriteConfigPackageNames(config, aliases) {
  return config.replace(/^(\s*name:\s+)['"]([^'"]+)['"]\s*$/gm, (line, prefix, name) => {
    const alias = aliases.get(name)
    return alias === undefined ? line : `${prefix}'cordis:${alias}'`
  })
}

export function staticPluginRegistry(config, additionalConfigs = []) {
  const names = [...new Set([config, ...additionalConfigs].flatMap(pluginNamesFromConfig))]
  const aliases = new Map(names.map((name, index) => [name, `p${index}`]))
  const staticConfig = rewriteConfigPackageNames(config, aliases)
  return { aliases, staticConfig }
}

export async function shippedPresetConfigs(configDir) {
  const presetRoot = path.join(configDir, 'agent-presets')
  const configs = []
  for (const entry of await readdir(presetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const configPath = path.join(presetRoot, entry.name, 'agent.cordis.yml')
    if (!existsSync(configPath)) continue
    configs.push({ relativePath: path.relative(configDir, configPath), contents: await readFile(configPath, 'utf8') })
  }
  return configs
}

export async function staticTypertPackages(aliases) {
  const packages = []
  for (const name of aliases.keys()) {
    const manifestPath = path.join(staticPackageSource(name), 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const target = manifest.exports?.['./typert']
    const relativePath = typeof target === 'string' ? target : target?.default
    if (typeof relativePath === 'string') {
      packages.push({ name, artifactPath: path.join(path.dirname(manifestPath), relativePath) })
    }
  }
  return packages
}

export function staticWebRunner(aliases, typertPackages) {
  const imports = [...aliases].map(([name, alias]) => `import * as ${alias} from ${JSON.stringify(name)};`).join('\n')
  const runtimeImports = RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => `import * as d${index} from ${JSON.stringify(name)};`).join('\n')
  const typertImports = typertPackages.map((entry, index) => `import { TYPERT as t${index} } from ${JSON.stringify(`${entry.name}/typert`)};`).join('\n')
  const typertLoader = aliases.get('@deepseek-ai/dsh-typert-loader')
  const registry = [...aliases]
    .filter(([_name, alias]) => alias !== typertLoader)
    .map(([_name, alias]) => `${JSON.stringify(alias)}: ${alias}`).join(',\n  ')
  const staticPackageNames = JSON.stringify({
    ...Object.fromEntries([...aliases].map(([name, alias]) => [`cordis:${alias}`, name])),
    ...Object.fromEntries(RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => [`cordis:d${index}`, name])),
  })
  const packageAliases = JSON.stringify({
    ...Object.fromEntries(aliases),
    ...Object.fromEntries(RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => [name, `d${index}`])),
  })
  const runtimeRegistry = RUNTIME_SELECTED_PLUGIN_PACKAGES.map((_name, index) => `${JSON.stringify(`d${index}`)}: d${index}`).join(',\n  ')
  const directoryPickerAuto = aliases.get('@deepseek-ai/dsh-host-directory-picker-auto')
  const clientModules = aliases.get('@deepseek-ai/dsh-client-modules')
  if (directoryPickerAuto === undefined) throw new Error('Static Web profile is missing directory-picker-auto')
  if (clientModules === undefined) throw new Error('Static Web profile is missing client-modules')
  if (typertLoader === undefined) throw new Error('Static Web profile is missing typert-loader')
  return `import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { boot, loadLayeredEnv, loadOptionalPatches, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';
import { provideCmdline } from '@deepseek-ai/dsh-cmdline';
${imports}
${runtimeImports}
${typertImports}

const STATIC_TYPERT_MANIFESTS = Object.freeze([${typertPackages.map((_name, index) => `t${index}`).join(', ')}]);
const STATIC_TYPERT_LOADER = Object.freeze({
  ...${typertLoader},
  async apply(ctx, config) {
    await ${typertLoader}.apply(ctx, config);
    const disposers = STATIC_TYPERT_MANIFESTS.map((manifest) => ctx.typert.register(manifest));
    ctx.effect(function*() {
      yield () => Promise.all(disposers.map((dispose) => dispose())).then(() => undefined);
    }, 'static typert manifests');
  },
});

const STATIC_BUILTINS = Object.freeze({
  ${registry},
  ${runtimeRegistry},
  ${JSON.stringify(typertLoader)}: STATIC_TYPERT_LOADER
});
const STATIC_PACKAGE_NAMES = Object.freeze(${staticPackageNames});
const CLIENT_MODULE_REGISTRY = ${clientModules}.default;
const DIRECTORY_PICKER_AUTO = ${directoryPickerAuto};
const STATIC_PACKAGE_ALIASES = Object.freeze(${packageAliases});
function rewriteStaticPackageNames(value) {
  if (Array.isArray(value)) {
    for (const item of value) rewriteStaticPackageNames(item);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'name' && typeof item === 'string' && STATIC_PACKAGE_ALIASES[item]) {
      value[key] = 'cordis:' + STATIC_PACKAGE_ALIASES[item];
    } else if (key === 'name' && typeof item === 'string' && !item.startsWith('cordis:') && !item.startsWith('.') && !item.startsWith('file:')) {
      try {
        value[key] = pathToFileURL(PLUGIN_REQUIRE.resolve(item)).href;
      } catch {
        value[key] = item;
      }
    } else {
      rewriteStaticPackageNames(item);
    }
  }
  return value;
}
const CONFIG_PATH = resolve(dirname(process.argv[1]), '../config/static-web.cordis.yml');
const PACKAGED_PRESET_ROOT = resolve(dirname(CONFIG_PATH), 'agent-presets');
const DSH_HOME_PATH = process.env.DSH_HOME || resolve(homedir(), '.dsh');
const PROFILE_DIR = resolve(DSH_HOME_PATH, 'profiles/web');
const PLUGIN_BASE_URL = pathToFileURL(resolve(PROFILE_DIR, 'package.json')).href;
const PLUGIN_REQUIRE = createRequire(PLUGIN_BASE_URL);
function loadManagedProfilePatches() {
  const patches = [];
  const manifestPath = resolve(PROFILE_DIR, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    for (const bundle of bundles) {
      if (bundle === '@deepseek-ai/dsh-base' || bundle === '@deepseek-ai/dsh-web-app') continue;
      const bundleDir = resolveBundleDir('dsh', bundle, CONFIG_PATH, PROFILE_DIR);
      const bundleManifest = JSON.parse(readFileSync(resolve(bundleDir, 'package.json'), 'utf8'));
      const patchPath = bundleManifest.dsh?.bundle?.patch;
      if (typeof patchPath !== 'string') throw new Error('dsh: installed plugin bundle has no dsh.bundle.patch: ' + bundle);
      patches.push(...loadOverlayPatches('dsh', resolve(bundleDir, patchPath)));
    }
  }
  for (const file of [resolve(PROFILE_DIR, 'cordis.patch.yml'), resolve(DSH_HOME_PATH, 'cordis.patch.yml')]) {
    patches.push(...(loadOptionalPatches('dsh', file) ?? []));
  }
  return patches;
}
async function main() {
const argv = process.argv.slice(2);
const patchFiles = [];
const appArgs = [];
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--profile') {
    const profile = argv[index + 1];
    if (profile !== 'web') throw new Error('This production runtime only ships the web profile.');
    index += 1;
    continue;
  }
  if (argument === '--patch') {
    const patch = argv[index + 1];
    if (!patch) throw new Error('dsh: --patch needs a path');
    patchFiles.push(resolve(patch));
    index += 1;
    continue;
  }
  appArgs.push(argument);
}

if (appArgs.includes('--help') || appArgs.includes('-h')) {
  process.stdout.write('dsh web: static production profile\\n');
  process.exit(0);
}
const patches = [
  ...loadManagedProfilePatches(),
  ...patchFiles.flatMap((file) => loadOverlayPatches('dsh', file)),
  {
    id: 'agent-presets',
    config: {
      default: 'standard',
      roots: [{ path: PACKAGED_PRESET_ROOT, trust: 'system' }],
    },
  },
].map(rewriteStaticPackageNames);
await boot('dsh', CONFIG_PATH, patches, (ctx) => {
  Object.assign(ctx.loader.builtins, STATIC_BUILTINS);
  const clientPrototype = CLIENT_MODULE_REGISTRY.prototype;
  if (clientPrototype.__dshStaticPackagePatch !== true) {
    const processOne = clientPrototype.processOne;
    clientPrototype.processOne = function(entryName) {
      const packageName = STATIC_PACKAGE_NAMES[entryName];
      if (packageName === undefined) return processOne.call(this, entryName);
      const active = [...this.ctx.loader.entries()].some((entry) => entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled);
      if (!active) return this.table.delete(packageName);
      if (this.table.has(packageName)) return false;
      const meta = this.resolveMeta(packageName);
      if (meta === null) return false;
      const rev = this.initialBundleRevision(packageName, meta.clientPath);
      this.table.set(packageName, {
        entry: { id: packageName, url: '/plugins/' + packageName + '/client.js?rev=' + rev, rev, ...(meta.inject === undefined ? {} : { inject: meta.inject }), ...(meta.immediately ? { immediately: true } : {}) },
        clientPath: meta.clientPath,
      });
      return true;
    };
    clientPrototype.__dshStaticPackagePatch = true;
  }
  DIRECTORY_PICKER_AUTO.BACKEND_PACKAGES.native = 'cordis:d0';
  DIRECTORY_PICKER_AUTO.SURFACE_PACKAGES.native = 'cordis:d1';
  DIRECTORY_PICKER_AUTO.BACKEND_PACKAGES.browse = 'cordis:d2';
  DIRECTORY_PICKER_AUTO.SURFACE_PACKAGES.browse = 'cordis:d3';
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh'));
  provideCmdline(ctx, { args: appArgs, exit: (code) => process.exit(code) });
}, PLUGIN_BASE_URL);
}

main().catch((error) => {
  const render = (value) => {
    if (!(value instanceof Error)) return String(value);
    const nested = value instanceof AggregateError ? value.errors.map(render) : [];
    if (value.cause) nested.push(render(value.cause));
    return [value.stack ?? value.message, ...nested].join('\\nCaused by: ');
  };
  console.error(render(error));
  process.exit(1);
});
`
}

export function staticPackageSource(name, harnessRoot = HARNESS_ROOT) {
  if (name.startsWith('@accrui/')) return path.join(PROJECT_ROOT, 'packages', name.split('/').at(-1))
  return path.join(harnessRoot, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'))
}

export function staticBundleEntry(name, harnessRoot = HARNESS_ROOT) {
  const source = staticPackageSource(name, harnessRoot)
  // esbuild resolves directory aliases differently on Windows. Product
  // plugins are already built, so use their concrete server entry while
  // keeping staticPackageSource() as the package root for manifests/clients.
  if (name.startsWith('@accrui/')) return path.join(source, 'lib', 'index.js')
  return source
}

export function staticBundleAliases(names, harnessRoot = HARNESS_ROOT) {
  return Object.fromEntries([...new Set(names)].map(name => [name, staticBundleEntry(name, harnessRoot)]))
}

export async function copyWebClientPackages(aliases, configDir, { harnessRoot = HARNESS_ROOT } = {}) {
  for (const name of aliases.keys()) {
    const sourceDir = staticPackageSource(name, harnessRoot)
    const manifestPath = path.join(sourceDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.dsh?.client?.platform !== 'web') continue
    const clientExport = manifest.exports?.['./client']
    const clientRelative = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (typeof clientRelative !== 'string') throw new Error(`Web client package has no default client export: ${name}`)
    const targetDir = path.join(configDir, 'client-packages', ...name.split('/'))
    await mkdir(path.dirname(path.join(targetDir, clientRelative)), { recursive: true })
    await cp(path.join(sourceDir, clientRelative), path.join(targetDir, clientRelative))
    await writeFile(path.join(targetDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

export function nativeResolverBanner(target = 'darwin-arm64') {
  const windows = target === 'win32-x64'
  const nodePty = windows ? 'win32-x64' : 'darwin-arm64'
  const sharp = windows ? 'win32-x64' : 'darwin-arm64'
  const koffi = windows ? 'win32-x64' : 'darwin-arm64'
  const requireBuiltin = windows ? 'win32-x64-msvc' : 'darwin-arm64'
  const ripgrep = windows ? 'win32-x64' : 'darwin-arm64'
  const nodePtyRoot = windows ? `node-pty/prebuilds/${nodePty}/pty.node` : 'node-pty/pty.node'
  const sharpLibvipsMappings = windows ? '' : `
  ['@img/sharp-libvips-${sharp}/lib', __dshResolve(__dshNativeRoot, 'sharp-libvips/lib/index.js')],
  ['@img/sharp-libvips-${sharp}/package', __dshResolve(__dshNativeRoot, 'sharp-libvips/package.json')],
  ['@img/sharp-libvips-${sharp}/versions', __dshResolve(__dshNativeRoot, 'sharp-libvips/versions.json')],`
  return `import { existsSync as __dshExistsSync } from 'node:fs';
import { createRequire as __dshCreateRequire, Module as __dshModule } from 'node:module';
import { dirname as __dshDirname, resolve as __dshResolve } from 'node:path';
import { fileURLToPath as __dshFileURLToPath } from 'node:url';
const require = __dshCreateRequire(import.meta.url);
const __dshBundleDir = __dshDirname(__dshFileURLToPath(import.meta.url));
const __dshNativeRoot = __dshResolve(__dshBundleDir, '../../../../native');
const __dshClientPackageRoot = __dshResolve(__dshBundleDir, '../config/client-packages');
const __dshNativeModules = new Map([
  ['../prebuilds/${nodePty}/pty.node', __dshResolve(__dshNativeRoot, '${nodePtyRoot}')],
  ['@img/sharp-${sharp}/sharp.node', __dshResolve(__dshNativeRoot, 'sharp/sharp.node')],
  ${sharpLibvipsMappings}
  ['@koromix/koffi-${koffi}', __dshResolve(__dshNativeRoot, 'koffi/koffi.node')],
  ['node-addon-require-builtin-${requireBuiltin}', __dshResolve(__dshNativeRoot, 'node-addon-require-builtin/addon.node')],
  ['@vscode/ripgrep-${ripgrep}/bin/rg${windows ? '.exe' : ''}', __dshResolve(__dshNativeRoot, 'ripgrep/rg${windows ? '.exe' : ''}')],
  ['@deepseek-ai/dsh-web-frontend/dist/index.html', __dshResolve(__dshNativeRoot, '../harness/apps/web/dist/index.html')],
]);
const __dshOriginalResolveFilename = __dshModule._resolveFilename;
__dshModule._resolveFilename = function(request, parent, isMain, options) {
  const clientManifest = /^(@[^/]+\\/)?[^/]+\\/package\\.json$/.test(request)
    ? __dshResolve(__dshClientPackageRoot, request)
    : undefined;
  const windowsNodePtyAsset = ${windows ? "typeof request === 'string' ? request.match(/(?:^|[\\\\/])prebuilds[\\\\/]win32-x64[\\\\/]([^\\\\/]+)\\.node$/)?.[1] : undefined" : 'undefined'};
  const mapped = (__dshExistsSync(clientManifest ?? '') ? clientManifest : undefined)
    ?? __dshNativeModules.get(request)
    ?? (windowsNodePtyAsset ? __dshResolve(__dshNativeRoot, 'node-pty/prebuilds/win32-x64/' + windowsNodePtyAsset + '.node') : undefined)
    ?? (/prebuilds\\/${nodePty}\\/+pty\\.node$/.test(request) ? __dshResolve(__dshNativeRoot, '${nodePtyRoot}') : undefined);
  return mapped ?? __dshOriginalResolveFilename.call(this, request, parent, isMain, options);
};`
}

export function bundleWithHarnessEsbuild({ contents, sourcefile, resolveDir, outfile, aliases = {}, nativeTarget = 'darwin-arm64' }) {
  const program = `
import { build } from 'esbuild';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await build({
  stdin: { contents: Buffer.concat(chunks).toString('utf8'), sourcefile: process.env.DSH_ESBUILD_SOURCEFILE, resolveDir: process.env.DSH_ESBUILD_RESOLVE_DIR },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  alias: JSON.parse(process.env.DSH_ESBUILD_ALIASES),
  banner: { js: process.env.DSH_ESBUILD_BANNER },
  outfile: process.env.DSH_ESBUILD_OUTFILE,
});
`
  run(process.execPath, ['--input-type=module', '-e', program], {
    cwd: HARNESS_ROOT,
    input: contents,
    env: {
      ...process.env,
      DSH_ESBUILD_SOURCEFILE: sourcefile,
      DSH_ESBUILD_RESOLVE_DIR: resolveDir,
      DSH_ESBUILD_OUTFILE: outfile,
      DSH_ESBUILD_ALIASES: JSON.stringify(aliases),
      DSH_ESBUILD_BANNER: nativeResolverBanner(nativeTarget),
    },
  })
}

/**
 * The Win32 directory picker launches this as a child process rather than a
 * worker thread. Keep its Koffi loader inside the CJS artifact and resolve
 * the shipped native sidecar relative to apps/cli/lib at runtime.
 */
export function directoryPickerKoffiShimSource(nativeModulePath = '../../../../native/koffi/koffi.node') {
  return `const path = require('node:path');
const native = require(path.resolve(__dirname, ${JSON.stringify(nativeModulePath)}));
const introspect = native.introspect ?? native.type;
if (typeof introspect !== 'function') throw new Error('Bundled Koffi native module has no introspection API');
native.sizeof ??= (spec) => introspect(spec).size;
native.alignof ??= (spec) => introspect(spec).alignment;
native.offsetof ??= (spec, name) => {
  const info = introspect(spec);
  if (info.primitive !== 'Record') throw new TypeError('The offsetof() function can only be used with record types');
  const member = info.members?.[name];
  if (member == null) throw new Error('Koffi record member not found: ' + name);
  return member.offset;
};
module.exports = native;
`
}

export async function bundleDirectoryPickerWorker({
  harnessRoot = HARNESS_ROOT,
  outfile,
} = {}) {
  if (!outfile) throw new Error('bundleDirectoryPickerWorker requires outfile')
  const worker = path.join(harnessRoot, 'packages', 'host', 'directory-picker-native', 'lib', 'worker.cjs')
  if (!existsSync(worker)) throw new Error(`Built directory-picker worker is missing: ${worker}`)
  const shim = path.join(path.dirname(outfile), '.directory-picker-koffi-shim.cjs')
  await mkdir(path.dirname(outfile), { recursive: true })
  await writeFile(shim, directoryPickerKoffiShimSource())
  const program = `
import { build } from 'esbuild';
await build({
  entryPoints: [process.env.DSH_DIRECTORY_PICKER_WORKER],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'bundle',
  alias: { koffi: process.env.DSH_DIRECTORY_PICKER_KOFFI_SHIM },
  outfile: process.env.DSH_DIRECTORY_PICKER_OUTFILE,
});
`
  try {
    run(process.execPath, ['--input-type=module', '-e', program], {
      cwd: harnessRoot,
      env: {
        ...process.env,
        DSH_DIRECTORY_PICKER_WORKER: worker,
        DSH_DIRECTORY_PICKER_KOFFI_SHIM: shim,
        DSH_DIRECTORY_PICKER_OUTFILE: outfile,
      },
    })
  } finally {
    await rm(shim, { force: true })
  }
}

export async function patchBundledWorkerPaths(bundlePath, { includeDirectoryPicker = false } = {}) {
  let source = await readFile(bundlePath, 'utf8')
  const replacements = [
    {
      marker: '// packages/workflow/workflow-worker-thread/src/host.ts',
      from: 'new URL("./worker.cjs", import.meta.url)',
      to: 'new URL("./workflow-worker.cjs", import.meta.url)',
    },
    {
      marker: '// packages/code-runtime/code-runtime-worker-thread/src/index.ts',
      from: '? "./worker.ts" : "./worker.cjs"',
      to: '? "./worker.ts" : "./code-runtime-worker.cjs"',
    },
    ...(includeDirectoryPicker ? [{
      markers: [
        '// packages/host/directory-picker-native/lib/index.js',
        '// packages/host/directory-picker-native/src/win32-dialog-host.ts',
      ],
      from: 'new URL("./worker.cjs", import.meta.url)',
      to: 'new URL("./directory-picker-worker.cjs", import.meta.url)',
    }] : []),
  ]
  for (const replacement of replacements) {
    const markers = replacement.markers ?? [replacement.marker]
    const marker = markers.find(candidate => source.includes(candidate))
    if (marker === undefined) throw new Error(`Bundled worker marker is missing: ${markers.join(' or ')}`)
    const markerIndex = source.indexOf(marker)
    const workerIndex = source.indexOf(replacement.from, markerIndex)
    if (workerIndex < 0) throw new Error(`Bundled worker path is missing after ${marker}`)
    source = source.slice(0, workerIndex) + replacement.to + source.slice(workerIndex + replacement.from.length)
  }
  await writeFile(bundlePath, source)
}

async function pnpmPackagePath(packageName) {
  const virtualStore = path.join(HARNESS_ROOT, 'node_modules', '.pnpm')
  const prefix = `${packageName.replace('/', '+')}@`
  const candidates = (await readdir(virtualStore)).filter((entry) => entry.startsWith(prefix)).sort()
  for (const candidate of candidates) {
    const packagePath = path.join(virtualStore, candidate, 'node_modules', ...packageName.split('/'))
    if (existsSync(packagePath)) return packagePath
  }
  throw new Error(`Missing Mac native package: ${packageName}`)
}

async function onlyMatchingFile(directory, predicate, label) {
  const matches = (await readdir(directory)).filter(predicate)
  if (matches.length !== 1) throw new Error(`Expected one ${label} in ${directory}, found ${matches.length}`)
  return path.join(directory, matches[0])
}

async function copyMacNativeAssets(nativeDir) {
  const sharp = await pnpmPackagePath('@img/sharp-darwin-arm64')
  const libvips = await pnpmPackagePath('@img/sharp-libvips-darwin-arm64')
  const nodePty = await pnpmPackagePath('node-pty')
  const koffi = await pnpmPackagePath('@koromix/koffi-darwin-arm64')
  const requireBuiltin = await pnpmPackagePath('node-addon-require-builtin-darwin-arm64')
  const ripgrep = await pnpmPackagePath('@vscode/ripgrep-darwin-arm64')

  await mkdir(path.join(nativeDir, 'sharp'), { recursive: true })
  const sharpTarget = path.join(nativeDir, 'sharp', 'sharp.node')
  await cp(await onlyMatchingFile(path.join(sharp, 'lib'), (name) => name.endsWith('.node'), 'Sharp addon'), sharpTarget)
  await copyWithoutSourceMaps(libvips, path.join(nativeDir, 'sharp-libvips'))
  const libvipsDependency = execFileSync('otool', ['-L', sharpTarget], { encoding: 'utf8' })
    .match(/\s+(@rpath\/libvips-cpp\.[^\s]+\.dylib)/)?.[1]
  if (libvipsDependency === undefined) throw new Error('Sharp addon has no bundled libvips dependency')
  run('install_name_tool', [
    '-change',
    libvipsDependency,
    `@loader_path/../sharp-libvips/lib/${path.basename(libvipsDependency)}`,
    sharpTarget,
  ])
  run('codesign', ['--force', '--sign', '-', sharpTarget])
  await mkdir(path.join(nativeDir, 'node-pty'), { recursive: true })
  await cp(path.join(nodePty, 'prebuilds', 'darwin-arm64', 'pty.node'), path.join(nativeDir, 'node-pty', 'pty.node'))
  await cp(path.join(nodePty, 'prebuilds', 'darwin-arm64', 'spawn-helper'), path.join(nativeDir, 'node-pty', 'spawn-helper'))
  await mkdir(path.join(nativeDir, 'koffi'), { recursive: true })
  await cp(path.join(koffi, 'darwin_arm64', 'koffi.node'), path.join(nativeDir, 'koffi', 'koffi.node'))
  await mkdir(path.join(nativeDir, 'node-addon-require-builtin'), { recursive: true })
  await cp(path.join(requireBuiltin, 'prebuilt', 'darwin-arm64-napi-v9.node'), path.join(nativeDir, 'node-addon-require-builtin', 'addon.node'))
  await mkdir(path.join(nativeDir, 'ripgrep'), { recursive: true })
  await cp(path.join(ripgrep, 'bin', 'rg'), path.join(nativeDir, 'ripgrep', 'rg'))
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
}

export async function copyWithoutSourceMaps(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (candidate) => !candidate.endsWith('.map'),
  })
}

/** Keep the small product plugins beside the packaged Native Host. */
async function copyProductUiPackages(destination) {
  for (const name of PRODUCT_UI_PACKAGE_NAMES) {
    const source = path.join(PROJECT_ROOT, 'packages', name)
    if (!existsSync(path.join(source, 'package.json')) || !existsSync(path.join(source, 'lib', 'index.js')) || !existsSync(path.join(source, 'lib', 'client.js'))) {
      throw new Error(`Missing built product UI package: ${source}`)
    }
    await cp(source, path.join(destination, name), {
      recursive: true,
      dereference: true,
      filter: (candidate) => !candidate.endsWith('.map') && !candidate.includes(`${path.sep}src${path.sep}`) && !candidate.includes(`${path.sep}test${path.sep}`),
    })
  }
}

async function directorySize(root) {
  let bytes = 0
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) bytes += (await stat(child)).size
    }
  }
  await visit(root)
  return bytes
}

function macNativeHostLauncher() {
  return `#!/bin/sh
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE_PATH_FILE="$PACKAGE_DIR/node-path.txt"
if ! test -r "$NODE_PATH_FILE"; then
  printf '%s\n' 'Verified Node.js path is missing. Re-run install.command.' >&2
  exit 1
fi
IFS= read -r NODE_EXEC < "$NODE_PATH_FILE"
case "$NODE_EXEC" in
  /*) ;;
  *) printf '%s\n' 'Verified Node.js path is invalid. Re-run install.command.' >&2; exit 1 ;;
esac
if ! test -x "$NODE_EXEC"; then
  printf 'Verified Node.js executable is unavailable: %s\n' "$NODE_EXEC" >&2
  exit 1
fi
export DSH_ROOT="$PACKAGE_DIR/harness"
export DSH_CLI_PATH="$DSH_ROOT/apps/cli/lib/server.mjs"
export DSH_CWD="$PACKAGE_DIR/../workspace"
export DSH_PRODUCT_PLUGIN_ROOT="$PACKAGE_DIR/product-plugins"
export DSH_NODE_PTY_SPAWN_HELPER="$PACKAGE_DIR/native/node-pty/spawn-helper"
export DSH_NATIVE_LOG="$PACKAGE_DIR/../logs/native-host.log"
exec "$NODE_EXEC" "$PACKAGE_DIR/native-server/runtime.mjs"
`
}

function pluginManagerLauncher() {
  return `#!/bin/sh
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
IFS= read -r NODE_EXEC < "$PACKAGE_DIR/node-path.txt"
test -x "$NODE_EXEC"
exec "$NODE_EXEC" "$PACKAGE_DIR/harness/apps/cli/lib/plugin-manager.mjs" plugin --profile web "$@"
`
}

function interactivePluginInstaller() {
  return `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
printf '%s' '请输入要安装的 Harness 插件包名: '
IFS= read -r PLUGIN_NAME
test -n "$PLUGIN_NAME"
"$HOME/Library/Application Support/accr-ui-harness/runtime/dsh-plugin" add "$PLUGIN_NAME"
printf '%s\n' '插件已安装。请在 Harness UI 中点击重新连接。'
`
}

function registerNativeHost() {
  return `#!/bin/sh
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LAUNCHER="$PACKAGE_DIR/run-native-host.sh"
EXTENSION_ID="cmgjacoohdgjedoekbdbhbelpmboankg"
for TARGET in "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
  mkdir -p "$TARGET"
  for NAME in com.deepseek.harness.chrome com.chromemcp.nativehost; do
    printf '{\n  "name": "%s",\n  "description": "DeepSeek Harness Native Messaging host",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' "$NAME" "$LAUNCHER" "$EXTENSION_ID" > "$TARGET/$NAME.json"
  done
done
`
}

function installer() {
  return `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_ROOT="$HOME/Library/Application Support/accr-ui-harness"
PAYLOAD="$SCRIPT_DIR/payload.zip"
test -f "$PAYLOAD"
NODE_EXEC="$(command -v node || true)"
case "$NODE_EXEC" in
  /*) ;;
  *) printf '%s\n' '未找到可用的 Node.js，请先安装 Node.js 22 或更高版本。' >&2; exit 1 ;;
esac
"$NODE_EXEC" --version >/dev/null
mkdir -p "$INSTALL_ROOT"
# Keep workspace/logs/.webmcp user data. Only release-owned trees are replaced.
rm -rf "$INSTALL_ROOT/extension" "$INSTALL_ROOT/runtime"
ditto -x -k "$PAYLOAD" "$INSTALL_ROOT"
printf '%s\n' "$NODE_EXEC" > "$INSTALL_ROOT/runtime/node-path.txt"
"$INSTALL_ROOT/runtime/register-native-host.sh"
printf '%s\n' 'Harness UI 已安装。请在 chrome://extensions 或 edge://extensions 重新加载扩展。'
`
}

async function validatePackage({ packageDir, payloadDir, zipPath }) {
  const server = path.join(payloadDir, 'runtime', 'harness', 'apps', 'cli', 'lib', 'server.mjs')
  const nativeServer = path.join(payloadDir, 'runtime', 'native-server', 'runtime.mjs')
  const packageJson = path.join(payloadDir, 'runtime', 'harness', 'apps', 'cli', 'package.json')
  const nodeModules = path.join(payloadDir, 'runtime', 'harness', 'node_modules')
  if (!existsSync(server) || !existsSync(nativeServer) || !existsSync(packageJson)) throw new Error('Harness single-file runtime is incomplete')
  if (existsSync(nodeModules)) throw new Error('PoC unexpectedly contains runtime/harness/node_modules')
  const smoke = run(process.execPath, [server, '--help'], {
    env: {
      ...process.env,
      DSH_NODE_PTY_SPAWN_HELPER: path.join(payloadDir, 'runtime', 'native', 'node-pty', 'spawn-helper'),
    },
  })
  if (!smoke.stdout.includes('dsh web: static production profile')) throw new Error('Harness --help smoke did not print the static Web help text')
  const zipEntries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  if (!zipEntries.includes(`${path.basename(packageDir)}/payload.zip`)) throw new Error('Outer ZIP is missing payload.zip')
  return { helpSmoke: true }
}

/** Build the no-node_modules Mac package PoC from existing built artifacts. */
export async function buildMacProductionPackage({ releaseDir = path.join(PROJECT_ROOT, 'release') } = {}) {
  assertHarnessProductAvailable()
  const cliEntry = path.join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')
  const webDist = path.join(HARNESS_ROOT, 'apps', 'web', 'dist')
  const cliConfig = path.join(HARNESS_ROOT, 'apps', 'cli', 'config')
  const extensionDir = path.join(PROJECT_ROOT, 'apps', 'chrome-extension', '.output', 'chrome-mv3')
  const nativeServerEntry = path.join(PROJECT_ROOT, 'apps', 'native-server', 'bin.mjs')
  for (const required of [cliEntry, webDist, cliConfig, extensionDir, nativeServerEntry]) {
    if (!existsSync(required)) throw new Error(`Missing built package input: ${required}`)
  }

  const packageDir = path.join(releaseDir, PACKAGE_NAME)
  const tempDir = path.join(releaseDir, '.tmp', PACKAGE_NAME)
  const payloadDir = path.join(tempDir, 'payload')
  const runtimeDir = path.join(payloadDir, 'runtime')
  const harnessDir = path.join(runtimeDir, 'harness')
  const cliDir = path.join(harnessDir, 'apps', 'cli')
  const zipPath = path.join(releaseDir, `${PACKAGE_NAME}.zip`)
  await resetDirectory(tempDir)
  await resetDirectory(packageDir)
  await rm(zipPath, { force: true })

  // Materialize the ordinary Web profile once, then replace every runtime bare
  // package specifier with a Cordis builtin backed by a static ESM import.
  // This is the seam that removes the in-box node_modules dependency.
  const dumpHome = path.join(tempDir, 'dump-home')
  const dump = run(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'web', '--dump-default-config'], {
    cwd: HARNESS_ROOT,
    env: { ...process.env, DSH_HOME: dumpHome, DSH_TELEMETRY_DISABLED: '1' },
  }).stdout
  const presetConfigs = await shippedPresetConfigs(cliConfig)
  const { aliases, staticConfig } = staticPluginRegistry(dump, presetConfigs.map((preset) => preset.contents))
  if (aliases.size === 0) throw new Error('Static Web profile contains no plugin entries')
  const allStaticAliases = new Map([
    ...aliases,
    ...RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => [name, `d${index}`]),
  ])
  const typertPackages = await staticTypertPackages(allStaticAliases)
  const bundlePath = path.join(tempDir, 'server.mjs')
  bundleWithHarnessEsbuild({
    contents: staticWebRunner(aliases, typertPackages),
    sourcefile: 'static-web-runner.mjs',
    resolveDir: path.join(HARNESS_ROOT, 'apps', 'cli'),
    outfile: bundlePath,
    aliases: {
      ...staticBundleAliases([...STATIC_REGISTRY_PACKAGE_OVERRIDES, ...RUNTIME_SELECTED_PLUGIN_PACKAGES]),
      ...Object.fromEntries(typertPackages.map((entry) => [`${entry.name}/typert`, entry.artifactPath])),
    },
  })
  await patchBundledWorkerPaths(bundlePath)
  const nativeBundlePath = path.join(tempDir, 'native-server.mjs')
  const harnessRuntimePluginPath = path.join(tempDir, 'harness-runtime.mjs')
  const harnessTrackingPluginPath = path.join(tempDir, 'harness-tracking.mjs')
  const pluginManagerPath = path.join(tempDir, 'plugin-manager.mjs')
  const schemasteryPath = path.join(harnessDir, 'vendor', 'schemastery', 'lib', 'index.mjs')
  // The sibling Harness checkout owns the host-native esbuild binary. The
  // extension checkout may have been installed for a different CPU target.
  run('pnpm', ['exec', 'esbuild', nativeServerEntry, '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${nativeBundlePath}`], { cwd: PROJECT_ROOT })
  await bundleHarnessRuntimePlugin({ outfile: harnessRuntimePluginPath, projectRoot: PROJECT_ROOT })
  await bundleHarnessTrackingPlugin({ outfile: harnessTrackingPluginPath, projectRoot: PROJECT_ROOT })
  run('pnpm', ['exec', 'esbuild', cliEntry, '--bundle', '--platform=node', '--format=esm', '--target=node22', '--packages=bundle', `--outfile=${pluginManagerPath}`], { cwd: PROJECT_ROOT })
  await mkdir(path.join(cliDir, 'lib'), { recursive: true })
  // `harness-skill-settings` loads this through DSH_PRODUCT_SCHEMATERY_URL.
  // Keep a bundled copy in the same location as a normal Harness runtime.
  run('pnpm', ['exec', 'esbuild', path.join(HARNESS_ROOT, 'vendor', 'schemastery', 'lib', 'index.mjs'), '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${schemasteryPath}`], { cwd: PROJECT_ROOT })
  await cp(bundlePath, path.join(cliDir, 'lib', 'server.mjs'))
  await cp(
    path.join(HARNESS_ROOT, 'packages', 'code-runtime', 'code-runtime-worker-thread', 'lib', 'worker.cjs'),
    path.join(cliDir, 'lib', 'code-runtime-worker.cjs'),
  )
  await cp(
    path.join(HARNESS_ROOT, 'packages', 'workflow', 'workflow-worker-thread', 'lib', 'worker.cjs'),
    path.join(cliDir, 'lib', 'workflow-worker.cjs'),
  )
  await cp(pluginManagerPath, path.join(cliDir, 'lib', 'plugin-manager.mjs'))
  await copyWithoutSourceMaps(cliConfig, path.join(cliDir, 'config'))
  await writeFile(path.join(cliDir, 'config', 'static-web.cordis.yml'), staticConfig)
  for (const preset of presetConfigs) {
    await writeFile(
      path.join(cliDir, 'config', preset.relativePath),
      rewriteConfigPackageNames(preset.contents, aliases),
    )
  }
  await copyWebClientPackages(new Map([
    ...aliases,
    ...RUNTIME_SELECTED_PLUGIN_PACKAGES.map((name, index) => [name, `d${index}`]),
  ]), path.join(cliDir, 'config'))
  await writeFile(path.join(cliDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.5', type: 'module' }, null, 2)}\n`)
  await copyWithoutSourceMaps(webDist, path.join(harnessDir, 'apps', 'web', 'dist'))
  await copyWithoutSourceMaps(extensionDir, path.join(payloadDir, 'extension'))
  const manifestPath = path.join(payloadDir, 'extension', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, name: 'accr-ui Harness UI', version: EXTENSION_VERSION, key: EXTENSION_KEY }, null, 2)}\n`)
  await mkdir(path.join(runtimeDir, 'native-server'), { recursive: true })
  await cp(nativeBundlePath, path.join(runtimeDir, 'native-server', 'runtime.mjs'))
  await cp(harnessRuntimePluginPath, path.join(runtimeDir, 'native-server', 'harness-runtime.mjs'))
  await cp(harnessTrackingPluginPath, path.join(runtimeDir, 'native-server', 'harness-tracking.mjs'))
  await cp(
    path.join(PROJECT_ROOT, 'apps', 'native-server', 'src', 'selected-source-routing-prompt.mjs'),
    path.join(runtimeDir, 'native-server', 'selected-source-routing-prompt.mjs'),
  )
  await copyProductUiPackages(path.join(runtimeDir, 'product-plugins'))
  await copyMacNativeAssets(path.join(runtimeDir, 'native'))
  await mkdir(path.join(payloadDir, 'workspace'), { recursive: true })
  await mkdir(path.join(payloadDir, 'logs'), { recursive: true })
  await writeFile(path.join(runtimeDir, 'run-native-host.sh'), macNativeHostLauncher(), { mode: 0o755 })
  await writeFile(path.join(runtimeDir, 'dsh-plugin'), pluginManagerLauncher(), { mode: 0o755 })
  await writeFile(path.join(runtimeDir, 'register-native-host.sh'), registerNativeHost(), { mode: 0o755 })
  await writeFile(path.join(harnessDir, 'harness-runtime.json'), `${JSON.stringify({ format: 'deepseek-harness-mac-static-web-v1', entrypoint: 'apps/cli/lib/server.mjs', bundled: true, nodeModulesIncluded: false, staticWebPluginCount: aliases.size, dynamicPluginRepository: 'managed-web-profile' }, null, 2)}\n`)
  await writeFile(path.join(packageDir, 'README.zh-CN.md'), '# Harness UI Mac 生产候选包\n\n核心 Harness Web profile 已打包为 `server.mjs`，只携带 Mac ARM64 必需的原生文件，不含整套 `node_modules`。双击 `install.command` 安装主程序；双击 `install-plugin.command` 可以之后独立安装兼容的 Harness 插件，不需要重新发布主包。插件安装需要本机 `pnpm`。\n')
  await writeFile(path.join(packageDir, 'install.command'), installer(), { mode: 0o755 })
  await writeFile(path.join(packageDir, 'install-plugin.command'), interactivePluginInstaller(), { mode: 0o755 })
  run('zip', ['-qr', path.join(packageDir, 'payload.zip'), '.'], { cwd: payloadDir })
  run('zip', ['-qr', zipPath, path.basename(packageDir)], { cwd: releaseDir })
  const validation = await validatePackage({ packageDir, payloadDir, zipPath })
  const result = {
    packageDir,
    zipPath,
    zipBytes: (await stat(zipPath)).size,
    packageBytes: await directorySize(packageDir),
    payloadUnpackedBytes: await directorySize(payloadDir),
    ...validation,
  }
  await rm(tempDir, { recursive: true, force: true })
  return result
}

async function main() {
  assertHarnessProductAvailable()
  // The package exports resolve to generated lib/ files. Refresh them before
  // bundling so a source change cannot silently ship an older Harness runtime.
  run('pnpm', ['run', 'build:lib:host'], { cwd: HARNESS_ROOT })
  const result = await buildMacProductionPackage()
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
  })
}
