# DSH Custom Headers

中文 | [English](README.en.md)

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件：为每个模型单独附加自定义 HTTP 请求头。

实际部署中，模型请求往往不直达提供方，而是经过企业网关、自研代理或 OpenAI 兼容端点——这些中间层常要求额外的请求头（租户标识、计费标签、自定义鉴权拼写等），且不同模型的要求可能不同。本插件把这件事做成一个**按模型、可随时修改的设置项**：

1. 定义任意多个命名的**请求头配置**（header profile），每个配置是一组 `名称 / 值` 键值对——DSH 0.1.7+ 在「插件」页的本包详情页中编辑，DSH 0.1.5 在「设置 → 插件 → 插件配置」中编辑；
2. 在「设置 → 模型」的模型目录中，为某个模型从下拉框里选择一个配置；
3. 此后每次调用该模型，插件都会在 pi-ai 适配器派发前把所选配置解析成请求头并附加到请求上——读取的是实时设置，改配置或换选择，下一次请求即生效，无需重启。

插件由两半组成：host 半端负责 `custom-headers` 配置（写入校验、持久化）和 LLM 派发注入；Web 客户端半端提供插件配置卡片和模型行下拉框。全部数据都保存在 DSH 自身的配置层中（0.1.7+ 为 Profile 的 cordis 补丁，0.1.5 为用户设置文档），不引入任何外部存储；取消选择或删除配置后，下一次调用即恢复原状，不留痕迹。

## 为什么需要

DSH 的提供方资料（provider profile）本身支持 `headers`，但它作用于**整个提供方路由**，无法区分同一路由下的不同模型。而「按模型附加请求头」在真实部署里很常见：

- **企业网关 / 自研代理**：网关按 `X-Tenant`、`X-Billable` 之类的头做租户识别与计费分摊；不同模型可能归属不同租户或成本中心，需要不同的头。
- **OpenAI 兼容端点的非标准要求**：不少兼容端点（自建 vLLM / one-api / 各类中转）要求额外的标识头，或自定义拼写的鉴权头，否则拒绝服务。
- **灰度与流量调度**：给特定模型的请求打标记头，让上游代理把这部分流量导向灰度部署或备用集群。
- **排障与观测**：附加追踪 / 调试标识头，把某个模型的调用从网关日志里单独筛出来。

这些头若写进提供方资料，会无差别地附加到该路由下的所有模型；若写进自定义适配器代码，则无法随设置调整。本插件正是在这两者之间补上了「按模型粒度、运行时可视化配置」这一层。

## 特性

- **命名的请求头配置**：每个配置包含一个 ID 和任意多组 `header-name` / `value` 键值对；ID 不允许重复（大小写不敏感，`Gateway` 与 `gateway` 视为同一个）。
- **配置持久化**：所有配置保存在 `custom-headers` 配置名下（0.1.7+ 持久化于 Profile 的 cordis 补丁中本插件行的 `config` 下，0.1.5 持久化于用户设置文档的同名命名空间），重启后保留；写入时由 Host 端校验，非法数据（重复 ID、非法请求头名/值）会被拒绝并原样反馈。
- **按模型选用**：在「设置 → 模型 → 提供方 → 模型目录」中，每个模型行内显示一个请求头选择下拉框（`默认` + 全部配置 ID）；选择结果写入该模型在 `llm-pi-ai` 设置中的 `headersProfile` 字段，随设置文档持久化。
- **调用时自动生效**：调用被选中模型时，插件在 pi-ai 适配器派发前把该配置解析为请求头并附加到请求上；取消选择（`默认`）或删除配置后，下一次调用即恢复原状。

## 安装

要求：deepseek-harness 的 **0.1.5 预发布线（≥ rc.2）、0.1.7 预发布线（≥ rc.1），或 0.2.0 预发布线（≥ rc.1）**——仅预发布线；各线正式版（0.1.7、0.2.0）暂不接纳，待逐线验证后放行。两个世代的设置机制（0.1.7+ 的 Profile 实时配置、0.1.5 的设置节）均已适配，同一份构建在两者上运行。

