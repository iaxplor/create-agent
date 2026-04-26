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
}

/** Adiciona ou substitui o bloco do módulo no `.env.example`.
 *
 *  NÃO levanta exceções — retorna `EnvExampleChanges` com `applied: false` e
 *  `errorMessage` em caso de falha. Caller decide como apresentar pro usuário.
 */
export async function updateEnvExample(
  opts: UpdateEnvExampleOptions,
): Promise<EnvExampleChanges> {
  const { projectDir, manifest, dryRun } = opts;
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
      };
    }

    const original = await readFile(filePath, "utf8");
    let replaced = false;
    let updated: string;

    if (blockRegex.test(original)) {
      // Bloco existente — substitui in-place preservando o resto do arquivo.
      // Reset lastIndex do regex em cada operação (g não, mas melhor blindar).
      updated = original.replace(buildBlockRegex(manifest.name), `${newBlock}\n`);
      replaced = true;
    } else {
      // Append no final com separador em branco.
      const separator = original.endsWith("\n") ? "\n" : "\n\n";
      updated = `${original}${separator}${newBlock}\n`;
    }

    // Detecta duplicatas fora do bloco. Removemos o bloco do conteúdo antes
    // de procurar — senão o próprio bloco que acabamos de escrever matcharia.
    const contentWithoutBlock = updated.replace(
      buildBlockRegex(manifest.name),
      "",
    );
    const outOfBlockDuplicates = findOutOfBlockDuplicates(
      contentWithoutBlock,
      manifest.env_vars,
    );

    if (!dryRun) {
      await writeFile(filePath, updated, "utf8");
    }

    return {
      applied: true,
      created: false,
      replaced,
      varCount,
      outOfBlockDuplicates,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      applied: false,
      created: false,
      replaced: false,
      varCount,
      outOfBlockDuplicates: [],
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
};
