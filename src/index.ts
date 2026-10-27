/**
 * Host half of dsh-custom-headers.
 *
 * Two jobs:
 *   1. Own the `custom-headers` configuration: named profiles of header
 *      name/value rows, validated on every write (ids unique
 *      case-insensitively, names representable as Fetch headers). Where this
 *      lives depends on the host generation:
 *        - DSH 0.1.7+: the plugin entry's volatile `profiles` Config field,
 *          persisted in the profile's cordis patch and edited live; and
 *        - DSH 0.1.5: the `custom-headers` settings namespace, registered
 *          with write-time validation and persisted in the user settings
 *          document.
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
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS, PLUGIN_ID } from './constants.js'
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

/** The branded settings namespaces this plugin owns (custom-headers) and reads (llm-pi-ai). */
const OWN_NS = CUSTOM_HEADERS_NS as SettingsNamespace
const PI_NS = PI_AI_NS as SettingsNamespace

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

/** The `custom-headers` section schema: the profiles list, empty by default. */
const Section: Schema<CustomHeadersSection> = Schema.object({
  profiles: Schema.array(headerProfile).default([]),
})

/**
 * A live configuration cell: DSH 0.1.7 wraps `.volatile()` Config fields in
 * one of these so edits apply without remounting the plugin fiber; DSH 0.1.5
 * resolves the same field to a plain value. Declared structurally so the
 * plugin typechecks against either cordis generation.
 */
export interface VolatileLike<T> {
  get(): T
}

/**
 * Plugin configuration, supplied through the profile's cordis layer (the
 * row's `config:` block): a deployment may seed composition-base profiles
 * here; the user layer merges over them. On DSH 0.1.7 the field is volatile,
 * so the resolved value arrives as a live {@link VolatileLike} cell whose
 * `get()` reflects user edits on the next call; on DSH 0.1.5 it is a plain
 * array and user edits ride the `custom-headers` settings namespace instead.
 */
export interface Config {
  /** Composition-base header profiles (default none). */
  profiles?: HeaderProfile[] | VolatileLike<HeaderProfile[]>
}

const profilesField: Schema<HeaderProfile[]> = Schema.array(headerProfile).default([])

/**
 * The 0.1.7 settings service admits a profile entry into its live
 * configuration forms only when the Config schema carries a volatile field —
 * and `.volatile()` exists only on the schemastery 0.1.7 ships (3.18.4;
 * 0.1.5-rc.2 ships 3.18.2, where the call is absent). Probe the capability
 * so this same schema builds on both generations: plain field on 0.1.5,
 * volatile (live-editable, no remount) on 0.1.7.
 */
const liveProfilesField: Schema<HeaderProfile[]> = typeof (profilesField as unknown as { volatile?: unknown }).volatile === 'function'
  ? (profilesField as unknown as { volatile(): Schema<HeaderProfile[]> }).volatile()
  : profilesField

/** Schemastery schema: Cordis validates the row config and fills defaults before apply(). */
export const Config = Schema.object({
  profiles: liveProfilesField,
})

// ---- pi-ai snapshot + settings structural faces (compile-time privacy only;
// ---- the exact shapes are verified against dsh-v0.1.5-rc.2 and the
// ---- dsh-v0.1.7-rc.1 – dsh-v0.2.1-rc.2 corridor, and every access fails open
// ---- so a kernel drift degrades to "no custom headers", never to a broken
// ---- dispatch). ----

/** The settings service face of DSH 0.1.5: registered namespaces. */
interface LegacySettingsFace {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    base: CustomHeadersSection,
    hooks: {
      validate(value: CustomHeadersSection): void
      setSource(current: () => CustomHeadersSection): void
      onChange(): void
    },
  ): unknown
  get(ns: string): unknown
}

/**
 * The settings service face of DSH 0.1.7: schema-derived forms over profile
 * plugin entries. `describe()` snapshots every served entry (keyed by row id);
 * `configure()` registers this entry's page policy.
 */
interface SettingsFormsFace {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): Array<{ ns: string; value: unknown }>
}

/**
 * The profile editor's raw user layers. Unlike the Settings form projection,
 * these values retain plugin-owned fields that the host's Config schema does
 * not declare (including this plugin's `headersProfile` model pick).
 */
interface ConfigEditorFace {
  configuration(): Array<{
    entry: { options: { id: string } }
    override: Record<string, unknown>
  }>
}

/** The union face: each member is probed before use, never assumed. */
type SettingsFace = Partial<LegacySettingsFace & SettingsFormsFace>

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
  /** Runtime-owned route registry; present in every supported DSH cohort. */
  adapters?: ReadonlyMap<string, AdapterRegistrationLike>
}

type HeaderCarrier = Record<string, unknown>

