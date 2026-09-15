/**
 * DOM injector tests: model-row discovery through the official anchors,
 * idempotent reconciliation, route resolution (edit card, create card,
 * display-name-only cards), staged rows, and unmounting on page teardown.
 */

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createScanState, reconcile, routeOfCard, type HostLabels, type SelectMountProps } from '../src/client/injector.js'
import type { SettingsJoin } from '../src/client/types.js'
import { CUSTOM_HEADERS_NS, HEADERS_PROFILE_FIELD, PI_AI_NS } from '../src/constants.js'

const LABELS: HostLabels = {
  capacity: ['Capacities'],
  modelId: ['Model ID'],
  routeId: ['Provider ID'],
}

const t = (key: string): string => key

/**
 * One edit card with model rows, mimicking the official Models page DOM.
 * Rows are rendered EXPANDED by default (the official page mounts the
 * `.modelAdvanced` disclosure only while expanded); pass a `{id, collapsed}`
 * entry to render a folded row with no disclosure container.
 */
function editCardHtml(route: string, displayName: string, modelIds: Array<string | { id: string; collapsed: true }>): string {
  const rows = modelIds.map((entry, index) => {
    const id = typeof entry === 'string' ? entry : entry.id
    const collapsed = typeof entry !== 'string' && entry.collapsed === true
    return `
    <div class="xmodelEntry">
      <div class="xmodelRow">
        <input aria-label="Model ID ${index + 1}" value="${id}" />
        <input aria-label="Display name ${index + 1}" value="" />
        <button aria-label="Capacities ${index + 1}"></button>
      </div>
      ${collapsed ? '' : '<div class="xmodelAdvanced"><label class="xmodelField"><span>Context window</span><input aria-label="Context window 1" /></label></div>'}
    </div>`
  }).join('')
  return `
    <div class="xeditor">
      <span class="xeditorTitle">${displayName}</span>
      <span class="xeditorRoute">${route}</span>
      ${rows}
    </div>`
}

/** A create card (Provider ID typed, nothing saved yet), rows expanded. */
function createCardHtml(routeId: string, modelIds: string[]): string {
  const rows = modelIds.map((id, index) => `
    <div class="xmodelEntry">
      <div class="xmodelRow">
        <input aria-label="Model ID ${index + 1}" value="${id}" />
        <button aria-label="Capacities ${index + 1}"></button>
      </div>
      <div class="xmodelAdvanced"></div>
    </div>`).join('')
  return `
    <div class="xaddCard">
      <input aria-label="Provider ID" value="${routeId}" />
      ${rows}
    </div>`
}

interface MountRecord {
  props: SelectMountProps
  renders: SelectMountProps[]
  unmounted: boolean
}

function makeDeps(join: SettingsJoin) {
  const mounted = new Map<HTMLElement, MountRecord>()
  const deps = {
    describeNamespace: vi.fn(async () => join),
    t,
    labels: () => LABELS,
    mount(rowLine: HTMLElement, props: SelectMountProps) {
      const record: MountRecord = { props, renders: [props], unmounted: false }
      mounted.set(rowLine, record)
      return {
        unmount: () => { record.unmounted = true; mounted.delete(rowLine) },
        render: (next: SelectMountProps) => { record.props = next; record.renders.push(next) },
      }
    },
  }
  return { deps, mounted }
}

function makeJoin(options?: {
  providers?: unknown
  profiles?: unknown
  writable?: boolean
}): SettingsJoin {
  return {
    piAi: { ns: PI_AI_NS, value: { providers: options?.providers ?? {} }, revision: 1 } as never,
    customHeaders: { ns: CUSTOM_HEADERS_NS, value: { profiles: options?.profiles ?? [] }, revision: 1 } as never,
    writable: options?.writable ?? true,
  }
}

