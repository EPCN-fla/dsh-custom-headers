# DSH Custom Headers

[中文](README.md) | English

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that attaches custom HTTP request headers per model.

In real deployments, model requests often don't go straight to the provider — they pass through corporate gateways, self-hosted proxies, or OpenAI-compatible endpoints, which commonly demand extra headers (tenant identifiers, billing tags, custom auth spellings), and the demands can differ per model. This plugin turns that into a **per-model, runtime-editable setting**:

1. Define any number of named *header profiles* — each a list of `name / value` pairs — on this package's detail page under **Plugins** (DSH 0.1.7+) or under **Settings → Plugins → Plugin configuration** (DSH 0.1.5);
2. Pick a profile for a model from a dropdown in the model catalog under **Settings → Models**;
3. From then on, every call to that model has the profile resolved and its headers stamped onto the request just before the pi-ai adapter dispatches it. The plugin reads live settings, so edits and pick changes reach the very next request — no restart needed.

The plugin has two halves: the host half owns the `custom-headers` configuration (write-time validation, persistence) and the LLM dispatch injection; the Web client half contributes the configuration card and the per-model dropdown. Everything is stored in DSH's own configuration layer (the profile's cordis patch on 0.1.7+, the user settings document on 0.1.5) — no external storage — and unpicking or deleting a profile restores the original behavior on the next call, leaving no trace.

## Why

DSH's provider profile already supports `headers`, but they apply to the **whole provider route** and cannot distinguish between models on the same route. Per-model headers, however, are a common real-world need:

- **Corporate gateways / self-hosted proxies**: the gateway identifies tenants and splits billing via headers like `X-Tenant` or `X-Billable`; different models may belong to different tenants or cost centers and need different values.
- **Non-standard demands of OpenAI-compatible endpoints**: many compatible endpoints (self-hosted vLLM, one-api, various relays) refuse to serve without extra identification headers, or a custom-spelled auth header.
- **Gradual rollouts and traffic steering**: tag a specific model's requests with a marker header so the upstream proxy routes that traffic to a canary deployment or a standby cluster.
- **Debugging and observability**: attach tracing/debug headers so one model's calls can be filtered out of the gateway logs on their own.

Putting these headers in the provider profile sprays them over every model on the route; baking them into custom adapter code makes them impossible to tune through settings. This plugin fills the gap in between: per-model granularity, configured visually at runtime.

## Features

