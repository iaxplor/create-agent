// Automação 1 — atualizar `.env.example` com bloco do módulo.
//
// Blocos são delimitados por comentários pra permitir detecção e substituição
// em reinstalações (mesmo com versão diferente), sem duplicar ou poluir
// entradas manuais do dev.
//
// NUNCA modifica `.env` (valores reais de produção vivem no painel Dokploy).

import path from "node:path";

import fsExtra from "fs-extra";

import { envBlockEnd, envBlockStart } from "../constants.js";
import type {
  EnvExampleChanges,
  EnvVarDefinition,
  ModuleTemplateJson,
} from "../types.js";

/** Subset estrutural do `ModuleTemplateJson` que `updateEnvExample` consome.
 *
 *  Permite reuso do helper pra qualquer manifest que tenha esses 3 campos —
 *  inclusive o core (que NÃO satisfaz `ModuleTemplateJson` completo, faltando
 *  `requires`, `min_core_version`, `files`, `patches`). Adicionado em CLI
 *  v0.5.0 quando upgrade do core passou a propagar env_vars novas (bug #2
 *  da paridade `add`/`upgrade`).
 *
 *  `ModuleTemplateJson` satisfaz este tipo estruturalmente — chamadas
 *  existentes em `add.ts` continuam funcionando sem mudança.
 */
export interface EnvBlockTarget {
  name: string;
  version: string;
  env_vars: EnvVarDefinition[];
}

const { pathExists, readFile, writeFile } = fsExtra;

const ENV_EXAMPLE_FILENAME = ".env.example";
const DEFAULT_HEADER = "# Environment variables\n";

/** Constrói o regex que detecta o bloco de um módulo com QUALQUER versão.
 *
 *  O grupo `\((.+?)\)` é non-greedy pra pegar o primeiro `)` — suporta
 *  versionamento arbitrário (0.1.0, 0.2.0-rc.1, 1.2.3+build, etc.).
 *
 *  Escapa o nome do módulo pra evitar meta-chars do regex (módulos tipo
 *  `n8n.webhook` levariam `.` literal).
 */
