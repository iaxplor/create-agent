// Tests do pyproject-deps-reader (CLI v0.8.5+, doctor V12).

import { describe, expect, it } from "vitest";

import {
  findMissingDeps,
  readPyprojectDeps,
} from "../src/utils/pyproject-deps-reader.js";

describe("readPyprojectDeps", () => {
  it("pyproject vazio → Set vazio", () => {
    expect(readPyprojectDeps("")).toEqual(new Set());
  });

  it("pyproject sem [project].dependencies → Set vazio", () => {
    const content = `[project]\nname = "x"\n`;
    expect(readPyprojectDeps(content)).toEqual(new Set());
  });

  it("extrai nomes ignorando versões e extras", () => {
    const content = `[project]
name = "iaxplor-agent"
version = "0.1.0"
dependencies = [
    "agno>=2.5.17",
    "fastapi>=0.115",
    "psycopg[binary]>=3.2",
    "google-auth>=2.30",
]
`;
    const deps = readPyprojectDeps(content);
    expect(deps).toEqual(new Set(["agno", "fastapi", "psycopg", "google-auth"]));
  });

  it("normaliza case (lower) e hífens", () => {
    const content = `[project]
dependencies = ["Google-API-Python-Client>=2.100"]
`;
    expect(readPyprojectDeps(content)).toEqual(
      new Set(["google-api-python-client"]),
    );
  });

  it("TOML malformado → Set vazio (não lança)", () => {
    expect(readPyprojectDeps("isso não é toml válido [[[")).toEqual(new Set());
  });
});

describe("findMissingDeps", () => {
  it("manifest com tudo presente → lista vazia", () => {
    const missing = findMissingDeps(
      ["agno>=2.5.17", "fastapi>=0.115"],
      new Set(["agno", "fastapi"]),
    );
    expect(missing).toEqual([]);
  });

  it("manifest tem 2 que pyproject não tem → ambas listadas", () => {
    const missing = findMissingDeps(
      ["google-auth>=2.30", "google-api-python-client>=2.100"],
      new Set(["agno", "fastapi"]),
    );
    expect(missing).toEqual([
      "google-api-python-client>=2.100",
      "google-auth>=2.30",
    ]);
  });

  it("normalização case-insensitive de match", () => {
    const missing = findMissingDeps(
      ["Google-Auth>=2.30"],
      new Set(["google-auth"]),
    );
    expect(missing).toEqual([]);
  });
});
