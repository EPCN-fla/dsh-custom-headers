/**
 * Host half of dsh-custom-headers.
 *
 * Two jobs:
 *   1. Own the `custom-headers` configuration: named profiles of header
 *      name/value rows, validated on every write (ids unique
 *      case-insensitively, names representable as Fetch headers). On DSH
 *      0.2.2-rc.2 / rc.3 this is the plugin entry's volatile `profiles` Config
 *      field, persisted in the profile's cordis patch and edited live.
 *   2. Apply the picked profile to every matching LLM call. pi-ai resolves
 *      one immutable snapshot per configuration and sends `model.headers`
 *      on the wire for every protocol (options/profile headers win name
 *      collisions, Harness attribution wins those), so dispatch is wrapped
 *      to give each call its own snapshot/model copy. The shared pi-ai
 *      descriptor is never mutated: prepared and direct streams keep the
 *      headers resolved when that call was created, including after dispose.
 *
 * @module dsh-custom-headers
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer/llm/settings service merges into this program's Context.
import type {} from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { HEADERS_PROFILE_FIELD, PI_AI_NS, PLUGIN_ID } from './constants.js'
import {
  assertValidProfiles,
  isRecord,
  modelProfileIdOf,
  normalizeProfiles,
  profilesFromUnknown,
  resolveProfileHeaders,
  type CustomHeadersSection,
  type HeaderProfile,
} from './headers.js'

/** Stable plugin id (cordis plugin name, bundle id, client module id). The cordis row id is `custom-headers`. */
export const name = PLUGIN_ID

/** Hard dependencies: the loader waits for these before calling apply. */
export const inject = ['settings', 'llm']

/** One header row as persisted. */
interface HeaderEntryWire {
  name: string
  value: string
}

/** One profile as persisted. */
interface HeaderProfileWire {
  id: string
  headers: HeaderEntryWire[]
}

const headerEntry: Schema<HeaderEntryWire> = Schema.object({
  name: Schema.string().required(),
  value: Schema.string().default(''),
})

const headerProfile: Schema<HeaderProfileWire> = Schema.object({
  id: Schema.string().required(),
  headers: Schema.array(headerEntry).default([]),
})

/**
 * A live configuration cell: the target wraps `.volatile()` Config fields in
 * one of these so edits apply without remounting the plugin fiber. The plain
 * value arm remains useful for direct composition-base calls.
 */
export interface VolatileLike<T> {
  get(): T
}

/**
 * Plugin configuration, supplied through the profile's cordis layer (the
 * row's `config:` block): a deployment may seed composition-base profiles
 * here; the user layer merges over them. The field is volatile, so the
 * resolved value arrives as a live {@link VolatileLike} cell whose `get()`
 * reflects user edits on the next call.
 */
export interface Config {
  /** Composition-base header profiles (default none). */
  profiles?: HeaderProfile[] | VolatileLike<HeaderProfile[]>
}

const profilesField: Schema<HeaderProfile[]> = Schema.array(headerProfile).default([])

/** Live-edit the profiles through the target settings service without a remount. */
const liveProfilesField = profilesField.volatile()

/** Schemastery schema: Cordis validates the row config and fills defaults before apply(). */
export const Config = Schema.object({
  profiles: liveProfilesField,
})

// ---- pi-ai snapshot + settings structural faces (compile-time privacy only;
// ---- the exact shapes are verified against dsh-v0.2.2-rc.2 / rc.3, and every access
// ---- fails open so kernel drift degrades to "no custom headers", never to a
// ---- broken dispatch). ----

/**
 * The target settings service face: schema-derived forms over profile
 * plugin entries. `describe()` snapshots every served entry (keyed by row id);
 * `configure()` registers this entry's page policy.
 */
interface SettingsFormsFace {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): Array<{ ns: string; value: unknown }>
}


/** Optional members are probed before use so a minimal composition can still mount. */
type SettingsFace = Partial<SettingsFormsFace>

/** The pi-ai models collection: getModel returns the resolved Model descriptor. */
interface PiAiModelsLike {
  getModel?(provider: string, id: string): unknown
}

/** The adapter's memoized snapshot (profiles + resolved models collection). */
interface PiAiSnapshotLike {
  models?: PiAiModelsLike
}

/** The slice of PiAiAdapter this plugin wraps. */
interface PiAiAdapterLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
  prepareCall?(provider: string, model: string, signal?: unknown): Promise<unknown>
  current?(): PiAiSnapshotLike | undefined
}

/** One live adapter registration in the runtime's route registry. */
interface AdapterRegistrationLike {
  adapter: unknown
}

/** The llm service slice this plugin wraps. */
interface LlmServiceLike {
  registerAdapter(providers: string[], adapter: unknown): unknown
  /** Runtime-owned route registry on the target host. */
  adapters?: ReadonlyMap<string, AdapterRegistrationLike>
}

type HeaderCarrier = Record<string, unknown>


