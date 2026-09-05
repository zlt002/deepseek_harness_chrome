import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const OFFICE_SKILLS = new Set(['docx', 'pptx', 'xlsx'])
const SOURCE_ENTRY_MARKER = '# Source-tree compatibility entry; distributions receive the shared original.'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/**
 * Copy a skills directory into a deployment directory. Source checkouts keep
 * Office resources once in _shared; each deployed skill gets the original,
 * self-contained scripts/office tree. Already materialized inputs also work.
 * Callers own staging/replacing their destination directory.
 */
export async function materializeProductSkills(sourceRoot, destinationRoot) {
  const source = resolve(sourceRoot)
  const destination = resolve(destinationRoot)
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error('Product skills source and destination must not overlap')
  }
  const entries = await readdir(source, { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('_') && await exists(join(source, entry.name, 'SKILL.md'))) {
      names.push(entry.name)
    }
  }
  if (!names.length) throw new Error(`No product skills found in ${source}`)

  const sharedRoot = join(source, '_shared/office')
  const hasShared = await exists(sharedRoot)
  let sharedFiles = []
  if (hasShared) {
    sharedFiles = JSON.parse(await readFile(join(source, '_shared/office-files.json'), 'utf8'))
    if (!Array.isArray(sharedFiles) || !sharedFiles.length) throw new Error('Invalid shared Office file manifest')
    // Validate before writing: a missing schema must fail packaging, not silently
    // produce a package whose validation fails only on the user's machine.
    for (const file of sharedFiles) {
      if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
        throw new Error(`Invalid shared Office file: ${file}`)
      }
      if (!(await stat(join(sharedRoot, file))).isFile()) throw new Error(`Invalid shared Office file: ${file}`)
    }
  }
  for (const name of names.filter((name) => OFFICE_SKILLS.has(name))) {
    const validatePath = join(source, name, 'scripts/office/validate.py')
    const validate = await readFile(validatePath, 'utf8')
    if (!hasShared && validate.startsWith(SOURCE_ENTRY_MARKER)) {
      throw new Error(`Missing shared Office resources required by ${validatePath}`)
    }
  }

  const filter = (path) => basename(path) !== '__pycache__' && !path.endsWith('.pyc')
  await mkdir(destination, { recursive: true })
  for (const name of names) {
    await cp(join(source, name), join(destination, name), { recursive: true, filter })
    if (hasShared && OFFICE_SKILLS.has(name)) {
      for (const file of sharedFiles) {
        const target = join(destination, name, 'scripts/office', file)
        await mkdir(resolve(target, '..'), { recursive: true })
        await cp(join(sharedRoot, file), target)
      }
    }
  }
  return names.sort()
}