- **Named header profiles**: each profile has an ID plus any number of `header-name` / `value` pairs. IDs must be unique case-insensitively (`Gateway` and `gateway` name the same profile).
- **Persistent configuration**: profiles live under the `custom-headers` name (in the profile's cordis patch under this plugin row's `config` on 0.1.7+, in the user settings document's same-named namespace on 0.1.5) and survive restarts. Every write is validated on the Host; invalid data (duplicate IDs, header names/values Fetch cannot represent) is refused and reported verbatim.
- **Per-model selection**: in **Settings → Models → a provider card → model catalog**, every model row shows a header-profile dropdown (`Default` plus every profile ID). The pick is stored as the `headersProfile` field on the model's `llm-pi-ai` settings row and persists with the document.
- **Applied at call time**: when the model is called, the plugin resolves the profile and stamps the headers onto the request just before the pi-ai adapter dispatches it. Switching back to `Default` — or deleting the profile — restores the original behavior on the very next call.

## Installation

Requires deepseek-harness **0.1.7-rc.1** or **0.1.5-rc.2** (`@deepseek-ai/dsh-*` packages ≥ 0.1.5-rc.2; both settings generations are adapted to, and one build runs on both).

All three options use the DSH CLI to add the plugin to a given profile (`web` in the examples; substitute as needed). The bundled `cordis.patch.yml` is picked up by the composer, which mounts the host half and serves `lib/client.js` to the Web client as `/plugins/dsh-custom-headers/client.js` — no extra composition wiring needed after install.

### From npm

```sh
dsh plugin --profile web add dsh-custom-headers
```

### From GitHub

```sh
dsh plugin --profile web add github:EPCN-fla/dsh-custom-headers
```

When installed from a git source, npm runs the package's `prepare` script to build it automatically (requires Node `^22.19.0` or `>=24`).

### Local development

```sh
git clone https://github.com/EPCN-fla/dsh-custom-headers.git
cd dsh-custom-headers
npm install
npm run build
npm pack        # produces dsh-custom-headers-<version>.tgz
```

Then install the tarball with the CLI:

```sh
dsh plugin --profile web add /path/to/dsh-custom-headers-0.1.0.tgz
```

During development you can also point the CLI at the working-copy directory; re-run `npm run build` after each change.

## Usage

### 1. Create a header profile

- **DSH 0.1.7+**: open the **Plugins** page, open the **dsh-custom-headers** detail page — the **Custom headers** card sits between the package description and its rows;
- **DSH 0.1.5**: open **Settings → Plugins → Plugin configuration** and find the **Custom headers** card below the web-search card.

Expand the card, then:

1. Click **Add profile**; each profile is its own section inside the card — **collapsed by default, showing only its ID**. Click the ID row to expand it.
2. While expanded, edit the **ID** (e.g. `gateway`), and click **+ Add header** to add `header-name` / `value` rows; the row's **−** button removes a row, **Delete profile** removes the whole profile.
3. Click **Save**. While the draft is invalid (empty ID, duplicate ID, unrepresentable header name/value), the save button stays disabled and the offending field is flagged inline.

### 2. Pick a profile for a model

Open **Settings → Models**, expand a provider card, and expand a model's **Capacities** disclosure in the model catalog — the **Request headers** dropdown folds together with the capacity fields and appears on the row below **Context window** and **Max output tokens**:

- **Default**: no custom headers (the initial state).
- A profile ID: subsequent calls to that model carry the profile's headers.

> The dropdown is disabled on unsaved rows (a create card's draft route or a not-yet-saved model row); save the provider first.

### 3. Effective timing and precedence

- Headers are resolved from live settings on **every call**: edits and pick changes reach the next request without a restart.
- On a name collision (case-insensitive), the provider profile's own `headers` **win over** this plugin's per-model headers, and Harness attribution (`User-Agent`) is always owned by Harness — same-named custom entries are filtered out.
- Credential auth headers (`Authorization`, `x-api-key`) are set by the SDK from the provider's credential. To authenticate through a custom scheme, use a custom header name (e.g. a gateway's `X-Api-Key` spelling) and be aware that sharing the credential header's name may be overridden by the SDK.

## Storage format

The user layer under the `custom-headers` name (in the profile's cordis patch under this plugin row's `config` on DSH 0.1.7+; in the user settings document's same-named namespace on DSH 0.1.5. The first 0.1.7 boot imports a legacy `settings.yaml` `custom-headers` section onto this plugin's row automatically):

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

The per-model pick (under `llm-pi-ai`; written by the dropdown, no hand-editing needed):

```yaml
llm-pi-ai:
  providers:
    acme:
      models:
        - id: my-model
          headersProfile: gateway
```

A deployment may also seed composition-base profiles through the plugin's cordis row `config:` block:

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

## Scope and known limitations

- Only calls served by the **pi-ai adapter** (`llm-pi-ai` provider routes, including hand-declared custom providers) are affected; other adapter families (e.g. `deepseek-official`) do not pass through this dispatch path and picks are not applied to them.
- Headers apply to the model's **actual LLM requests**. Configuration-time discovery ("fetch model list from the endpoint") keeps using the provider profile's own headers and does not attach per-model picks.
- The dropdown is injected into the official Models page's per-row Capacities disclosure through DOM anchors because the official slot contract offers no per-model-row extension point. The injector is defensive against the 0.1.5-rc.2 and 0.1.7-rc.1 page structures (identical): if the official structure changes, the plugin simply stops injecting and leaves the page untouched.
- (DSH 0.1.5 only) The card's position on the Plugin configuration tab depends on the shipped web-search card's registration: this plugin waits for it on the slot ledger before registering (with a ~10s fallback timeout); if a deployment strips the shipped plugins package, the card still registers, at whatever position the ledger has then. On DSH 0.1.7+ the card lives on this package's detail page and has no position dependency.
- Repeated header names within one profile resolve last-wins, case-insensitively (Fetch `Headers` semantics).

## Development

```sh
npm install        # install dependencies (.npmrc enables legacy-peer-deps)
npm run typecheck  # typecheck
npm test           # vitest: unit / DOM injection / component / real pi-ai wire tests
npm run build      # emit lib/index.js (host), lib/client.js (web), type declarations
```

All tests live in `tests/`:

| File | Coverage |
|---|---|
| `tests/headers.spec.ts` | Validation, normalization, resolution, and model-row pick reading (pure logic) |
| `tests/host.spec.ts` | Both settings generations (0.1.5 namespace registration / 0.1.7 volatile config), adapter wrapping, header stamping/restoration, teardown |
| `tests/pi-ai-wire.spec.ts` | Real pi-ai openai-completions wire: `model.headers` reach the request, collision precedence, auth intact |
| `tests/ops.spec.ts` | Client settings seams (conflict retry, refusal pass-through, blank-row cleanup) |
| `tests/injector.spec.ts` | Model-row discovery, idempotent injection, staged rows, language anchors |
| `tests/register.spec.ts` | Card registration across both slot generations (0.1.5 `settings.plugin.item` / 0.1.7 `plugins.bundle.config`) |
| `tests/card.spec.tsx` | Profile card: expand, edit, validation gating, save/discard, read-only |
| `tests/select.spec.tsx` | Dropdown: options, writes, missing-profile display, disabled states, Chinese copy |

## License

[MIT](LICENSE)
