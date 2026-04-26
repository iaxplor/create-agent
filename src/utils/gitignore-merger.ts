// Merge custom de `.gitignore` (CLI v0.8.0+).
//
// Resolve o problema de #2 do feedback do projeto lab: aluno adicionou
// `credentials.json` ao `.gitignore` seguindo `GOOGLE_CALENDAR_SETUP.md`,
// e `upgrade core --yes` removeu a linha → credential leak iminente.
//
// Estratégia (ADR-002):
//   1. Preserva 100% do conteúdo local (append-only — nunca remove)
//   2. Acrescenta linhas do template novo que não existem localmente
//   3. Garante SECURITY_BASELINE (insere se faltar)
//
// Não tenta deduplicar entradas existentes — verbosidade > vazamento.
// Comments e linhas em branco do local são preservados na ordem original.

/** Linhas de proteção que o CLI re-injeta em todo upgrade, mesmo se o
 *  aluno tiver removido. Cobre casos comuns de credential leak observados
 *  no projeto lab (GCAL credentials.json, Service Account JSON, etc.). */
export const SECURITY_BASELINE: readonly string[] = [
  ".env",
  ".env.local",
  ".env.*.local",
  "credentials.json",
  "client_secret_*.json",
  "service-account*.json",
  "*.pem",
  "*.key",
];

/** Header inserido antes da baseline quando ela é adicionada por nós (não
 *  vinha do local). Permite identificar visualmente que essas linhas vêm
 *  do CLI e não devem ser removidas sem entender o trade-off. */
const BASELINE_HEADER =
  "# --- security baseline (injetada pelo create-agent v0.8.0+) ---";

/** Faz o merge de 3 fontes em uma string `.gitignore` final.
 *
 *  @param localContent  conteúdo atual do projeto (ou string vazia se ausente)
 *  @param templateContent  conteúdo do template novo (vindo do snapshot do core)
 *  @param baseline  lista de patterns que SEMPRE devem estar presentes
 *
 *  Retorna o conteúdo merged. Idempotente: rodar 2x produz o mesmo resultado.
 */
export function mergeGitignore(
  localContent: string,
  templateContent: string,
  baseline: readonly string[] = SECURITY_BASELINE,
): string {
  const localLines = localContent.split(/\r?\n/);
  const templateLines = templateContent.split(/\r?\n/);

  // Set de patterns "ativos" (linhas não-comentário, não-vazias) já presentes.
  // Usado pra detectar "esse pattern já existe?" em ambos: append do template
  // e injeção da baseline.
  const presentPatterns = new Set<string>();
  for (const line of localLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      presentPatterns.add(trimmed);
    }
  }

  // Resultado começa com tudo o que tinha localmente (preserva ordem,
  // comments, espaços em branco — append-only).
  const result: string[] = [...localLines];

  // Append: linhas novas do template que ainda não existem localmente.
  // Comments do template são copiados junto com as linhas que precedem
  // (heurística simples: copia linha a linha pulando o que já existe).
  const newFromTemplate: string[] = [];
  for (const line of templateLines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // pula linhas em branco (separação visual)
    if (trimmed.startsWith("#")) continue; // pula comments do template
    if (presentPatterns.has(trimmed)) continue;
    newFromTemplate.push(line);
    presentPatterns.add(trimmed);
  }
  if (newFromTemplate.length > 0) {
    if (result[result.length - 1]?.trim() !== "") result.push("");
    result.push("# --- adicionado pelo create-agent (template novo) ---");
    result.push(...newFromTemplate);
  }

  // Baseline: garante presença das linhas críticas, mesmo se aluno removeu.
  const missingBaseline = baseline.filter((p) => !presentPatterns.has(p));
  if (missingBaseline.length > 0) {
    if (result[result.length - 1]?.trim() !== "") result.push("");
    result.push(BASELINE_HEADER);
    result.push(...missingBaseline);
  }

  // Garante newline final (convenção POSIX).
  let merged = result.join("\n");
  if (!merged.endsWith("\n")) merged += "\n";
  return merged;
}
