// Testes unitários pro pyproject-editor.
//
// Foco:
//   - Inserção preserva formato (comentários, indentação, seções não mexidas).
//   - Detecção de deps já presentes (skip silencioso).
//   - Detecção de conflito de versão (warning, NÃO sobrescreve).
//   - Normalização PEP 503 de nomes (psycopg[binary] = psycopg).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _internals,
  updatePyproject,
} from "../src/utils/pyproject-editor.js";

const SAMPLE_PYPROJECT = `[project]
name = "iaxplor-agent"
version = "0.1.0"
description = "Test project"
requires-python = ">=3.11"

# Dependências principais
dependencies = [
    "agno>=2.5.17",
    "fastapi>=0.115",
    "psycopg[binary]>=3.2",
]

[tool.uv]
package = false

[tool.ruff]
line-length = 100
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaxplor-pyedit-test-"));
  await writeFile(join(dir, "pyproject.toml"), SAMPLE_PYPROJECT, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// =============================================================================
// Testes
// =============================================================================

describe("updatePyproject — happy path", () => {
  it("adiciona deps novas preservando seções e comentários", async () => {
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["httpx>=0.27", "openai>=1.50"],
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(result.added).toEqual(["httpx>=0.27", "openai>=1.50"]);
    expect(result.versionConflicts).toEqual([]);
    expect(result.alreadyPresent).toEqual([]);

    const content = await readFile(join(dir, "pyproject.toml"), "utf8");
    // Deps novas presentes.
    expect(content).toContain('"httpx>=0.27"');
    expect(content).toContain('"openai>=1.50"');
    // Deps originais intactas.
    expect(content).toContain('"agno>=2.5.17"');
    expect(content).toContain('"psycopg[binary]>=3.2"');
    // Comentário preservado.
    expect(content).toContain("# Dependências principais");
    // Seção [tool.ruff] não modificada.
    expect(content).toContain("[tool.ruff]");
    expect(content).toContain("line-length = 100");
  });

  it("preserva indentação (4 espaços) das linhas existentes", async () => {
    await updatePyproject({
      projectDir: dir,
      dependencies: ["newdep>=1.0"],
      dryRun: false,
    });
    const content = await readFile(join(dir, "pyproject.toml"), "utf8");
    // Linha nova deve começar com 4 espaços (indent herdado).
    expect(content).toMatch(/^    "newdep>=1\.0",$/m);
  });

  it("respeita dry-run (não escreve)", async () => {
    const before = await readFile(join(dir, "pyproject.toml"), "utf8");
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["httpx>=0.27"],
      dryRun: true,
    });
    expect(result.applied).toBe(true);
    expect(result.added).toEqual(["httpx>=0.27"]);
    const after = await readFile(join(dir, "pyproject.toml"), "utf8");
    expect(after).toBe(before);
  });
});

describe("updatePyproject — detecção de deps existentes", () => {
  it("skip silencioso quando dep já existe com mesma constraint", async () => {
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["agno>=2.5.17"],
      dryRun: false,
    });
    expect(result.applied).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual(["agno"]);
    expect(result.versionConflicts).toEqual([]);

    // Conteúdo não duplicou.
    const content = await readFile(join(dir, "pyproject.toml"), "utf8");
    const matches = content.match(/"agno>=2\.5\.17"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("warning quando dep existe com constraint diferente (NÃO sobrescreve)", async () => {
    const result = await updatePyproject({
      projectDir: dir,
      // Existente: agno>=2.5.17. Requisitado: agno>=3.0
      dependencies: ["agno>=3.0"],
      dryRun: false,
    });
    expect(result.applied).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.versionConflicts).toHaveLength(1);
    expect(result.versionConflicts[0]).toMatchObject({
      name: "agno",
      existing: "agno>=2.5.17",
      requested: "agno>=3.0",
    });

    // Conteúdo NÃO deve ter agno>=3.0.
    const content = await readFile(join(dir, "pyproject.toml"), "utf8");
    expect(content).not.toContain("agno>=3.0");
    expect(content).toContain('"agno>=2.5.17"');
  });

  it("mistura: 1 dep nova + 1 já presente + 1 conflito", async () => {
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["httpx>=0.27", "agno>=2.5.17", "fastapi>=0.116"],
      dryRun: false,
    });
    expect(result.added).toEqual(["httpx>=0.27"]);
    expect(result.alreadyPresent).toEqual(["agno"]);
    expect(result.versionConflicts).toHaveLength(1);
    expect(result.versionConflicts[0]?.name).toBe("fastapi");
  });
});

describe("updatePyproject — erros e casos de borda", () => {
  it("falha graciosamente quando pyproject.toml não existe", async () => {
    await rm(join(dir, "pyproject.toml"));
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["httpx>=0.27"],
      dryRun: false,
    });
    expect(result.applied).toBe(false);
    expect(result.errorMessage).toContain("não encontrado");
  });

  it("falha graciosamente com pyproject sem [project].dependencies", async () => {
    await writeFile(
      join(dir, "pyproject.toml"),
      `[project]\nname = "foo"\n\n[tool.uv]\npackage = false\n`,
      "utf8",
    );
    const result = await updatePyproject({
      projectDir: dir,
      dependencies: ["httpx>=0.27"],
      dryRun: false,
    });
    expect(result.applied).toBe(false);
    expect(result.errorMessage).toContain("dependencies");
  });

  it("normaliza PEP 503: psycopg vs psycopg[binary] conta como mesmo pacote", () => {
    const a = _internals.normalizeName("psycopg[binary]");
    const b = _internals.normalizeName("psycopg");
    expect(a).toBe(b);
  });
});

describe("parseDep", () => {
  const { parseDep } = _internals;

  it("extrai name e constraint de `pkg>=1.0`", () => {
    expect(parseDep("httpx>=0.27")).toEqual({
      name: "httpx",
      constraint: ">=0.27",
      raw: "httpx>=0.27",
    });
  });

  it("lida com extras (`psycopg[binary]>=3.2`)", () => {
    expect(parseDep("psycopg[binary]>=3.2")).toEqual({
      name: "psycopg",
      constraint: ">=3.2",
      raw: "psycopg[binary]>=3.2",
    });
  });

  it("sem constraint → constraint=null", () => {
    expect(parseDep("httpx")).toEqual({
      name: "httpx",
      constraint: null,
      raw: "httpx",
    });
  });

  it("normaliza underscore/dot: `my_pkg` = `my-pkg`", () => {
    expect(parseDep("my_pkg>=1.0").name).toBe("my-pkg");
    expect(parseDep("my.pkg>=1.0").name).toBe("my-pkg");
  });
});
