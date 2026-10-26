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
  补充复核（2026-10-26）：`providers` 是 dict 时，`value` / `user` 投影会保留其整棵子树及 `headersProfile`，因此不能把当时的观测泛化为所有 Modern Settings 都会过滤该字段；读取 raw override 仍作为防御性回退保留。
- 原动态 `ctx.inject(['llm'])` 回调在真实 headless 组合中没有运行；修复为静态声明 `llm` 并在 `apply()` 中直接包装适配器注册。
- 新回归先经反向变异验证变红，恢复修复后变绿。

最终产物在两个目标版本上均通过功能探针：真实用户轮次完成并返回 `OK`，本地端点收到两个 chat 请求，`X-Trace-Id` 分别为 `rc1-final` / `rc2-final`，provider 的 `X-Tenant: provider-wins` 优先、虚拟 `Authorization` 与 Harness `User-Agent` 保持。证据目录为 `.npm-cache/validation/functional-rc1-final-b9d3pN/` 与 `.npm-cache/validation/functional-rc2-final-MHlSxw/`；其中只含虚拟密钥和回环地址。

## 未验证边界与维护事项

- Docker 在当前 WSL 中不可用，Docker smoke 未执行。
- 未发现浏览器或 Playwright，真实浏览器 DOM 挂载、控制台错误和 Web artifact 浏览器内验证未执行；当前只有 jsdom 回归与 Web 冷启动证据。
- 隔离 DSH/消费者安装曾使根 `package.json` 被 npm 写入 102 个无关依赖及 `directories`/`bugs` 规范化变化；已确认属于本任务的嵌套 prefix 副作用，并在每次发生后只还原该文件。最终提交中不包含该副作用。
- 审计缓存、临时 Profile、调试副本、虚拟凭据和 tarball 均位于忽略的 `.npm-cache/`，不属于提交内容。


## 2026-10-26：rc.3 复审与全面代码审查

### 外部兼容结论

- 精确来源：`dsh-v0.2.1-rc.2` = `687f282e8625c6b8d11ff58211a90524be2e4317`，`dsh-v0.2.1-rc.3` = `1f81c047fc48fa190a683e469daa699857e9afe8`；merge-base 纯净，5 个非合并提交，640 个文件变化。
- 同时审计 npm 发布树与精确 Git 标签；报告位于 `tmp/0.2.1rc2-to-0.2.1rc3/UPGRADE-ADAPTATION.md`（本地忽略目录）。未发现新增外部破坏或 revert。变化主要是导航入口定制、additive 分析事件和 DeepSeek 官方 API-key 路由 `/models` 列表。
- 本插件使用的 LLM/pi-ai、Settings、Slots、Models DOM 与组合 seam 无 rc.3 专项迁移变更；现有 `>=0.2.1-rc.1 <0.2.1` peer 已涵盖 rc.3，无需扩宽。

### 审查后修复

- Host 不再原地盖写共享 model descriptor；每次 `stream` / `prepareCall` 使用独立 snapshot/model 副本，交错调用与 dispose 不会串用或残留请求头。注册失败和卸载均精确恢复属性描述符。
- 配置卡片把整表草稿绑定原始 revision；外部写入导致可见冲突，不再自动用旧草稿覆盖最新文档。所有加载路径使用代次与卸载失效。
- DOM 注入增加 input/change 重扫描、异步代次、wrapper 自愈和重复标签去重；未提交的模型改名（包括改成另一已有 ID）保持禁用，新建行保存后采用其已保存身份。
- 选择器按 Host 相同规则规范化大小写/空白 ID，补充可见状态及 ARIA；只读时禁止保存。
- 开发 cohort 对齐 rc.3、Cordis `4.0.5`、Schemastery `3.18.5`，新增 Cordis peer；Client Settings 类型改从窄入口导入，CI 禁用 legacy peer 并增加 `skipLibCheck:false` 的产物消费检查。

### 最终验证

- rc.2 迁移前基线：typecheck、90 项 Vitest、build 全绿；无需要豁免的既有失败。
- 最终 rc.3：严格 `npm ci --legacy-peer-deps=false`、`npm ls`、typecheck、108 项 Vitest、build、`git diff --check` 全绿。
- 最终产物：`tmp/artifacts/dsh-custom-headers-0.4.0.tgz`，SHA-256 `86ba9992445280556c6d3adf49eba235249f77549032ab7cd608e9baeddc9c90`；隔离消费者完成 Host 导入、Client/Root 类型严格解析和 manifest/patch 检查。
- rc.3 真实 Web Profile：`verify-runtime` 为 `pass-timeout-alive`（安装、列出、冷启动）；证据 `tmp/verify-runtime-rc3-final.json`。
- rc.3 Web 启动图含 `dsh-custom-headers`，广告 artifact HTTP 200，ModuleLoader 注册与 factory 导出通过；证据 `tmp/web-artifact-rc3-final.json`。
- rc.3 官方 headless Profile 完成真实用户轮次并返回 `OK`；回环端点收到 2 个请求，均验证自定义 trace、provider 冲突优先级、虚拟 Authorization 与 Harness User-Agent。证据 `tmp/functional-rc3-final/report.json`。

### 仍未验证 / 限制

- Docker Desktop 的 WSL 集成不可用，Docker smoke 为 blocked；不得以本地隔离验证替代声明 Docker 通过。
- 未执行真实浏览器 DOM/控制台验证；当前证据为 jsdom、真实 Web artifact 和 factory，不是浏览器兼容声明。
- 未使用真实 provider 凭据，未复测全部旧 cohort 或非 Linux 平台；这些边界不由 rc.3 结果外推。
- 完全继承 installed catalog、没有显式 `models` 可写行的模型仍保持禁用；未猜测 `modelOverrides` 写入目标。
- 未采用每请求重读 Profile 的缓存重写；避免引入失效语义风险，留待有性能证据后单独处理。
