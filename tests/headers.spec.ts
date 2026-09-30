/**
 * Pure header-profile logic: validation (case-insensitive id uniqueness,
 * Fetch-valid header names), normalization of hostile documents, call-time
 * resolution, and the model-row pick reader.
 */

import { describe, expect, it } from 'vitest'
import {
  assertValidProfiles,
  modelProfileIdOf,
  normalizeProfiles,
  profilesFromUnknown,
  resolveProfileHeaders,
  validateProfiles,
  type HeaderProfile,
} from '../src/headers.js'

const profiles: HeaderProfile[] = [
  { id: 'gateway', headers: [{ name: 'X-Tenant', value: 'acme' }, { name: 'X-Trace', value: '1' }] },
  { id: 'Relay', headers: [{ name: 'X-Relay-Key', value: 'k' }] },
]

describe('validateProfiles', () => {
  it('accepts a valid list', () => {
    expect(validateProfiles(profiles)).toEqual([])
  })

  it('rejects an empty id', () => {
    const issues = validateProfiles([{ id: '  ', headers: [] }])
    expect(issues).toEqual([{ profile: 0, code: 'id-empty', value: '  ' }])
  })

  it('rejects duplicate ids case-insensitively', () => {
    const issues = validateProfiles([
      { id: 'Gateway', headers: [] },
      { id: 'gateway', headers: [] },
      { id: 'GATEWAY', headers: [] },
    ])
    expect(issues.map(issue => issue.code)).toEqual(['id-duplicate', 'id-duplicate'])
    expect(issues[0]?.profile).toBe(1)
    expect(issues[1]?.profile).toBe(2)
  })

  it('treats ids with different spelling as distinct', () => {
    expect(validateProfiles([{ id: 'a', headers: [] }, { id: 'ab', headers: [] }])).toEqual([])
  })

  it('flags a value without a header name but ignores a fully blank row', () => {
    const issues = validateProfiles([{
      id: 'p',
      headers: [{ name: '', value: '' }, { name: '  ', value: 'v' }],
    }])
    expect(issues).toEqual([{ profile: 0, row: 1, code: 'name-empty', value: 'v' }])
  })

  it('flags header names Fetch cannot represent', () => {
    const issues = validateProfiles([{ id: 'p', headers: [{ name: 'bad header', value: 'v' }] }])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('name-invalid')
    expect(issues[0]?.row).toBe(0)
  })

  it('flags header values Fetch cannot represent', () => {
    // A newline in the value is a header-injection attempt Fetch refuses.
    const issues = validateProfiles([{ id: 'p', headers: [{ name: 'X-Test', value: 'a\nb' }] }])
    expect(issues).toHaveLength(1)
    expect(['name-invalid', 'value-invalid']).toContain(issues[0]?.code)
  })
})

