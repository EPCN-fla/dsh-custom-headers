/**
 * Browser half of dsh-custom-headers on DSH 0.2.2-rc.2 / rc.3.
 *
 * Contributions, all of which dispose with the plugin fiber:
 *   1. The "自定义请求头" / "Custom headers" configuration card in the
 *      keyed `plugins.bundle.config` slot under the package name, rendered
 *      on this package's Plugins-page detail view.
 *   2. The DOM bypass injector: a MutationObserver over the whole document
 *      keeps the official Models page's model rows (the provider card's
 *      model catalog) equipped with the header-profile picker.
 *   3. The stylesheet and copy dictionaries.
 *
 * @module dsh-custom-headers/client
 */

import type { ClientContext, RemoteApi, SlotRegistrarFace } from './types.js'
import { CUSTOM_HEADERS_NS, PI_AI_NS, PLUGIN_ID, STORE_NS } from '../constants.js'
import { Component, createElement } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HeadersCard } from './HeadersCard.tsx'
import { LocaleRefresh, type LocaleFace } from './LocaleRefresh.tsx'
import { ModelHeaderSelect } from './ModelHeaderSelect.tsx'
import { createScanState, invalidateScanState, reconcile, type HostLabels, type SelectMountProps } from './injector.ts'
import { en, zh, type ChKey } from './locales.ts'
import { describeNamespaces, writeProfilePick } from './ops.ts'
import { STYLES } from './styles.ts'

/** Stable plugin id (cordis plugin name, bundle id, client module id). The cordis row id is `custom-headers`. */
export const name = PLUGIN_ID

/** Cordis fiber dependencies of the browser half. */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

/** Dictionary namespace owning the Models page's copy (ui-settings-models). */
const HOST_MODELS_NS = 'settings.models'

/**
 * The official Models-page controls this plugin anchors to, as (dictionary
 * key, ...English copy) tuples. The English copies are the anchors for a host
 * that ships no such namespace and the host's own fallback language. Resolve
 * through the host dictionary so another language relabels both together.
 */
const HOST_LABEL_KEYS = {
  capacity: ['modelAdvanced', 'Model options'],
  modelId: ['modelId', 'Model ID'],
  routeId: ['customRoute', 'Provider ID'],
} as const satisfies Record<keyof HostLabels, readonly [string, ...string[]]>

/** Render-failure boundary: surfaces the cause instead of an empty root. */
class ChBoundary extends Component<{ children?: ReactNode; fallback: string }, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[dsh-custom-headers] render failed:', error, info.componentStack)
  }
  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement(
        'div',
        { style: { color: '#ff8a8a', fontSize: '11px', whiteSpace: 'pre-wrap', padding: '6px' } },
        `${this.props.fallback}: ${this.state.error}`,
      )
    }
    return this.props.children
  }
}

/**
 * The root this plugin scans. The official models page can live anywhere in
 * the settings surface (a panel, a dialog, a portal), so guessing a
 * container is fragile — and the injector is idempotent and cheap, so
 * scanning the whole document is both safe and correct.
 */
function panelRoot(): HTMLElement {
  return document.body
}

