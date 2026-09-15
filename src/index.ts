/**
 * Host half of dsh-custom-headers.
 *
 * Two jobs:
 *   1. Own the `custom-headers` settings namespace: named profiles of
 *      header name/value rows, validated on every write (ids unique
 *      case-insensitively, names representable as Fetch headers) and
 *      persisted in the user settings document like any other namespace.
 *   2. Apply the picked profile to every matching LLM call. pi-ai resolves
 *      one immutable snapshot per configuration and sends `model.headers`
 *      on the wire for every protocol (options/profile headers win name
 *      collisions, Harness attribution wins those), so dispatch is wrapped
 *      to stamp the resolved headers onto the snapshot's model descriptor
 *      just before the adapter reads it — and to restore the descriptor's
 *      own headers when the model names no (or an unknown) profile.
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
  resolveProfileHeaders,
  type CustomHeadersSection,
  type HeaderProfile,
} from './headers.js'

/** Stable plugin id, matching the cordis.patch.yml row and the bundle id. */
export const name = PLUGIN_ID

/** Hard dependencies: the loader waits for these before calling apply. */
export const inject = ['settings']

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
 * Plugin configuration, supplied through the profile's cordis layer (the
 * row's `config:` block): a deployment may seed composition-base profiles
 * here; the user layer merges over them exactly as for any other namespace.
 */
export interface Config {
  /** Composition-base header profiles (default none). */
  profiles?: HeaderProfile[]
}

/** Schemastery schema: Cordis validates the row config and fills defaults before apply(). */
export const Config: Schema<Config> = Schema.object({
  profiles: Schema.array(headerProfile).default([]),
})

// ---- pi-ai snapshot structural faces (compile-time privacy only; the exact
// ---- shapes are verified against dsh-v0.1.5-rc.2 and every access fails
// ---- open so a kernel drift degrades to "no custom headers", never to a
// ---- broken dispatch). ----

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

/** The llm service slice this plugin wraps. */
interface LlmServiceLike {
  registerAdapter(providers: string[], adapter: unknown): unknown
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
 * Apply the plugin.
 * @param ctx - host context.
 * @param config - the cordis row's config block (composition-base profiles).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Cordis fills schema defaults; direct calls (tests) may omit fields.
  const base: CustomHeadersSection = { profiles: config.profiles ?? [] }

  /** Resolved profiles of the `custom-headers` section (composition base + user layer). */
  let currentProfiles: readonly HeaderProfile[] = normalizeProfiles(base)

  /** Harness attribution names always win: the reserved set custom headers lose to. */
  const reserved = new Set(Object.keys(attributionHeaders()).map(name => name.toLowerCase()))

  // Register the owned namespace with write-time validation: a duplicate id
  // or a Fetch-unrepresentable header name refuses the save, so an invalid
  // section never reaches the dispatch path below. installSection hands the
  // source thunk once (at attach, and the composition fallback at detach) and
  // fires onChange at attach and after every committed change, so re-reading
  // the thunk in onChange is what keeps the resolved list current — the
  // dispatch wrapper then reads `currentProfiles` per call.
  let source: () => CustomHeadersSection = () => base
  ctx.settings.installSection(ctx, OWN_NS, Section, base, {
    validate: (value) => { assertValidProfiles(value.profiles) },
    setSource: (current) => {
      source = current
    },
    onChange: () => {
      currentProfiles = normalizeProfiles(source())
    },
  })

  /**
   * The effective custom headers for one exact route/model pair, or
   * undefined when the model names no profile or the profile is unknown.
   * Reads the RESOLVED pi-ai section per call — a configuration change
   * reaches the next request without a restart, exactly like pi-ai itself.
   */
  const headersFor = (provider: string, modelId: string): Record<string, string> | undefined => {
    const section = ctx.settings.get(PI_NS)
    const picked = modelProfileIdOf(
      isRecord(section) ? section['providers'] : undefined,
      provider,
      modelId,
      HEADERS_PROFILE_FIELD,
    )
    if (picked === undefined) return undefined
    return resolveProfileHeaders(currentProfiles, picked, reserved)
  }

  /**
   * Stamp the snapshot's descriptor for one route/model pair with its
   * effective custom headers (or restore the descriptor when none apply).
   * Fails open: any structural surprise leaves dispatch untouched.
   */
  const patchModel = (adapter: PiAiAdapterLike, provider: string, modelId: string): void => {
    try {
      const snapshot = adapter.current?.()
      const model = snapshot?.models?.getModel?.(provider, modelId)
      if (!isRecord(model)) return
      stampModelHeaders(model, headersFor(provider, modelId))
    } catch (error) {
      console.warn(`[dsh-custom-headers] header stamping skipped for "${provider}/${modelId}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Wrapped adapters and their original dispatch entries, for fiber teardown. */
  const originals = new Map<PiAiAdapterLike, { stream: PiAiAdapterLike['stream']; prepareCall: PiAiAdapterLike['prepareCall'] }>()

  /**
   * Wrap one adapter's dispatch entries so every call re-stamps its model's
   * headers from live settings before the adapter reads its snapshot. Only
   * pi-ai-shaped adapters (a memoized `current()` snapshot with a models
   * collection) are wrapped; anything else dispatches exactly as before.
   */
  const wrapAdapter = (adapter: unknown): void => {
    if (!isRecord(adapter)) return
    const candidate = adapter as unknown as PiAiAdapterLike
    if (originals.has(candidate)) return
    if (typeof candidate.stream !== 'function') return
    if (typeof candidate.current !== 'function') return
    const originalStream = candidate.stream
    const originalPrepareCall = candidate.prepareCall
    candidate.stream = (options) => {
      const provider = options['provider']
      const model = options['model']
      if (typeof provider === 'string' && typeof model === 'string') patchModel(candidate, provider, model)
      return originalStream.call(candidate, options)
    }
    if (typeof originalPrepareCall === 'function') {
      // prepareCall captures the memoized snapshot for its one-shot handle;
      // stamping before the call lands the headers in that same snapshot.
      candidate.prepareCall = (provider, model, signal) => {
        patchModel(candidate, provider, model)
        return originalPrepareCall.call(candidate, provider, model, signal)
      }
    }
    originals.set(candidate, { stream: originalStream, prepareCall: originalPrepareCall })
  }

  // Intercept adapter registrations to wrap each adapter as it arrives.
  // Deferred inject: the wrap lands whenever the llm service registers, and
  // ctx.effect restores the originals on dispose (disable/HMR leaves no trace).
  ctx.inject(['llm'], (llmCtx) => {
    const llm = (llmCtx as unknown as { llm?: unknown }).llm as LlmServiceLike | undefined
    if (llm === undefined || typeof llm.registerAdapter !== 'function') return
    const originalRegister = llm.registerAdapter
    llm.registerAdapter = (providers: string[], adapter: unknown) => {
      wrapAdapter(adapter)
      return originalRegister.call(llm, providers, adapter)
    }
    ctx.effect(() => () => {
      llm.registerAdapter = originalRegister
      for (const [adapter, original] of originals) {
        adapter.stream = original.stream
        adapter.prepareCall = original.prepareCall
      }
      originals.clear()
    }, 'dsh-custom-headers: llm dispatch injection')
  })
}

export { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS, PLUGIN_ID } from './constants.js'
export {
  assertValidProfiles,
  modelProfileIdOf,
  normalizeProfiles,
  resolveProfileHeaders,
  validateProfiles,
} from './headers.js'
export type { CustomHeadersSection, HeaderEntry, HeaderProfile, ProfileIssue } from './headers.js'
