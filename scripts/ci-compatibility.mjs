/** Dependency-free CI metadata reader; package.json is the compatibility source. */
import { readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const number = '(?:0|[1-9][0-9]*)'
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const exactVersion = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)
const exactDependency = /^\d+\.\d+\.\d+$/

/** Read validated exact host versions before dependencies have been installed. */
export function readCompatibility(path = 'package.json') {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const entries = manifest.dshCompatibility
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
    throw new Error('package.json dshCompatibility must be a non-empty version map')
  }
  for (const [version, config] of Object.entries(entries)) {
    if (!exactVersion.test(version)) throw new Error('dshCompatibility keys must be exact DSH versions, not ranges or tags')
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || !exactDependency.test(config.cordis) || !exactDependency.test(config.schemastery)
      || Object.keys(config).some(key => !['cordis', 'schemastery'].includes(key))) {
      throw new Error(`dshCompatibility ${version} requires exact cordis and schemastery versions`)
    }
  }
  return { manifest, entries }
}

function main() {
  const [mode, version] = process.argv.slice(2)
  const { manifest, entries } = readCompatibility()
  if (mode === 'matrix') {
    const matrix = JSON.stringify({ 'dsh-version': Object.keys(entries) })
    console.log(matrix)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`)
  } else if (mode === 'check') {
    if (!Object.hasOwn(entries, version ?? '')) throw new Error('Checked DSH version is not declared in dshCompatibility')
    const dependencies = manifest.devDependencies
    const packages = Object.keys(dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    if (packages.length === 0 || !dependencies['@deepseek-ai/cordis'] || !dependencies['@deepseek-ai/schemastery']) {
      throw new Error('Missing DSH/Cordis/Schemastery development dependencies')
    }
    const mismatches = packages.filter(name => dependencies[name] !== version)
    for (const [name, selected] of Object.entries(entries[version])) {
      const key = `@deepseek-ai/${name}`
      if (dependencies[key] !== selected) mismatches.push(key)
    }
    if (mismatches.length > 0) {
      throw new Error(`Development cohort does not match DSH ${version}: ${mismatches.join(', ')}`)
    }
    console.log(`cohort=${version}`)
  } else {
    throw new Error('Usage: node scripts/ci-compatibility.mjs matrix | check <version>')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