/** Let the folded describe promise and its .then chain settle. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const PROVIDERS = {
  acme: {
    displayName: 'Acme',
    models: [{ id: 'm1', [HEADERS_PROFILE_FIELD]: 'gw' }, { id: 'm2' }],
  },
}
const PROFILES = [{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'acme' }] }]

describe('reconcile', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('mounts one picker per saved model row with its stored pick', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1', 'm2'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()

    expect(mounted.size).toBe(2)
    const [first, second] = [...mounted.values()]
    expect(first?.props.route).toBe('acme')
    expect(first?.props.modelId).toBe('m1')
    expect(first?.props.value).toBe('gw')
    expect(first?.props.profiles).toEqual([{ id: 'gw' }])
    expect(first?.props.staged).toBe(false)
    expect(second?.props.modelId).toBe('m2')
    expect(second?.props.value).toBeUndefined()
  })

  it('is idempotent: a second scan with the same document re-renders nothing', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(1)
    expect([...mounted.values()][0]?.renders).toHaveLength(1)
  })

  it('re-renders in place when the stored pick changes', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()

    deps.describeNamespace = vi.fn(async () => makeJoin({
      providers: { acme: { displayName: 'Acme', models: [{ id: 'm1' }] } },
      profiles: PROFILES,
    }))
    state.describePromise = undefined
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    const record = [...mounted.values()][0]
    expect(record?.renders).toHaveLength(2)
    expect(record?.props.value).toBeUndefined()
    expect(record?.unmounted).toBe(false)
  })

  it('unmounts pickers whose rows left the page', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(1)

    document.body.innerHTML = '<div class="xeditor"></div>'
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(0)
    expect(state.mounted.size).toBe(0)
  })

  it('marks create-card rows staged (disabled picker, no write target)', async () => {
    document.body.innerHTML = createCardHtml('newroute', ['draft-model'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    const record = [...mounted.values()][0]
    expect(record?.props.route).toBe('newroute')
    expect(record?.props.staged).toBe(true)
    expect(record?.props.value).toBeUndefined()
  })

  it('marks a typed-but-unsaved model row on a saved route staged', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1', 'm3'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    const byModel = new Map([...mounted.values()].map(record => [record.props.modelId, record.props]))
    expect(byModel.get('m1')?.staged).toBe(false)
    expect(byModel.get('m3')?.staged).toBe(true)
  })

  it('folds with the disclosure: a collapsed row carries no picker until expanded', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', [{ id: 'm1', collapsed: true }])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    // The row is on the page (its Capacities anchor matched) but collapsed:
    // no disclosure container, no picker.
    expect(mounted.size).toBe(0)

    // Expanding renders the disclosure; the next scan mounts the picker.
    const row = document.querySelector('.xmodelEntry')!
    row.insertAdjacentHTML('beforeend', '<div class="xmodelAdvanced"></div>')
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(1)
    expect([...mounted.values()][0]?.props.modelId).toBe('m1')
  })

  it('unmounts the picker when the row is collapsed again', async () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', ['m1'])
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    const state = createScanState()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(1)

    document.querySelector('.xmodelAdvanced')!.remove()
    reconcile(document.body, deps, state, 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(0)
    expect(state.mounted.size).toBe(0)
  })

  it('does nothing when no model row is on the page', async () => {
    document.body.innerHTML = '<div>chat content</div>'
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    reconcile(document.body, deps, createScanState(), 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(0)
    expect(deps.describeNamespace).not.toHaveBeenCalled()
  })

  it('follows the active language anchors', async () => {
    document.body.innerHTML = `
      <div class="xeditor">
        <span class="xeditorTitle">Acme</span>
        <span class="xeditorRoute">acme</span>
        <div class="xmodelEntry">
          <div class="xmodelRow">
            <input aria-label="模型 ID 1" value="m1" />
            <button aria-label="容量 1"></button>
          </div>
          <div class="xmodelAdvanced"></div>
        </div>
      </div>`
    const { deps, mounted } = makeDeps(makeJoin({ providers: PROVIDERS, profiles: PROFILES }))
    deps.labels = () => ({ capacity: ['容量', 'Capacities'], modelId: ['模型 ID', 'Model ID'], routeId: ['提供方 ID', 'Provider ID'] })
    reconcile(document.body, deps, createScanState(), 'dsh-custom-headers')
    await flush()
    expect(mounted.size).toBe(1)
    expect([...mounted.values()][0]?.props.modelId).toBe('m1')
  })
})

describe('routeOfCard', () => {
  it('prefers the exact editorRoute tag', () => {
    document.body.innerHTML = editCardHtml('acme', 'Acme', [])
    const card = document.querySelector<HTMLElement>('.xeditor')!
    expect(routeOfCard(card, PROVIDERS, LABELS)).toEqual({ route: 'acme', staged: false })
  })

  it('resolves a create card by its typed Provider ID only while unknown', () => {
    document.body.innerHTML = createCardHtml('fresh', [])
    const card = document.querySelector<HTMLElement>('.xaddCard')!
    expect(routeOfCard(card, PROVIDERS, LABELS)).toEqual({ route: 'fresh', staged: true })
    // A saved route id in the Provider ID input is not a create card.
    expect(routeOfCard(card, { ...PROVIDERS, fresh: { models: [] } }, LABELS)).toBeUndefined()
  })

  it('falls back to the display-name title and the bare route-key title', () => {
    document.body.innerHTML = '<div class="xrowCard"><span class="xrowName">Acme</span></div>'
    const card = document.querySelector<HTMLElement>('.xrowCard')!
    expect(routeOfCard(card, PROVIDERS, LABELS)).toEqual({ route: 'acme', staged: false })

    document.body.innerHTML = '<div class="xrowCard"><span class="xrowName">noname-route</span></div>'
    const card2 = document.querySelector<HTMLElement>('.xrowCard')!
    const providers = { 'noname-route': { models: [] } }
    expect(routeOfCard(card2, providers, LABELS)).toEqual({ route: 'noname-route', staged: false })
  })
})
