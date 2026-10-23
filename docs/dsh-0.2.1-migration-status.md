# DSH 0.2.1 适配状态记录

记录时间：2026-10-18；最终验证完成于 2026-10-23。本文是 `0.4.0` 迁移的最终证据快照；真实浏览器与 Docker 边界仍按末尾说明保持未验证。

## 目标与基线

- 插件：`dsh-custom-headers`，从 `0.3.0` 升级到 `0.4.0`。
- 原适配基线：DSH `0.2.0-rc.2`（`dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`）。
- 新增目标：DSH `0.2.1-rc.1` 与 `0.2.1-rc.2`。
- 插件原始基线：`bedd7c66d440dd5a4ffc30cb8a94b94e79b8feeb`（`v0.3.0`）。
- 当前分支：`0.4.0`。
- 原 DSH 检出 `/home/fla1337/deepseek-harness` 未被修改，仍在上述 `0.2.0-rc.2` commit；所有审计均在工作区忽略的 `.npm-cache/dsh-audit/deepseek-harness` 沙箱克隆中进行。

## 已完成的原子提交

1. `3951e72 docs: simplify the version-matrix lead-in`：用户授权的既有 README 修改，独立提交。
2. `d4cf6fd chore(deps): admit the DSH 0.2.1 release candidates`：追加 `>=0.2.1-rc.1 <0.2.1` peer 区间，开发基线升级为 DSH `0.2.1-rc.2`，pi-ai 范围改为 `^1.1.0`。
3. `5d204c9 test: cover the DSH 0.2.1 model options layout`：覆盖模型选项区内新增推理控件时的 DOM 注入。
4. `715f6c7 docs: document DSH 0.2.1 compatibility`：更新中英文支持矩阵和源码版本注释。
5. `4d935bf chore(release): bump version to 0.4.0`：单独升级插件版本号。
6. `54a6e9d docs: record the DSH 0.2.1 migration status`：保存迁移中间状态与根因假设。
7. `67cf1c5 fix: read model picks from raw profile config`：从原始用户层读取 `headersProfile`，避免 Settings 表单投影过滤插件字段。
8. `6687105 fix: declare llm before wrapping adapter registration`：静态声明 `llm` 并直接包装适配器注册，移除真实组合中不会触发的动态注入路径。

## 审计与静态验证

- 七触点扫描已完成；版本卡不覆盖该走廊，因此使用两个精确 Git 标签的源码审计。
- `0.2.0-rc.2 → 0.2.1-rc.1`：1477 个非合并提交、8361 个文件变化。六个外部兼容面已检查；未发现本插件所用 Settings、LLM/pi-ai、Slots、Models DOM 或 bundle patch 面的直接迁移阻断。
- `0.2.1-rc.1 → 0.2.1-rc.2`：5 个非合并提交、456 个文件变化；本插件直接依赖面除 manifest 版本号外无源代码差异。两段综合报告分别位于 `.npm-cache/dsh-audit/deepseek-harness/tmp/0.2.0rc2-to-0.2.1rc1/UPGRADE-ADAPTATION.md` 和 `.npm-cache/dsh-audit/deepseek-harness/tmp/0.2.1rc1-to-0.2.1rc2/UPGRADE-ADAPTATION.md`。
- 迁移前基线：typecheck、88 项 Vitest、build 全部通过。
- 最终 `0.2.1-rc.1` 独立依赖克隆：typecheck、90 项 Vitest、build 全部通过。
- 最终 `0.2.1-rc.2` 开发基线：typecheck、90 项 Vitest、build 全部通过。
- 最终产物为 `.npm-cache/artifacts-final/dsh-custom-headers-0.4.0.tgz`，SHA-256 为 `472d6f743ffc90e63ed48a47b1e92d65644f1baeae1b690f7c98220d59d5f46f`；隔离消费者验证 manifest 版本、Host/Client 入口、静态 `llm` 注入、`cordis.patch.yml`、README、LICENSE 和无 TypeScript 源码泄漏均通过。

## 运行时证据

### 已通过

- 使用隔离 npm prefix 安装并确认两个真实 DSH 版本：`0.2.1-rc.1`、`0.2.1-rc.2`。
- 最终产物在两个版本的 `verify-runtime.mjs` 均为 `pass-timeout-alive`：插件安装、列出和 Web 冷启动激活通过。
- pnpm 默认 store 位于沙箱外曾导致安装失败；改用工作区内 `XDG_DATA_HOME` / `XDG_CACHE_HOME` 后通过。这属于验证环境问题，不是插件兼容性失败。

### 已解决的核心问题

真实功能探针通过官方 `headless` Profile、实际 DSH 用户轮次和本地回环 OpenAI 兼容端点验证请求头。初探暴露了两个插件侧问题：

- `SettingsForms.describe()` 的 schema 投影会过滤插件自定义 `headersProfile`；该逻辑在 `0.2.0-rc.2` 与两个目标版本中相同，属于既有缺陷而非 0.2.1 删除 API。修复为读取 `ConfigEditor.configuration()` 的原始用户层，并保留 `describe()` 回退。
- 原动态 `ctx.inject(['llm'])` 回调在真实 headless 组合中没有运行；修复为静态声明 `llm` 并在 `apply()` 中直接包装适配器注册。
- 新回归先经反向变异验证变红，恢复修复后变绿。

最终产物在两个目标版本上均通过功能探针：真实用户轮次完成并返回 `OK`，本地端点收到两个 chat 请求，`X-Trace-Id` 分别为 `rc1-final` / `rc2-final`，provider 的 `X-Tenant: provider-wins` 优先、虚拟 `Authorization` 与 Harness `User-Agent` 保持。证据目录为 `.npm-cache/validation/functional-rc1-final-b9d3pN/` 与 `.npm-cache/validation/functional-rc2-final-MHlSxw/`；其中只含虚拟密钥和回环地址。

## 未验证边界与维护事项

- Docker 在当前 WSL 中不可用，Docker smoke 未执行。
- 未发现浏览器或 Playwright，真实浏览器 DOM 挂载、控制台错误和 Web artifact 浏览器内验证未执行；当前只有 jsdom 回归与 Web 冷启动证据。
- 隔离 DSH/消费者安装曾使根 `package.json` 被 npm 写入 102 个无关依赖及 `directories`/`bugs` 规范化变化；已确认属于本任务的嵌套 prefix 副作用，并在每次发生后只还原该文件。最终提交中不包含该副作用。
- 审计缓存、临时 Profile、调试副本、虚拟凭据和 tarball 均位于忽略的 `.npm-cache/`，不属于提交内容。
