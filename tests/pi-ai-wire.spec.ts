/**
 * Real-wire proof of the seam the host half stamps: pi-ai sends
 * `model.headers` on the request, profile-level options headers override
 * them per name, and credential auth stays intact. Exercises the genuine
 * `@earendil-works/pi-ai` openai-completions stream against a stubbed
 * global fetch — the exact call dsh-llm-pi-ai's adapter makes after this
 * plugin stamps the resolved model descriptor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

/** Minimal chat-completion SSE reply (one content chunk, a stop, [DONE]). */
const SSE_BODY = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

interface Captured {
  url: string
  headers: Headers
  body: unknown
}

describe('pi-ai wire contract for model.headers', () => {
  const originalFetch = globalThis.fetch
  let captured: Captured | undefined

  beforeEach(() => {
    captured = undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      }
      return new Response(SSE_BODY, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends stamped model headers; profile headers win collisions; auth survives', async () => {
    // The descriptor shape dsh-llm-pi-ai's catalog resolution returns; this
    // plugin stamps exactly the `headers` own-property of such an object.
    const model = {
      id: 'm1',
      name: 'm1',
      api: 'openai-completions',
      provider: 'acme',
      baseUrl: 'https://gw.example/v1',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
      // What the host half stamps (custom profile "gw": X-Tenant + X-Billable).
      headers: { 'X-Tenant': 'custom', 'X-Billable': 'yes' },
    } as unknown as Parameters<typeof streamSimple>[0]
    const context = {
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    } as unknown as Parameters<typeof streamSimple>[1]

    const stream = streamSimple(model, context, {
      apiKey: 'test-key',
      // The profile-level headers dsh-llm-pi-ai passes alongside.
      headers: { 'X-Tenant': 'profile-wins' },
    } as Parameters<typeof streamSimple>[2])
    for await (const _event of stream) { /* drain */ }

    expect(captured).toBeDefined()
    expect(captured?.url).toBe('https://gw.example/v1/chat/completions')
    // The custom model headers reached the wire.
    expect(captured?.headers.get('x-billable')).toBe('yes')
    // Name collision: the provider profile's own headers (deployment-owned)
    // win over the per-model custom pick, matching pi-ai's merge order.
    expect(captured?.headers.get('x-tenant')).toBe('profile-wins')
    // Credential auth is applied by the SDK on top and stays intact.
    expect(captured?.headers.get('authorization')).toBe('Bearer test-key')
    // Harness/pi-ai attribution is present (the plugin never stamps it).
    expect(captured?.headers.get('user-agent')).toBeTruthy()
  })
})
