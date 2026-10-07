/**
 * The `custom-headers` card inside the official "Plugin configuration"
 * (插件配置) tab: one collapsible card, registered into the
 * `settings.plugin.item` slot keyed by the namespace it edits. The chrome is
 * a 1:1 port of the official PluginCard (header, disclosure, save/discard
 * footer). Inside the card, each profile is its own disclosure: collapsed it
 * shows just the ID; expanding reveals the id field and the header
 * name/value rows with their + / − buttons. The whole list saves in one
 * settings mutation.
 *
 * @module dsh-custom-headers/client/HeadersCard
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { validateProfiles, type HeaderProfile, type ProfileIssue } from '../headers.js'
import { describeNamespaces, profilesOf, writeProfiles } from './ops.js'
import type { ChKey } from './locales.js'
import type { RemoteApi } from './types.js'

/** Translate face the card consumes (namespace-bound by the slot renderer). */
export type CardTranslate = (key: ChKey, params?: Record<string, unknown>) => string

/** Props the slot registration binds: the locale seat plus the injected face. */
export interface HeadersCardProps {
  t: CardTranslate
  /** The settings Remote face (injected by the slot entry). */
  api: RemoteApi
  /**
   * Subscribe to external invalidations of the custom-headers namespace
   * (another surface's save, a reconnect). Returns the disposer.
   */
  subscribe(listener: () => void): () => void
}

