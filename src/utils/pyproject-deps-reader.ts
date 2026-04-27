// Helper read-only pra extrair nomes de dependências do pyproject.toml.
// Usado pelo doctor V12 (CLI v0.8.5+) pra cruzar com manifests dos módulos
// instalados e detectar gap de deps após `upgrade core --overwrite-modified`.
//
// Pure: zero I/O — recebe content como string. Caller (doctor) lê arquivo.

import { parse as parseToml } from "smol-toml";

import { _internals as pyprojectInternals } from "./pyproject-editor.js";

const { parseDep } = pyprojectInternals;

/** Lê `[project].dependencies` do pyproject.toml e retorna SET de nomes
 *  normalizados (lowercase, hífen). Sem versão/constraint — só o nome
 *  do pacote.
 *
 *  Ex.: `["agno>=2.5.17", "google-auth>=2.30"]` → Set {"agno", "google-auth"}
 *
 *  Se pyproject.toml é malformado OU não tem `[project].dependencies`,
 *  retorna Set vazio (caller decide se trata como erro). */
export function readPyprojectDeps(pyprojectContent: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = parseToml(pyprojectContent);
  } catch {
    return new Set();
  }
  if (typeof parsed !== "object" || parsed === null) return new Set();
  const project = (parsed as Record<string, unknown>)["project"];
  if (typeof project !== "object" || project === null) return new Set();
  const deps = (project as Record<string, unknown>)["dependencies"];
  if (!Array.isArray(deps)) return new Set();

  const names = new Set<string>();
  for (const raw of deps) {
    if (typeof raw !== "string") continue;
    const parsed = parseDep(raw);
    if (parsed.name) names.add(parsed.name);
  }
  return names;
}

/** Diff: deps declaradas no manifest do módulo MAS ausentes no pyproject.
 *  Usa nome normalizado (parseDep). Retorna lista ordenada. */
export function findMissingDeps(
  manifestDeps: readonly string[],
  pyprojectDeps: Set<string>,
): string[] {
  const missing: string[] = [];
  for (const raw of manifestDeps) {
    const parsed = parseDep(raw);
    if (parsed.name && !pyprojectDeps.has(parsed.name)) {
      missing.push(raw);
    }
  }
  return missing.sort();
}