/**
 * Read a live configuration cell, or the plain value supplied by a direct
 * composition-base call.
 * @param value - the resolved Config field.
 */
function volatileRead<T>(value: T | VolatileLike<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileLike<T>).get()
  }
  return value as T | undefined
}

/**
 * Apply the plugin.
 * @param ctx - host context.
 * @param config - the cordis row's config block (composition-base profiles).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Cordis fills schema defaults; direct calls (tests) may omit fields.
  const base: CustomHeadersSection = { profiles: volatileRead(config.profiles) ?? [] }

  /** Harness attribution names always win: the reserved set custom headers lose to. */
  const reserved = new Set(Object.keys(attributionHeaders()).map(name => name.toLowerCase()))

  const settings = ctx.settings as unknown as SettingsFace | undefined

  /** Resolved profiles of the owned configuration (composition base + user layer). */
  let ownProfiles: () => readonly HeaderProfile[]
  /** The resolved pi-ai section (its providers dict), or undefined when unserved. */
  let piAiSection: () => unknown

  if (typeof settings?.describe === 'function') {
    // The target settings service projects profile entries' volatile
    // Config fields; this plugin's profiles live on its own entry config and
    // pi-ai's providers ride the `llm-pi-ai` entry (the shipped row id).
    const forms = settings as SettingsFormsFace
    const fiber = (ctx as { fiber?: unknown }).fiber
    if (typeof forms.configure === 'function' && fiber !== undefined) {
      // The browser half ships the custom card; no schema-derived page.
      ctx.effect(() => forms.configure({ auto: false }, fiber), 'dsh-custom-headers: settings page policy')
    }
    // Cordis 4.1 runs this waterfall on every entry recompose. A throw
    // refuses the write and the settings surface reports it verbatim.
    ctx.on('internal/config', (changedFiber: unknown, next: () => unknown) => {
      const nextConfig = next()
      if (changedFiber !== fiber) return nextConfig
      assertValidProfiles(profilesFromUnknown(isRecord(nextConfig) ? nextConfig['profiles'] : undefined))
      return nextConfig
    })
    // The volatile cell re-reads per call: a user edit reaches the next
    // request without a restart, exactly like pi-ai's own providers.
    ownProfiles = () => normalizeProfiles({ profiles: volatileRead(config.profiles) })
    // Read the resolved, interpolated form value. ConfigEditor.override is
    // only the raw user patch (often {}), so preferring it would hide picks
    // supplied by composition-base or inherited layers. The target's dict
    // projection preserves the plugin-owned model-row headersProfile field.
    piAiSection = () => forms.describe().find(row => row.ns === PI_AI_NS)?.value
  } else {
    // No settings service at all (a minimal composition): composition-base
    // profiles still apply; nothing is editable and no model names a pick.
    ownProfiles = () => normalizeProfiles(base)
    piAiSection = () => undefined
  }

  /**
   * The effective custom headers for one exact route/model pair, or
   * undefined when the model names no profile or the profile is unknown.
   * Reads the RESOLVED pi-ai configuration per call — a change reaches the
   * next request without a restart, exactly like pi-ai itself.
   */
  const headersFor = (provider: string, modelId: string): Record<string, string> | undefined => {
    const section = piAiSection()
    const picked = modelProfileIdOf(
      isRecord(section) ? section['providers'] : undefined,
      provider,
      modelId,
      HEADERS_PROFILE_FIELD,
    )
    if (picked === undefined) return undefined
    return resolveProfileHeaders(ownProfiles(), picked, reserved)
  }

  /**
   * Build the private snapshot for one route/model call. Only the exact model
   * descriptor is copied; profiles and every unrelated model retain their
   * original identity. Methods on the models facade bind to the original
   * collection, so private fields and internal state keep working.
   */
  const snapshotFor = (
    originalCurrent: NonNullable<PiAiAdapterLike['current']>,
    adapter: PiAiAdapterLike,
    provider: string,
    modelId: string,
  ): PiAiSnapshotLike | undefined => {
    const snapshot = originalCurrent.call(adapter)
    const models = snapshot?.models
    const getModel = models?.getModel
    if (snapshot === undefined || models === undefined || typeof getModel !== 'function') return snapshot
    const headers = headersFor(provider, modelId)
    if (headers === undefined || !isRecord(getModel.call(models, provider, modelId))) return snapshot
    const facade = new Proxy(models as object, {
      get(target, property) {
        if (property === 'getModel') {
          return (route: string, id: string): unknown => {
            const resolved = getModel.call(models, route, id)
            if (route !== provider || id !== modelId || !isRecord(resolved)) return resolved
            return { ...resolved, headers }
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ...snapshot, models: facade }
  }

  /** A reversible own-property method patch, including inherited/missing originals. */
  interface MethodPatch {
    target: HeaderCarrier
    key: string
    wrapped: unknown
    own: PropertyDescriptor | undefined
  }

  const patchMethod = (target: HeaderCarrier, key: string, wrapped: unknown): MethodPatch => {
    const own = Object.getOwnPropertyDescriptor(target, key)
    target[key] = wrapped
    return { target, key, wrapped, own }
  }

  /** Restore only our still-installed wrapper; never overwrite a later wrapper. */
  const restoreMethod = (patch: MethodPatch): void => {
    if (Object.getOwnPropertyDescriptor(patch.target, patch.key)?.value !== patch.wrapped) return
    if (patch.own === undefined) delete patch.target[patch.key]
    else Object.defineProperty(patch.target, patch.key, patch.own)
  }

  /** Wrapped adapters and their exact dispatch-entry patches, for fiber teardown. */
  const originals = new Map<PiAiAdapterLike, MethodPatch[]>()
  // A later plugin may still hold our wrappers in its call chain after
  // teardown. Restoration deliberately leaves that chain intact, so the
  // closures must also stop contributing headers on their own.
  let disposed = false

  /**
   * Wrap one pi-ai-shaped adapter. current() synchronously returns a one-call
   * snapshot only while stream()/prepareCall() is being created; the original
   * method then captures that snapshot using its normal, unmodified control
   * flow. No shared descriptor is stamped and no in-flight restore is needed.
   * @returns rollback for a registration that fails, or undefined when the
   * adapter was already wrapped.
   */
  const wrapAdapter = (adapter: unknown): (() => void) | undefined => {
    if (!isRecord(adapter)) return undefined
    const candidate = adapter as unknown as PiAiAdapterLike
    if (originals.has(candidate)) return undefined
    if (typeof candidate.stream !== 'function') return undefined
    if (typeof candidate.current !== 'function') return undefined
    const originalStream = candidate.stream
    const originalPrepareCall = candidate.prepareCall
    const originalCurrent = candidate.current
    const target = candidate as unknown as HeaderCarrier
    let pending: PiAiSnapshotLike | undefined

    const dispatch = <T>(provider: string, modelId: string, invoke: () => T): T => {
      if (disposed) return invoke()
      let override: PiAiSnapshotLike | undefined
      try {
        override = snapshotFor(originalCurrent, candidate, provider, modelId)
      } catch (error) {
        console.warn(`[dsh-custom-headers] header snapshot skipped for "${provider}/${modelId}": ${error instanceof Error ? error.message : String(error)}`)
      }
      const previous = pending
      pending = override
      try { return invoke() } finally { pending = previous }
    }

    const patches: MethodPatch[] = []
    patches.push(patchMethod(target, 'current', function (this: PiAiAdapterLike) {
      return pending ?? originalCurrent.call(this)
    }))
    patches.push(patchMethod(target, 'stream', (options: Record<string, unknown>) => {
      const provider = options['provider']
      const model = options['model']
      if (typeof provider !== 'string' || typeof model !== 'string') return originalStream.call(candidate, options)
      return dispatch(provider, model, () => originalStream.call(candidate, options))
    }))
    if (typeof originalPrepareCall === 'function') {
      patches.push(patchMethod(target, 'prepareCall', (provider: string, model: string, signal?: unknown) =>
        dispatch(provider, model, () => originalPrepareCall.call(candidate, provider, model, signal))))
    }
    originals.set(candidate, patches)
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const patch of patches) restoreMethod(patch)
      originals.delete(candidate)
    }
  }

  // Intercept adapter registrations to wrap each adapter as it arrives. The
  // static inject above makes the service available before apply; failed
  // registrations roll back only a newly installed wrapper, and dispose
  // restores the precise property descriptors without touching later wrappers.
  const llm = (ctx as unknown as { llm?: unknown }).llm as LlmServiceLike | undefined
  if (llm !== undefined && typeof llm.registerAdapter === 'function') {
    const originalRegister = llm.registerAdapter
    const registerTarget = llm as unknown as HeaderCarrier
    const wrappedRegister = (providers: string[], adapter: unknown): unknown => {
      if (disposed) return originalRegister.call(llm, providers, adapter)
      const rollback = wrapAdapter(adapter)
      try { return originalRegister.call(llm, providers, adapter) }
      catch (error) {
        rollback?.()
        throw error
      }
    }
    const registerPatch = patchMethod(registerTarget, 'registerAdapter', wrappedRegister)
    // Mounting or reloading another plugin can change Cordis dependency timing:
    // llm-pi-ai may already own routes before this plugin applies. Adopt those
    // registrations as well as the future ones intercepted above.
    if (llm.adapters instanceof Map) {
      for (const registration of llm.adapters.values()) wrapAdapter(registration.adapter)
    }
    ctx.effect(() => () => {
      disposed = true
      restoreMethod(registerPatch)
      for (const patches of originals.values()) {
        for (const patch of patches) restoreMethod(patch)
      }
      originals.clear()
    }, 'dsh-custom-headers: llm dispatch injection')
  }
}

export type { CustomHeadersSection, HeaderEntry, HeaderProfile, ProfileIssue } from './headers.js'