/**
 * Apply the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(STORE_NS, { zh, en }), 'dsh-custom-headers: dictionaries')

  const style = document.createElement('style')
  style.dataset['pluginStyles'] = PLUGIN_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  ctx.effect(() => () => style.remove(), 'dsh-custom-headers: stylesheet')

  const settingsApi: RemoteApi = { settings: ctx.remote.settings }
  const t = ctx.locale.bind(STORE_NS)

  // The locale service is also its own LocaleFace (getSnapshot/subscribe);
  // the slot-rendered card gets a re-derived `t` from the framework on a
  // language switch, while the createRoot-mounted picker needs the seat.
  const localeFace = (): LocaleFace | undefined => {
    const locale = ctx.locale
    return typeof locale.subscribe === 'function' && typeof locale.getSnapshot === 'function'
      ? locale as LocaleFace
      : undefined
  }

  /** Wrap a subtree so it re-translates on a language switch. */
  const refreshed = (children: () => ReactNode): ReactNode => {
    const face = localeFace()
    return face === undefined ? children() : createElement(LocaleRefresh, { locale: face, children })
  }

  /**
   * The official controls' aria-labels in the host's ACTIVE language — a
   * thunk, never a cached value: the host renders those labels from its own
   * dictionary, so re-reading per scan is what keeps a language switch (or a
   * late language pack) from stranding the anchors on words the page no
   * longer prints.
   */
  const hostLabels = (): HostLabels => {
    const translate = ctx.locale.bind(HOST_MODELS_NS) as (key: string) => string
    const resolve = ([key, ...fallbacks]: readonly [string, ...string[]]): readonly string[] => {
      const value = translate(key)
      // A host with no such namespace makes translate() echo the key back.
      return Array.from(new Set(value === key || value.trim() === '' ? fallbacks : [value, ...fallbacks]))
    }
    return {
      capacity: resolve(HOST_LABEL_KEYS.capacity),
      modelId: resolve(HOST_LABEL_KEYS.modelId),
      routeId: resolve(HOST_LABEL_KEYS.routeId),
    }
  }

  // ---- Plugin-configuration card ----
  // External invalidations (another surface's save, a reconnect) reach the
  // card through this subscription so a stale baseline never fences its save.
  const cardListeners = new Set<() => void>()
  /**
   * The injected face the card registration hands to the slot renderer: the
   * settings Remote plus the external-invalidation subscription.
   */
  const cardInject = (): Record<string, unknown> => ({
    api: settingsApi,
    subscribe: (listener: () => void) => {
      cardListeners.add(listener)
      return () => { cardListeners.delete(listener) }
    },
  })

  // A bundle's own configuration renders on its Plugins-page detail view.
  // slots.inject waits until the page declares the keyed slot.
  ctx.effect(() => {
    const slots = (ctx as unknown as { slots?: SlotRegistrarFace }).slots
    if (slots === undefined || typeof slots.inject !== 'function') return
    return slots.inject('plugins.bundle.config', () =>
      slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_ID,
        id: `${PLUGIN_ID}-card`,
        locale: STORE_NS,
        inject: cardInject,
      }, HeadersCard))
  }, 'dsh-custom-headers: bundle configuration card')

  // ---- DOM bypass injection (Models page per-model picker) ----
  /** Debounce window for DOM-mutation scans (one scan per render burst). */
  const SCAN_DEBOUNCE_MS = 120
  const scanState = createScanState()
  let scanTimer: number | undefined
  let observer: MutationObserver | undefined

  const scheduleScan = (): void => {
    if (scanTimer !== undefined) return
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined
      reconcile(panelRoot(), {
        describeNamespace: () => describeNamespaces(settingsApi),
        t: t as (key: string, params?: Record<string, unknown>) => string,
        labels: hostLabels,
        mount(container, props: SelectMountProps) {
          const wrapper = document.createElement('div')
          // The grid-column span: this wrapper — not the React picker inside
          // it — is the item the official disclosure grid places, and the
          // span puts the picker on the row below 上下文窗口 / 最大输出.
          wrapper.className = 'ch-field'
          // Mark the container synchronously — before React renders — so the
          // idempotency guard (hasPicker) holds from the very first scan;
          // without it, the appendChild-triggered observer scan can run
          // before React's async render produced the picker and mount twice.
          wrapper.dataset['plugin'] = PLUGIN_ID
          container.appendChild(wrapper)
          const reactRoot = createRoot(wrapper)
          const renderSelect = (p: SelectMountProps): void => {
            reactRoot.render(createElement(
              ChBoundary,
              {
                fallback: 'custom-headers',
                children: refreshed(() => createElement(ModelHeaderSelect, {
                  ...p,
                  onPick: (route, modelId, pick) => writeProfilePick(settingsApi, route, modelId, pick),
                })),
              },
            ))
          }
          renderSelect(props)
          return {
            unmount: () => { reactRoot.unmount(); wrapper.remove() },
            render: renderSelect,
          }
        },
      }, scanState, PLUGIN_ID)
    }, SCAN_DEBOUNCE_MS)
  }

  ctx.effect(() => {
    observer = new MutationObserver(() => { scheduleScan() })
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('input', scheduleScan, true)
    document.addEventListener('change', scheduleScan, true)
    scheduleScan()
    return () => {
      if (scanTimer !== undefined) {
        window.clearTimeout(scanTimer)
        scanTimer = undefined
      }
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('input', scheduleScan, true)
      document.removeEventListener('change', scheduleScan, true)
      invalidateScanState(scanState)
      // Orphaned pickers must not outlive the fiber: on plugin disable or
      // HMR they would keep rendering with a stale api face, failing every
      // write visibly. Unmount every React root this plugin created.
      for (const [, entry] of scanState.mounted) entry.editor.unmount()
      scanState.mounted.clear()
    }
  }, 'dsh-custom-headers: DOM injector')

  // Refresh the injection when the settings document changes (an apply from
  // either the official page or this plugin re-renders the rows; a profile
  // edit changes the pickers' options). The folded describe snapshot is
  // invalidated first so no scan reads a revision the change left behind.
  ctx.effect(() => {
    const refresh = (): void => {
      invalidateScanState(scanState)
      scheduleScan()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns: unknown) => {
        if (ns === PI_AI_NS || ns === CUSTOM_HEADERS_NS) refresh()
        if (ns === CUSTOM_HEADERS_NS) for (const listener of cardListeners) listener()
      }),
      ctx.on('connection/reset', () => {
        refresh()
        for (const listener of cardListeners) listener()
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-custom-headers: pushed invalidations')
}

export type { ChKey }
export { HeadersCard } from './HeadersCard.tsx'
export { ModelHeaderSelect } from './ModelHeaderSelect.tsx'
export type { ModelHeaderSelectProps } from './ModelHeaderSelect.tsx'
export { createScanState, invalidateScanState, reconcile, routeOfCard } from './injector.ts'
export type { HostLabels, InjectorDeps, MountedSelect, ScanState, SelectMountProps } from './injector.ts'
export * from './ops.ts'
export * from './types.ts'
