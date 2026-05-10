// Tests do comando `create` em hereMode (`create-agent .`).
//
// Cobertura: AC-1 a AC-5, AC-7, AC-8 do plano de "create-agent .".
// Estratégia: mock `template-fetcher` (popula targetDir com arquivos fake,
// sem network) + mock `execa` (rastreia chamadas a `git init`).

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do template-fetcher: popula o targetDir com 2 arquivos fake e
// retorna um TemplateJson minimal. Sem rede.
vi.mock("../src/utils/template-fetcher.js", () => ({
  fetchCoreTemplate: vi.fn(async (targetDir: string) => {
    await writeFile(join(targetDir, "pyproject.toml"), "[project]\nname='fake'\n");
    await mkdir(join(targetDir, "agent"), { recursive: true });
    await writeFile(join(targetDir, "agent", "instructions.py"), "INSTRUCTIONS = []\n");
    return { version: "0.10.0", python_version: "3.11" };
  }),
}));

// Mock do execa: rastreia chamadas (usado pra asserir que `git init`
// NÃO foi chamado quando .git/ já existe). vi.hoisted é necessário porque
// vi.mock é içado pro topo do arquivo — referenciar uma const top-level
// gera ReferenceError.
const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));
vi.mock("execa", () => ({
  execa: execaMock,
}));

// Silencia output do banner/spinner/logs pra não poluir saída do test runner.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// Import depois dos mocks pra que `createCommand` resolva os mockados.
import { createCommand } from "../src/commands/create.js";
import { UserError } from "../src/utils/errors.js";

// `mkdtemp` retorna pastas com sufixo random contendo maiúsculas. Como o
// hereMode deriva o nome do projeto do basename do cwd, criamos uma subpasta
// com nome válido (kebab-case) e fazemos chdir pra ela. `parentDir` é só pra
// cleanup; `dir` é onde os testes rodam.
let parentDir: string;
let dir: string;
let originalCwd: string;

beforeEach(async () => {
  parentDir = await mkdtemp(join(tmpdir(), "iaxplor-create-here-"));
  dir = join(parentDir, "meu-bot");
  await mkdir(dir, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(parentDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// =========================================================================== //
//  AC-1 — cwd vazio
// =========================================================================== //

describe("createCommand('.') — AC-1: cwd vazio", () => {
  it("cria o projeto no cwd e roda git init", async () => {
    await createCommand(".");

    // agente.config.json no cwd
    const config = JSON.parse(
      await readFile(join(dir, "agente.config.json"), "utf8"),
    ) as { name: string; coreVersion: string };
    expect(config.coreVersion).toBe("0.10.0");

    // template foi copiado (via mock)
    const pyproject = await readFile(join(dir, "pyproject.toml"), "utf8");
    expect(pyproject).toContain("[project]");

    // git init foi chamado uma vez
    const gitInitCalls = execaMock.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "init",
    );
    expect(gitInitCalls).toHaveLength(1);
  });
});

// =========================================================================== //
//  AC-2 — cwd com só .git/ (clone vazio do GitHub)
// =========================================================================== //

describe("createCommand('.') — AC-2: cwd com .git/", () => {
  it("cria o projeto e PULA git init (já é repo)", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });

    await createCommand(".");

    // Projeto criado normalmente
    expect(
      JSON.parse(await readFile(join(dir, "agente.config.json"), "utf8")),
    ).toMatchObject({ coreVersion: "0.10.0" });

    // git init NÃO foi chamado
    const gitInitCalls = execaMock.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "init",
    );
    expect(gitInitCalls).toHaveLength(0);
  });
});

// =========================================================================== //
//  AC-3 — cwd com arquivos não-whitelist
// =========================================================================== //

describe("createCommand('.') — AC-3: cwd sujo", () => {
  it("rejeita listando os arquivos conflitantes, sem tocar no cwd", async () => {
    await writeFile(join(dir, "random.txt"), "lixo");
    await writeFile(join(dir, "outro.md"), "lixo2");

    await expect(createCommand(".")).rejects.toThrow(UserError);

    try {
      await createCommand(".");
    } catch (err) {
      expect((err as UserError).message).toContain("random.txt");
      expect((err as UserError).message).toContain("outro.md");
    }

    // cwd intocado: arquivos originais ainda lá, sem agente.config.json
    expect(
      await readFile(join(dir, "random.txt"), "utf8"),
    ).toBe("lixo");
    await expect(
      readFile(join(dir, "agente.config.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("aceita .git/ na lista (whitelist) mas rejeita resto", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "preexistente");

    await expect(createCommand(".")).rejects.toThrow(/README\.md/);
  });
});

// =========================================================================== //
//  AC-4 — projeto já criado (idempotência)
// =========================================================================== //

describe("createCommand('.') — AC-4: agente.config.json já existe", () => {
  it("rejeita com mensagem mencionando 'já' e 'upgrade'", async () => {
    await writeFile(
      join(dir, "agente.config.json"),
      JSON.stringify({ name: "old", version: "0.0.1" }),
    );

    await expect(createCommand(".")).rejects.toThrow(/já/);

    // Mensagem orienta usar upgrade
    try {
      await createCommand(".");
    } catch (err) {
      expect((err as UserError).message).toContain("upgrade");
    }
  });
});

// =========================================================================== //
//  AC-5 — basename do cwd não é slug válido
// =========================================================================== //

describe("createCommand('.') — AC-5: basename inválido", () => {
  it("rejeita quando o nome da pasta tem maiúsculas/underscores", async () => {
    // Sai do dir padrão (cleanup do afterEach cuida do parentDir).
    process.chdir(originalCwd);
    // Cria uma árvore separada com nome inválido pelo regex.
    const isolated = await mkdtemp(join(tmpdir(), "iaxplor-create-here-bad-"));
    const badDir = join(isolated, "My_Bot");
    await mkdir(badDir, { recursive: true });
    process.chdir(badDir);

    try {
      await createCommand(".");
      expect.fail("createCommand deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(UserError);
      expect((err as UserError).message).toMatch(/My_Bot/);
      expect((err as UserError).message).toMatch(/inválid/i);
    } finally {
      process.chdir(originalCwd);
      await rm(isolated, { recursive: true, force: true });
    }
  });
});

// =========================================================================== //
//  AC-7 — name field deriva do basename(cwd)
// =========================================================================== //

describe("createCommand('.') — AC-7: name vem do basename", () => {
  it("agente.config.json.name === basename(cwd)", async () => {
    // O setup padrão já faz chdir pra `<parent>/meu-bot` — basta usar.
    await createCommand(".");

    const config = JSON.parse(
      await readFile(join(dir, "agente.config.json"), "utf8"),
    ) as { name: string };
    expect(config.name).toBe("meu-bot");
  });
});

// =========================================================================== //
//  AC-8 — falha de fetch NÃO remove o cwd
// =========================================================================== //

describe("createCommand('.') — AC-8: cleanup não remove cwd", () => {
  it("falha do fetcher preserva o cwd", async () => {
    // Re-mock o fetcher pra falhar
    const { fetchCoreTemplate } = await import(
      "../src/utils/template-fetcher.js"
    );
    vi.mocked(fetchCoreTemplate).mockRejectedValueOnce(
      new Error("network down"),
    );

    await expect(createCommand(".")).rejects.toThrow("network down");

    // Cwd ainda existe (não foi removido como cleanup)
    const stat = await import("node:fs/promises").then((m) => m.stat(dir));
    expect(stat.isDirectory()).toBe(true);
  });
});
