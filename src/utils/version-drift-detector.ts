// Helper read-only pra detectar drift de versão de deps críticas (Agno
// principalmente) entre o que está no projeto do aluno e o range testado
// pelo template IAxplor.
//
// Usado pelo doctor V14 (CLI v0.9.0+, parte da Fase 3 do versionamento
// determinístico). Pure: zero I/O — recebe contents como string. Caller
// (doctor) lê arquivos.
//
// Cenários cobertos:
//   1. Range no pyproject local difere do range testado pelo template
//      (ex.: aluno em projeto antigo com `agno>=2.5.17` vs template novo
//      com `agno>=2.6.4,<2.7`). → recomenda `upgrade core`.
//   2. Versão exata resolvida no uv.lock divergiu do range testado
//      (ex.: aluno fez `uv lock --upgrade-package agno` e pegou 2.7.0,
//      mas template só validou até 2.6.x). → recomenda re-lock com cap.

import { parse as parseToml } from "smol-toml";

import { _internals as pyprojectInternals } from "./pyproject-editor.js";

const { parseDep } = pyprojectInternals;

/** Pacotes monitorados pelo V14. Lista intencionalmente curta — apenas
 *  deps com histórico de breaking changes que motivaram esta proteção.
 *  Adicionar pacote aqui = adicionar warn pro aluno. */
export const MONITORED_DEPS = ["agno"] as const;
export type MonitoredDep = (typeof MONITORED_DEPS)[number];

export interface VersionDriftFinding {
  /** Nome do pacote (sempre lowercase, ex.: "agno"). */
  pkg: MonitoredDep;
  /** Tipo de drift detectado. */
  kind: "range-drift" | "lock-drift";
  /** Range/versão observado localmente. */
  local: string;
  /** Range/versão esperado pelo template. */
  expected: string;
  /** Mensagem human-friendly pra mostrar no doctor output. */
  message: string;
}

// --------------------------------------------------------------------------- //
//  Extração de range do pyproject.toml
// --------------------------------------------------------------------------- //

/** Lê `[project].dependencies` do pyproject.toml e retorna a entrada bruta
 *  (`"agno>=2.5.17"`) pro pacote pedido — null se não estiver listado. */
