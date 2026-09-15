/**
 * Pure header-profile logic shared by the host and browser halves: the
 * section shape, its validation (case-insensitive id uniqueness, Fetch-valid
 * header names), and call-time resolution of one model's effective headers.
 * No Cordis, no DOM — every function here is unit-testable in isolation.
 *
 * @module dsh-custom-headers/headers
 */

/** One header row of a profile, exactly as the editor stages it. */
export interface HeaderEntry {
  /** HTTP field name; validated against Fetch (`Headers#set`) before a save lands. */
  name: string
  /** Field value; the empty string is a legal value. */
  value: string
}

/** One named custom-header profile. */
export interface HeaderProfile {
  /**
   * User-chosen profile id. Unique across profiles case-insensitively —
   * "Gateway" and "gateway" name the same profile.
   */
  id: string
  /** The profile's header rows. */
  headers: HeaderEntry[]
}

/** The `custom-headers` settings section this plugin owns. */
export interface CustomHeadersSection {
  profiles: HeaderProfile[]
}

/** A validation finding, addressed by profile index and (for rows) row index. */
export interface ProfileIssue {
  /** Index of the offending profile in the section. */
  profile: number
  /** Index of the offending header row; absent for profile-level findings. */
  row?: number
  code: 'id-empty' | 'id-duplicate' | 'name-empty' | 'name-invalid' | 'value-invalid'
  /** Offending value, echoed for diagnostics. */
  value: string
}

/** Whether a header name/value pair is representable as a Fetch header. */
function fetchAccepts(name: string, value: string): boolean {
  try {
    const headers = new Headers()
    headers.set(name, value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate one profile list, returning every finding (empty when valid).
 * Row order is stable so the editor can pin messages next to their inputs.
 * @param profiles - the staged or resolved profile list.
 */
export function validateProfiles(profiles: readonly HeaderProfile[]): ProfileIssue[] {
  const issues: ProfileIssue[] = []
  const seen = new Map<string, number>()
  profiles.forEach((profile, at) => {
    const id = profile.id.trim()
    if (id.length === 0) {
      issues.push({ profile: at, code: 'id-empty', value: profile.id })
    } else {
      const key = id.toLowerCase()
      const prior = seen.get(key)
      if (prior !== undefined) {
        issues.push({ profile: at, code: 'id-duplicate', value: id })
      } else {
        seen.set(key, at)
      }
    }
    profile.headers.forEach((entry, row) => {
      const name = entry.name.trim()
      if (name.length === 0) {
        // A fully blank row is an editing artifact the editor strips before
        // saving; a value without a name is a real mistake and must surface.
        if (entry.value.length > 0) issues.push({ profile: at, row, code: 'name-empty', value: entry.value })
        return
      }
      if (!fetchAccepts(name, entry.value)) {
        issues.push({ profile: at, row, code: 'name-invalid', value: name })
      }
    })
  })
  return issues
}

/**
 * Throwing form of {@link validateProfiles} for the host's settings
 * `validate` hook: the write that produced an invalid section is refused
 * with a message naming the profile and row.
 * @param profiles - the resolved section's profile list.
 */
export function assertValidProfiles(profiles: readonly HeaderProfile[]): void {
  const issue = validateProfiles(profiles)[0]
  if (issue === undefined) return
  const where = issue.row === undefined
    ? `profile #${String(issue.profile + 1)}`
    : `profile #${String(issue.profile + 1)} header row #${String(issue.row + 1)}`
  const reason = {
    'id-empty': 'needs an id',
    'id-duplicate': `duplicates id "${issue.value}" (ids are compared case-insensitively)`,
    'name-empty': 'has a value without a header name',
    'name-invalid': `names a header Fetch cannot represent: "${issue.value}"`,
    'value-invalid': `carries a value Fetch cannot represent for "${issue.value}"`,
  }[issue.code]
  throw new Error(`custom-headers: ${where} ${reason}`)
}

/** Plain-object guard (host/client neutral). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize a raw settings section (any layer) into a clean profile list.
 * Foreign shapes degrade to absent entries rather than throwing: the settings
 * document is user-editable YAML, and a hostile row must not break the call
 * path. Ids are trimmed; header rows with blank names are dropped.
 */
export function normalizeProfiles(section: unknown): HeaderProfile[] {
  if (!isRecord(section) || !Array.isArray(section['profiles'])) return []
  const out: HeaderProfile[] = []
  for (const raw of section['profiles']) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') continue
    const headers: HeaderEntry[] = []
    if (Array.isArray(raw['headers'])) {
      for (const entry of raw['headers']) {
        if (!isRecord(entry)) continue
        const name = typeof entry['name'] === 'string' ? entry['name'].trim() : ''
        const value = typeof entry['value'] === 'string' ? entry['value'] : ''
        if (name.length === 0) continue
        headers.push({ name, value })
      }
    }
    out.push({ id: raw['id'].trim(), headers })
  }
  return out.filter(profile => profile.id.length > 0)
}

/**
 * Resolve one profile's effective wire headers.
 *
 * Composition mirrors llm-pi-ai's own `requestHeaders()` discipline: entries
 * Fetch cannot represent are skipped, names colliding case-insensitively with
 * a reserved name (Harness attribution: `user-agent`) are dropped so
 * Harness self-identification always wins, and a repeated name resolves
 * last-wins case-insensitively (Fetch `Headers` semantics).
 *
 * @param profiles - the resolved profile list.
 * @param id - the profile id a model row names, matched case-insensitively.
 * @param reserved - lowercased reserved names (attribution); defaults to none.
 * @returns the effective headers, or undefined when the profile is unknown
 *   or nothing valid remains (the caller leaves the model untouched).
 */
export function resolveProfileHeaders(
  profiles: readonly HeaderProfile[],
  id: string,
  reserved: ReadonlySet<string> = new Set(),
): Record<string, string> | undefined {
  const wanted = id.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  const profile = profiles.find(candidate => candidate.id.toLowerCase() === wanted)
  if (profile === undefined) return undefined
  const headers = new Headers()
  for (const entry of profile.headers) {
    const name = entry.name.trim()
    if (name.length === 0 || reserved.has(name.toLowerCase())) continue
    try {
      headers.set(name, entry.value)
    } catch {
      // Unrepresentable as a Fetch header: skip the entry, keep the rest.
    }
  }
  const out = Object.fromEntries(headers.entries())
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * The header-profile id one pi-ai model row names, or undefined when the row
 * (or the field) does not exist. Reads the RAW user-layer providers dict the
 * browser half edits; a non-string value degrades to "no pick" rather than
 * poisoning dispatch.
 * @param providers - the pi-ai namespace's providers dict.
 * @param route - the provider route key.
 * @param modelId - the exact model id.
 * @param field - the model-row field carrying the pick (`headersProfile`).
 */
export function modelProfileIdOf(
  providers: unknown,
  route: string,
  modelId: string,
  field: string,
): string | undefined {
  if (!isRecord(providers)) return undefined
  const profile = providers[route]
  if (!isRecord(profile) || !Array.isArray(profile['models'])) return undefined
  const row = profile['models'].find((model): model is Record<string, unknown> =>
    isRecord(model) && model['id'] === modelId)
  const picked = row?.[field]
  return typeof picked === 'string' && picked.trim().length > 0 ? picked.trim() : undefined
}
