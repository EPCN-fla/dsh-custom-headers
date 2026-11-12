/**
 * Host-half behavior on the DSH 0.2.2-rc.2 contracts: settings-form
 * validation, adapter registration wrapping, per-call header snapshots,
 * restoration of untouched descriptors, and fiber teardown.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { attributionHeaders, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config as PluginConfig, inject as pluginInject, stampModelHeaders } from '../src/index.js'
import { CUSTOM_HEADERS_NS, PI_AI_NS } from '../src/constants.js'
import type { HeaderProfile } from '../src/headers.js'

afterEach(() => { vi.unstubAllEnvs() })

/** The target settings face: profile-entry forms (describe/configure). */
interface FakeSettings {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): Array<{ ns: string; value: unknown }>
}

interface Harness {
  ctx: Context
  llm: { registerAdapter(providers: string[], adapter: unknown): { replaced: string[] } }
  originalRegister(providers: string[], adapter: unknown): { replaced: string[] }
  settings: FakeSettings
  fiber: object
  configListeners: Array<(fiber: unknown, next: () => unknown) => unknown>
  configured: Array<{ auto?: boolean }>
  disposers: Array<() => void>
  setOwnProfiles(value: HeaderProfile[]): void
  setPiValue(value: unknown): void
  setPiOverride(value: unknown): void
}

