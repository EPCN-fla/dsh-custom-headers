/**
 * ModelHeaderSelect render-level tests: option list (Default + profile ids),
 * pick writes, the missing-profile display, and the disabled states
 * (read-only document, unsaved/staged row).
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelHeaderSelect, type ModelHeaderSelectProps } from '../src/client/ModelHeaderSelect.js'
import { en, zh } from '../src/client/locales.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

function translate(dict: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string => {
    let text = dict[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${String(name)}}`, String(value))
    }
    return text
  }
}

let root: Root | undefined
let container: HTMLElement | undefined

function baseProps(overrides?: Partial<ModelHeaderSelectProps>): ModelHeaderSelectProps {
  return {
    route: 'acme',
    modelId: 'm1',
    profiles: [{ id: 'gw' }, { id: 'relay' }],
    readOnly: false,
    index: 0,
    t: translate(en),
    onPick: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  }
}

async function renderSelect(props: ModelHeaderSelectProps): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(ModelHeaderSelect, props))
  })
}

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  root = undefined
  container?.remove()
  container = undefined
})

function select(): HTMLSelectElement {
  const found = container!.querySelector('select')
  if (found === null) throw new Error('select not found')
  return found
}

function choose(value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select(), value)
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ModelHeaderSelect', () => {
  it('offers Default plus every profile id', async () => {
    await renderSelect(baseProps())
    const labels = Array.from(select().options).map(option => option.textContent)
    expect(labels).toEqual([translate(en)('modelPickerDefault'), 'gw', 'relay'])
    expect(select().value).toBe('')
  })

  it('shows the stored pick and writes a new one', async () => {
    const props = baseProps({ value: 'gw' })
    await renderSelect(props)
    expect(select().value).toBe('gw')
    choose('relay')
    await act(async () => {})
    expect(props.onPick).toHaveBeenCalledWith('acme', 'm1', 'relay')
  })

  it('writes null for Default', async () => {
    const props = baseProps({ value: 'gw' })
    await renderSelect(props)
    choose('')
    await act(async () => {})
    expect(props.onPick).toHaveBeenCalledWith('acme', 'm1', null)
  })

  it('keeps a vanished profile visible and correctable', async () => {
    await renderSelect(baseProps({ value: 'deleted-profile' }))
    const labels = Array.from(select().options).map(option => option.textContent)
    expect(labels).toContain('deleted-profile (?)')
    expect(select().value).toBe('deleted-profile')
  })

  it('is disabled with an explanatory tooltip on a staged row', async () => {
    await renderSelect(baseProps({ staged: true }))
    expect(select().disabled).toBe(true)
    expect(select().title).toBe(translate(en)('modelPickerSaveFirst'))
  })

  it('is disabled on a read-only document', async () => {
    await renderSelect(baseProps({ readOnly: true }))
    expect(select().disabled).toBe(true)
  })

  it('marks the failure state when the write is refused', async () => {
    const props = baseProps({ onPick: vi.fn(async () => ({ ok: false as const, error: 'denied' })) })
    await renderSelect(props)
    choose('gw')
    await act(async () => {})
    expect(container!.querySelector('.ch-select')!.getAttribute('data-failed')).toBe('true')
    expect(select().title).toContain('denied')
  })

  it('renders Chinese copy under a zh dictionary', async () => {
    await renderSelect(baseProps({ t: translate(zh as unknown as Record<string, string>) }))
    expect(Array.from(select().options)[0]?.textContent).toBe('默认')
    expect(select().getAttribute('aria-label')).toBe('请求头: m1')
  })
})
