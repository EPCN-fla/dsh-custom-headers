/**
 * Plugin-wide constants shared by the host and browser halves.
 *
 * @module dsh-custom-headers/constants
 */

/** Stable plugin id, matching the cordis.patch.yml row and the bundle id. */
export const PLUGIN_ID = 'dsh-custom-headers'

/**
 * The settings namespace this plugin OWNS: named custom-header profiles,
 * edited from the plugin-configuration card and persisted in the user
 * settings document.
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
