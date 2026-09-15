/**
 * Copy dictionaries for the browser half, keyed by locale. The union type is
 * derived from the English dictionary; the Chinese dictionary must cover
 * exactly the same keys (compile-time checked).
 *
 * @module dsh-custom-headers/client/locales
 */

const en = {
  // ---- Plugin-configuration card ----
  cardTitle: 'Custom headers',
  cardDescription: 'Named request-header profiles that models can opt into.',
  profileId: 'ID',
  profileIdPlaceholder: 'Profile ID, e.g. gateway',
  addProfile: 'Add profile',
  removeProfile: 'Delete profile',
  headerName: 'Header name',
  headerValue: 'Value',
  addHeader: 'Add header',
  removeHeader: 'Remove header',
  emptyProfiles: 'No header profiles yet. Add one, then pick it for a model on the Models page.',
  issueIdEmpty: 'ID is required.',
  issueIdDuplicate: 'ID must be unique (case-insensitive).',
  issueNameEmpty: 'Header name is required when a value is set.',
  issueNameInvalid: 'This header name/value is not representable as an HTTP header.',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  readOnly: 'This settings document is read-only in the current deployment.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  expandProfile: 'Show headers',
  collapseProfile: 'Hide headers',
  profileIdUntitled: '(unnamed profile)',
  // ---- Models-page per-model picker ----
  modelPicker: 'Request headers',
  modelPickerDefault: 'Default',
  modelPickerSaveFirst: 'Save this provider before picking a header profile.',
  modelPickerWriteFailed: 'Could not save the header profile pick',
} as const

/** Union of every dictionary key. */
export type ChKey = keyof typeof en

const zh: Record<ChKey, string> = {
  cardTitle: '自定义请求头',
  cardDescription: '命名的请求头配置，可按模型选用。',
  profileId: 'ID',
  profileIdPlaceholder: '配置 ID，例如 gateway',
  addProfile: '添加配置',
  removeProfile: '删除配置',
  headerName: '请求头名称',
  headerValue: '值',
  addHeader: '添加请求头',
  removeHeader: '删除请求头',
  emptyProfiles: '还没有请求头配置。添加一个后，即可在“模型”页面为模型选用。',
  issueIdEmpty: 'ID 不能为空。',
  issueIdDuplicate: 'ID 不能重复（不区分大小写）。',
  issueNameEmpty: '设置了值时，请求头名称不能为空。',
  issueNameInvalid: '该请求头名称/值不是合法的 HTTP 请求头。',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  readOnly: '当前部署的设置文档为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  expandProfile: '展开请求头',
  collapseProfile: '收起请求头',
  profileIdUntitled: '（未命名配置）',
  modelPicker: '请求头',
  modelPickerDefault: '默认',
  modelPickerSaveFirst: '请先保存该提供方，再选择请求头配置。',
  modelPickerWriteFailed: '请求头配置选择保存失败',
}

export { en, zh }
