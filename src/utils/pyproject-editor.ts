// Automação 2 — adicionar dependências Python ao `[project].dependencies` do
// pyproject.toml preservando formatação, comentários e outras seções.
//
// Estratégia HÍBRIDA (parser + string manipulation):
//   1. `smol-toml.parse` lê o arquivo pra validar estrutura e extrair deps
//      existentes (pra detecção de conflito de versão).
//   2. Inserção de novas deps é feita via STRING manipulation — localiza o
//      array `dependencies = [ ... ]` dentro de `[project]` e injeta antes do
//      `]` final. Preserva formatação e comentários do arquivo original.
//
// Por que hybrid: nenhuma lib JS de TOML preserva comentários em round-trip
// (parse → modify → stringify). String-based preserva, mas perde validação.
// Hybrid tem o melhor dos dois mundos.

import path from "node:path";

import fsExtra from "fs-extra";
import { parse as parseToml } from "smol-toml";

import type { PyprojectChanges } from "../types.js";

const { pathExists, readFile, writeFile } = fsExtra;

const PYPROJECT_FILENAME = "pyproject.toml";

/** Normaliza uma string de dep pra `{name, constraint}` — aceita `pkg>=1.2`,
 *  `pkg==1.0`, `pkg[extras]>=1`, `pkg`. Não-match → retorna só `name`.
 */
interface ParsedDep {
  name: string;
  constraint: string | null;
  raw: string;
}

function parseDep(raw: string): ParsedDep {
  // Primeiro operador de comparação divide name de constraint.
  // Inclui `[extras]` opcional no name (ex.: `psycopg[binary]>=3.2`).
  const match = raw.match(/^([A-Za-z0-9._-]+(?:\[[^\]]+\])?)\s*(.*)$/);
  if (!match) {
    return { name: raw.trim(), constraint: null, raw };
  }
  const name = (match[1] ?? "").trim();
  const constraint = (match[2] ?? "").trim();
  return {
    name: normalizeName(name),
    constraint: constraint.length > 0 ? constraint : null,
    raw,
  };
}

/** PEP 503: normaliza pra lowercase e troca `_`/`.` por `-`. */
function normalizeName(name: string): string {
  // Remove `[extras]` antes de comparar nome canônico.
  const withoutExtras = name.replace(/\[[^\]]+\]/g, "");
  return withoutExtras.toLowerCase().replace(/[._]+/g, "-");
}

// --------------------------------------------------------------------------- //
//  API pública
// --------------------------------------------------------------------------- //

export interface UpdatePyprojectOptions {
  projectDir: string;
  dependencies: string[];
  dryRun: boolean;
}

export async function updatePyproject(
  opts: UpdatePyprojectOptions,
): Promise<PyprojectChanges> {
  const { projectDir, dependencies, dryRun } = opts;
  const filePath = path.join(projectDir, PYPROJECT_FILENAME);

  if (!(await pathExists(filePath))) {
    return {
      applied: false,
      added: [],
      alreadyPresent: [],
      versionConflicts: [],
      errorMessage: `${PYPROJECT_FILENAME} não encontrado em ${projectDir}`,
    };
  }

  let original: string;
  try {
    original = await readFile(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      applied: false,
      added: [],
      alreadyPresent: [],
      versionConflicts: [],
      errorMessage: `Falha ao ler ${PYPROJECT_FILENAME}: ${msg}`,
    };
  }

  // --- 1) Parse pra extrair deps existentes -----------------------------
  let existingDeps: string[];
  try {
    const parsed = parseToml(original) as {
      project?: { dependencies?: unknown };
    };
    const rawDeps = parsed.project?.dependencies;
    if (!Array.isArray(rawDeps)) {
      return {
        applied: false,
        added: [],
        alreadyPresent: [],
        versionConflicts: [],
        errorMessage:
          "pyproject.toml: seção [project].dependencies ausente ou não é um array.",
      };
    }
    // Garante que todas as entradas são strings.
    if (!rawDeps.every((d) => typeof d === "string")) {
      return {
        applied: false,
        added: [],
        alreadyPresent: [],
        versionConflicts: [],
        errorMessage:
          "pyproject.toml: [project].dependencies contém entradas não-string.",
      };
    }
    existingDeps = rawDeps as string[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      applied: false,
      added: [],
      alreadyPresent: [],
      versionConflicts: [],
      errorMessage: `Falha ao parsear pyproject.toml: ${msg}`,
    };
  }

  // Map nome-normalizado → string original. Usado pra detectar colisão.
  const existingByName = new Map<string, ParsedDep>();
  for (const d of existingDeps) {
    const parsed = parseDep(d);
    existingByName.set(parsed.name, parsed);
  }

  // --- 2) Classifica cada dep requisitada -------------------------------
  const toAdd: string[] = [];
  const alreadyPresent: string[] = [];
  const versionConflicts: PyprojectChanges["versionConflicts"] = [];

  for (const depRaw of dependencies) {
    const parsed = parseDep(depRaw);
    const existing = existingByName.get(parsed.name);

    if (!existing) {
      toAdd.push(depRaw);
      continue;
    }

    // Já existe. Se o raw é idêntico, skip silencioso. Se diverge, warning.
    if (existing.raw.trim() === depRaw.trim()) {
      alreadyPresent.push(parsed.name);
    } else {
      versionConflicts.push({
        name: parsed.name,
        existing: existing.raw,
        requested: depRaw,
      });
    }
  }

  // --- 3) Se nada pra adicionar, retorna (possivelmente com warnings) ---
  if (toAdd.length === 0) {
    return {
      applied: true,
      added: [],
      alreadyPresent,
      versionConflicts,
    };
  }

  // --- 4) Inserção via string manipulation ------------------------------
  const injected = injectIntoDependenciesArray(original, toAdd);
  if (injected === null) {
    return {
      applied: false,
      added: [],
      alreadyPresent,
      versionConflicts,
      errorMessage:
        "Não consegui localizar o array `dependencies = [...]` em formato multi-linha " +
        "dentro de `[project]`. Adicione as deps manualmente (listadas na mensagem final).",
    };
  }

  if (!dryRun) {
    try {
      await writeFile(filePath, injected, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        applied: false,
        added: [],
        alreadyPresent,
        versionConflicts,
        errorMessage: `Falha ao escrever pyproject.toml: ${msg}`,
      };
    }
  }

  return {
    applied: true,
    added: toAdd,
    alreadyPresent,
    versionConflicts,
  };
}

