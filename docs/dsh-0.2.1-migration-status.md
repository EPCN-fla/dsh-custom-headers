# DSH 0.2.1 适配状态记录

记录时间：2026-10-18。本文是继续迁移前的工作快照，不代表最终兼容性结论。

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

## 审计与静态验证

- 七触点扫描已完成；版本卡不覆盖该走廊，因此使用两个精确 Git 标签的源码审计。
- `0.2.0-rc.2 → 0.2.1-rc.1`：1477 个非合并提交、8361 个文件变化。六个外部兼容面已检查；未发现本插件所用 Settings、LLM/pi-ai、Slots、Models DOM 或 bundle patch 面的直接迁移阻断。
- `0.2.1-rc.1 → 0.2.1-rc.2`：5 个非合并提交、456 个文件变化；本插件直接依赖面除 manifest 版本号外无源代码差异。该段报告已写入 `.npm-cache/dsh-audit/deepseek-harness/tmp/0.2.1rc1-to-0.2.1rc2/UPGRADE-ADAPTATION.md`。第一段综合报告尚待整理。
- 迁移前基线：typecheck、88 项 Vitest、build 全部通过。
- `0.2.1-rc.1` 独立依赖克隆：typecheck、89 项 Vitest、build 全部通过。
- `0.2.1-rc.2` 开发基线：typecheck、89 项 Vitest、build 全部通过。
- 已生成 `dsh-custom-headers-0.4.0.tgz`，隔离消费者验证 manifest 版本、Host/Client 入口、`cordis.patch.yml`、README、LICENSE 和无 TypeScript 源码泄漏均通过。若后续修改生产代码，该产物及其验证结果必须重新生成。

## 运行时证据

### 已通过

- 使用隔离 npm prefix 安装并确认两个真实 DSH 版本：`0.2.1-rc.1`、`0.2.1-rc.2`。
- 两个版本的 `verify-runtime.mjs` 均为 `pass-timeout-alive`：插件安装、列出和 Web 冷启动激活通过。
- pnpm 默认 store 位于沙箱外曾导致安装失败；改用工作区内 `XDG_DATA_HOME` / `XDG_CACHE_HOME` 后通过。这属于验证环境问题，不是插件兼容性失败。

### 当前核心问题

真实功能探针通过官方 `headless` Profile、实际 DSH 用户轮次和本地回环 OpenAI 兼容端点验证请求头：

- provider 自带的 `X-Tenant: provider-wins` 与虚拟 `Authorization` 正常到达；
- 插件的 `X-Trace-Id` 未到达，因此不能声称核心功能已适配；
- `headless` 默认禁用 `settings`，最初探针因此退化；在测试专用 Profile 中显式启用后，问题仍可复现；
- 根因已定位到 `SettingsForms.describe()` 的 schema 投影：`llm-pi-ai` 的 Loader 配置可以保留插件自定义 `headersProfile`，但 Settings 表单投影只保留 schema 声明字段，导致插件此前读取不到模型选择。`0.2.0-rc.2` 也有相同投影逻辑，所以这是新探针暴露的既有缺陷，不是 0.2.1 删除 API。
- 最近失败证据目录：`.npm-cache/validation/functional-rc1-gLcPVJ/`。其中的配置只含虚拟密钥和回环地址。

## 后续修复计划

仅修改以下两个文件，并创建独立约定式提交：

1. `src/index.ts`：通过窄结构接口读取 `ConfigEditor.configuration()` 中 `llm-pi-ai` 行的原始用户层 `override`，保留插件自定义 `headersProfile`；保留 `describe()` 回退与 0.1.5 分支。
2. `tests/host.spec.ts`：增加“表单投影已丢弃字段、原始配置仍保留字段”的回归，覆盖盖印和取消选择后的还原。

随后重新生成 `0.4.0` tarball，重跑完整静态门禁、两个版本的冷启动和两个版本的真实功能探针。生产修复尚未实施，`0.2.1-rc.2` 功能探针尚未执行。

## 未验证边界与维护事项

- Docker 在当前 WSL 中不可用，Docker smoke 未执行。
- 未发现浏览器或 Playwright，真实浏览器 DOM 挂载、控制台错误和 Web artifact 浏览器内验证未执行；当前只有 jsdom 回归与 Web 冷启动证据。
- 隔离 DSH 安装曾使根 `package.json` 被 npm 写入 102 个无关依赖及 `directories`/`bugs` 规范化变化；已确认属于本任务的嵌套 prefix 副作用并只还原该文件，未改动其他路径。后续应复用现有隔离主机，避免重复安装。
- 当前工作区在本记录写入前应只有本文件这一新增变更；不得把审计缓存、临时 Profile、虚拟凭据或 npm 副作用纳入提交。
