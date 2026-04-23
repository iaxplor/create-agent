// Expansão de `files[]` do módulo → plano concreto de cópia + execução.
//
// O `template.json.files[]` de um módulo pode conter entradas tipo:
//   - Arquivo: `{from: "files/foo.py", to: "foo.py"}`
//   - Diretório: `{from: "files/channels/evolution/", to: "channels/evolution/"}`
//
// Este módulo:
//   1. Expande cada entrada em lista concreta de operações `source → destino`.
//   2. Detecta conflitos (destinos que já existem no projeto).
//   3. Executa a cópia (ou simula, se `dryRun=true`).

import path from "node:path";

import fsExtra from "fs-extra";

import type { FileMapping, InstallPlan, InstallResult } from "../types.js";
import { InternalError } from "./errors.js";

const { copy, ensureDir, pathExists, readdir, stat } = fsExtra;

/** Expande `mappings` em operações concretas e identifica conflitos.
 *
 *  Todos os paths retornados em `operations` são absolutos (source e dest).
 *  `conflicts` são paths **relativos** ao `projectDir` — facilita exibir pro
 *  usuário.
 */
export async function planInstall(opts: {
  mappings: FileMapping[];
  moduleDir: string;
  projectDir: string;
}): Promise<InstallPlan> {
  const operations: InstallPlan["operations"] = [];
  const conflicts: string[] = [];

  for (const mapping of opts.mappings) {
    const sourceAbs = path.resolve(opts.moduleDir, mapping.from);

    if (!(await pathExists(sourceAbs))) {
      throw new InternalError(
        `Módulo inválido: arquivo/pasta '${mapping.from}' declarado em ` +
          `template.json.files[] não existe no módulo baixado.`,
      );
    }

    const stats = await stat(sourceAbs);

    if (stats.isDirectory()) {
      // Expande recursivamente todos os arquivos.
      for (const file of await walkFiles(sourceAbs)) {
        // `rel` é o caminho relativo à raiz do source (ex.: "channels/evolution/client.py").
        const rel = path.relative(sourceAbs, file);
        // Se `to` termina com "/", preserva como raiz; senão usa como prefixo.
        const destRel = path.join(stripTrailingSlash(mapping.to), rel);
        const destAbs = path.resolve(opts.projectDir, destRel);

        if (await pathExists(destAbs)) {
          conflicts.push(destRel);
        }
        operations.push({ sourceAbs: file, destAbs, destRel });
      }
    } else {
      // Arquivo único.
      const destRel = stripTrailingSlash(mapping.to);
      const destAbs = path.resolve(opts.projectDir, destRel);

      if (await pathExists(destAbs)) {
        conflicts.push(destRel);
      }
      operations.push({ sourceAbs, destAbs, destRel });
    }
  }

  return { operations, conflicts };
}

/** Executa o plano. `dryRun=true` pula a cópia mas retorna contagem que seria
 *  copiada — caller continua imprimindo "✓ Copiaria X" normalmente.
 */
export async function executeInstall(
  plan: InstallPlan,
  opts: { dryRun: boolean },
): Promise<InstallResult> {
  if (opts.dryRun) {
    return { copiedCount: plan.operations.length, dryRun: true };
  }

  for (const op of plan.operations) {
    // Garante diretórios intermediários.
    await ensureDir(path.dirname(op.destAbs));
    // `overwrite: true` já foi autorizado via confirm no passo anterior.
    await copy(op.sourceAbs, op.destAbs, { overwrite: true });
  }

  return { copiedCount: plan.operations.length, dryRun: false };
}

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //

/** Lista recursiva de arquivos (só arquivos, não diretórios) sob `root`. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
    // symlinks, sockets, etc. ignorados de propósito — template não deve ter.
  }
  return out;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
