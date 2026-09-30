/**
 * Browser half of dsh-custom-headers.
 *
 * Contributions, all of which dispose with the plugin fiber:
 *   1. The "自定义请求头" / "Custom headers" card inside the official
 *      Settings → Plugins → Plugin configuration tab, registered into the
 *      sanctioned `settings.plugin.item` slot keyed by the namespace it
 *      edits (`custom-headers`). Keyed entries render in ledger
 *      (registration) order and this plugin's browser half can apply BEFORE
 *      the shipped cards register, so the registration defers until the
 *      shipped web-search card is on the ledger — landing the card right
 *      below 网页搜索, at the bottom of the list.
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
import { createScanState, reconcile, type HostLabels, type SelectMountProps } from './injector.ts'
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
 * The settings-namespace key of the shipped 网页搜索 / web-search card — the
 * last shipped card on the Plugin configuration tab. This card defers its
 * registration until that key is on the ledger (see below).
 */
const WEB_SEARCH_CARD_KEY = 'web-search-deepseek'

/**
 * How long the card registration waits for the shipped cards before
 * registering anyway (a deployment without the web-search card still gets
 * this one, simply at whatever position the ledger is at then).
 */
const CARD_DEFER_TIMEOUT_MS = 10_000

/**
 * The official Models-page controls this plugin anchors to, as (dictionary
 * key, English copy) pairs — the English copy is both the anchor for a host
 * that ships no such namespace and the language the host itself falls back
 * to. Resolved through the host's own dictionary so a third language (or a
 * late language pack) relabels the page and the anchors together.
 */
const HOST_LABEL_KEYS = {
  capacity: ['modelAdvanced', 'Capacities'],
  modelId: ['modelId', 'Model ID'],
  routeId: ['customRoute', 'Provider ID'],
} as const satisfies Record<keyof HostLabels, readonly [string, string]>

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
    const resolve = ([key, fallback]: readonly [string, string]): readonly string[] => {
      const value = translate(key)
      // A host with no such namespace makes translate() echo the key back.
      return value === key || value.trim() === '' ? [fallback] : [value, fallback]
    }
    return {
      capacity: resolve(HOST_LABEL_KEYS.capacity),
      modelId: resolve(HOST_LABEL_KEYS.modelId),
      routeId: resolve(HOST_LABEL_KEYS.routeId),
    }
  }

  // ---- Plugin-configuration card ('设置 → 插件 → 插件配置') ----
  // The sanctioned `settings.plugin.item` slot is keyed by settings
  // namespace; the host half registers `custom-headers`, this card claims
  // it, and the official tab pairs the two. External invalidations of the
  // namespace (another surface's save, a reconnect) reach the card through
  // the subscribe face so a stale baseline never fences its next save.
  const cardListeners = new Set<() => void>()
  ctx.effect(() => {
    const slots = (ctx as unknown as { slots?: SlotRegistrarFace }).slots
    if (slots === undefined || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return
    let disposeCard: (() => void) | undefined
    let disposeWatch: (() => void) | undefined
    let deferTimer: number | undefined
    const clearDeferral = (): void => {
      disposeWatch?.()
      disposeWatch = undefined
      if (deferTimer !== undefined) {
        window.clearTimeout(deferTimer)
        deferTimer = undefined
      }
    }
    const registerCard = (): void => {
      clearDeferral()
      if (disposeCard !== undefined) return
      disposeCard = slots.register({
        name: 'settings.plugin.item',
        key: CUSTOM_HEADERS_NS,
        id: `${PLUGIN_ID}-card`,
        locale: STORE_NS,
        inject: () => ({
          api: settingsApi,
          subscribe: (listener: () => void) => {
            cardListeners.add(listener)
            return () => { cardListeners.delete(listener) }
          },
        }),
      }, HeadersCard)
    }
    /**
     * Register only once the shipped cards are on the ledger: keyed entries
     * render in ledger order, so registering while 网页搜索 (web-search) is
     * present lands this card right below it. A deployment whose composition
     * lacks that card still gets ours once the defer window elapses.
     */
    const attemptRegistration = (): boolean => {
      const keys = slots.entries('settings.plugin.item').map(entry => entry.options?.key)
      if (keys.includes(WEB_SEARCH_CARD_KEY)) {
        registerCard()
        return true
      }
      return false
    }
    slots.inject('settings.plugin.item', () => {
      // The slot owner remounted (redeclaration): the framework re-runs this
      // registrar against a fresh ledger. Re-defer so the card re-lands below
      // the shipped cards instead of keeping an earlier position.
      disposeCard?.()
      disposeCard = undefined
      clearDeferral()
      if (attemptRegistration()) return
      disposeWatch = slots.subscribe('settings.plugin.item', () => { void attemptRegistration() })
      deferTimer = window.setTimeout(registerCard, CARD_DEFER_TIMEOUT_MS)
    })
    return () => {
      clearDeferral()
      disposeCard?.()
      disposeCard = undefined
    }
  }, 'dsh-custom-headers: plugin-configuration card')

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
            unmount: () => { reactRoot.unmount() },
            render: renderSelect,
          }
        },
      }, scanState, PLUGIN_ID)
    }, SCAN_DEBOUNCE_MS)
  }

  ctx.effect(() => {
    observer = new MutationObserver(() => { scheduleScan() })
    observer.observe(document.body, { childList: true, subtree: true })
    scheduleScan()
    return () => {
      if (scanTimer !== undefined) {
        window.clearTimeout(scanTimer)
        scanTimer = undefined
      }
      observer?.disconnect()
      observer = undefined
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
      scanState.describePromise = undefined
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
export { createScanState, reconcile, routeOfCard } from './injector.ts'
export type { HostLabels, InjectorDeps, MountedSelect, ScanState, SelectMountProps } from './injector.ts'
export * from './ops.ts'
export * from './types.ts'
