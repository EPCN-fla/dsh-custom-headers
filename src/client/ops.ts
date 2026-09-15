/**
 * Client-side settings seams over 'settings.mutate': reading both namespaces
 * this plugin joins on, writing one model's header-profile pick onto its
 * pi-ai model row, and replacing the owned profiles list. Pure logic — no
 * React, no DOM — so it stays unit-testable in isolation.
 *
 * @module dsh-custom-headers/client/ops
 */

import { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS } from '../constants.js'
import { isRecord, normalizeProfiles, type HeaderProfile } from '../headers.js'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteApi, SettingsJoin, SettingsNamespaceView, WriteReply } from './types.js'

/**
 * Describe the pi-ai and custom-headers namespaces plus writability through
 * the settings Remote. The single describe seam for the browser half: the
 * injector's scan join, the pick write seam, and the profiles card all read
 * through it (one wire call carries every namespace).
 */
export async function describeNamespaces(api: RemoteApi): Promise<SettingsJoin> {
  const response = await api.settings.describe()
  if (!response.ok) return { piAi: undefined, customHeaders: undefined, writable: false }
  return {
    piAi: response.value.namespaces.find(ns => ns.ns === PI_AI_NS),
    customHeaders: response.value.namespaces.find(ns => ns.ns === CUSTOM_HEADERS_NS),
    writable: response.value.writable,
  }
}

/** The resolved profile list of a custom-headers namespace view. */
export function profilesOf(namespace: SettingsNamespaceView | undefined): HeaderProfile[] {
  return normalizeProfiles(namespace?.value)
}

/** The user-layer providers dict of the pi-ai namespace, as records. */
export function providersOf(namespace: SettingsNamespaceView | undefined): Record<string, Record<string, unknown>> {
  const value = namespace?.value as { providers?: unknown } | undefined
  const providers = value?.providers
  if (!isRecord(providers)) return {}
  return Object.fromEntries(
    Object.entries(providers).filter(([, profile]) => isRecord(profile)),
  ) as Record<string, Record<string, unknown>>
}

/** The model rows of one route in a providers dict (records only). */
export function modelsOf(providers: Record<string, Record<string, unknown>>, route: string): Record<string, unknown>[] {
  const models = providers[route]?.['models']
  if (!Array.isArray(models)) return []
  return models.filter(isRecord)
}

/**
 * The header-profile pick of one model in a route's models. A non-string
 * value degrades to undefined: the field is plugin-owned, and a stale or
 * hostile document must read as "Default", never break the picker.
 */
export function profilePickOf(models: Record<string, unknown>[], modelId: string): string | undefined {
  const entry = models.find(model => model['id'] === modelId)
  const picked = entry?.[HEADERS_PROFILE_FIELD]
  return typeof picked === 'string' && picked.trim().length > 0 ? picked : undefined
}

/**
 * Write one model's header-profile pick onto its pi-ai model row: a profile
 * id sets the field, `null` removes it ("Default"). The models array is
 * rebuilt verbatim; a row this code cannot represent refuses the write
 * rather than silently dropping it. Retried once on a revision conflict
 * (a concurrent writer moved the namespace between describe and mutate) —
 * the same recovery the official settings form uses.
 * @param api - the settings Remote face.
 * @param route - the provider route key.
 * @param modelId - the exact model id.
 * @param pick - the profile id, or null for Default.
 * @param describe - how to obtain the namespaces join (injectable for tests).
 */
export async function writeProfilePick(
  api: RemoteApi,
  route: string,
  modelId: string,
  pick: string | null,
  describe: () => Promise<SettingsJoin> = () => describeNamespaces(api),
): Promise<WriteReply> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const join = await describe()
      if (join.piAi === undefined) return { ok: false, error: 'no-namespace' }
      const providers = providersOf(join.piAi)
      const rawModels = providers[route]?.['models']
      if (!Array.isArray(rawModels)) return { ok: false, error: 'model-not-found' }
      if (!rawModels.every(isRecord)) return { ok: false, error: 'invalid-models' }
      const models = rawModels as Record<string, unknown>[]
      const index = models.findIndex(model => model['id'] === modelId)
      if (index < 0) return { ok: false, error: 'model-not-found' }
      const nextModels = models.map((model, at) => {
        if (at !== index) return model
        const copy = { ...model }
        if (pick === null) delete copy[HEADERS_PROFILE_FIELD]
        else copy[HEADERS_PROFILE_FIELD] = pick
        return copy
      })
      const response = await api.settings.mutate(
        PI_AI_NS,
        // The rebuilt models array is JSON-shaped by construction (a settings
        // document is JSON); the set op asserts once instead of rebuilding
        // the row's type.
        [{ op: 'set', path: ['providers', route, 'models'], value: nextModels } as unknown as SettingsPathOpView],
        join.piAi.revision,
      )
      if (!response.ok) {
        // The stable wire code, not the message prose: 'settings/conflict'
        // means a concurrent writer moved the namespace between our describe
        // and mutate; re-read once and retry with the fresh revision.
        if (attempt === 0 && response.error.code === 'settings/conflict') continue
        return { ok: false, error: response.error.message }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: false, error: 'conflict' }
}

/**
 * Replace the owned profiles list wholesale (one save of the configuration
 * card). Fully-blank header rows are editing artifacts and are stripped
 * before the write; everything else is written as staged (the host's
 * registration validator is the gate for invalid data, and its refusal is
 * surfaced verbatim). Retried once on a revision conflict, re-writing the
 * same staged list against the fresh revision.
 * @param api - the settings Remote face.
 * @param profiles - the staged profile list.
 * @param describe - how to obtain the namespaces join (injectable for tests).
 */
export async function writeProfiles(
  api: RemoteApi,
  profiles: readonly HeaderProfile[],
  describe: () => Promise<SettingsJoin> = () => describeNamespaces(api),
): Promise<WriteReply> {
  const cleaned = profiles.map(profile => ({
    id: profile.id.trim(),
    headers: profile.headers.filter(entry => entry.name.trim().length > 0 || entry.value.length > 0),
  }))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const join = await describe()
      if (join.customHeaders === undefined) return { ok: false, error: 'no-namespace' }
      const response = await api.settings.mutate(
        CUSTOM_HEADERS_NS,
        [{ op: 'set', path: ['profiles'], value: cleaned } as unknown as SettingsPathOpView],
        join.customHeaders.revision,
      )
      if (!response.ok) {
        if (attempt === 0 && response.error.code === 'settings/conflict') continue
        return { ok: false, error: response.error.message }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: false, error: 'conflict' }
}
