/**
 * Host-half behavior over a fake Cordis context: namespace registration with
 * write-time validation, adapter registration wrapping, per-call header
 * stamping, restoration of untouched descriptors, and fiber teardown.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, stampModelHeaders } from '../src/index.js'
import { CUSTOM_HEADERS_NS, PI_AI_NS } from '../src/constants.js'
import type { HeaderProfile } from '../src/headers.js'

interface FakeSettings {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: {
      setSource(current: () => unknown): void
      onChange(): void
      validate?(value: unknown): void
    },
  ): void
  get(ns: string): unknown
}

interface Harness {
  ctx: Context
  settings: FakeSettings
  llm: { registerAdapter(providers: string[], adapter: unknown): { replaced: string[] } }
  setSection(value: { profiles: HeaderProfile[] }): void
  setPiSection(value: unknown): void
  disposers: Array<() => void>
  validate: ((value: { profiles: HeaderProfile[] }) => void) | undefined
}

/** The 0.1.7 settings face: profile-entry forms (describe/configure). */
interface FakeSettingsForms {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): Array<{ ns: string; value: unknown }>
}

interface ModernHarness {
  ctx: Context
  llm: { registerAdapter(providers: string[], adapter: unknown): { replaced: string[] } }
  settings: FakeSettingsForms
  /** The fiber marker the plugin reads as ctx.fiber. */
  fiber: object
  /** internal/config listeners the plugin registered. */
  configListeners: Array<(this: unknown, raw: unknown, next: () => unknown) => unknown>
  /** Every configure() call's presentation argument. */
  configured: Array<{ auto?: boolean }>
  disposers: Array<() => void>
  /** Move the live volatile cell (a user edit of the profiles field). */
  setOwnProfiles(value: HeaderProfile[]): void
  /** Move the pi-ai entry's served value (a pick write, a route edit). */
  setPiValue(value: unknown): void
}

/** Build a fake 0.1.7 host context: forms-style settings plus a volatile Config cell. */
function makeModernHarness(options?: {
  profiles?: HeaderProfile[]
  piValue?: unknown
  /** Extra face members, e.g. a legacy installSection that must stay unused. */
  extraSettings?: Record<string, unknown>
}): ModernHarness {
  let piValue: unknown = options?.piValue
  let ownProfiles: HeaderProfile[] = options?.profiles ?? []
  const fiber = {}
  const configured: Array<{ auto?: boolean }> = []
  const configListeners: ModernHarness['configListeners'] = []
  const disposers: Array<() => void> = []
  const llm = {
    registerAdapter(_providers: string[], _adapter: unknown) {
      return { replaced: [] as string[] }
    },
  }
  const settings: FakeSettingsForms = {
    configure(presentation) {
      configured.push(presentation)
      return () => {}
    },
    describe() {
      return piValue === undefined ? [] : [{ ns: PI_AI_NS, value: piValue }]
    },
    ...options?.extraSettings,
  }
  const ctx = {
    settings,
    fiber,
    inject(names: string[], callback: (c: unknown) => void) {
      if (names[0] === 'llm') callback(ctx)
      return undefined
    },
    effect(fn: () => unknown, _name?: string) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
    on(event: string, listener: ModernHarness['configListeners'][number]) {
      if (event === 'internal/config') configListeners.push(listener)
      return () => {}
    },
  }
  ;(ctx as unknown as { llm: typeof llm }).llm = llm
  // The volatile Config field as DSH 0.1.7 hands it to apply(): a live cell.
  const config = { profiles: { get: () => ownProfiles } }
  apply(ctx as unknown as Context, config)
  return {
    ctx: ctx as unknown as Context,
    llm,
    settings,
    fiber,
    configListeners,
    configured,
    disposers,
    setOwnProfiles(value) { ownProfiles = value },
    setPiValue(value) { piValue = value },
  }
}