/** The official ic_ds_chevron_down_outline_14 icon (verbatim path). */
function ChevronIcon(props: { open: boolean }): ReactNode {
  return (
    <span className={`ch-chevron${props.open ? ' ch-chevron-open' : ''}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
          fill="currentColor"
        />
      </svg>
    </span>
  )
}

/** Semantic equality of two staged/loaded profile lists. */
function sameProfiles(a: readonly HeaderProfile[], b: readonly HeaderProfile[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Group validation findings by profile index for per-field rendering. */
function issuesByProfile(issues: readonly ProfileIssue[]): Map<number, ProfileIssue[]> {
  const map = new Map<number, ProfileIssue[]>()
  for (const issue of issues) {
    const list = map.get(issue.profile) ?? []
    list.push(issue)
    map.set(issue.profile, list)
  }
  return map
}

/** The locale key of one validation finding. */
function issueKey(code: ProfileIssue['code']): ChKey {
  switch (code) {
    case 'id-empty': return 'issueIdEmpty'
    case 'id-duplicate': return 'issueIdDuplicate'
    case 'name-empty': return 'issueNameEmpty'
    case 'name-invalid': return 'issueNameInvalid'
    case 'value-invalid': return 'issueValueInvalid'
  }
}

/**
 * Render the custom-headers card. Renders nothing while the namespace join
 * has not loaded — the tab only dispatches served namespaces, so a missing
 * answer is a transient (or a read-only mirror), not an empty form.
 */
export function HeadersCard(props: HeadersCardProps): ReactNode {
  const { t, api, subscribe } = props
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<HeaderProfile[] | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [draft, setDraft] = useState<HeaderProfile[] | null>(null)
  /**
   * Per-profile disclosure flags, kept index-aligned with the profiles list.
   * Loaded profiles start collapsed (only the ID shows); a freshly added
   * profile starts expanded so its empty id field is immediately editable.
   */
  const [openProfiles, setOpenProfiles] = useState<boolean[]>([])
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  // Load on first render, and follow external invalidations. A dirty draft
  // survives a reload: the baseline moves under it and the user keeps editing.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const join = await describeNamespaces(api)
      if (!alive) return
      if (join.customHeaders === undefined) return
      setLoaded(profilesOf(join.customHeaders))
      setWritable(join.writable)
    }
    void load()
    return subscribe(() => { void load() })
  }, [api, subscribe])

  const current = draft ?? loaded
  const dirty = draft !== null && loaded !== undefined && !sameProfiles(draft, loaded)
  const issues = useMemo(() => validateProfiles(current ?? []), [current])
  const grouped = useMemo(() => issuesByProfile(issues), [issues])

  if (loaded === undefined) return null

  const edit = (next: HeaderProfile[], nextOpen?: (flags: boolean[]) => boolean[]): void => {
    setDraft(next)
    setFailed(false)
    setOpenProfiles(flags => {
      // Keep the flags index-aligned with the list they describe.
      const trimmed = flags.slice(0, next.length)
      while (trimmed.length < next.length) trimmed.push(false)
      return nextOpen === undefined ? trimmed : nextOpen(trimmed)
    })
  }
  const toggleProfile = (at: number): void => {
    setOpenProfiles(flags => {
      const next = flags.slice(0)
      while (next.length <= at) next.push(false)
      next[at] = !next[at]
      return next
    })
  }
  const patchProfile = (at: number, patch: Partial<HeaderProfile>): void => {
    if (current === undefined) return
    edit(current.map((profile, index) => (index === at ? { ...profile, ...patch } : profile)))
  }
  const patchRow = (at: number, row: number, patch: Partial<{ name: string; value: string }>): void => {
    if (current === undefined) return
    edit(current.map((profile, index) => index !== at ? profile : {
      ...profile,
      headers: profile.headers.map((entry, atRow) => (atRow === row ? { ...entry, ...patch } : entry)),
    }))
  }
  const removeProfile = (at: number): void => {
    edit(
      (current ?? []).filter((_, index) => index !== at),
      flags => flags.filter((_, index) => index !== at),
    )
  }
  const addProfile = (): void => {
    edit(
      [...(current ?? []), { id: '', headers: [{ name: '', value: '' }] }],
      // A new profile starts expanded: its empty id needs immediate editing.
      // `edit` has already index-aligned the flags with the new list, so the
      // last flag IS the new profile's.
      flags => flags.map((flag, index) => (index === flags.length - 1 ? true : flag)),
    )
  }

  const onSave = async (): Promise<void> => {
    if (current === undefined || saving) return
    setSaving(true)
    setFailed(false)
    try {
      const reply = await writeProfiles(api, current)
      if (reply.ok) {
        setDraft(null)
        const join = await describeNamespaces(api)
        if (join.customHeaders !== undefined) setLoaded(profilesOf(join.customHeaders))
      } else {
        setFailed(true)
        console.error(`[dsh-custom-headers] profile save failed: ${reply.error}`)
      }
    } finally {
      setSaving(false)
    }
  }
  const onDiscard = (): void => {
    setDraft(null)
    setFailed(false)
    setOpenProfiles(flags => flags.map(() => false))
  }

  const blocked = !dirty || issues.length > 0 || saving
  return (
    <li className={`ch-card${open ? ' ch-card-open' : ''}`}>
      <button
        type="button"
        className="ch-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('cardTitle')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="ch-head-text">
          <span className="ch-card-name">{t('cardTitle')}</span>
          <span className="ch-card-description">{t('cardDescription')}</span>
        </span>
        {dirty ? <span className="ch-tag">{t('unsaved')}</span> : null}
        <ChevronIcon open={open} />
      </button>
      {open
        ? (
          <div className="ch-card-body">
            {!writable ? <p className="ch-readonly" role="status">{t('readOnly')}</p> : null}
            {current !== undefined && current.length === 0
              ? <p className="ch-empty">{t('emptyProfiles')}</p>
              : null}
            {(current ?? []).map((profile, at) => {
              const profileOpen = openProfiles[at] === true
              const profileIssues = grouped.get(at) ?? []
              const idIssue = profileIssues.find(issue => issue.row === undefined)
              const title = profile.id.trim()
              return (
                <section className="ch-profile" key={at}>
                  <div className="ch-profile-head">
                    <button
                      type="button"
                      className="ch-profile-toggle"
                      aria-expanded={profileOpen}
                      aria-label={`${t(profileOpen ? 'collapseProfile' : 'expandProfile')}: ${title.length > 0 ? title : t('profileIdUntitled')}`}
                      onClick={() => { toggleProfile(at) }}
                    >
                      <ChevronIcon open={profileOpen} />
                      <span className={`ch-profile-title${title.length === 0 ? ' ch-profile-title-unset' : ''}`}>
                        {title.length > 0 ? title : t('profileIdUntitled')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ch-button ch-button-small"
                      aria-label={`${t('removeProfile')} ${String(at + 1)}`}
                      disabled={!writable || saving}
                      onClick={() => { removeProfile(at) }}
                    >
                      {t('removeProfile')}
                    </button>
                  </div>
                  {profileOpen
                    ? (
                      <div className="ch-profile-body">
                        <input
                          className={`ch-input${idIssue !== undefined ? ' ch-input-invalid' : ''}`}
                          type="text"
                          value={profile.id}
                          placeholder={t('profileIdPlaceholder')}
                          aria-label={`${t('profileId')} ${String(at + 1)}`}
                          disabled={!writable || saving}
                          onChange={(event) => { patchProfile(at, { id: event.target.value }) }}
                        />
                        {idIssue !== undefined
                          ? <p className="ch-issue" role="alert">{t(issueKey(idIssue.code))}</p>
                          : null}
                        {profile.headers.map((entry, row) => {
                          const rowIssue = profileIssues.find(issue => issue.row === row)
                          const nameInvalid = rowIssue !== undefined && rowIssue.code !== 'value-invalid'
                          const valueInvalid = rowIssue?.code === 'value-invalid'
                          return (
                            <div className="ch-header-row" key={row}>
                              <input
                                className={`ch-input${nameInvalid ? ' ch-input-invalid' : ''}`}
                                type="text"
                                value={entry.name}
                                placeholder={t('headerName')}
                                aria-label={`${t('headerName')} ${String(at + 1)}-${String(row + 1)}`}
                                disabled={!writable || saving}
                                onChange={(event) => { patchRow(at, row, { name: event.target.value }) }}
                              />
                              <input
                                className={`ch-input${valueInvalid ? ' ch-input-invalid' : ''}`}
                                type="text"
                                value={entry.value}
                                placeholder={t('headerValue')}
                                aria-label={`${t('headerValue')} ${String(at + 1)}-${String(row + 1)}`}
                                disabled={!writable || saving}
                                onChange={(event) => { patchRow(at, row, { value: event.target.value }) }}
                              />
                              <button
                                type="button"
                                className="ch-button ch-button-icon ch-button-small"
                                aria-label={`${t('removeHeader')} ${String(at + 1)}-${String(row + 1)}`}
                                title={t('removeHeader')}
                                disabled={!writable || saving}
                                onClick={() => {
                                  patchProfile(at, { headers: profile.headers.filter((_, atRow) => atRow !== row) })
                                }}
                              >
                                −
                              </button>
                              {rowIssue !== undefined
                                ? <p className="ch-issue" role="alert">{t(issueKey(rowIssue.code))}</p>
                                : null}
                            </div>
                          )
                        })}
                        <div>
                          <button
                            type="button"
                            className="ch-button ch-button-small"
                            aria-label={`${t('addHeader')} ${String(at + 1)}`}
                            disabled={!writable || saving}
                            onClick={() => { patchProfile(at, { headers: [...profile.headers, { name: '', value: '' }] }) }}
                          >
                            + {t('addHeader')}
                          </button>
                        </div>
                      </div>
                    )
                    : null}
                </section>
              )
            })}
            <div style={{ marginTop: '4px' }}>
              <button
                type="button"
                className="ch-button"
                disabled={!writable || saving}
                onClick={addProfile}
              >
                + {t('addProfile')}
              </button>
            </div>
            <div className="ch-card-footer">
              {failed ? <p className="ch-failed" role="status">{t('saveFailed')}</p> : null}
              <button
                type="button"
                className="ch-button"
                disabled={!dirty || saving}
                onClick={onDiscard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                className="ch-button ch-button-primary"
                disabled={blocked}
                onClick={() => { void onSave() }}
              >
                {t(saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