export function extractDepEntry(
  pyprojectContent: string,
  pkgName: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = parseToml(pyprojectContent);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const project = (parsed as Record<string, unknown>)["project"];
  if (typeof project !== "object" || project === null) return null;
  const deps = (project as Record<string, unknown>)["dependencies"];
  if (!Array.isArray(deps)) return null;

  const target = pkgName.toLowerCase();
  for (const raw of deps) {
    if (typeof raw !== "string") continue;
    const parsedDep = parseDep(raw);
    if (parsedDep.name === target) {
      return raw;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
//  Extração de versão exata do uv.lock
// --------------------------------------------------------------------------- //

/** Lê `uv.lock` (formato TOML) e retorna a versão exata resolvida do
 *  pacote — null se ausente. uv.lock tem formato:
 *
 *    [[package]]
 *    name = "agno"
 *    version = "2.6.4"
 *
 *  Pode haver múltiplos [[package]] — pegamos o que bater pelo nome. */
export function extractLockedVersion(
  uvLockContent: string,
  pkgName: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = parseToml(uvLockContent);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const packages = (parsed as Record<string, unknown>)["package"];
  if (!Array.isArray(packages)) return null;

  const target = pkgName.toLowerCase();
  for (const entry of packages) {
    if (typeof entry !== "object" || entry === null) continue;
    const pkg = entry as Record<string, unknown>;
    const name = typeof pkg["name"] === "string" ? pkg["name"].toLowerCase() : null;
    if (name !== target) continue;
    const version = pkg["version"];
    if (typeof version === "string") return version;
  }
  return null;
}

// --------------------------------------------------------------------------- //
//  Comparação de range vs lock
// --------------------------------------------------------------------------- //

/** Extrai a parte da versão de uma entrada de dep (ex.: "agno>=2.5.17" →
 *  ">=2.5.17"; "agno" → ""). Usado pra comparar ranges sem o prefixo do
 *  nome do pacote. */
function extractConstraint(rawDep: string): string {
  const parsed = parseDep(rawDep);
  return parsed.constraint ?? "";
}

/** Extrai upper bound (`<X.Y`) de um range. Retorna null se não houver. */
function extractUpperBound(constraint: string): string | null {
  // Regex pega `<X.Y[.Z]` (opcional patch) — ignora `<=` (raro em deps).
  const match = constraint.match(/<\s*([0-9]+(?:\.[0-9]+)*(?:\.[0-9]+)?)/);
  return match ? (match[1] ?? null) : null;
}

/** Compara versão exata X.Y.Z com upper bound A.B[.C]. True se versão
 *  está ABAIXO do upper bound (ex.: 2.6.4 < 2.7 → true). */
function isVersionBelow(version: string, upperBound: string): boolean {
  const vParts = version.split(".").map((s) => parseInt(s, 10));
  const bParts = upperBound.split(".").map((s) => parseInt(s, 10));
  // Comparação lexicográfica numérica, padding com 0 onde faltar.
  const len = Math.max(vParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const v = vParts[i] ?? 0;
    const b = bParts[i] ?? 0;
    if (Number.isNaN(v) || Number.isNaN(b)) return false; // versão malformada
    if (v < b) return true;
    if (v > b) return false;
  }
  return false; // iguais → NÃO está abaixo
}

// --------------------------------------------------------------------------- //
//  Função principal — detecta drifts
// --------------------------------------------------------------------------- //

export interface DetectDriftInput {
  /** Conteúdo do `pyproject.toml` local (do projeto do aluno). */
  localPyproject: string;
  /** Conteúdo do `uv.lock` local — opcional (pode estar ausente). */
  localLock: string | null;
  /** Conteúdo do `pyproject.toml` ESPERADO (do snapshot do template testado
   *  pelo CI da IAxplor). Lido pelo doctor a partir do snapshot do core. */
  expectedPyproject: string;
}

/** Detecta drifts entre o estado local do projeto e o estado testado pelo
 *  template. Retorna lista de findings — vazia se tudo bate. */
export function detectVersionDrift(
  input: DetectDriftInput,
): VersionDriftFinding[] {
  const findings: VersionDriftFinding[] = [];

  for (const pkg of MONITORED_DEPS) {
    const localEntry = extractDepEntry(input.localPyproject, pkg);
    const expectedEntry = extractDepEntry(input.expectedPyproject, pkg);

    // Se template não declara o pacote (não monitorado nesta versão), pula.
    if (!expectedEntry) continue;

    const expectedConstraint = extractConstraint(expectedEntry);

    // --- Range drift: pyproject local difere do esperado --------------
    if (!localEntry) {
      // Pacote ausente do pyproject local — caso raro (V12 já trata
      // missing deps por módulo; aqui é uma redundância pra core).
      findings.push({
        pkg,
        kind: "range-drift",
        local: "(ausente)",
        expected: expectedEntry,
        message:
          `${pkg} não declarado em pyproject.toml. Esperado pelo template: ` +
          `\`${expectedEntry}\`. Considere \`upgrade core\` pra alinhar.`,
      });
    } else {
      const localConstraint = extractConstraint(localEntry);
      // Comparação simples: se constraints diferem, warn. Falsos positivos
      // possíveis (ex.: `>=2.6.4,<2.7` vs `>=2.6.4, <2.7` — diferem por
      // espaço). Comparação semver completa fica em iteração futura.
      if (localConstraint !== expectedConstraint) {
        findings.push({
          pkg,
          kind: "range-drift",
          local: localEntry,
          expected: expectedEntry,
          message:
            `Range do ${pkg} no seu projeto (\`${localEntry}\`) difere do ` +
            `range testado pelo template IAxplor (\`${expectedEntry}\`). ` +
            `Considere \`npx create-agent upgrade core\` pra alinhar.`,
        });
      }
    }

    // --- Lock drift: versão exata do lock vs upper bound do template --
    if (input.localLock) {
      const lockedVersion = extractLockedVersion(input.localLock, pkg);
      if (lockedVersion) {
        const upperBound = extractUpperBound(expectedConstraint);
        if (upperBound && !isVersionBelow(lockedVersion, upperBound)) {
          findings.push({
            pkg,
            kind: "lock-drift",
            local: lockedVersion,
            expected: expectedConstraint,
            message:
              `Você está usando \`${pkg}==${lockedVersion}\` (resolvido em ` +
              `uv.lock) mas o template testou apenas dentro de ` +
              `\`${expectedConstraint}\`. Pode ter incompat. Rode ` +
              `\`uv lock --upgrade-package ${pkg}\` com o cap correto, ou ` +
              `aceite o risco conscientemente.`,
          });
        }
      }
    }
  }

  return findings;
}

// --------------------------------------------------------------------------- //
//  Internals expostos pra testes
// --------------------------------------------------------------------------- //

export const _internals = {
  extractConstraint,
  extractUpperBound,
  isVersionBelow,
};