/** Build a fake host context wiring the seams apply() consumes. */
function makeHarness(options?: {
  profiles?: HeaderProfile[]
  piSection?: unknown
}): Harness {
  let section: { profiles: HeaderProfile[] } = { profiles: options?.profiles ?? [] }
  let piSection: unknown = options?.piSection
  let validate: Harness['validate']
  const disposers: Array<() => void> = []
  const llm = {
    registerAdapter(_providers: string[], _adapter: unknown) {
      return { replaced: [] as string[] }
    },
  }
  const settings: FakeSettings = {
    installSection(_owner, _ns, _schema, _entry, hooks) {
      validate = hooks.validate as Harness['validate']
      hooks.setSource(() => section)
      hooks.onChange()
      harnessHooks = hooks
    },
    get(ns: string) {
      return ns === PI_AI_NS ? piSection : undefined
    },
  }
  let harnessHooks: { setSource(current: () => unknown): void; onChange(): void } | undefined
  const ctx = {
    settings,
    inject(names: string[], callback: (c: unknown) => void) {
      if (names[0] === 'llm') callback(ctx)
      return undefined
    },
    effect(fn: () => unknown, _name?: string) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  } as unknown as Context & { llm: typeof llm }
  ;(ctx as unknown as { llm: typeof llm }).llm = llm
  return {
    ctx: ctx as unknown as Context,
    settings,
    llm,
    disposers,
    get validate() { return validate },
    setSection(value) {
      section = value
      harnessHooks?.setSource(() => section)
      harnessHooks?.onChange()
    },
    setPiSection(value) { piSection = value },
  }
}

/** A fake pi-ai-shaped adapter: memoized snapshot plus dispatch entries. */
function makePiAdapter(models: Record<string, Record<string, unknown>>) {
  const snapshot = {
    models: {
      getModel(provider: string, id: string) {
        return models[`${provider}/${id}`]
      },
    },
  }
  return {
    streamed: [] as Array<Record<string, unknown>>,
    current() { return snapshot },
    async *stream(options: Record<string, unknown>) {
      this.streamed.push(options)
      yield { type: 'chunk' }
    },
    async prepareCall(provider: string, model: string) {
      return { model: { provider, id: model }, stream: () => this.stream({ provider, model }) }
    },
  }
}

const GW_PROFILES: HeaderProfile[] = [
  { id: 'gw', headers: [{ name: 'X-Tenant', value: 'acme' }] },
]

const PI_SECTION = {
  providers: {
    acme: {
      models: [
        { id: 'm1', headersProfile: 'gw' },
        { id: 'm2' },
      ],
    },
  },
}

describe('namespace registration', () => {
  it('registers the custom-headers namespace with write-time validation', () => {
    const harness = makeHarness()
    apply(harness.ctx, {})
    expect(harness.validate).toBeTypeOf('function')
    expect(() => harness.validate?.({ profiles: GW_PROFILES })).not.toThrow()
    expect(() => {
      harness.validate?.({ profiles: [{ id: 'GW', headers: [] }, { id: 'gw', headers: [] }] })
    }).toThrow(/case-insensitively/)
  })
})

describe('dispatch header stamping', () => {
  it('stamps the picked profile onto the resolved model at stream time', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })
  })

  it('stamps through prepareCall (the captured-snapshot dispatch path)', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    await adapter.prepareCall('acme', 'm1')
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })
  })

  it('leaves an unpicked model bare, and restores a descriptor it stamped before', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const picked: Record<string, unknown> = { id: 'm1' }
    const plain: Record<string, unknown> = { id: 'm2' }
    const adapter = makePiAdapter({ 'acme/m1': picked, 'acme/m2': plain })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm2' })) { /* drain */ }
    expect('headers' in plain).toBe(false)

    // The pick is removed from settings: the next call restores the descriptor.
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(picked['headers']).toEqual({ 'x-tenant': 'acme' })
    harness.setPiSection({ providers: { acme: { models: [{ id: 'm1' }] } } })
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect('headers' in picked).toBe(false)
  })

  it('restores catalog-carried headers when the pick disappears', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const catalogHeaders = { 'x-catalog': 'shipped' }
    const modelObj: Record<string, unknown> = { id: 'm1', headers: catalogHeaders }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    void adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]().next()
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })
    harness.setPiSection({ providers: { acme: { models: [{ id: 'm1' }] } } })
    void adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]().next()
    expect(modelObj['headers']).toBe(catalogHeaders)
  })

  it('falls back to no stamping when the picked profile vanishes', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })

    harness.setSection({ profiles: [] })
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect('headers' in modelObj).toBe(false)
  })

  it('filters Harness attribution names from the applied headers', async () => {
    const harness = makeHarness({
      profiles: [{ id: 'gw', headers: [{ name: 'User-Agent', value: 'spoof' }, { name: 'X-Ok', value: '1' }] }],
      piSection: PI_SECTION,
    })
    apply(harness.ctx, {})
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-ok': '1' })
  })

  it('does not wrap adapters without a pi-ai snapshot seam', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    apply(harness.ctx, {})
    const stream = async function* (): AsyncGenerator<unknown> { yield 1 }
    const foreign = { stream }
    harness.llm.registerAdapter(['deepseek-official'], foreign)
    expect(foreign.stream).toBe(stream)
  })

  it('restores registerAdapter and the adapter entries on dispose', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piSection: PI_SECTION })
    // Captured BEFORE apply: the plugin replaces the service entry at inject.
    const originalRegister = harness.llm.registerAdapter
    apply(harness.ctx, {})
    expect(harness.llm.registerAdapter).not.toBe(originalRegister)
    const adapter = makePiAdapter({})
    const originalStream = adapter.stream
    harness.llm.registerAdapter(['acme'], adapter)
    expect(adapter.stream).not.toBe(originalStream)

    for (const dispose of harness.disposers) dispose()
    expect(harness.llm.registerAdapter).toBe(originalRegister)
    expect(adapter.stream).toBe(originalStream)
  })
})

