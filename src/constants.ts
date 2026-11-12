/**
 * Plugin-wide constants shared by the host and browser halves.
 *
 * @module dsh-custom-headers/constants
 */

/**
 * Stable plugin id: the cordis plugin name, the bundle id, and the client
 * module id (all keyed by package name). The cordis.patch.yml ROW id is
 * `custom-headers` instead — see that file for why the row id carries the
 * settings-namespace continuity.
 */
export const PLUGIN_ID = 'dsh-custom-headers'

/**
 * The settings namespace this plugin OWNS: named custom-header profiles,
 * edited from the plugin's configuration card. On DSH 0.2.2-rc.2 this is
 * the plugin's cordis row id, whose volatile Config field the settings
 * service serves. Keeping the row id stable preserves existing profile data.
 */
export const CUSTOM_HEADERS_NS = 'custom-headers'

/** The settings namespace this plugin READS and annotates: pi-ai provider routes. */
export const PI_AI_NS = 'llm-pi-ai'

/**
 * Model-level field written onto a pi-ai model row when the user picks a
 * header profile for it ("默认"/Default removes the field). Schemastery
 * passes unknown model keys through, so the field survives official Models
 * page saves and restarts; pi-ai's catalog resolution enumerates its own
 * known fields and never forwards this one onto the wire model.
 */
export const HEADERS_PROFILE_FIELD = 'headersProfile'

/** Locale dictionary namespace for the browser half's copy (not a settings namespace). */
export const STORE_NS = PLUGIN_ID
