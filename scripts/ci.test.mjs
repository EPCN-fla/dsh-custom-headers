import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { readCompatibility } from './ci-compatibility.mjs'

const script = name => fileURLToPath(new URL(name, import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'headers-ci-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const run = (root, name, args, env = {}) => spawnSync(process.execPath, [script(name), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env }, timeout: 10000,
})

test('compatibility matrix checks the exact declared development cohort without rewriting it', () => fixture(root => {
  const matrix = run(root, 'ci-compatibility.mjs', ['matrix'])
  assert.equal(matrix.status, 0, matrix.stderr)
  assert.deepEqual(Object.keys(manifest.dshCompatibility), ['0.2.2-rc.2'])
  assert.equal(manifest.engines.node, '>=24.9.0')
  assert.deepEqual(JSON.parse(matrix.stdout), { 'dsh-version': ['0.2.2-rc.2'] })
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  for (const version of Object.keys(manifest.dshCompatibility)) {
    const result = run(root, 'ci-compatibility.mjs', ['check', version])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `cohort=${version}`)
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before)
  }
  assert.notEqual(run(root, 'ci-compatibility.mjs', ['check', 'latest']).status, 0)
  const drifted = JSON.parse(before)
  drifted.devDependencies['@deepseek-ai/dsh-settings'] = '0.2.2-rc.1'
  writeFileSync(join(root, 'package.json'), JSON.stringify(drifted))
  const mismatch = run(root, 'ci-compatibility.mjs', ['check', '0.2.2-rc.2'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /@deepseek-ai\/dsh-settings/)
}))

test('compatibility reader rejects empty, ranged and malformed metadata', () => fixture(root => {
  for (const entries of [undefined, {}, [], { latest: { cordis: '4.0.5', schemastery: '3.18.5' } },
    { '0.2.0-rc.1': { cordis: '*', schemastery: '3.18.4' } },
    { '0.2.0-rc.1': { cordis: '4.0.4' } }]) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dshCompatibility: entries }))
    assert.throws(() => readCompatibility(join(root, 'package.json')))
  }
}))

test('verification records failures, continues independent checks and summarizes Node 24', { skip: process.platform === 'win32' }, () => fixture(root => {
  mkdirSync(join(root, 'bin'))
  const npm = join(root, 'bin/npm')
  writeFileSync(npm, `#!${process.execPath}\nprocess.exit(process.argv.includes(process.env.FAIL_STEP) ? 1 : 0)\n`)
  chmodSync(npm, 0o755)
  const major = process.versions.node.split('.')[0]
  const env = { PATH: `${root}/bin:${process.env.PATH}`, DSH_TEST_VERSION: Object.keys(manifest.dshCompatibility)[0], FAIL_STEP: 'typecheck' }
  const result = run(root, 'ci-verify.mjs', ['verify', major], env)
  assert.equal(result.status, 1, result.stderr)
  let report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.equal(report.steps.find(s => s.name === 'typecheck').status, 'failed')
  assert.equal(report.steps.find(s => s.name === 'package').status, 'passed')
  const summary = run(root, 'ci-verify.mjs', ['summary'], env)
  assert.equal(summary.status, 0, summary.stderr)
  assert.match(summary.stdout, /failed/)
  assert.match(summary.stdout, /Node 24/)
  assert.doesNotMatch(summary.stdout, /Node 22/)
  const installFailure = run(root, 'ci-verify.mjs', ['verify', major], { ...env, FAIL_STEP: 'ci' })
  assert.equal(installFailure.status, 1)
  report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.ok(report.steps.slice(1).every(s => s.status === 'skipped'))
}))

test('workflow uses only Node 24 and pins npm before dependency resolution', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.verify.steps
  const at = id => steps.findIndex(step => step.id === id)
  const index = at('npm24')
  assert.ok(index >= 0, 'npm24 must pin npm before dependency resolution')
  assert.equal(steps[index].run, 'npm install --global npm@11.19.0')
  assert.ok(at('setup24') < index && index < at('cohort') && at('cohort') < at('verify24'))
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with['node-version'], '24.9.0')
      assert.doesNotMatch(step.id ?? '', /22/)
    }
  }
})

test('workflow installs and checks only the committed target cohort', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const run = workflow.jobs.verify.steps.find(step => step.id === 'cohort').run
  assert.match(run, /npm ci --ignore-scripts --legacy-peer-deps=false/)
  assert.match(run, /node scripts\/ci-compatibility\.mjs check "\$DSH_TEST_VERSION"/)
  assert.doesNotMatch(run, /select|override|changed=true/)
})

test('workflow isolates PR validation from tag-only publishing with no artifact uploads', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.on, { pull_request: null, push: { tags: ['v*'] } })
  assert.equal(workflow.jobs.publish.needs, undefined)
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write')
  const steps = workflow.jobs.verify.steps
  assert.match(steps.find(s => s.id === 'verify24').if, /!cancelled\(\)/)
  assert.doesNotMatch(steps.find(s => s.id === 'verify24').if, /verify22/)
  assert.equal(steps.find(s => s.name === 'Test summary').if, 'always()')
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.every(s => !s.uses?.includes('artifact')))
  }
  const publishCommands = workflow.jobs.publish.steps.map(s => s.run ?? '').join('\n')
  assert.doesNotMatch(publishCommands, /npm (test|run (check|test|pack:check))/)
  assert.match(publishCommands, /npm publish --ignore-scripts/)
  assert.match(publishCommands, /npm ci --ignore-scripts --legacy-peer-deps=false/)
})
