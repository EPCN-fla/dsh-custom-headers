/**
 * Client settings seams: describe joining, model-row pick writes (set /
 * delete / conflict retry / refusal pass-through), and profile-list saves
 * (blank-row stripping, conflict retry).
 */

import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS } from '../src/constants.js'
import {
  describeNamespaces,
  modelsOf,
  profilePickOf,
  providersOf,
  writeProfilePick,
  writeProfiles,
} from '../src/client/ops.js'
import type { RemoteApi, SettingsNamespaceView } from '../src/client/types.js'

/** A namespace view literal for the fake Remote. */
function nsView(ns: string, value: unknown, revision = 1): SettingsNamespaceView {
  return { ns, value, revision } as unknown as SettingsNamespaceView
}

/** A fake settings Remote over an in-memory document with revisions. */
function fakeApi(doc: Record<string, { value: unknown }>, revisions: Record<string, number> = {}) {
  const state = new Map<string, { value: unknown; revision: number }>(
    Object.entries(doc).map(([ns, entry]) => [ns, { value: entry.value, revision: revisions[ns] ?? 1 }]),
  )
  const mutate = vi.fn(async (ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expectedRevision?: number) => {
    const entry = state.get(ns)
    if (entry === undefined) return { ok: false as const, error: { code: 'settings/not-found', message: 'unknown namespace' } }
    if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
      return { ok: false as const, error: { code: 'settings/conflict', message: 'settings conflict' } }
    }
    for (const op of ops) {
      if (op.op === 'set') {
        // Path-aware set: walk to the parent, then assign the last segment.
        let target = entry.value as Record<string, unknown>
        for (const segment of op.path.slice(0, -1)) target = target[segment] as Record<string, unknown>
        const last = op.path[op.path.length - 1] as string
        target[last] = op.value
      }
    }
    entry.revision += 1
    return { ok: true as const, value: nsView(ns, entry.value, entry.revision) }
  })
  const api: RemoteApi = {
    settings: {
      describe: vi.fn(async () => ({
        ok: true as const,
        value: {
          namespaces: [...state.entries()].map(([ns, entry]) => nsView(ns, entry.value, entry.revision)),
          writable: true,
        } as never,
      })),
      mutate: mutate as never,
    },
  }
  return { api, mutate, state }
}

const PI_DOC = {
  providers: {
    acme: {
      displayName: 'Acme',
      models: [
        { id: 'm1', [HEADERS_PROFILE_FIELD]: 'gw' },
        { id: 'm2' },
      ],
    },
  },
}

describe('describeNamespaces', () => {
  it('joins both namespaces plus writability', async () => {
    const { api } = fakeApi({ [PI_AI_NS]: { value: PI_DOC }, [CUSTOM_HEADERS_NS]: { value: { profiles: [] } } })
    const join = await describeNamespaces(api)
    expect(join.writable).toBe(true)
    expect(join.piAi).toBeDefined()
    expect(join.customHeaders).toBeDefined()
  })

  it('answers undefined namespaces on a refused describe', async () => {
    const api: RemoteApi = {
      settings: {
        describe: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'down' } }),
        mutate: async () => { throw new Error('unreachable') },
      },
    }
    const join = await describeNamespaces(api)
    expect(join.piAi).toBeUndefined()
    expect(join.customHeaders).toBeUndefined()
    expect(join.writable).toBe(false)
  })
})

describe('providersOf / modelsOf / profilePickOf', () => {
  it('reads providers, models, and picks from a namespace view', () => {
    const providers = providersOf(nsView(PI_AI_NS, PI_DOC))
    expect(Object.keys(providers)).toEqual(['acme'])
    const models = modelsOf(providers, 'acme')
    expect(models).toHaveLength(2)
    expect(profilePickOf(models, 'm1')).toBe('gw')
    expect(profilePickOf(models, 'm2')).toBeUndefined()
    expect(profilePickOf(models, 'nope')).toBeUndefined()
  })

  it('degrades foreign shapes to empty answers', () => {
    expect(providersOf(undefined)).toEqual({})
    expect(providersOf(nsView(PI_AI_NS, { providers: 'nope' }))).toEqual({})
    expect(modelsOf({}, 'acme')).toEqual([])
  })
})

