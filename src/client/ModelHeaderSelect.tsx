/**
 * The per-model header-profile picker mounted into the official Models
 * page's model rows (the provider card's "模型目录" / model catalog): a
 * compact select offering 默认/Default plus every custom-header profile id.
 * Choosing one writes the pick onto the model's pi-ai settings row; Default
 * removes it.
 *
 * @module dsh-custom-headers/client/ModelHeaderSelect
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChKey } from './locales.js'
import type { WriteReply } from './types.js'

/** Translate face the picker consumes. */
export type SelectTranslate = (key: ChKey, params?: Record<string, unknown>) => string

/** Props the injector hands to one mounted picker. */
export interface ModelHeaderSelectProps {
  /** The route being edited. */
  route: string
  /** The model id read from the row's own input. */
  modelId: string
  /** The model's stored header-profile pick, when one is set. */
  value?: string
  /** The profiles to offer (ids, canonical case). */
  profiles: readonly { id: string }[]
  /** True while the settings document refuses writes. */
  readOnly: boolean
  /**
   * True while the row is unsaved (a create card's draft route, or a new
   * model row on a saved route): there is no settings row to write yet, so
   * the picker mounts disabled with an explanatory tooltip.
   */
  staged?: boolean
  /** Row ordinal among the models found in this scan (for aria labels). */
  index: number
  t: SelectTranslate
  /** Write the pick (a profile id, or null for Default). */
  onPick(route: string, modelId: string, pick: string | null): Promise<WriteReply>
}

/** Render one model row's header-profile picker. */
export function ModelHeaderSelect(props: ModelHeaderSelectProps): ReactNode {
  const { t } = props
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const value = props.value ?? ''
  const missing = value.length > 0 && !props.profiles.some(profile => profile.id === value)
  const disabled = props.readOnly || props.staged === true || saving
  const title = props.staged === true
    ? t('modelPickerSaveFirst')
    : failed !== null
      ? `${t('modelPickerWriteFailed')}: ${failed}`
      : t('modelPicker')

  const onChange = async (next: string): Promise<void> => {
    setSaving(true)
    setFailed(null)
    try {
      const reply = await props.onPick(props.route, props.modelId, next === '' ? null : next)
      if (!reply.ok) {
        setFailed(reply.error)
        console.error(`[dsh-custom-headers] pick write failed for "${props.route}/${props.modelId}": ${reply.error}`)
      }
      // On success the document-updated invalidation re-scans and the next
      // props carry the stored pick; nothing optimistic to commit here.
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="ch-select" data-failed={failed !== null ? 'true' : undefined}>
      <span className="ch-field-label">{t('modelPicker')}</span>
      <select
        className="ch-select-input"
        aria-label={`${t('modelPicker')}: ${props.modelId}`}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(event) => { void onChange(event.target.value) }}
      >
        <option value="">{t('modelPickerDefault')}</option>
        {props.profiles.map(profile => (
          <option key={profile.id} value={profile.id}>{profile.id}</option>
        ))}
        {missing
          // The stored pick names a profile that no longer exists: keep it
          // visible (and correctable) instead of silently showing Default.
          ? <option value={value}>{value} (?)</option>
          : null}
      </select>
    </span>
  )
}
