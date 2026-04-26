// Classifica a severidade de um bump entre duas versões semver.
//
// Usado por `list` (CLI v0.7.0+) pra mostrar badge ao lado de cada componente
// com update — `(major)`, `(minor)`, `(patch)`. Calibra urgência sem o aluno
// precisar abrir o CHANGELOG.
//
// Reusa o mesmo `parseSemver` de version-check.ts pra manter coerência com
// `isCompatible`/`isNewer` (todos tolerantes a partes inválidas).

import { parseSemver } from "./version-check.js";

/** Severidade de um bump semver. `null` quando não há bump (versões iguais
 *  ou available <= installed). */
export type Severity = "patch" | "minor" | "major";

/** Retorna a parte semver mais alta que mudou entre `installed` e `available`.
 *
 *  Exemplos:
 *    severityOfBump("1.0.0", "1.0.1")     → "patch"
 *    severityOfBump("1.0.0", "1.1.0")     → "minor"
 *    severityOfBump("1.0.0", "2.0.0")     → "major"
 *    severityOfBump("1.0.0", "1.0.0")     → null    (sem bump)
 *    severityOfBump("2.0.0", "1.0.0")     → null    (downgrade — não badgeamos)
 *    severityOfBump("1.0.0", "1.0.1-rc.1") → "patch" (pre-release ignorado)
 *
 *  Pre-release/build metadata são descartados pelo `parseSemver` — coerente
 *  com `isNewer` em `version-manifest.ts`.
 */
export function severityOfBump(
  installed: string,
  available: string,
): Severity | null {
  const [iMajor, iMinor, iPatch] = parseSemver(installed);
  const [aMajor, aMinor, aPatch] = parseSemver(available);

  if (aMajor > iMajor) return "major";
  if (aMajor < iMajor) return null;
  if (aMinor > iMinor) return "minor";
  if (aMinor < iMinor) return null;
  if (aPatch > iPatch) return "patch";
  return null;
}