| 插件版本 | 适配的 DSH 版本（peer 区间语义） |
| --- | --- |
| 0.3.0（未发布） | 0.1.5-rc.2 ~ <0.1.5，0.1.7-rc.1 ~ <0.1.7，0.2.0-rc.1 ~ <0.2.0 |
| 0.2.0 | 0.1.5-rc.2 ~ <0.1.5，0.1.7-rc.1 |
| 0.1.0 | ≥0.1.5-rc.2 |

三种方式都通过 DSH CLI 把插件加入指定的 Profile（这里以 `web` 为例，按需替换）。本包自带 `cordis.patch.yml`，组合器会自动挂载 host 半端，并向 Web 客户端提供 `/plugins/dsh-custom-headers/client.js`——安装后无需额外的组合配置。

### 从 npm 安装

```sh
dsh plugin --profile web add dsh-custom-headers
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:EPCN-fla/dsh-custom-headers
```

通过 git 源安装时，npm 会执行包的 `prepare` 脚本自动完成构建（要求 Node `^22.19.0` 或 `>=24`）。

### 从 tarball 安装

```sh
git clone https://github.com/EPCN-fla/dsh-custom-headers.git
cd dsh-custom-headers
npm install
npm run build
npm pack        # 产出 dsh-custom-headers-<version>.tgz
dsh plugin --profile web add ./dsh-custom-headers-<version>.tgz
```

### 本地开发

开发期也可以把 CLI 直接指向工作副本目录；每次改动后重新 `npm run build` 即可生效：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-custom-headers
```

安装后重启 DSH Web。确认加载：`dsh --profile web --dump-config | grep custom-headers`。

## 使用

### 1. 创建请求头配置

- **DSH 0.1.7+**：打开「插件」页，打开 **dsh-custom-headers** 的详情页，**自定义请求头** 配置卡片位于包说明与行列表之间；
- **DSH 0.1.5**：打开 **设置 → 插件 → 插件配置**，在「网页搜索」下方找到 **自定义请求头** 卡片。

点击卡片展开后：

1. 点击 **添加配置**；每个配置在卡片内独立成段，**默认收起、只显示 ID**，点击 ID 行展开后可编辑。
2. 展开后填写 **ID**（如 `gateway`），点击 **+ 添加请求头** 填写 **请求头名称** 与 **值**；点击行尾 **−** 删除一行，点击 **删除配置** 删除整个配置。
3. 点击 **保存**。校验不通过时（ID 为空、ID 重复、请求头名称/值不合法），保存按钮不可用并显示对应错误。

### 2. 为模型选择配置

打开 **设置 → 模型**，展开某个提供方卡片，在 **模型目录** 中展开某个模型的 **容量**（Capacities）折叠区——「请求头」下拉框与容量配置一起折叠，展开后显示在「上下文窗口」和「最大输出」的下方一行：

- **默认**：不附加自定义请求头（初始状态）。
- 选择某个配置 ID：之后调用该模型时自动附加该配置的请求头。

> 尚未保存的提供方/模型行（新建卡片）上的下拉框处于禁用状态；请先保存提供方。

### 3. 生效时机与优先级

- 请求头在**每次调用时**从当前设置解析，修改配置或更换选择后，下一次请求即生效，无需重启。
- 名称冲突时（大小写不敏感）：提供方资料（provider profile）自带的 `headers` **优先于**本插件的模型级请求头；DSH 的归属标识头（`User-Agent`）始终由 Harness 决定，本插件会过滤同名自定义项。
- 凭据认证头（如 `Authorization`、`x-api-key`）由 SDK 按提供方凭据设置；如需自定义认证方式，请在配置中使用自定义名称的头（例如 `X-Api-Key` 的网关拼写），并知晓与凭据头同名时可能被 SDK 覆盖。

## 配置存储格式

`custom-headers` 名下的用户层（DSH 0.1.7+ 写在 Profile 的 cordis 补丁中本插件行的 `config` 下；DSH 0.1.5 写在用户设置文档的同名命名空间里。首个 0.1.7 启动会自动把旧 `settings.yaml` 的 `custom-headers` 节导入到本插件行）：

```yaml
custom-headers:
  profiles:
    - id: gateway
      headers:
        - name: X-Tenant
          value: acme
        - name: X-Trace-Id
          value: "1"
