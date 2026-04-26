// Testes unitários pro env-example-editor.
//
// Foco:
//   - Degradação graciosa com template.json legado (sem campo `default`).
//   - Detecção de bloco versioned com QUALQUER versão (upgrade 0.1.0 → 0.2.0).
//   - Duplicatas fora do bloco.
//   - Escape de valores com caracteres especiais.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _internals, updateEnvExample } from "../src/utils/env-example-editor.js";
import type { ModuleTemplateJson } from "../src/types.js";

// -------- Fixtures ---------

function makeManifest(
  overrides: Partial<ModuleTemplateJson> = {},
): ModuleTemplateJson {
  return {
    name: "evolution-api",
    version: "0.1.0",
    description: "test",
    requires: ["core"],
    min_core_version: "0.1.0",
    dependencies: [],
    env_vars: [
      { name: "EVOLUTION_URL", required: true },
      { name: "EVOLUTION_API_KEY", required: true },
      {
        name: "TRANSCRIPTION_MODEL",
        required: false,
        default: "gpt-4o-mini-transcribe",
      },
    ],
    files: [],
    patches: [],
    ...overrides,
  };
}

// -------- Setup temp dir pra cada teste ---------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaxplor-envedit-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// =============================================================================
// Testes
// =============================================================================

describe("updateEnvExample — criação e formatação básica", () => {
  it("cria .env.example do zero quando não existe", async () => {
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest(),
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(result.created).toBe(true);
    expect(result.replaced).toBe(false);

    const content = await readFile(join(dir, ".env.example"), "utf8");
    expect(content).toContain("# --- evolution-api (0.1.0) ---");
    expect(content).toContain("# --- Fim evolution-api ---");
    expect(content).toContain("EVOLUTION_URL=");
    expect(content).toContain("TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe");
  });

  it("respeita dry-run (não escreve)", async () => {
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest(),
      dryRun: true,
    });

    expect(result.applied).toBe(true);
    await expect(
      readFile(join(dir, ".env.example"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("updateEnvExample — degradação graciosa sem campo `default`", () => {
  it("template.json legado (env vars sem default) gera linhas vazias", async () => {
    const legacyManifest = makeManifest({
      env_vars: [
        { name: "LEGACY_REQUIRED", required: true },
        { name: "LEGACY_OPTIONAL", required: false }, // sem default
        { name: "LEGACY_WITH_DEFAULT", required: false, default: "fallback" },
      ],
    });

    await updateEnvExample({
      projectDir: dir,
      manifest: legacyManifest,
      dryRun: false,
    });

    const content = await readFile(join(dir, ".env.example"), "utf8");
    expect(content).toContain("LEGACY_REQUIRED=");
    expect(content).toContain("LEGACY_OPTIONAL=");
    expect(content).toContain("LEGACY_WITH_DEFAULT=fallback");
  });

  it("não quebra se env_vars vier vazio", async () => {
    const noEnvVars = makeManifest({ env_vars: [] });
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: noEnvVars,
      dryRun: false,
    });
    expect(result.applied).toBe(true);
    expect(result.varCount).toBe(0);
  });
});

describe("updateEnvExample — substituição de bloco existente (qualquer versão)", () => {
  it("substitui bloco 0.1.0 ao rodar com 0.2.0", async () => {
    // Primeira instalação: cria bloco 0.1.0.
    await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest({ version: "0.1.0" }),
      dryRun: false,
    });

    // Segunda: bumpa pra 0.2.0 com env vars ligeiramente diferentes.
    const newManifest = makeManifest({
      version: "0.2.0",
      env_vars: [
        { name: "EVOLUTION_URL", required: true },
        { name: "NEW_VAR_IN_V2", required: false, default: "new" },
      ],
    });
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: newManifest,
      dryRun: false,
    });

    expect(result.replaced).toBe(true);

    const content = await readFile(join(dir, ".env.example"), "utf8");
    // Bloco novo presente.
    expect(content).toContain("# --- evolution-api (0.2.0) ---");
    expect(content).toContain("NEW_VAR_IN_V2=new");
    // Bloco antigo FOI removido (regex captura qualquer versão).
    expect(content).not.toContain("# --- evolution-api (0.1.0) ---");
    // Exatamente 1 ocorrência do delimitador start.
    const matches = content.match(/# --- evolution-api \(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("regex captura versões exóticas (pre-release, build metadata)", () => {
    const regex = _internals.buildBlockRegex("evolution-api");
    const content = `
# --- evolution-api (1.2.3-rc.1+build.2024) ---
FOO=bar
# --- Fim evolution-api ---
`;
    expect(regex.test(content)).toBe(true);
  });
});

