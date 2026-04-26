// Tests do comando `doctor` (CLI v0.6.0).
//
// Estratégia: testar cada validação em isolamento via funções helper
// exportadas — sem network, sem fs, sem `doctorCommand` end-to-end.
// Smoke pós-publish cobre o fluxo completo (ver plan).

import { describe, expect, it, vi } from "vitest";

import {
  _internals,
  checkMinCoreVersion,
  checkRequiredEnvVars,
  renderFindings,
  reportVersionAvailability,
  shouldExitStrict,
  validateConfigStructure,
  type Finding,
} from "../src/commands/doctor.js";
import type { AgenteConfig, ModuleTemplateJson } from "../src/types.js";
import type { ComponentVersion } from "../src/utils/version-manifest.js";

// --------------------------------------------------------------------------- //
//  Helpers de fixture
// --------------------------------------------------------------------------- //

function makeConfig(overrides: Partial<AgenteConfig> = {}): AgenteConfig {
  return {
    name: "smoke",
    version: "0.1.0",
    coreVersion: "0.6.0",
    createdAt: new Date().toISOString(),
    modules: {},
    python: { packageManager: "uv", version: "3.11" },
    ...overrides,
  };
}

function makeManifest(
  overrides: Partial<ModuleTemplateJson> = {},
): ModuleTemplateJson {
  return {
    name: "google-calendar",
    version: "0.4.1",
    description: "test",
    requires: ["core"],
    min_core_version: "0.5.0",
    dependencies: [],
    env_vars: [],
    files: [],
    patches: [],
    ...overrides,
  };
}

// =========================================================================== //
//  V1 — validateConfigStructure
// =========================================================================== //