```

模型行上的选择（`llm-pi-ai` 名下，由下拉框写入，无需手工维护）：

```yaml
llm-pi-ai:
  providers:
    acme:
      models:
        - id: my-model
          headersProfile: gateway
```

部署方也可以通过插件的 cordis 行 `config:` 预置组合层配置（作为用户层的 base）：

```yaml
- id: custom-headers
  name: dsh-custom-headers
  config:
    profiles:
      - id: gateway
        headers:
          - name: X-Tenant
            value: acme
```

## 支持范围与已知限制

- 仅对 **pi-ai 适配器**（`llm-pi-ai` 提供方路由，含手工声明的自定义提供方）的调用生效；其他适配器家族（如 `deepseek-official`）不经过该连线路径，选择不会被应用。
- 请求头应用于模型的**实际 LLM 请求**；「从端点获取模型列表」等配置期发现请求沿用提供方资料自身的头，不附加模型级配置。
- 下拉框通过 DOM 锚定注入到官方模型页面每行的「模型选项」折叠区内（0.1.5 称为「容量」；官方槽位没有模型行级扩展点）。已按 0.1.5-rc.2、0.1.7-rc.1 – 0.2.0-rc.2 的页面结构（各版本结构一致；折叠区名称经宿主词典逐代解析）做了防御式适配：官方页面结构若发生变化，插件会停止注入而不影响页面本身。
- （仅 DSH 0.1.5）「插件配置」中的卡片位置依赖内置「网页搜索」卡片的注册：本插件会等待其出现在槽位账本后再注册（约 10 秒兜底超时）；若部署裁剪了内置插件包导致其不存在，本卡片仍会注册，但位置取决于当时的账本顺序。DSH 0.1.7+ 的卡片位于本包详情页，无位置依赖。
- 同名请求头在一个配置内重复出现时，按大小写不敏感「后者覆盖前者」处理（Fetch `Headers` 语义）。

## 开发

```sh
npm install        # 安装依赖（.npmrc 已启用 legacy-peer-deps）
npm run typecheck  # 类型检查
npm test           # vitest：单元 / DOM 注入 / 组件 / 真实 pi-ai 连线测试
npm run build      # 产出 lib/index.js（host）、lib/client.js（web）、类型声明
```

测试全部位于 `tests/`：

| 文件 | 覆盖 |
|---|---|
| `tests/headers.spec.ts` | 校验、归一化、解析、模型行选择读取等纯逻辑 |
| `tests/host.spec.ts` | 设置 seam 双世代（0.1.5 命名空间注册 / 0.1.7 volatile 配置）、适配器包装、请求头盖印与还原、卸载清理 |
| `tests/pi-ai-wire.spec.ts` | 真实 pi-ai openai-completions 连线：`model.headers` 到达请求、冲突优先级、认证保持 |
| `tests/ops.spec.ts` | 客户端设置读写（冲突重试、拒绝透传、空行清理） |
| `tests/injector.spec.ts` | 模型行发现、幂等注入、staged 行、语言锚点 |
| `tests/register.spec.ts` | 配置卡片在两个世代的槽位注册（0.1.5 `settings.plugin.item` / 0.1.7 `plugins.bundle.config`） |
| `tests/card.spec.tsx` | 配置卡片：展开、编辑、校验拦截、保存/放弃、只读 |
| `tests/select.spec.tsx` | 下拉框：选项、写入、已删除配置显示、禁用态、中文文案 |

## 许可证

[MIT](LICENSE)
