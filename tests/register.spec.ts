// @vitest-environment jsdom
/**
 * Client apply() slot registrations across host generations: the
 * configuration card must land in `settings.plugin.item` on DSH 0.1.5 and in
 * `plugins.bundle.config` on DSH 0.1.7+, with each registration self-gated
 * by its slot's declaration.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.js'
import { HeadersCard } from '../src/client/HeadersCard.js'
import { CUSTOM_HEADERS_NS, PLUGIN_ID } from '../src/constants.js'
import type { ClientContext } from '../src/client/types.js'

interface Registration {
  options: Record<string, unknown>
  component: unknown
}

/**
 * A slots face with declaration-gated inject: inject() runs its registrar
 * immediately when the slot is declared, otherwise parks it until declare().
 */
function makeSlots(declared: string[], ledgerKeys: Record<string, string[]> = {}) {
  const declaredSet = new Set(declared)
  const registrations: Registration[] = []
  const pending: Array<{ name: string; registrar: () => unknown }> = []
  const slots = {
    registrations,
    inject(name: string, registrar: () => unknown) {
      if (declaredSet.has(name)) {
        void registrar()
        return () => {}
      }
      const entry = { name, registrar }
      pending.push(entry)
      return () => {
        const at = pending.indexOf(entry)
        if (at >= 0) pending.splice(at, 1)
      }
    },
    register(options: Record<string, unknown>, component: unknown) {
      registrations.push({ options, component })
      return () => {}
    },
    entries(name: string) {
      return (ledgerKeys[name] ?? []).map(key => ({ options: { key } }))
    },
    subscribe(_name: string, _listener: () => void) {
      return () => {}
    },
    /** Test seam: declare a slot after apply, flushing its pending injects. */
    declare(name: string) {
      declaredSet.add(name)
      for (const entry of pending.filter(candidate => candidate.name === name)) {
        pending.splice(pending.indexOf(entry), 1)
        void entry.registrar()
      }
    },
    pendingCount() {
      return pending.length
    },
  }
  return slots
}

function makeClientContext(slots: ReturnType<typeof makeSlots>) {
  const disposers: Array<() => void> = []
  const ctx = {
    locale: {
      register: () => ({}),
      bind: () => (key: string) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    remote: {
      $on: () => () => {},
      settings: {
        describe: async () => ({ ok: true as const, value: { namespaces: [], writable: true } }),
        mutate: async () => ({ ok: false as const, error: { code: 'unused', message: 'unused' } }),
      },
    },
    slots,
    on: () => () => {},
    effect(fn: () => unknown, _name?: string) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  }
  apply(ctx as unknown as ClientContext)
  return { ctx: ctx as unknown as ClientContext, disposers }
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanups) dispose()
  cleanups = []
})

describe('configuration card registration', () => {
  it('registers into settings.plugin.item on a 0.1.5 host', () => {
    const slots = makeSlots(['settings.plugin.item'], {
      // The shipped web-search card is on the ledger, so no deferral timer.
      'settings.plugin.item': ['web-search-deepseek'],
    })
    const { disposers } = makeClientContext(slots)
    cleanups = disposers

    const legacy = slots.registrations.filter(entry => entry.options['name'] === 'settings.plugin.item')
    expect(legacy).toHaveLength(1)
    expect(legacy[0]?.options['key']).toBe(CUSTOM_HEADERS_NS)
    expect(legacy[0]?.component).toBe(HeadersCard)
    // The modern slot is undeclared: its registration never ran.
    expect(slots.registrations.some(entry => entry.options['name'] === 'plugins.bundle.config')).toBe(false)
  })

  it('registers into plugins.bundle.config keyed by package name on a 0.1.7 host', () => {
    const slots = makeSlots(['plugins.bundle.config'])
    const { disposers } = makeClientContext(slots)
    cleanups = disposers

    const modern = slots.registrations.filter(entry => entry.options['name'] === 'plugins.bundle.config')
    expect(modern).toHaveLength(1)
    expect(modern[0]?.options['key']).toBe(PLUGIN_ID)
    expect(modern[0]?.options['id']).toBe(`${PLUGIN_ID}-card`)
    expect(modern[0]?.options['locale']).toBe(PLUGIN_ID)
    expect(modern[0]?.component).toBe(HeadersCard)
    expect(slots.registrations.some(entry => entry.options['name'] === 'settings.plugin.item')).toBe(false)
  })

  it('registers into both when a host declares both slots', () => {
    const slots = makeSlots(['settings.plugin.item', 'plugins.bundle.config'], {
      'settings.plugin.item': ['web-search-deepseek'],
    })
    const { disposers } = makeClientContext(slots)
    cleanups = disposers

    expect(slots.registrations.map(entry => entry.options['name']).sort()).toEqual([
      'plugins.bundle.config',
      'settings.plugin.item',
    ])
  })

  it('flushes a pending registration when its slot is declared after apply', () => {
    const slots = makeSlots([])
    const { disposers } = makeClientContext(slots)
    cleanups = disposers
    expect(slots.registrations).toHaveLength(0)
    expect(slots.pendingCount()).toBe(2)

    slots.declare('plugins.bundle.config')
    expect(slots.registrations.map(entry => entry.options['name'])).toEqual(['plugins.bundle.config'])
    // The legacy registration is still parked, waiting on its own slot.
    expect(slots.pendingCount()).toBe(1)
  })
})
