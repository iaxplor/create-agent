// Tests do `upgrade --check` (CI gate, CLI v0.7.0+).
//
// Arquivo separado de upgrade-propagation.test.ts pra isolar o vi.mock de
// listProjectComponents + readAgenteConfig — esses helpers não são usados
// pelas outras suites, mas mock global afetaria todo o arquivo.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCheckMode } from "../src/commands/upgrade.js";
import type { ComponentVersion } from "../src/utils/version-manifest.js";

// Mock os 2 helpers que runCheckMode chama. Espelhamos a assinatura real.
vi.mock("../src/utils/version-manifest.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listProjectComponents: vi.fn(),
  };
});

import { listProjectComponents } from "../src/utils/version-manifest.js";

// --------------------------------------------------------------------------- //
//  Setup tmpdir + agente.config.json mínimo (readAgenteConfig precisa do file)
// --------------------------------------------------------------------------- //

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaxplor-upgrade-check-test-"));
  await writeFile(
    join(dir, "agente.config.json"),
    JSON.stringify({
      name: "smoke",
      version: "0.1.0",
      coreVersion: "0.6.0",
      createdAt: new Date().toISOString(),
      modules: {},
      python: { packageManager: "uv", version: "3.11" },
    }),
  );
  originalCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// --------------------------------------------------------------------------- //
//  Fixtures
// --------------------------------------------------------------------------- //

function comp(
  target: string,
  installed: string,
  available: string,
  hasUpdate: boolean,
): ComponentVersion {
  return {
    target,
    displayName: target,
    installedVersion: installed,
    availableVersion: available,
    hasUpdate,
  };
}

// =========================================================================== //
//  Testes
// =========================================================================== //

describe("runCheckMode", () => {
  it("retorna exitCode 0 + updates vazio quando tudo atualizado", async () => {
    vi.mocked(listProjectComponents).mockResolvedValueOnce([
      comp("core", "0.6.0", "0.6.0", false),
    ]);
    const result = await runCheckMode({});
    expect(result.exitCode).toBe(0);
    expect(result.updates).toHaveLength(0);
  });

  it("retorna exitCode 1 + 1 update quando 1 módulo desatualizado", async () => {
    vi.mocked(listProjectComponents).mockResolvedValueOnce([
      comp("core", "0.6.0", "0.6.0", false),
      comp("google-calendar", "0.4.0", "0.4.1", true),
    ]);
    const result = await runCheckMode({});
    expect(result.exitCode).toBe(1);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.target).toBe("google-calendar");
  });

  it("retorna exitCode 1 + N updates quando core + 2 módulos desatualizados", async () => {
    vi.mocked(listProjectComponents).mockResolvedValueOnce([
      comp("core", "0.5.0", "0.6.0", true),
      comp("google-calendar", "0.4.0", "0.4.1", true),
      comp("evolution-api", "0.3.0", "0.4.0", true),
    ]);
    const result = await runCheckMode({});
    expect(result.exitCode).toBe(1);
    expect(result.updates).toHaveLength(3);
  });
});
