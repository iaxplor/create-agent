// Tests do upgrade-executor (CLI v0.8.0+).
//
// Foco: novos actions adicionados na v0.8.0 — `generate-template` (PROTECTED
// agent/*) e `merge` (MERGED .gitignore/.env.example placeholder).
// Comportamento clássico (copy-new/overwrite/delete/keep/skip) já é coberto
// implicitamente pelos tests de upgrade-planner + upgrade-propagation.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeUpgrade,
  resolveAction,
  type UpgradeDecisions,
} from "../src/utils/upgrade-executor.js";
import type { PlanEntry, UpgradePlan } from "../src/utils/upgrade-planner.js";

// --------------------------------------------------------------------------- //
//  Helpers de fixture
// --------------------------------------------------------------------------- //

let projectDir: string;
let snapshotDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "iaxplor-exec-proj-"));
  snapshotDir = await mkdtemp(join(tmpdir(), "iaxplor-exec-snap-"));
  // Mínimo pra readAgenteConfig funcionar no updateConfigVersion final.
  await writeFile(
    join(projectDir, "agente.config.json"),
    JSON.stringify({
      name: "test",
      version: "0.1.0",
      coreVersion: "0.5.0",
      createdAt: new Date().toISOString(),
      modules: {},
      python: { packageManager: "uv", version: "3.11" },
    }),
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
  await rm(snapshotDir, { recursive: true, force: true });
});

function emptyDecisions(): UpgradeDecisions {
  return {
    modifiedLocally: new Map(),
    changedRemoteNoBase: new Map(),
    deletedInNew: new Map(),
  };
}

async function writeSnapshotFile(relPath: string, content: string): Promise<string> {
  const abs = join(snapshotDir, relPath);
  const parent = abs.substring(0, abs.lastIndexOf("/"));
  await mkdir(parent, { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
}

function planWith(entries: PlanEntry[]): UpgradePlan {
  return { entries, baseAvailable: true };
}

// =========================================================================== //
//  resolveAction — mapeamento status → action (ADR-006)
// =========================================================================== //

describe("resolveAction", () => {
  it("status 'protected-skipped' → action 'generate-template'", () => {
    const entry: PlanEntry = {
      relPath: "agent/instructions.py",
      status: "protected-skipped",
      destPath: "/x/agent/instructions.py",
      sourceNewPath: "/y/agent/instructions.py",
    };
    expect(resolveAction(entry, emptyDecisions())).toBe("generate-template");
  });

  it("status 'merged' → action 'merge'", () => {
    const entry: PlanEntry = {
      relPath: ".gitignore",
      status: "merged",
      destPath: "/x/.gitignore",
      sourceNewPath: "/y/.gitignore",
    };
    expect(resolveAction(entry, emptyDecisions())).toBe("merge");
  });
});

// =========================================================================== //
//  Action 'generate-template' — Bloco A (US-1)
// =========================================================================== //

describe("executeUpgrade — generate-template (PROTECTED agent/*)", () => {
  it("gera <path>.template lateral sem tocar o arquivo do aluno", async () => {
    // Aluno tem agent/instructions.py com 70 linhas customizadas
    await mkdir(join(projectDir, "agent"), { recursive: true });
    const alunoContent = "# 70 linhas de system prompt do aluno\n".repeat(70);
    await writeFile(join(projectDir, "agent/instructions.py"), alunoContent);

    // Snapshot novo tem skeleton diferente
    const sourceNewPath = await writeSnapshotFile(
      "agent/instructions.py",
      "# skeleton novo do template (vazio)\n",
    );

    const plan = planWith([
      {
        relPath: "agent/instructions.py",
        status: "protected-skipped",
        destPath: join(projectDir, "agent/instructions.py"),
        sourceNewPath,
      },
    ]);

    const result = await executeUpgrade({
      plan,
      decisions: emptyDecisions(),
      projectDir,
      newVersion: "0.6.0",
      target: "core",
      dryRun: false,
    });

    // Arquivo do aluno PERMANECE intacto
    const alunoFinal = await readFile(join(projectDir, "agent/instructions.py"), "utf8");
    expect(alunoFinal).toBe(alunoContent);

    // .template lateral foi criado com conteúdo do snapshot novo
    const templatePath = join(projectDir, "agent/instructions.py.template");
    expect(existsSync(templatePath)).toBe(true);
    const templateContent = await readFile(templatePath, "utf8");
    expect(templateContent).toBe("# skeleton novo do template (vazio)\n");

    // Reportado em result.templatesGenerated
    expect(result.templatesGenerated).toEqual(["agent/instructions.py"]);
    expect(result.copied).toEqual([]);
    expect(result.overwritten).toEqual([]);
  });

  it("dry-run não escreve nem cria .template", async () => {
    const sourceNewPath = await writeSnapshotFile(
      "agent/novo.py",
      "skeleton novo\n",
    );

    const plan = planWith([
      {
        relPath: "agent/novo.py",
        status: "protected-skipped",
        destPath: join(projectDir, "agent/novo.py"),
        sourceNewPath,
      },
    ]);

    const result = await executeUpgrade({
      plan,
      decisions: emptyDecisions(),
      projectDir,
      newVersion: "0.6.0",
      target: "core",
      dryRun: true,
    });

    // Nem o arquivo nem o .template foram criados
    expect(existsSync(join(projectDir, "agent/novo.py"))).toBe(false);
    expect(existsSync(join(projectDir, "agent/novo.py.template"))).toBe(false);

    // Mas o resultado reporta que SERIA gerado (pra mensagem do usuário)
    expect(result.templatesGenerated).toEqual(["agent/novo.py"]);
    expect(result.dryRun).toBe(true);
  });
});