/** Build a fake target host context: forms-style settings plus a volatile Config cell. */
function makeHarness(options?: {
  profiles?: HeaderProfile[]
  piValue?: unknown
  /** Raw user-layer value returned through ConfigEditor.configuration(). */
  piOverride?: unknown
  registrationError?: Error
}): Harness {
  let piValue: unknown = options?.piValue
  let piOverride: unknown = options?.piOverride
  let ownProfiles: HeaderProfile[] = options?.profiles ?? []
  const fiber = {}
  const configured: Array<{ auto?: boolean }> = []
  const configListeners: Harness['configListeners'] = []
  const disposers: Array<() => void> = []
  const llm = {
    registerAdapter(_providers: string[], _adapter: unknown) {
      if (options?.registrationError !== undefined) throw options.registrationError
      return { replaced: [] as string[] }
    },
  }
  const originalRegister = llm.registerAdapter
  const settings: FakeSettings = {
    configure(presentation) {
      configured.push(presentation)
      return () => {}
    },
    describe() {
      return piValue === undefined ? [] : [{ ns: PI_AI_NS, value: piValue }]
    },
  }
  const ctx = {
    settings,
    fiber,
    get(name: string) {
      if (name === 'llm') return llm
      if (name !== 'configEditor') return undefined
      return {
        configuration: () => piOverride === undefined
          ? []
          : [{ entry: { options: { id: PI_AI_NS } }, override: piOverride }],
      }
    },
    inject(names: string[]) {
      if (names[0] === 'llm') throw new Error('dynamic llm injection must not be used')
      return undefined
    },
    effect(fn: () => unknown, _name?: string) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
    on(event: string, listener: Harness['configListeners'][number]) {
      if (event === 'internal/config') configListeners.push(listener)
      return () => {}
    },
  }
  ;(ctx as unknown as { llm: typeof llm }).llm = llm
  const config = { profiles: { get: () => ownProfiles } }
  apply(ctx as unknown as Context, config)
  return {
    ctx: ctx as unknown as Context,
    llm,
    originalRegister,
    settings,
    fiber,
    configListeners,
    configured,
    disposers,
    setOwnProfiles(value) { ownProfiles = value },
    setPiValue(value) { piValue = value },
    setPiOverride(value) { piOverride = value },
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
  const streamWithSnapshot = async function* (
    streamed: Array<{ options: Record<string, unknown>; headers: unknown }>,
    options: Record<string, unknown>,
    captured: typeof snapshot,
  ) {
    const resolved = captured.models.getModel(String(options['provider']), String(options['model']))
    streamed.push({ options, headers: resolved?.['headers'] })
    yield { type: 'chunk' }
  }
  return {
    streamed: [] as Array<{ options: Record<string, unknown>; headers: unknown }>,
    current() { return snapshot },
    stream(options: Record<string, unknown>) {
      return streamWithSnapshot(this.streamed, options, this.current())
    },
    async prepareCall(provider: string, model: string) {
      const captured = this.current()
      return {
        model: { provider, id: model },
        stream: () => streamWithSnapshot(this.streamed, { provider, model }, captured),
      }
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

describe('dispatch header snapshots', () => {
  it('applies the picked profile without mutating the resolved model', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)
  })

  it('applies headers through the captured-snapshot dispatch path', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    const call = await adapter.prepareCall('acme', 'm1')
    for await (const _ of call.stream()) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)
  })

  it('leaves shared descriptors bare as picks change', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const picked: Record<string, unknown> = { id: 'm1' }
    const plain: Record<string, unknown> = { id: 'm2' }
    const adapter = makePiAdapter({ 'acme/m1': picked, 'acme/m2': plain })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm2' })) { /* drain */ }
    expect('headers' in plain).toBe(false)

    // The pick is removed from settings: the next call restores the descriptor.
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in picked).toBe(false)
    harness.setPiValue({ providers: { acme: { models: [{ id: 'm1' }] } } })
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toBeUndefined()
    expect('headers' in picked).toBe(false)
  })

  it('preserves catalog-carried headers as picks change', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const catalogHeaders = { 'x-catalog': 'shipped' }
    const modelObj: Record<string, unknown> = { id: 'm1', headers: catalogHeaders }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    void adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]().next()
    expect(adapter.streamed[0]?.headers).toEqual({ 'x-tenant': 'acme' })
    expect(modelObj['headers']).toBe(catalogHeaders)
    harness.setPiValue({ providers: { acme: { models: [{ id: 'm1' }] } } })
    void adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]().next()
    expect(adapter.streamed[1]?.headers).toBe(catalogHeaders)
    expect(modelObj['headers']).toBe(catalogHeaders)
  })

  it('falls back to catalog behavior when the picked profile vanishes', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)

    harness.setOwnProfiles([])
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toBeUndefined()
    expect('headers' in modelObj).toBe(false)
  })

  it('filters Harness attribution names from the applied headers with a launch suffix', async () => {
    vi.stubEnv('DSH_USER_AGENT_SUFFIX', 'dsh-profile/test')
    const harness = makeHarness({
      profiles: [{ id: 'gw', headers: [{ name: 'User-Agent', value: 'spoof' }, { name: 'X-Ok', value: '1' }] }],
      piValue: PI_SECTION,
    })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-ok': '1' })
    expect(attributionHeaders()['user-agent']).toContain('dsh-profile/test')
    expect('headers' in modelObj).toBe(false)
  })

  it('rejects an invalid launch suffix before patching adapter dispatch', () => {
    vi.stubEnv('DSH_USER_AGENT_SUFFIX', 'dsh-profile/not valid')
    const adapter = makePiAdapter({})
    const originalStream = adapter.stream
    const llm = {
      adapters: new Map([['acme', { adapter }]]),
      registerAdapter(_providers: string[], _adapter: unknown) { return { replaced: [] as string[] } },
    }
    const originalRegister = llm.registerAdapter
    const ctx = { llm } as unknown as Context

    expect(() => apply(ctx, { profiles: GW_PROFILES })).toThrow('DSH_USER_AGENT_SUFFIX must be an RFC 9110 product token')
    expect(llm.registerAdapter).toBe(originalRegister)
    expect(adapter.stream).toBe(originalStream)
  })

  it('does not wrap adapters without a pi-ai snapshot seam', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const stream = async function* (): AsyncGenerator<unknown> { yield 1 }
    const foreign = { stream }
    harness.llm.registerAdapter(['deepseek-official'], foreign)
    expect(foreign.stream).toBe(stream)
  })

  it('freezes headers per prepared call when profiles change between interleaved calls', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    const first = await adapter.prepareCall('acme', 'm1')
    harness.setOwnProfiles([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'other' }] }])
    const second = await adapter.prepareCall('acme', 'm1')
    for await (const _ of first.stream()) { /* drain */ }
    for await (const _ of second.stream()) { /* drain */ }

    expect(adapter.streamed.map(call => call.headers)).toEqual([
      { 'x-tenant': 'acme' },
      { 'x-tenant': 'other' },
    ])
    expect('headers' in modelObj).toBe(false)
  })

  it('freezes direct streams before delayed iteration', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const adapter = makePiAdapter({ 'acme/m1': { id: 'm1' } })
    harness.llm.registerAdapter(['acme'], adapter)

    const first = adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]()
    harness.setOwnProfiles([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'other' }] }])
    const second = adapter.stream({ provider: 'acme', model: 'm1' })[Symbol.asyncIterator]()
    await first.next()
    await second.next()

    expect(adapter.streamed.map(call => call.headers)).toEqual([
      { 'x-tenant': 'acme' },
      { 'x-tenant': 'other' },
    ])
  })

  it('does not leave custom headers on the shared descriptor after dispose', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const catalogHeaders = { 'x-catalog': 'shipped' }
    const modelObj: Record<string, unknown> = { id: 'm1', headers: catalogHeaders }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)
    const prepared = await adapter.prepareCall('acme', 'm1')

    for (const dispose of harness.disposers) dispose()
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(modelObj['headers']).toBe(catalogHeaders)
    expect(adapter.streamed.at(-1)?.headers).toBe(catalogHeaders)

    // An already prepared call retains its own frozen snapshot, not shared state.
    for await (const _ of prepared.stream()) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect(modelObj['headers']).toBe(catalogHeaders)
  })

  it('rolls back a newly wrapped adapter when registration fails', () => {
    const harness = makeHarness({ registrationError: new Error('duplicate') })
    const adapter = makePiAdapter({})
    const before = Object.getOwnPropertyDescriptors(adapter)
    expect(() => harness.llm.registerAdapter(['acme'], adapter)).toThrow('duplicate')
    expect(Object.getOwnPropertyDescriptors(adapter)).toEqual(before)
  })

  it('restores the exact property shape of inherited and absent methods', () => {
    const harness = makeHarness()
    const adapter = Object.assign(Object.create(makePiAdapter({})), { ownMarker: true })
    const before = Object.getOwnPropertyDescriptors(adapter)
    harness.llm.registerAdapter(['acme'], adapter)
    for (const dispose of harness.disposers) dispose()
    expect(Object.getOwnPropertyDescriptors(adapter)).toEqual(before)
  })

  it('restores registerAdapter and the adapter entries on dispose', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const originalRegister = harness.originalRegister
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

describe('runtime adapter registration order', () => {
  it('wraps a pre-registered adapter for reviewer-style runtime streams', async () => {
    type RuntimeSnapshot = {
      models: { getModel(provider: string, id: string): Record<string, unknown> | undefined }
    }
    class PreRegisteredPiAdapter extends LlmAdapter {
      readonly seen: unknown[] = []
      private readonly snapshot: RuntimeSnapshot = {
        models: {
          getModel: (_provider, _id) => ({ id: 'm1' }),
        },
      }

      current(): RuntimeSnapshot { return this.snapshot }

      override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
        const snapshot = this.current()
        return Promise.resolve({
          model: { provider, id: model, name: model },
          stream: options => this.capture(options, snapshot),
        })
      }

      override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        return this.capture(options, this.current())
      }

      private async * capture(options: GenerateOptions, snapshot: RuntimeSnapshot): AsyncGenerator<StreamChunk> {
        this.seen.push(snapshot.models.getModel(options.provider, options.model)?.['headers'])
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.provide('settings', {
        configure() { return () => {} },
        describe() { return [{ ns: PI_AI_NS, value: PI_SECTION }] },
      })
      const adapter = new PreRegisteredPiAdapter()
      ctx.llm.registerAdapter(['acme'], adapter)

      // Cordis may mount this plugin after llm-pi-ai when another plugin
      // changes dependency timing. Reviewer calls use this direct service path.
      apply(ctx, { profiles: GW_PROFILES })
      for await (const _chunk of ctx.llm.stream({ provider: 'acme', model: 'm1', messages: [] })) { /* drain */ }

      expect(adapter.seen).toEqual([{ 'x-tenant': 'acme' }])
    } finally {
      await ctx.fiber.dispose()
    }
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

describe('settings forms seam (DSH 0.2.2-rc.2)', () => {
  it('registers the page policy and applies describe() plus the volatile cell', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    expect(harness.configured).toEqual([{ auto: false }])
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)
  })

  it('reads model picks from the raw override when form projection drops them', async () => {
    const projected = { providers: { acme: { models: [{ id: 'm1' }] } } }
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: projected, piOverride: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)

    harness.setPiOverride(projected)
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toBeUndefined()
    expect('headers' in modelObj).toBe(false)
  })

  it('follows live profile edits without a remount', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)

    // A user edit to the volatile profiles field reaches the very next call.
    harness.setOwnProfiles([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'edited' }] }])
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'edited' })
    expect('headers' in modelObj).toBe(false)
  })

  it('leaves the descriptor unchanged when the pick disappears', async () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    const modelObj: Record<string, unknown> = { id: 'm1' }
    const adapter = makePiAdapter({ 'acme/m1': modelObj })
    harness.llm.registerAdapter(['acme'], adapter)

    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toEqual({ 'x-tenant': 'acme' })
    expect('headers' in modelObj).toBe(false)

    harness.setPiValue({ providers: { acme: { models: [{ id: 'm1' }] } } })
    for await (const _ of adapter.stream({ provider: 'acme', model: 'm1' })) { /* drain */ }
    expect(adapter.streamed.at(-1)?.headers).toBeUndefined()
    expect('headers' in modelObj).toBe(false)
  })

  it('refuses invalid profiles through the Cordis 4.1 internal/config contract, own fiber only', () => {
    const harness = makeHarness({ profiles: GW_PROFILES, piValue: PI_SECTION })
    expect(harness.configListeners).toHaveLength(1)
    const listener = harness.configListeners[0]!
    const duplicate = () => ({ profiles: [{ id: 'GW', headers: [] }, { id: 'gw', headers: [] }] })

    let ownCalls = 0
    const own = () => { ownCalls += 1; return duplicate() }
    expect(() => listener(harness.fiber, own)).toThrow(/case-insensitively/)
    expect(ownCalls).toBe(1)

    let otherCalls = 0
    const other = () => { otherCalls += 1; return duplicate() }
    expect(listener({}, other)).toEqual(duplicate())
    expect(otherCalls).toBe(1)
  })

  it('enforces profile validation through the real Cordis config dispatcher', async () => {
    const ctx = new Context()
    try {
      ctx.provide('settings', {
        configure() { return () => {} },
        describe() { return [] },
      } as never)
      ctx.provide('llm', {
        adapters: new Map(),
        registerAdapter() {},
      } as never)
      const fiber = await ctx.plugin({
        name: 'dsh-custom-headers',
        inject: pluginInject,
        Config: PluginConfig,
        apply,
      })
      const resolve = (candidate: { profiles: HeaderProfile[] }): unknown =>
        (fiber as unknown as { resolveConfig(value: unknown): unknown }).resolveConfig(candidate)

      expect(() => resolve({ profiles: [
        { id: 'GW', headers: [] },
        { id: 'gw', headers: [] },
      ] })).toThrow(/case-insensitively/)
      expect(() => resolve({ profiles: [
        { id: 'gw', headers: [{ name: 'bad\nname', value: 'value' }] },
      ] })).toThrow(/Fetch cannot represent/)
      expect(resolve({ profiles: GW_PROFILES })).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
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
      get(name: string) { return name === 'llm' ? llm : undefined },
      inject(names: string[]) {
        if (names[0] === 'llm') throw new Error('dynamic llm injection must not be used')
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
    expect(pluginInject).toEqual(['settings', 'llm'])
  })
})
