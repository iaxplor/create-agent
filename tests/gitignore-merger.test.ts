// Tests do gitignore-merger (CLI v0.8.0+, US-2).
//
// Cobre acceptance criteria de US-2 (.gitignore append-only + security baseline).

import { describe, expect, it } from "vitest";

import {
  mergeGitignore,
  SECURITY_BASELINE,
} from "../src/utils/gitignore-merger.js";

describe("mergeGitignore", () => {
  it("local vazio + template vazio → só baseline", () => {
    const result = mergeGitignore("", "");
    for (const pattern of SECURITY_BASELINE) {
      expect(result).toContain(pattern);
    }
    expect(result).toContain("security baseline");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("local idêntico ao template → idempotente (sem mudança visível além de baseline)", () => {
    const content = "*.pyc\n.venv/\n.env\n";
    const result = mergeGitignore(content, content);
    expect(result).toContain("*.pyc");
    expect(result).toContain(".venv/");
    expect(result).toContain(".env");
    // Roda de novo: idempotência
    const second = mergeGitignore(result, content);
    expect(second).toBe(result);
  });

  it("local com credentials.json + template sem → preserva linha do aluno", () => {
    // Cenário do feedback #2 do projeto lab.
    const local = "*.pyc\n.venv/\ncredentials.json\n";
    const template = "*.pyc\n.venv/\n.env\n";
    const result = mergeGitignore(local, template);
    expect(result).toContain("credentials.json"); // ✓ preservado
    expect(result).toContain(".env"); // ✓ adicionado do template
    expect(result).toContain("*.pyc"); // ✓ original
  });

  it("template tem linhas novas que local não tem → append no final", () => {
    const local = "*.pyc\n";
    const template = "*.pyc\n.coverage\nhtmlcov/\n";
    const result = mergeGitignore(local, template);
    expect(result).toContain("*.pyc");
    expect(result).toContain(".coverage");
    expect(result).toContain("htmlcov/");
    expect(result).toContain("template novo");
    // Ordem: local primeiro, depois adicionados
    const pycIndex = result.indexOf("*.pyc");
    const covIndex = result.indexOf(".coverage");
    expect(pycIndex).toBeLessThan(covIndex);
  });

  it("aluno removeu credentials.json do .gitignore → baseline reinjeta", () => {
    // Cenário central do feedback #2.
    const local = "*.pyc\n.env\n"; // SEM credentials.json
    const template = "*.pyc\n";
    const result = mergeGitignore(local, template);
    expect(result).toContain("credentials.json"); // ✓ restaurado pela baseline
    expect(result).toContain("client_secret_*.json");
    expect(result).toContain("service-account*.json");
    expect(result).toContain("*.pem");
    expect(result).toContain("*.key");
  });

  it("comments e espaços em branco do local são preservados na ordem", () => {
    const local = `# Python
*.pyc

# Ambientes
.venv/

# Custom do aluno
meu_arquivo_secreto.txt
`;
    const template = "*.pyc\n.venv/\n";
    const result = mergeGitignore(local, template);
    expect(result).toContain("# Python");
    expect(result).toContain("# Ambientes");
    expect(result).toContain("# Custom do aluno");
    expect(result).toContain("meu_arquivo_secreto.txt");
    // Ordem original mantida
    const pythonIndex = result.indexOf("# Python");
    const customIndex = result.indexOf("# Custom do aluno");
    expect(pythonIndex).toBeLessThan(customIndex);
  });

  it("baseline customizada (override) substitui SECURITY_BASELINE default", () => {
    const result = mergeGitignore("", "", ["foo.json", "bar.key"]);
    expect(result).toContain("foo.json");
    expect(result).toContain("bar.key");
    // Default não vaza quando caller passa baseline custom
    expect(result).not.toContain("credentials.json");
  });
});