describe("updateEnvExample — detecção de duplicatas fora do bloco", () => {
  it("flag env var que já existe fora do bloco delimitado", async () => {
    // .env.example pré-existente com EVOLUTION_URL configurado manualmente.
    await writeFile(
      join(dir, ".env.example"),
      `# My vars\nEVOLUTION_URL=https://foo.com\nOTHER_VAR=baz\n`,
      "utf8",
    );

    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest(),
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(result.outOfBlockDuplicates).toContain("EVOLUTION_URL");
    // EVOLUTION_API_KEY e TRANSCRIPTION_MODEL não estavam fora → não duplicam.
    expect(result.outOfBlockDuplicates).not.toContain("EVOLUTION_API_KEY");
  });

  it("vars dentro do bloco NÃO contam como duplicatas fora", async () => {
    // Simula re-instalação (bloco já existe).
    await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest(),
      dryRun: false,
    });
    // Roda de novo — todas as vars estão DENTRO do bloco, nenhuma fora.
    const result2 = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest(),
      dryRun: false,
    });
    expect(result2.outOfBlockDuplicates).toEqual([]);
  });
});

describe("renderEnvLine — escape de valores com caracteres especiais", () => {
  const { renderEnvLine } = _internals;

  it("valor simples sem espaço → sem aspas", () => {
    expect(
      renderEnvLine({ name: "LLM_MODEL", default: "gpt-4o-mini" }),
    ).toBe("LLM_MODEL=gpt-4o-mini");
  });

  it("valor com espaço → aspas duplas", () => {
    expect(
      renderEnvLine({ name: "MSG", default: "Olá mundo" }),
    ).toBe('MSG="Olá mundo"');
  });

  it("valor com # → aspas duplas (# é comentário em .env)", () => {
    expect(renderEnvLine({ name: "X", default: "a#b" })).toBe('X="a#b"');
  });

  it("valor com aspa dupla → escape interno", () => {
    expect(renderEnvLine({ name: "X", default: 'a"b' })).toBe('X="a\\"b"');
  });

  it("var sem default → linha vazia", () => {
    expect(renderEnvLine({ name: "EMPTY" })).toBe("EMPTY=");
  });
});

// =========================================================================== //
//  Dedup automático fora do bloco (US-3, CLI v0.8.0+)
// =========================================================================== //

describe("updateEnvExample — dedup automático (dedupOutOfBlock=true default)", () => {
  it("sem duplicatas fora → no-op (removedDuplicates vazio)", async () => {
    await writeFile(
      join(dir, ".env.example"),
      "# header\n# --- evolution-api (0.1.0) ---\nEVOLUTION_URL=\nEVOLUTION_API_KEY=\nTRANSCRIPTION_MODEL=\n# --- Fim evolution-api ---\n",
      "utf8",
    );
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest({ version: "0.2.0" }),
      dryRun: false,
    });
    expect(result.removedDuplicates).toEqual([]);
    expect(result.replaced).toBe(true);
  });

  it("DOMAIN duplicado fora do bloco → removido automaticamente", async () => {
    // Cenário real do feedback projeto lab.
    await writeFile(
      join(dir, ".env.example"),
      [
        "# antes do bloco",
        "EVOLUTION_URL=fora_do_bloco",
        "",
        "# --- evolution-api (0.1.0) ---",
        "EVOLUTION_URL=",
        "EVOLUTION_API_KEY=",
        "TRANSCRIPTION_MODEL=",
        "# --- Fim evolution-api ---",
        "",
        "EVOLUTION_URL=outra_duplicata_no_fim",
      ].join("\n"),
      "utf8",
    );
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest({ version: "0.2.0" }),
      dryRun: false,
    });
    expect(result.removedDuplicates).toContain("EVOLUTION_URL");
    expect(result.outOfBlockDuplicates).toContain("EVOLUTION_URL");

    const finalContent = await readFile(join(dir, ".env.example"), "utf8");
    // Conta ocorrências de EVOLUTION_URL= em início de linha
    const matches = finalContent.match(/^EVOLUTION_URL=/gm) ?? [];
    expect(matches.length).toBe(1); // só dentro do bloco
  });

  it("dedupOutOfBlock=false preserva duplicatas (comportamento pre-v0.8.0)", async () => {
    await writeFile(
      join(dir, ".env.example"),
      [
        "EVOLUTION_URL=fora",
        "# --- evolution-api (0.1.0) ---",
        "EVOLUTION_URL=",
        "EVOLUTION_API_KEY=",
        "TRANSCRIPTION_MODEL=",
        "# --- Fim evolution-api ---",
      ].join("\n"),
      "utf8",
    );
    const result = await updateEnvExample({
      projectDir: dir,
      manifest: makeManifest({ version: "0.2.0" }),
      dryRun: false,
      dedupOutOfBlock: false,
    });
    expect(result.removedDuplicates).toEqual([]);
    expect(result.outOfBlockDuplicates).toContain("EVOLUTION_URL");

    const finalContent = await readFile(join(dir, ".env.example"), "utf8");
    const matches = finalContent.match(/^EVOLUTION_URL=/gm) ?? [];
    expect(matches.length).toBe(2); // dentro do bloco + fora preservada
  });
});