function buildBlockRegex(moduleName: string): RegExp {
  const escapedName = escapeRegex(moduleName);
  // Captura: start line + corpo do bloco + end line + newline opcional.
  // `m` flag permite `^` / `$` operarem por linha.
  return new RegExp(
    `^# --- ${escapedName} \\(.+?\\) ---[\\r\\n]+` +
      `[\\s\\S]*?` +
      `^# --- Fim ${escapedName} ---[\\r\\n]*`,
    "m",
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Renderiza uma única linha `KEY=value` respeitando convenções de escape.
 *
 *  Envolve em aspas duplas quando o valor contém espaço, `#` ou aspa dupla
 *  — protege contra parsers de .env que tratam essas marcas especialmente.
 *  Aspas internas são escapadas com barra.
 */
function renderEnvLine(envVar: EnvVarDefinition): string {
  // Obrigatória sem default → vazio. Obrigatória COM default → usa default
  // (incomum mas possível). Opcional → default ou vazio.
  const value = envVar.default ?? "";
  const needsQuoting =
    value.length > 0 && /[\s#"]/.test(value);
  const rendered = needsQuoting
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
  return `${envVar.name}=${rendered}`;
}

/** Gera o bloco completo (delimitadores + linhas) pra um módulo. */
function renderBlock(manifest: EnvBlockTarget): string {
  const lines: string[] = [];
  lines.push(envBlockStart(manifest.name, manifest.version));
  for (const envVar of manifest.env_vars) {
    lines.push(renderEnvLine(envVar));
  }
  lines.push(envBlockEnd(manifest.name));
  return lines.join("\n");
}

/** Detecta vars do módulo que já existem FORA do bloco delimitado.
 *
 *  Por que importa: se o dev configurou `EVOLUTION_URL=...` manualmente antes
 *  da instalação do módulo, o bloco novo cria uma duplicata. Emitir warning
 *  ajuda a resolver sem perder configuração manual.
 */
function findOutOfBlockDuplicates(
  contentWithoutBlock: string,
  envVars: EnvVarDefinition[],
): string[] {
  const duplicates: string[] = [];
  for (const v of envVars) {
    // Match linha `VAR=` no início de linha (ignora comentários, etc.)
    const re = new RegExp(`^${escapeRegex(v.name)}=`, "m");
    if (re.test(contentWithoutBlock)) {
      duplicates.push(v.name);
    }
  }
  return duplicates;
}

// --------------------------------------------------------------------------- //
//  API pública
// --------------------------------------------------------------------------- //

export interface UpdateEnvExampleOptions {
  projectDir: string;
  manifest: EnvBlockTarget;
  dryRun: boolean;
  /** Quando `true` (default v0.8.0+), remove ocorrências das vars do
   *  manifest que existem FORA do bloco gerenciado antes de inserir o
   *  bloco novo. Resolve o problema do projeto lab onde `.env.example`
   *  acumulou 38 ocorrências de DOMAIN em 167 linhas após múltiplos
   *  upgrades. Setar `false` mantém comportamento pre-v0.8.0 (apenas
   *  detecta e warna). ADR-003. */
  dedupOutOfBlock?: boolean;
}

/** Remove TODAS as ocorrências (linhas) das vars listadas, fora do bloco.
 *  Pré-condição: o bloco do módulo foi REMOVIDO do `content` antes de
 *  chamar (caller passa `contentWithoutBlock`). Comments e linhas em
 *  branco são preservados. Idempotente. */
function removeOutOfBlockOccurrences(
  contentWithoutBlock: string,
  varNames: readonly string[],
): { content: string; removed: string[] } {
  if (varNames.length === 0) {
    return { content: contentWithoutBlock, removed: [] };
  }
  const removedSet = new Set<string>();
  const lines = contentWithoutBlock.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    let matched = false;
    for (const name of varNames) {
      const re = new RegExp(`^${escapeRegex(name)}=`);
      if (re.test(line)) {
        removedSet.add(name);
        matched = true;
        break;
      }
    }
    if (!matched) kept.push(line);
  }
  return { content: kept.join("\n"), removed: [...removedSet] };
}

/** Adiciona ou substitui o bloco do módulo no `.env.example`.
 *
 *  NÃO levanta exceções — retorna `EnvExampleChanges` com `applied: false` e
 *  `errorMessage` em caso de falha. Caller decide como apresentar pro usuário.
 *
 *  `dedupOutOfBlock` (default `true` em v0.8.0+): se houver vars do manifest
 *  declaradas fora do bloco gerenciado, REMOVE as ocorrências antes de
 *  inserir o novo bloco. Mantém apenas a versão dentro do bloco. Aluno é
 *  notificado via `removedDuplicates` no resultado.
 */
export async function updateEnvExample(
  opts: UpdateEnvExampleOptions,
): Promise<EnvExampleChanges> {
  const { projectDir, manifest, dryRun } = opts;
  const dedup = opts.dedupOutOfBlock ?? true;
  const filePath = path.join(projectDir, ENV_EXAMPLE_FILENAME);
  const exists = await pathExists(filePath);
  const blockRegex = buildBlockRegex(manifest.name);
  const newBlock = renderBlock(manifest);
  const varCount = manifest.env_vars.length;

  try {
    if (!exists) {
      // Não existe: cria com header mínimo + bloco.
      if (!dryRun) {
        await writeFile(filePath, `${DEFAULT_HEADER}\n${newBlock}\n`, "utf8");
      }
      return {
        applied: true,
        created: true,
        replaced: false,
        varCount,
        outOfBlockDuplicates: [],
        removedDuplicates: [],
      };
    }

    const original = await readFile(filePath, "utf8");
    let replaced = false;

    // Passo 1: remove o bloco existente do módulo (se houver) pra ter base
    // limpa pra dedup + re-inserção.
    let stripped = original;
    if (blockRegex.test(original)) {
      stripped = original.replace(buildBlockRegex(manifest.name), "");
      replaced = true;
    }

    // Passo 2: detecta + opcionalmente remove duplicatas FORA do bloco.
    const detectedDuplicates = findOutOfBlockDuplicates(
      stripped,
      manifest.env_vars,
    );
    let removedDuplicates: string[] = [];
    if (dedup && detectedDuplicates.length > 0) {
      const dedupResult = removeOutOfBlockOccurrences(
        stripped,
        detectedDuplicates,
      );
      stripped = dedupResult.content;
      removedDuplicates = dedupResult.removed;
    }

    // Passo 3: re-insere o bloco novo (no final se foi append, ou no
    // mesmo "espaço" lógico se foi replace).
    const separator = stripped.endsWith("\n") || stripped === ""
      ? ""
      : "\n";
    const updated = `${stripped}${separator}${newBlock}\n`;

    // outOfBlockDuplicates ainda reflete o detectado (transparência);
    // removedDuplicates só lista o que efetivamente sumiu.
    const outOfBlockDuplicates = detectedDuplicates;

    if (!dryRun) {
      await writeFile(filePath, updated, "utf8");
    }

    return {
      applied: true,
      created: false,
      replaced,
      varCount,
      outOfBlockDuplicates,
      removedDuplicates,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      applied: false,
      created: false,
      replaced: false,
      varCount,
      outOfBlockDuplicates: [],
      removedDuplicates: [],
      errorMessage: msg,
    };
  }
}

// Exporta helpers pra testes unitários (vitest importa direto).
export const _internals = {
  buildBlockRegex,
  renderBlock,
  renderEnvLine,
  findOutOfBlockDuplicates,
  removeOutOfBlockOccurrences,
};