describe('stampModelHeaders', () => {
  it('stamps, restores a previously absent property, and restores a present one', () => {
    const bare: Record<string, unknown> = {}
    stampModelHeaders(bare, { 'x-a': '1' })
    expect(bare['headers']).toEqual({ 'x-a': '1' })
    stampModelHeaders(bare, undefined)
    expect('headers' in bare).toBe(false)

    const carried = { 'x-cat': '1' }
    const rich: Record<string, unknown> = { headers: carried }
    stampModelHeaders(rich, { 'x-a': '1' })
    expect(rich['headers']).toEqual({ 'x-a': '1' })
    stampModelHeaders(rich, undefined)
    expect(rich['headers']).toBe(carried)
  })
})

describe('settings forms seam (DSH 0.1.7)', () => {
  it('registers the page policy and stamps from describe() plus the volatile cell', async () => {
    const harness = makeModernHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    expect(harness.configured).toEqual([{ auto: false }])
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })
  })

  it('follows live profile edits without a remount', async () => {
    const harness = makeModernHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })

    // A user edit to the volatile profiles field reaches the very next call.
    harness.setOwnProfiles([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'edited' }] }])
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'edited' })
  })

  it('restores the descriptor when the pick disappears from the served entry', async () => {
    const harness = makeModernHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toEqual({ 'x-tenant': 'acme' })

    harness.setPiValue({ providers: { acme: { models: [{ id: 'm1' }] } } })
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect('headers' in modelObj).toBe(false)
  })

  it('refuses an invalid profile list through internal/config, own fiber only', () => {
    const harness = makeModernHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    expect(harness.configListeners).toHaveLength(1)
    const listener = harness.configListeners[0]!
    const next = () => ({ profiles: [{ id: 'GW', headers: [] }, { id: 'gw', headers: [] }] })
    expect(() => listener.call(harness.fiber, undefined, next)).toThrow(/case-insensitively/)
    // Another entry's recompose is passed through untouched.
    const other = () => ({ profiles: [{ id: 'GW', headers: [] }, { id: 'gw', headers: [] }] })
    expect(listener.call({}, undefined, other)).toEqual({ profiles: [{ id: 'GW', headers: [] }, { id: 'gw', headers: [] }] })
  })

  it('prefers the forms seam when a host somehow offers both faces', () => {
    let installed = 0
    const harness = makeModernHarness({
      profiles: GW_PROFILES,
      piValue: PI_SECTION,
      extraSettings: {
        installSection() { installed += 1 },
        get() { return undefined },
      },
    })
    expect(installed).toBe(0)
    expect(harness.configured).toEqual([{ auto: false }])
  })

  it('degrades to composition-base profiles when no settings service exists', async () => {
    // A minimal composition without any settings service: apply() must not
    // throw, adapters still wrap, and no model can name a pick.
    const llm = {
      registerAdapter(_providers: string[], _adapter: unknown) {
        return { replaced: [] as string[] }
      },
    }
    const ctx = {
      settings: undefined,
      inject(names: string[], callback: (c: unknown) => void) {
        if (names[0] === 'llm') callback(ctx)
        return undefined
      },
      effect(fn: () => unknown) { return fn() },
      on() { return () => {} },
    }
    ;(ctx as unknown as { llm: typeof llm }).llm = llm
    apply(ctx as unknown as Context, { profiles: GW_PROFILES })

    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    llm.registerAdapter(['acme'], adapter)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect('headers' in modelObj).toBe(false)
  })
})

describe('constants', () => {
  it('owns the custom-headers namespace and annotates llm-pi-ai', () => {
    expect(CUSTOM_HEADERS_NS).toBe('custom-headers')
    expect(PI_AI_NS).toBe('llm-pi-ai')
  })
})
