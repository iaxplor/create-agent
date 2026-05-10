// Tests do comando `create` em subdir mode (`create-agent meu-bot`).
//
// Cobertura: AC-6 (regressão do comportamento atual) + casos de erro
// pré-existentes (pasta já existe, nome inválido).

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/template-fetcher.js", () => ({
  fetchCoreTemplate: vi.fn(async (targetDir: string) => {
    await writeFile(join(targetDir, "pyproject.toml"), "[project]\n");
    return { version: "0.10.0", python_version: "3.11" };
  }),
}));

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));
vi.mock("execa", () => ({
  execa: execaMock,
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

import { createCommand } from "../src/commands/create.js";
import { UserError } from "../src/utils/errors.js";

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaxplor-create-subdir-"));
  originalCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// =========================================================================== //
//  AC-6 — comportamento clássico (regressão)
// =========================================================================== //

describe("createCommand('meu-bot') — AC-6: subdir mode", () => {
  it("cria subdir, escreve config, roda git init", async () => {
    await createCommand("meu-bot");

    const subdir = join(dir, "meu-bot");
    const config = JSON.parse(
      await readFile(join(subdir, "agente.config.json"), "utf8"),
    ) as { name: string; coreVersion: string };
    expect(config.name).toBe("meu-bot");
    expect(config.coreVersion).toBe("0.10.0");

    // Template copiado pro subdir, não pro cwd
    const pyprojectInSubdir = await readFile(
      join(subdir, "pyproject.toml"),
      "utf8",
    );
    expect(pyprojectInSubdir).toContain("[project]");

    // Cwd NÃO recebeu o pyproject.toml
    await expect(
      readFile(join(dir, "pyproject.toml"), "utf8"),
    ).rejects.toThrow();

    // git init foi chamado no subdir
    const gitInitCalls = execaMock.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "init",
    );
    expect(gitInitCalls).toHaveLength(1);
  });
});

// =========================================================================== //
//  Casos de erro pré-existentes (regressão)
// =========================================================================== //

describe("createCommand subdir mode — erros", () => {
  it("rejeita quando o subdir já existe", async () => {
    await mkdir(join(dir, "meu-bot"), { recursive: true });

    await expect(createCommand("meu-bot")).rejects.toThrow(/já existe/);
  });

  it("rejeita nome com maiúsculas", async () => {
    await expect(createCommand("MeuBot")).rejects.toThrow(UserError);
  });

  it("rejeita nome muito curto", async () => {
    await expect(createCommand("ab")).rejects.toThrow(/curto/);
  });

  it("rejeita nome com hífen duplo", async () => {
    await expect(createCommand("meu--bot")).rejects.toThrow(UserError);
  });
});