/**
 * Original `headers` own-property of every resolved model descriptor this
 * plugin has ever stamped, so "no profile" restores the descriptor exactly
 * (a catalog-shipped `headers` block is put back; a bare descriptor is left
 * bare). Keyed on the descriptor object: a settings change rebuilds the
 * pi-ai snapshot and its descriptors, and the stale entries simply die with
 * them.
 */
const ORIGINAL_HEADERS = new WeakMap<HeaderCarrier, { present: boolean; value: unknown }>()

/**
 * Stamp (or restore) one resolved model descriptor's wire headers.
 * @param model - the resolved pi-ai Model object from the adapter snapshot.
 * @param headers - the effective custom headers, or undefined to restore.
 */
export function stampModelHeaders(model: HeaderCarrier, headers: Record<string, string> | undefined): void {
  let original = ORIGINAL_HEADERS.get(model)
  if (original === undefined) {
    original = {
      present: Object.prototype.hasOwnProperty.call(model, 'headers'),
      value: model['headers'],
    }
    ORIGINAL_HEADERS.set(model, original)
  }
  if (headers === undefined) {
    if (original.present) model['headers'] = original.value
    else delete model['headers']
    return
  }
  model['headers'] = headers
}

/**
 * Read a maybe-volatile configuration field: DSH 0.1.7 hands volatile fields
 * to the plugin as live cells (edits land without a remount), DSH 0.1.5
 * resolves the same field to its plain value.
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
    // DSH 0.1.7: the settings service projects profile entries' volatile
    // Config fields; this plugin's profiles live on its own entry config and
    // pi-ai's providers ride the `llm-pi-ai` entry (the shipped row id).
    const forms = settings as SettingsFormsFace
    const context = ctx as unknown as { get?(name: string): unknown }
    const editor = typeof context.get === 'function'
      ? context.get('configEditor') as ConfigEditorFace | undefined
      : undefined
    const fiber = (ctx as { fiber?: unknown }).fiber
    if (typeof forms.configure === 'function' && fiber !== undefined) {
      // The browser half ships the custom card; no schema-derived page.
      ctx.effect(() => forms.configure({ auto: false }, fiber), 'dsh-custom-headers: settings page policy')
    }
    // Write-time validation, replacing the removed installSection hook: the
    // loader's internal/config waterfall runs on every entry recompose, and a
    // throw refuses the change (the settings write surfaces it verbatim).
    ctx.on('internal/config', function (this: unknown, _raw: unknown, next: () => unknown) {
      const nextConfig = next()
      if (this !== fiber) return nextConfig
      assertValidProfiles(profilesFromUnknown(isRecord(nextConfig) ? nextConfig['profiles'] : undefined))
      return nextConfig
    })
    // The volatile cell re-reads per call: a user edit reaches the next
    // request without a restart, exactly like pi-ai's own providers.
    ownProfiles = () => normalizeProfiles({ profiles: volatileRead(config.profiles) })
    // The form projection strips fields unknown to the host schema. Read the
    // raw user layer for this plugin's model pick, exactly as the browser's
    // settings.mutate wrote it; older/minimal hosts retain the describe fallback.
    piAiSection = () => editor?.configuration().find(row => row.entry.options.id === PI_AI_NS)?.override
      ?? forms.describe().find(row => row.ns === PI_AI_NS)?.value
  } else if (typeof settings?.installSection === 'function') {
    // DSH 0.1.5: register the owned namespace with write-time validation: a
    // duplicate id or a Fetch-unrepresentable header name refuses the save,
    // so an invalid section never reaches the dispatch path below.
    // installSection hands the source thunk once (at attach, and the
    // composition fallback at detach) and fires onChange at attach and after
    // every committed change, so re-reading the thunk in onChange is what
    // keeps the resolved list current — the dispatch wrapper then reads
    // `currentProfiles` per call.
    const legacy = settings as LegacySettingsFace
    let currentProfiles: readonly HeaderProfile[] = normalizeProfiles(base)
    let source: () => CustomHeadersSection = () => base
    legacy.installSection(ctx, OWN_NS, Section, base, {
      validate: (value) => { assertValidProfiles(value.profiles) },
      setSource: (current) => {
        source = current
      },
      onChange: () => {
        currentProfiles = normalizeProfiles(source())
      },
    })
    ownProfiles = () => currentProfiles
    piAiSection = () => legacy.get(PI_NS)
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
      restoreMethod(registerPatch)
      for (const patches of originals.values()) {
        for (const patch of patches) restoreMethod(patch)
      }
      originals.clear()
    }, 'dsh-custom-headers: llm dispatch injection')
  }
}

export { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS, PLUGIN_ID } from './constants.js'
export {
  assertValidProfiles,
  modelProfileIdOf,
  normalizeProfiles,
  profilesFromUnknown,
  resolveProfileHeaders,
  validateProfiles,
} from './headers.js'
export type { CustomHeadersSection, HeaderEntry, HeaderProfile, ProfileIssue } from './headers.js'
