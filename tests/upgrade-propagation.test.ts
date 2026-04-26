// Tests do CLI v0.5.0 — paridade `add`/`upgrade`.
//
// Cobre os 4 helpers introduzidos em `src/commands/upgrade.ts` que
// implementam a paridade com `add`:
//   1. `notifyMigrationsIfPresent` — detecta migrations Alembic no plano
//   2. `reportPatchesDiff` — diff narrativo de patches entre versões
//   3. `loadCoreEnvBlockTarget` — parse minimalista do template.json do
//      core (que não satisfaz `ModuleTemplateJson` completo)
//
// Estratégia: testes puros das helpers (consoles capturados via vi.spyOn).
// Integração `updateEnvExample` + `updatePyproject` em si já é testada nos
// arquivos correspondentes (env-example-editor.test.ts, pyproject-editor.test.ts);
// aqui validamos apenas a CHAMADA dessas helpers no fluxo do upgrade.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadCoreEnvBlockTarget,
  notifyMigrationsIfPresent,
  reportPatchesDiff,
} from "../src/commands/upgrade.js";
import type { UpgradeDecisions } from "../src/utils/upgrade-executor.js";
import type {
  PlanEntry,
  UpgradePlan,
} from "../src/utils/upgrade-planner.js";

// --------------------------------------------------------------------------- //
//  Helpers de fixture
// --------------------------------------------------------------------------- //

function makeEntry(overrides: Partial<PlanEntry> & { relPath: string; status: PlanEntry["status"] }): PlanEntry {
  return {
    relPath: overrides.relPath,
    destPath: `/fake/dest/${overrides.relPath}`,
    sourceNewPath: `/fake/new/${overrides.relPath}`,
    sourceOldPath: null,
    status: overrides.status,
    ...overrides,
  };
}

function makePlan(entries: PlanEntry[]): UpgradePlan {
  return { entries };
}

function emptyDecisions(): UpgradeDecisions {
  return {
    modifiedLocally: new Map(),
    changedRemoteNoBase: new Map(),
    deletedInNew: new Map(),
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function loggedOutput(): string {
  return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
}

// =========================================================================== //
//  notifyMigrationsIfPresent (3 testes)
// =========================================================================== //

describe("notifyMigrationsIfPresent", () => {
  it("não imprime nada quando plano não tem migrations", () => {
    const plan = makePlan([
      makeEntry({ relPath: "integrations/google_calendar/service.py", status: "new" }),
      makeEntry({ relPath: "agent/calendar_metadata.py", status: "new" }),
    ]);
    notifyMigrationsIfPresent(plan, emptyDecisions());
    expect(loggedOutput()).toBe("");
  });

  it("imprime alerta + comando alembic quando migrations novas serão aplicadas", () => {
    const plan = makePlan([
      makeEntry({
        relPath: "migrations/versions/2026_04_26_1500_c3d4e5f6a7b8_create_calendar_events_table.py",
        status: "new",
      }),
    ]);
    notifyMigrationsIfPresent(plan, emptyDecisions());
    const output = loggedOutput();
    expect(output).toContain("migration(s) Alembic");
    expect(output).toContain("uv run alembic upgrade head");
    expect(output).toContain("c3d4e5f6a7b8");
  });

  it("NÃO imprime quando migration está modified-locally e decisão é 'keep'", () => {
    const plan = makePlan([
      makeEntry({
        relPath: "migrations/versions/2026_04_26_old_migration.py",
        status: "modified-locally",
      }),
    ]);
    const decisions: UpgradeDecisions = {
      modifiedLocally: new Map([["migrations/versions/2026_04_26_old_migration.py", "keep"]]),
      changedRemoteNoBase: new Map(),
      deletedInNew: new Map(),
    };
    notifyMigrationsIfPresent(plan, decisions);
    expect(loggedOutput()).toBe("");
  });
});

// =========================================================================== //
//  reportPatchesDiff (4 testes)
// =========================================================================== //

describe("reportPatchesDiff", () => {
  it("não imprime nada quando patches são idênticos", () => {
    const same = [
      { file: "api/main.py", description: "Registrar canal X" },
      { file: "workers/arq_worker.py", description: "Adicionar task Y" },
    ];
    reportPatchesDiff(same, same, "evolution-api");
    expect(loggedOutput()).toBe("");
  });

  it("imprime patches ADICIONADOS na nova versão", () => {
    const old: { file: string; description: string }[] = [];
    const newer = [
      { file: "core/config.py", description: "Adicionar campo NOVO_CAMPO" },
    ];
    reportPatchesDiff(old, newer, "evolution-api");
    const output = loggedOutput();
    expect(output).toContain("alterados nesta versão");
    expect(output).toContain("core/config.py");
    expect(output).toContain("NOVO_CAMPO");
  });

  it("imprime patches REMOVIDOS na nova versão", () => {
    const old = [
      { file: "api/main.py", description: "Velho patch" },
    ];
    const newer: { file: string; description: string }[] = [];
    reportPatchesDiff(old, newer, "evolution-api");
    const output = loggedOutput();
    expect(output).toContain("api/main.py");
    expect(output).toContain("Velho patch");
  });

  it("imprime patches com DESCRIPTION ALTERADA", () => {
    const old = [
      { file: "api/main.py", description: "Registrar canal Evolution" },
    ];
    const newer = [
      { file: "api/main.py", description: "Registrar canal Evolution + outbound sender" },
    ];
    reportPatchesDiff(old, newer, "evolution-api");
    const output = loggedOutput();
    expect(output).toContain("api/main.py");
    expect(output).toContain("antes:");
    expect(output).toContain("agora:");
    expect(output).toContain("outbound sender");
  });
});

// =========================================================================== //
//  loadCoreEnvBlockTarget (3 testes)
// =========================================================================== //

describe("loadCoreEnvBlockTarget", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "iaxplor-cli-core-target-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("retorna EnvBlockTarget quando template.json é válido", async () => {
    const manifest = {
      name: "core",
      version: "0.5.0",
      env_vars: [
        { name: "DATABASE_URL", required: true },
        { name: "BUFFER_TEXT_WINDOW", required: false, default: "30" },
      ],
    };
    await writeFile(join(tmpDir, "template.json"), JSON.stringify(manifest));
    const result = await loadCoreEnvBlockTarget(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("core");
    expect(result!.version).toBe("0.5.0");
    expect(result!.env_vars).toHaveLength(2);
    expect(result!.env_vars[0].name).toBe("DATABASE_URL");
    expect(result!.env_vars[1].default).toBe("30");
  });

  it("retorna null quando template.json não existe", async () => {
    const result = await loadCoreEnvBlockTarget(tmpDir);
    expect(result).toBeNull();
  });

  it("retorna null quando template.json é malformado (faltam name/version)", async () => {
    await writeFile(
      join(tmpDir, "template.json"),
      JSON.stringify({ env_vars: [] }),
    );
    const result = await loadCoreEnvBlockTarget(tmpDir);
    expect(result).toBeNull();
  });
});
