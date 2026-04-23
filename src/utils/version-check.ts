// Comparação semver simples (X.Y.Z) sem dependência externa.
//
// Por que não usar a lib `semver` do npm? Porque o uso aqui é mínimo
// (apenas verificar se `projectVersion >= minRequired`) e a lib `semver`
// adiciona ~50kb na build. Se o CLI começar a precisar de ranges complexos
// (ex.: `^0.1.2`, `>=0.1 <0.2`), migra-se.

/** Parseia `X.Y.Z` em tupla de inteiros. Ignora pre-release/build metadata.
 *
 *  Exemplos:
 *    "0.1.0"       → [0, 1, 0]
 *    "1.2"         → [1, 2, 0]
 *    "1.2.3-rc.1"  → [1, 2, 3]  (pre-release descartado)
 *
 *  Partes inválidas viram 0 — isso é intencional: permite tolerância a
 *  strings mal formatadas sem crashar o comando.
 */
export function parseSemver(v: string): [number, number, number] {
  // Strip pre-release/build (`-rc.1`, `+build`).
  const core = v.split(/[-+]/, 1)[0] ?? "0.0.0";
  const parts = core.split(".");
  return [
    toInt(parts[0]),
    toInt(parts[1]),
    toInt(parts[2]),
  ];
}

/** `true` se `project >= minRequired`. */
export function isCompatible(projectVersion: string, minRequired: string): boolean {
  const [pa, pb, pc] = parseSemver(projectVersion);
  const [ma, mb, mc] = parseSemver(minRequired);
  if (pa !== ma) return pa > ma;
  if (pb !== mb) return pb > mb;
  return pc >= mc;
}

function toInt(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}
