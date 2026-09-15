/**
 * The browser half's stylesheet. The card chrome and field controls are
 * 1:1 ports of the official `ui-settings-plugins` PluginCard / fields rules
 * and the `ui-settings-models` model-catalog input rules — same `--dsw-alias-*`
 * design tokens, same geometry — so the plugin's surfaces are visually
 * indistinguishable from the shipped ones. Class names stay `ch-` prefixed
 * (CSS-module hashes are per-package and cannot be reused).
 *
 * @module dsh-custom-headers/client/styles
 */

export const STYLES = `
/* ---- Plugin-configuration card (ported from PluginCard.module.css) ---- */
.ch-card {
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.ch-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.ch-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.ch-card-header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.ch-card-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.ch-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ch-card-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.ch-card-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ch-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; display: inline-flex; }
.ch-chevron-open { transform: rotate(180deg); }
.ch-card-body { border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.ch-readonly { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.ch-empty { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

/* Tag tone="neutral" port (the "unsaved" capsule on the card header). */
.ch-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  flex: none;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}

/* Card footer buttons (ported from PluginCard.module.css). */
.ch-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.ch-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.ch-button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.ch-button:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.ch-button-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); border-color: transparent; }
.ch-button:disabled { opacity: 0.4; cursor: default; }
.ch-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ch-button-small { padding: 2px 10px; font-size: 12px; }
.ch-button-icon { padding: 0 8px; font-weight: 600; }

/* ---- Profile blocks: one collapsible section per profile ---- */
.ch-profile { padding: 12px 0; display: flex; flex-direction: column; gap: 6px; }
.ch-profile + .ch-profile { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.ch-profile-head { display: flex; align-items: center; gap: 8px; }
.ch-profile-toggle {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
}
.ch-profile-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.ch-profile-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-profile-title-unset { color: var(--dsw-alias-label-dimmed); font-weight: 400; }
.ch-profile-body { display: flex; flex-direction: column; gap: 8px; padding-top: 2px; }
.ch-header-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
}
.ch-header-row .ch-issue { grid-column: 1 / -1; margin: -2px 0 0; }
.ch-issue { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }

/* Field inputs (ported from fields.module.css / ModelsSection .input). */
.ch-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.ch-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ch-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ch-input:disabled { opacity: 0.6; cursor: default; }
.ch-input-invalid { border-color: var(--dsw-alias-label-error); }

/* ---- Models-page picker: a .modelField row inside the Capacities disclosure ---- */
.ch-field { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; }
.ch-field-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.ch-select-input {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  max-width: 240px;
  height: 32px;
  padding: 0 32px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background-color: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  /* Data-URI SVGs cannot resolve CSS variables; #81858C is the caption gray
     shared by both themes (same port as the official .selectInput). */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
.ch-select-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ch-select-input:disabled { opacity: 0.6; cursor: default; }
.ch-select[data-failed="true"] .ch-select-input { border-color: var(--dsw-alias-label-error); }
`