// --------------------------------------------------------------------------- //
//  Inserção via string manipulation
// --------------------------------------------------------------------------- //

/** Injeta items antes do `]` final do array `dependencies` em `[project]`.
 *
 *  Algoritmo:
 *    1. Localiza a linha `[project]` (case-sensitive, início de linha).
 *    2. A partir dela, busca `dependencies = [` na mesma seção.
 *    3. Escaneia até o `]` correspondente (tracking profundidade, ignora `]`
 *       dentro de strings com aspas).
 *    4. Insere cada item novo antes do `]` preservando indentação detectada
 *       das linhas anteriores.
 *
 *  Retorna o conteúdo atualizado ou `null` se não localizou (caller faz fallback).
 */
function injectIntoDependenciesArray(
  content: string,
  itemsToAdd: string[],
): string | null {
  // Procura seção `[project]`. Case-sensitive por convenção TOML / PEP 621.
  const projectSectionRe = /^\[project\]\s*$/m;
  const projectMatch = projectSectionRe.exec(content);
  if (!projectMatch || projectMatch.index === undefined) return null;

  // Limita busca até o início da próxima seção (`[xyz]` ou `[[xyz]]` no início de linha).
  const afterProject = content.slice(projectMatch.index + projectMatch[0].length);
  const nextSectionRe = /^\[[^\]]/m;
  const nextSectionMatch = nextSectionRe.exec(afterProject);
  const sectionEnd =
    nextSectionMatch && nextSectionMatch.index !== undefined
      ? projectMatch.index + projectMatch[0].length + nextSectionMatch.index
      : content.length;

  const sectionContent = content.slice(
    projectMatch.index + projectMatch[0].length,
    sectionEnd,
  );

  // Acha `dependencies = [` (permite whitespace extra).
  const depsStartRe = /^(\s*)dependencies\s*=\s*\[/m;
  const depsMatch = depsStartRe.exec(sectionContent);
  if (!depsMatch || depsMatch.index === undefined) return null;

  const depsStartAbs =
    projectMatch.index + projectMatch[0].length + depsMatch.index + depsMatch[0].length;

  // Escaneia caracter-a-caracter pra achar o `]` que fecha, respeitando strings.
  let i = depsStartAbs;
  let inString: '"' | "'" | null = null;
  let depth = 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = ch;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    i++;
  }

  if (depth !== 0) return null;

  const closingBracketIndex = i;

  // Extrai linhas entre `[` e `]` pra inferir indentação.
  const arrayBody = content.slice(depsStartAbs, closingBracketIndex);
  const indent = inferIndent(arrayBody);

  // Monta linhas novas, mantendo indent + trailing comma.
  const newLines = itemsToAdd
    .map((item) => `${indent}"${item.replace(/"/g, '\\"')}",`)
    .join("\n");

  // Garantimos que há exatamente um newline antes do `]` (se já existe, reusa).
  const before = content.slice(0, closingBracketIndex);
  const after = content.slice(closingBracketIndex);

  // Se o array termina com newline + espaços (comum), injeta antes desse bloco.
  // Caso minimalista (array inline tipo `[]` sem newlines) — garante newline.
  const trailingWhitespaceMatch = /[\n\r][ \t]*$/.exec(before);
  if (trailingWhitespaceMatch) {
    // Injeta antes do último newline.
    const splitAt = trailingWhitespaceMatch.index;
    return `${before.slice(0, splitAt)}\n${newLines}${before.slice(splitAt)}${after}`;
  }
  return `${before}\n${newLines}\n${after}`;
}

/** Infere a indentação padrão dos items existentes. Fallback: 4 espaços.
 *
 *  Olha pra linhas que parecem items (começam com aspas após newline).
 */
function inferIndent(arrayBody: string): string {
  const lineRe = /\n([ \t]+)(?:")/g;
  let match: RegExpExecArray | null;
  const indents: string[] = [];
  while ((match = lineRe.exec(arrayBody)) !== null) {
    if (match[1]) indents.push(match[1]);
  }
  if (indents.length === 0) return "    ";
  // Usa o indent mais comum — rápido e suficiente pra arquivos bem formados.
  const first = indents[0];
  return first ?? "    ";
}

// Exportado pra testes — injeção sem I/O.
export const _internals = {
  parseDep,
  normalizeName,
  injectIntoDependenciesArray,
  inferIndent,
};
