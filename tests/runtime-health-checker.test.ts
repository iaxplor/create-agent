// Tests do runtime-health-checker (CLI v0.8.6+, doctor V13).
//
// Mocka `fetch` global pra simular cenários de Evolution API sem rede real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkEvolutionHealth } from "../src/utils/runtime-health-checker.js";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Response | Promise<Response>): void {
  vi.mocked(globalThis.fetch).mockImplementation(async () => impl());
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("checkEvolutionHealth", () => {
  it("state=open → ok", async () => {
    mockFetch(() => jsonResponse(200, { instance: { state: "open" } }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.message).toContain("state=open");
  });

  it("state=connecting → degraded (WhatsApp desconectado)", async () => {
    mockFetch(() => jsonResponse(200, { instance: { state: "connecting" } }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("connecting");
    expect(result.message).toContain("desconectado");
  });

  it("HTTP 401 → unreachable + msg sobre EVOLUTION_API_KEY", async () => {
    mockFetch(() => new Response(null, { status: 401 }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "wrong-key",
      instanceName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.message).toContain("EVOLUTION_API_KEY");
  });

  it("HTTP 404 (instance não existe) → unreachable", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "nope",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("instance 'nope'");
  });

  it("HTTP 500 → unreachable", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 500");
  });

  it("body sem instance.state → degraded (schema inesperado)", async () => {
    mockFetch(() => jsonResponse(200, { weird: "shape" }));
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("schema inesperado");
  });

  it("connection refused → unreachable com tipo da exception", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.message).toContain("TypeError");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("timeout via AbortController → unreachable com 'timeout'", async () => {
    mockFetch(() => {
      const err = new Error("operation aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await checkEvolutionHealth({
      url: "https://evo.example.com",
      apiKey: "fake",
      instanceName: "test",
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.message).toContain("timeout após 100ms");
  });
});