describe('assertValidProfiles', () => {
  it('throws a message naming the profile and row', () => {
    expect(() => {
      assertValidProfiles([
        { id: 'a', headers: [] },
        { id: 'A', headers: [] },
      ])
    }).toThrow(/profile #2.*duplicates id "A".*case-insensitively/)
  })

  it('does not throw for a valid list', () => {
    expect(() => { assertValidProfiles(profiles) }).not.toThrow()
  })
})

describe('normalizeProfiles', () => {
  it('drops foreign shapes and trims ids', () => {
    const out = normalizeProfiles({
      profiles: [
        { id: '  gw  ', headers: [{ name: ' X-A ', value: '1' }] },
        { id: 42, headers: [] },
        'garbage',
        { id: '', headers: [] },
        { id: 'ok' },
      ],
    })
    expect(out).toEqual([
      { id: 'gw', headers: [{ name: 'X-A', value: '1' }] },
      { id: 'ok', headers: [] },
    ])
  })

  it('drops rows with blank names and repairs missing/non-string values to empty', () => {
    const out = normalizeProfiles({
      profiles: [{ id: 'p', headers: [{ name: '', value: 'v' }, { name: 'X-A' }, { name: 'X-B', value: 3 }] }],
    })
    expect(out).toEqual([{ id: 'p', headers: [{ name: 'X-A', value: '' }, { name: 'X-B', value: '' }] }])
  })

  it('answers an empty list for a missing section', () => {
    expect(normalizeProfiles(undefined)).toEqual([])
    expect(normalizeProfiles({ profiles: 'nope' })).toEqual([])
  })
})

describe('resolveProfileHeaders', () => {
  it('resolves a profile by id case-insensitively', () => {
    expect(resolveProfileHeaders(profiles, 'GATEWAY')).toEqual({ 'x-tenant': 'acme', 'x-trace': '1' })
    expect(resolveProfileHeaders(profiles, 'relay')).toEqual({ 'x-relay-key': 'k' })
  })

  it('answers undefined for an unknown or empty id', () => {
    expect(resolveProfileHeaders(profiles, 'nope')).toBeUndefined()
    expect(resolveProfileHeaders(profiles, '  ')).toBeUndefined()
  })

  it('answers undefined when nothing valid remains', () => {
    expect(resolveProfileHeaders([{ id: 'p', headers: [] }], 'p')).toBeUndefined()
    expect(resolveProfileHeaders([{ id: 'p', headers: [{ name: 'bad name', value: 'v' }] }], 'p')).toBeUndefined()
  })

  it('drops reserved names case-insensitively', () => {
    const out = resolveProfileHeaders(
      [{ id: 'p', headers: [{ name: 'User-Agent', value: 'evil' }, { name: 'X-Ok', value: '1' }] }],
      'p',
      new Set(['user-agent']),
    )
    expect(out).toEqual({ 'x-ok': '1' })
  })

  it('resolves repeated names last-wins case-insensitively', () => {
    const out = resolveProfileHeaders(
      [{ id: 'p', headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] }],
      'p',
    )
    expect(out).toEqual({ 'x-a': '2' })
  })
})

describe('modelProfileIdOf', () => {
  const providers = {
    acme: { models: [{ id: 'm1', headersProfile: 'gw' }, { id: 'm2' }] },
    bare: {},
  }

  it('reads the pick of one exact route/model pair', () => {
    expect(modelProfileIdOf(providers, 'acme', 'm1', 'headersProfile')).toBe('gw')
  })

  it('answers undefined for missing routes, models, and fields', () => {
    expect(modelProfileIdOf(providers, 'acme', 'm2', 'headersProfile')).toBeUndefined()
    expect(modelProfileIdOf(providers, 'acme', 'nope', 'headersProfile')).toBeUndefined()
    expect(modelProfileIdOf(providers, 'nope', 'm1', 'headersProfile')).toBeUndefined()
    expect(modelProfileIdOf(providers, 'bare', 'm1', 'headersProfile')).toBeUndefined()
    expect(modelProfileIdOf(undefined, 'acme', 'm1', 'headersProfile')).toBeUndefined()
  })

  it('degrades a non-string pick to undefined', () => {
    const hostile = { acme: { models: [{ id: 'm1', headersProfile: 42 }] } }
    expect(modelProfileIdOf(hostile, 'acme', 'm1', 'headersProfile')).toBeUndefined()
  })
})

describe('profilesFromUnknown', () => {
  it('keeps flaggable rows intact (unlike normalizeProfiles)', () => {
    // Empty ids and blank names survive coercion so validateProfiles can flag
    // them; normalization would drop both silently.
    const coerced = profilesFromUnknown([
      { id: '', headers: [{ name: '', value: 'v' }] },
      { id: 'p', headers: [] },
    ])
    expect(validateProfiles(coerced).map(issue => issue.code)).toEqual(['id-empty', 'name-empty'])
  })

  it('coerces non-string fields to empty strings and skips non-record rows', () => {
    expect(profilesFromUnknown([
      'garbage',
      { id: 42, headers: [{ name: null, value: 7 }, 'junk'] },
    ])).toEqual([{ id: '', headers: [{ name: '', value: '' }] }])
  })

  it('answers an empty list for a missing or non-array value', () => {
    expect(profilesFromUnknown(undefined)).toEqual([])
    expect(profilesFromUnknown({ profiles: 'nope' })).toEqual([])
  })
})