describe("validateConfigStructure (V1)", () => {
  it("retorna 1 finding 'ok' pra projeto válido sem módulos", () => {
    const findings = validateConfigStructure(makeConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("ok");
    expect(findings[0]?.section).toBe("agente.config.json");
  });

  it("flagra coreVersion não-semver como error", () => {
    const findings = validateConfigStructure(
      makeConfig({ coreVersion: "abc" }),
    );
    const errors = findings.filter((f) => f.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/coreVersion 'abc'/);
  });

  it("flagra version de módulo não-semver como error", () => {
    const findings = validateConfigStructure(
      makeConfig({
        modules: {
          "google-calendar": {
            version: "latest",
            installedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const errors = findings.filter((f) => f.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/'latest'/);
  });
});

describe("isValidSemver (V1 helper)", () => {
  it.each([
    ["0.6.0", true],
    ["1.0.0", true],
    ["0.0.0", true],
    ["0.6.0-rc.1", true],
    ["0.6.0+build", true],
    ["abc", false],
    ["0.6", false],
    ["0.6.0.1", false],
    ["v0.6.0", false],
    ["", false],
  ])("'%s' → %s", (input, expected) => {
    expect(_internals.isValidSemver(input)).toBe(expected);
  });
});

// =========================================================================== //
//  V2 — reportVersionAvailability
// =========================================================================== //

describe("reportVersionAvailability (V2)", () => {
  it("OK quando versão instalada bate com disponível", () => {
    const components: ComponentVersion[] = [
      {
        target: "core",
        displayName: "core",
        installedVersion: "0.6.0",
        availableVersion: "0.6.0",
        hasUpdate: false,
      },
    ];
    const findings = reportVersionAvailability(components);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("ok");
    expect(findings[0]?.message).toBe("última versão");
  });

  it("warn quando há update disponível, com hint do comando upgrade", () => {
    const components: ComponentVersion[] = [
      {
        target: "google-calendar",
        displayName: "google-calendar",
        installedVersion: "0.4.0",
        availableVersion: "0.4.1",
        hasUpdate: true,
      },
    ];
    const findings = reportVersionAvailability(components);
    expect(findings[0]?.level).toBe("warn");
    expect(findings[0]?.message).toContain("0.4.1");
    expect(findings[0]?.message).toContain(
      "create-agent upgrade google-calendar",
    );
  });
});

// =========================================================================== //
//  V3 — checkMinCoreVersion
// =========================================================================== //

describe("checkMinCoreVersion (V3)", () => {
  it("OK quando coreVersion satisfaz min_core_version", () => {
    const manifest = makeManifest({ min_core_version: "0.5.0" });
    const findings = checkMinCoreVersion(
      "google-calendar",
      "0.4.1",
      manifest,
      "0.6.0",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("ok");
  });

  it("error quando coreVersion < min_core_version", () => {
    const manifest = makeManifest({ min_core_version: "0.6.0" });
    const findings = checkMinCoreVersion(
      "google-calendar",
      "0.4.1",
      manifest,
      "0.5.0",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("error");
    expect(findings[0]?.message).toMatch(/requer core >= 0\.6\.0/);
    expect(findings[0]?.message).toMatch(/projeto está em 0\.5\.0/);
  });
});

// =========================================================================== //
//  V4 — checkRequiredEnvVars
// =========================================================================== //

describe("checkRequiredEnvVars (V4)", () => {
  it("OK quando todas as required estão declaradas", () => {
    const findings = checkRequiredEnvVars(
      ".env.example (test)",
      [
        { name: "FOO", required: true },
        { name: "BAR", required: true },
        { name: "OPT", required: false },
      ],
      new Set(["FOO", "BAR"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("ok");
    expect(findings[0]?.message).toContain("2 env var(s) required");
  });

  it("error pra cada required ausente, ignorando opcionais ausentes", () => {
    const findings = checkRequiredEnvVars(
      ".env.example (test)",
      [
        { name: "FOO", required: true },
        { name: "BAR", required: true },
        { name: "OPT", required: false },
      ],
      new Set(["FOO"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("error");
    expect(findings[0]?.message).toContain("BAR");
    expect(findings[0]?.message).not.toContain("OPT");
  });

  it("OK quando manifest não declara nenhuma required", () => {
    const findings = checkRequiredEnvVars(
      ".env.example (test)",
      [{ name: "OPT", required: false }],
      new Set(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe("ok");
    expect(findings[0]?.message).toContain("0 env var(s)");
  });
});

// =========================================================================== //
//  renderFindings — output agrupado e sumário correto (multi-issue)
// =========================================================================== //

describe("renderFindings", () => {
  it("agrupa por seção e calcula sumário (3 erros, 1 warning, 2 OK)", () => {
    const findings: Finding[] = [
      { section: "agente.config.json", level: "ok", message: "ok" },
      { section: "core 0.6.0", level: "ok", message: "ok" },
      { section: "google-calendar 0.4.0", level: "warn", message: "update" },
      { section: ".env.example (core)", level: "error", message: "FOO" },
      { section: ".env.example (core)", level: "error", message: "BAR" },
      { section: ".env.example (gcal)", level: "error", message: "GCAL_X" },
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderFindings(findings);
      const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      // Cada seção aparece como header
      expect(output).toContain("agente.config.json");
      expect(output).toContain("core 0.6.0");
      expect(output).toContain("google-calendar 0.4.0");
      // Sumário tem contagem correta
      expect(output).toMatch(/3 erro/);
      expect(output).toMatch(/1 warning/);
      expect(output).toMatch(/2 OK/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("imprime mensagem de sucesso quando 0 erros e 0 warnings", () => {
    const findings: Finding[] = [
      { section: "agente.config.json", level: "ok", message: "ok" },
      { section: "core 0.6.0", level: "ok", message: "ok" },
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      renderFindings(findings);
      const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(output).toMatch(/Tudo OK \(2 verifica/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// =========================================================================== //
//  shouldExitStrict (CI gate v0.7.0+)
// =========================================================================== //

describe("shouldExitStrict (CI gate)", () => {
  it("retorna false sem --strict mesmo com errors (default informativo)", () => {
    const findings: Finding[] = [
      { section: "x", level: "error", message: "boom" },
    ];
    expect(shouldExitStrict(findings, {})).toBe(false);
    expect(shouldExitStrict(findings, { strict: false })).toBe(false);
  });

  it("retorna false com --strict se 0 errors (warnings não contam)", () => {
    const findings: Finding[] = [
      { section: "x", level: "ok", message: "ok" },
      { section: "y", level: "warn", message: "atenção" },
    ];
    expect(shouldExitStrict(findings, { strict: true })).toBe(false);
  });

  it("retorna true com --strict + pelo menos 1 error", () => {
    const findings: Finding[] = [
      { section: "x", level: "ok", message: "ok" },
      { section: "y", level: "warn", message: "atenção" },
      { section: "z", level: "error", message: "boom" },
    ];
    expect(shouldExitStrict(findings, { strict: true })).toBe(true);
  });
});
