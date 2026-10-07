/**
 * HeadersCard render-level tests over a real React root in jsdom: collapse /
 * expand, profile and header-row editing with the + / − buttons, draft
 * staging, validation gating (case-insensitive duplicate ids), save and
 * discard against a fake settings Remote.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HeadersCard, type HeadersCardProps } from '../src/client/HeadersCard.js'
import { en } from '../src/client/locales.js'
import { CUSTOM_HEADERS_NS } from '../src/constants.js'
import type { HeaderProfile } from '../src/headers.js'
import type { RemoteApi } from '../src/client/types.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

/** The shell's Translate face, approximated with the en dictionary. */
const t = (key: string, params?: Record<string, unknown>): string => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${String(name)}}`, String(value))
  }
  return text
}

/** A fake settings Remote holding one custom-headers section. */
function fakeApi(initial: HeaderProfile[], options?: { writable?: boolean }) {
  let value: unknown = { profiles: initial }
  let revision = 1
  const mutate = vi.fn(async (_ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>) => {
    for (const op of ops) {
      if (op.op === 'set' && op.path[0] === 'profiles') value = { profiles: op.value }
    }
    revision += 1
    return { ok: true as const, value: { ns: CUSTOM_HEADERS_NS, value, revision } }
  })
  const api: RemoteApi = {
    settings: {
      describe: vi.fn(async () => ({
        ok: true as const,
        value: {
          namespaces: [{ ns: CUSTOM_HEADERS_NS, value, revision }],
          writable: options?.writable ?? true,
        } as never,
      })),
      mutate: mutate as never,
    },
  }
  return { api, mutate, read: () => value }
}

let root: Root | undefined
let container: HTMLElement | undefined

async function renderCard(props: HeadersCardProps): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(HeadersCard, props))
  })
}

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  root = undefined
  container?.remove()
  container = undefined
  document.body.innerHTML = ''
})

function expand(): void {
  const header = container!.querySelector<HTMLButtonElement>('.ch-card-header')!
  act(() => { header.click() })
}

/** Expand one profile's nested disclosure by its displayed ID. */
function expandProfile(id: string): void {
  const toggle = Array.from(container!.querySelectorAll<HTMLButtonElement>('.ch-profile-toggle'))
    .find(candidate => candidate.textContent?.includes(id))
  if (toggle === undefined) throw new Error(`profile toggle "${id}" not found`)
  act(() => { toggle.click() })
}

function input(label: string): HTMLInputElement {
  const found = Array.from(container!.querySelectorAll<HTMLInputElement>('input[aria-label]'))
    .find(candidate => candidate.getAttribute('aria-label') === label)
  if (found === undefined) throw new Error(`input "${label}" not found`)
  return found
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
    .find(candidate => candidate.getAttribute('aria-label') === label)
  if (found === undefined) throw new Error(`button "${label}" not found`)
  return found
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll('button'))
    .find(candidate => candidate.textContent === text || candidate.textContent?.endsWith(text))
  if (found === undefined) throw new Error(`button "${text}" not found`)
  return found
}

/** jsdom does not implement the native setter cascade React relies on. */
function type(field: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const baseSubscribe = (): (() => void) => () => {}

describe('HeadersCard', () => {
  it('starts collapsed and expands on click, listing profiles by ID only', async () => {
    const { api } = fakeApi([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'acme' }] }])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expect(container!.textContent).toContain(t('cardTitle'))
    expect(container!.querySelector('.ch-card-body')).toBeNull()

    expand()
    expect(container!.querySelector('.ch-card-body')).not.toBeNull()
    // A loaded profile starts collapsed: only its ID shows, no inputs.
    expect(container!.querySelector('.ch-profile-title')!.textContent).toBe('gw')
    expect(container!.querySelector('input[aria-label="ID 1"]')).toBeNull()

    // Expanding the profile reveals the id field and its header rows.
    expandProfile('gw')
    expect(input('ID 1').value).toBe('gw')
    expect(input('Header name 1-1').value).toBe('X-Tenant')
    expect(input('Value 1-1').value).toBe('acme')

    // Collapsing folds the rows back to the bare ID.
    expandProfile('gw')
    expect(container!.querySelector('input[aria-label="ID 1"]')).toBeNull()
    expect(container!.querySelector('.ch-profile-title')!.textContent).toBe('gw')
  })

  it('adds a profile and header rows with +, removes them with −', async () => {
    const { api } = fakeApi([])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    expect(container!.textContent).toContain(t('emptyProfiles'))

    act(() => { buttonByText(t('addProfile')).click() })
    // A fresh profile starts with one blank row and is invalid (empty id).
    expect(input('ID 1').value).toBe('')
    expect(container!.textContent).toContain(t('issueIdEmpty'))
    expect(buttonByText(t('save')).disabled).toBe(true)

    type(input('ID 1'), 'gateway')
    type(input('Header name 1-1'), 'X-Tenant')
    type(input('Value 1-1'), 'acme')
    act(() => { button('Add header 1').click() })
    expect(input('Header name 1-2').value).toBe('')
    act(() => { button('Remove header 1-2').click() })
    expect(container!.querySelector('input[aria-label="Header name 1-2"]')).toBeNull()

    // Remove the whole profile again.
    act(() => { button('Delete profile 1').click() })
    expect(container!.textContent).toContain(t('emptyProfiles'))
  })

  it('flags an unrepresentable value on the value input and blocks the save', async () => {
    const { api, mutate } = fakeApi([{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'acme' }] }])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    expandProfile('gw')
    // A non-latin1 character survives text-input sanitization (a newline
    // would not) and Fetch refuses it as a header value.
    type(input('Value 1-1'), 'Bearer €')
    expect(container!.textContent).toContain(t('issueValueInvalid'))
    // The value input is marked invalid; the name input is not.
    expect(input('Value 1-1').className).toContain('ch-input-invalid')
    expect(input('Header name 1-1').className).not.toContain('ch-input-invalid')
    expect(buttonByText(t('save')).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('blocks saving duplicate ids case-insensitively', async () => {
    const { api, mutate } = fakeApi([])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    act(() => { buttonByText(t('addProfile')).click() })
    act(() => { buttonByText(t('addProfile')).click() })
    type(input('ID 1'), 'Gateway')
    type(input('ID 2'), 'gateway')
    expect(container!.textContent).toContain(t('issueIdDuplicate'))
    expect(buttonByText(t('save')).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('saves the staged draft in one mutation and returns to pristine', async () => {
    const { api, mutate, read } = fakeApi([])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    act(() => { buttonByText(t('addProfile')).click() })
    type(input('ID 1'), 'gw')
    type(input('Header name 1-1'), 'X-Tenant')
    type(input('Value 1-1'), 'acme')

    const save = buttonByText(t('save'))
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(read()).toEqual({ profiles: [{ id: 'gw', headers: [{ name: 'X-Tenant', value: 'acme' }] }] })
    // Back to pristine: no unsaved tag, save disabled.
    expect(container!.textContent).not.toContain(t('unsaved'))
    expect(buttonByText(t('save')).disabled).toBe(true)
  })

  it('discards the staged draft', async () => {
    const { api } = fakeApi([{ id: 'gw', headers: [] }])
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    expandProfile('gw')
    type(input('ID 1'), 'renamed')
    expect(container!.textContent).toContain(t('unsaved'))
    act(() => { buttonByText(t('discard')).click() })
    // Discard returns to the loaded baseline and folds the profile back.
    expect(container!.textContent).not.toContain(t('unsaved'))
    expect(container!.querySelector('.ch-profile-title')!.textContent).toBe('gw')
    expandProfile('gw')
    expect(input('ID 1').value).toBe('gw')
  })

  it('surfaces a refused save and keeps the draft', async () => {
    const { api, mutate } = fakeApi([])
    mutate.mockResolvedValue({ ok: false, error: { code: 'settings/rejected', message: 'nope' } } as never)
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    act(() => { buttonByText(t('addProfile')).click() })
    type(input('ID 1'), 'gw')
    await act(async () => { buttonByText(t('save')).click() })
    expect(container!.textContent).toContain(t('saveFailed'))
    expect(container!.textContent).toContain(t('unsaved'))
  })

  it('renders read-only when the document refuses writes', async () => {
    const { api } = fakeApi([{ id: 'gw', headers: [] }], { writable: false })
    await renderCard({ t, api, subscribe: baseSubscribe })
    expand()
    expect(container!.textContent).toContain(t('readOnly'))
    expandProfile('gw')
    expect(input('ID 1').disabled).toBe(true)
    expect(button('Delete profile 1').disabled).toBe(true)
  })
})
