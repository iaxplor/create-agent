// Tests pro helper read-only `readEnvExampleVars`.
//
// Foco: parser robusto contra formatos comuns do .env.example (vars com/sem
// valor, comentários, blocos delimitados, aspas, espaços). Não testa
// integração com o `doctor` em si — esse fica em `tests/doctor.test.ts`.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEnvExampleVars } from "../src/utils/env-example-reader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaxplor-envread-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readEnvExampleVars", () => {
  it("retorna Set vazio quando .env.example não existe", async () => {
    const result = await readEnvExampleVars(dir);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it("extrai nomes de vars simples (KEY=value, ignorando comentários e linhas em branco)", async () => {
    const content = `# Comentário inicial
DATABASE_URL=postgresql://localhost/db
REDIS_URL=redis://localhost:6379

# Outro comentário
OPENAI_API_KEY=sk-...
`;
    await writeFile(join(dir, ".env.example"), content, "utf8");
    const result = await readEnvExampleVars(dir);
    expect(result).toEqual(
      new Set(["DATABASE_URL", "REDIS_URL", "OPENAI_API_KEY"]),
    );
  });

  it("inclui vars com valor vazio, valores aspeados e blocos delimitados", async () => {
    const content = `# --- evolution-api (0.3.0) ---
EVOLUTION_URL=
EVOLUTION_API_KEY=
TRANSCRIPTION_MODEL="gpt-4o-mini-transcribe"
UNSUPPORTED_MEDIA_MESSAGE="Mensagem com espaços e # caracteres"
# --- Fim evolution-api ---

# Linha que parece var mas não é (só comentário)
# IGNORED_VAR=foo
`;
    await writeFile(join(dir, ".env.example"), content, "utf8");
    const result = await readEnvExampleVars(dir);
    expect(result).toEqual(
      new Set([
        "EVOLUTION_URL",
        "EVOLUTION_API_KEY",
        "TRANSCRIPTION_MODEL",
        "UNSUPPORTED_MEDIA_MESSAGE",
      ]),
    );
    // Garantia explícita: comentário com formato KEY= não vaza pro Set
    expect(result.has("IGNORED_VAR")).toBe(false);
  });
});