describe('writeProfilePick', () => {
  it('sets the pick field onto the exact model row', async () => {
    const { api, state } = fakeApi({ [PI_AI_NS]: { value: structuredClone(PI_DOC) } })
    const reply = await writeProfilePick(api, 'acme', 'm2', 'relay')
    expect(reply).toEqual({ ok: true })
    const providers = providersOf(nsView(PI_AI_NS, state.get(PI_AI_NS)?.value))
    expect(profilePickOf(modelsOf(providers, 'acme'), 'm2')).toBe('relay')
    // The other row is untouched.
    expect(profilePickOf(modelsOf(providers, 'acme'), 'm1')).toBe('gw')
  })

  it('deletes the pick field for Default', async () => {
    const { api, state } = fakeApi({ [PI_AI_NS]: { value: structuredClone(PI_DOC) } })
    const reply = await writeProfilePick(api, 'acme', 'm1', null)
    expect(reply).toEqual({ ok: true })
    const providers = providersOf(nsView(PI_AI_NS, state.get(PI_AI_NS)?.value))
    expect(profilePickOf(modelsOf(providers, 'acme'), 'm1')).toBeUndefined()
  })

  it('answers model-not-found for an unknown row and never writes', async () => {
    const { api, mutate } = fakeApi({ [PI_AI_NS]: { value: structuredClone(PI_DOC) } })
    const reply = await writeProfilePick(api, 'acme', 'nope', 'gw')
    expect(reply).toEqual({ ok: false, error: 'model-not-found' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('retries once on a revision conflict with a fresh describe', async () => {
    const { api, state } = fakeApi({ [PI_AI_NS]: { value: structuredClone(PI_DOC) } })
    let calls = 0
    const original = api.settings.mutate
    api.settings.mutate = (async (ns: string, ops: never[], rev?: number) => {
      calls += 1
      // First attempt arrives with the stale revision and is refused; a
      // concurrent writer then moves the document before the retry.
      if (calls === 1) {
        state.get(PI_AI_NS)!.revision += 1
        return { ok: false, error: { code: 'settings/conflict', message: 'conflict' } }
      }
      return (original as (n: string, o: never[], r?: number) => unknown)(ns, ops, rev)
    }) as never
    const reply = await writeProfilePick(api, 'acme', 'm2', 'relay')
    expect(reply).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('surfaces a rejection verbatim after the retry budget', async () => {
    const api: RemoteApi = {
      settings: {
        describe: async () => ({
          ok: true as const,
          value: { namespaces: [nsView(PI_AI_NS, structuredClone(PI_DOC), 1)], writable: true } as never,
        }),
        mutate: async () => ({ ok: false as const, error: { code: 'settings/rejected', message: 'nope' } }),
      },
    }
    const reply = await writeProfilePick(api, 'acme', 'm1', 'gw')
    expect(reply).toEqual({ ok: false, error: 'nope' })
  })
})

describe('writeProfiles', () => {
  it('strips fully-blank rows and trims ids before writing', async () => {
    const { api, state, mutate } = fakeApi({ [CUSTOM_HEADERS_NS]: { value: { profiles: [] } } })
    const reply = await writeProfiles(api, [
      { id: '  gw  ', headers: [{ name: 'X-A', value: '1' }, { name: '', value: '' }] },
    ])
    expect(reply).toEqual({ ok: true })
    const written = (state.get(CUSTOM_HEADERS_NS)?.value as { profiles: unknown[] }).profiles
    expect(written).toEqual([{ id: 'gw', headers: [{ name: 'X-A', value: '1' }] }])
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('keeps rows with a name and an empty value', async () => {
    const { api, state } = fakeApi({ [CUSTOM_HEADERS_NS]: { value: { profiles: [] } } })
    await writeProfiles(api, [{ id: 'p', headers: [{ name: 'X-Empty', value: '' }] }])
    const written = (state.get(CUSTOM_HEADERS_NS)?.value as { profiles: unknown[] }).profiles
    expect(written).toEqual([{ id: 'p', headers: [{ name: 'X-Empty', value: '' }] }])
  })

  it('answers no-namespace when the host never registered custom-headers', async () => {
    const { api } = fakeApi({})
    const reply = await writeProfiles(api, [])
    expect(reply).toEqual({ ok: false, error: 'no-namespace' })
  })

  it('surfaces the host validator refusal verbatim', async () => {
    const { api } = fakeApi({ [CUSTOM_HEADERS_NS]: { value: { profiles: [] } } })
    api.settings.mutate = (async () => ({
      ok: false,
      error: { code: 'settings/rejected', message: 'custom-headers: profile #2 duplicates id "GW"' },
    })) as never
    const reply = await writeProfiles(api, [{ id: 'gw', headers: [] }, { id: 'GW', headers: [] }])
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error).toContain('duplicates id')
  })
})
