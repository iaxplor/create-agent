// Executa o plano do upgrade-planner aplicando as decisões do usuário.
//
// Ordem das operações:
//   1. Cópia de arquivos (new, unchanged-from-base, e os "overwrite")
//   2. Geração de .template lateral (status "protected-skipped" — agent/*)
//   3. Merge custom (status "merged" — .gitignore, .env.example)
//   4. Deleção (os deleted-in-new com decisão "delete")
//   5. Update do config (coreVersion ou modules[X].version)
//
// Sem rollback automático (ADR-004). Se uma etapa falha:
//   - O loop interrompe na exceção (re-throw com contexto)
//   - Arquivos já copiados antes da falha permanecem
//   - agente.config.json NÃO é atualizado (versão antiga preservada)
//   - Recupere via `git stash pop` (se aceitou o stash automático no início
//     do upgrade) ou `git checkout HEAD .` se o projeto está em git limpo

import path from "node:path";

import fsExtra from "fs-extra";

import {
  readAgenteConfig,
  writeAgenteConfig,
} from "./config-reader.js";
import { mergeGitignore } from "./gitignore-merger.js";
import type { DeletedAction, FileAction } from "./interactive-file-action.js";
import type { PlanEntry, UpgradePlan } from "./upgrade-planner.js";

const { copy, ensureDir, pathExists, readFile, remove, writeFile } = fsExtra;

/** Decisões do usuário por arquivo (keyed por `relPath`). */
export interface UpgradeDecisions {
  modifiedLocally: Map<string, FileAction>;
  changedRemoteNoBase: Map<string, FileAction>;
  deletedInNew: Map<string, DeletedAction>;
}

export interface UpgradeResult {
  copied: string[];
  overwritten: string[];
  deleted: string[];
  kept: string[];
  skipped: string[];
  /** Arquivos PROTECTED (agent/*) cujo template difere do local — geramos
   *  `<path>.template` lateral pro aluno revisar (CLI v0.8.0+). */
  templatesGenerated: string[];
  /** Arquivos com merge custom aplicado (.gitignore, .env.example). */
  merged: string[];
  dryRun: boolean;
}

export interface ExecuteUpgradeOptions {
  plan: UpgradePlan;
  decisions: UpgradeDecisions;
  projectDir: string;
  /** Nova versão pra escrever no agente.config.json. */
  newVersion: string;
  /**
   * `"core"` ou nome do módulo — define onde a versão é escrita no config:
   *   - core   → `config.coreVersion = newVersion`
   *   - modulo → `config.modules[name].version = newVersion`
   */
  target: "core" | string;
  dryRun: boolean;
}

export async function executeUpgrade(
  opts: ExecuteUpgradeOptions,
): Promise<UpgradeResult> {
  const result: UpgradeResult = {
    copied: [],
    overwritten: [],
    deleted: [],
    kept: [],
    skipped: [],
    templatesGenerated: [],
    merged: [],
    dryRun: opts.dryRun,
  };

  // Contagem de entries já processadas — usada na mensagem de erro pra
  // dar contexto sobre quantos arquivos foram tocados antes da falha.
  let processedCount = 0;

  for (const entry of opts.plan.entries) {
    const action = resolveAction(entry, opts.decisions);

    try {
      switch (action) {
        case "copy-new":
          if (!opts.dryRun) await doCopy(entry);
          result.copied.push(entry.relPath);
          break;

        case "overwrite":
          if (!opts.dryRun) await doCopy(entry);
          result.overwritten.push(entry.relPath);
          break;

        case "delete":
          if (!opts.dryRun) await remove(entry.destPath);
          result.deleted.push(entry.relPath);
          break;

        case "keep":
          result.kept.push(entry.relPath);
          break;

        case "skip":
          result.skipped.push(entry.relPath);
          break;

        case "generate-template":
          if (!opts.dryRun) await doGenerateTemplate(entry);
          result.templatesGenerated.push(entry.relPath);
          break;

        case "merge":
          if (!opts.dryRun) await doMerge(entry);
          result.merged.push(entry.relPath);
          break;
      }
      processedCount++;
    } catch (err) {
      // Re-throw com contexto rico (ADR-004 — sem rollback automático,
      // apenas mensagem honest orientando recovery via git stash).
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Falha ao processar '${entry.relPath}' (action=${action}): ${original}\n\n` +
          `${processedCount} arquivo(s) já foram processados antes do erro. ` +
          `agente.config.json NÃO foi atualizado (versão antiga preservada).\n` +
          `Recupere via 'git stash pop' (se aceitou stash automático) ou ` +
          `'git checkout HEAD .' se o projeto está em git limpo.`,
      );
    }
  }

  // --- Update do agente.config.json -------------------------------------
  // SÓ executa se loop de cópia terminou sem exceção (caso contrário, já
  // foi re-thrown acima e config fica preservada na versão antiga).
  if (!opts.dryRun) {
    await updateConfigVersion(opts.projectDir, opts.target, opts.newVersion);
  }

  return result;
}

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //

type ResolvedAction =
  | "copy-new"
  | "overwrite"
  | "delete"
  | "keep"
  | "skip"
  | "generate-template"
  | "merge";

export function resolveAction(
  entry: PlanEntry,
  decisions: UpgradeDecisions,
): ResolvedAction {
  switch (entry.status) {
    case "new":
    case "unchanged-from-base":
      return "copy-new";

    case "same-as-new":
      return "skip";

    case "modified-locally":
      return decisions.modifiedLocally.get(entry.relPath) === "overwrite"
        ? "overwrite"
        : "keep";

    case "changed-remote-no-base":
      return decisions.changedRemoteNoBase.get(entry.relPath) === "overwrite"
        ? "overwrite"
        : "keep";

    case "deleted-in-new":
      return decisions.deletedInNew.get(entry.relPath) === "delete"
        ? "delete"
        : "keep";

    case "protected-skipped":
      return "generate-template";

    case "merged":
      return "merge";
  }
}

async function doCopy(entry: PlanEntry): Promise<void> {
  if (!entry.sourceNewPath) {
    throw new Error(
      `Entry ${entry.relPath} marcado como copy mas sem sourceNewPath`,
    );
  }
  await ensureDir(path.dirname(entry.destPath));
  await copy(entry.sourceNewPath, entry.destPath, { overwrite: true });
}

/** Gera `<destPath>.template` lateral pra arquivos PROTECTED (agent/*).
 *  Aluno revisa e mescla manualmente; doctor V8 alerta sobre presença. */
async function doGenerateTemplate(entry: PlanEntry): Promise<void> {
  if (!entry.sourceNewPath) {
    throw new Error(
      `Entry ${entry.relPath} marcado como protected-skipped mas sem sourceNewPath`,
    );
  }
  const templatePath = `${entry.destPath}.template`;
  await ensureDir(path.dirname(templatePath));
  await copy(entry.sourceNewPath, templatePath, { overwrite: true });
}

/** Aplica merge custom em arquivos MERGED (.gitignore por enquanto;
 *  .env.example tem caminho próprio via env-example-editor já existente).
 *
 *  Pra .gitignore: usa mergeGitignore (append-only + security baseline).
 *  Pra .env.example: o env-example-editor é chamado pelo upgrade.ts em
 *  fase posterior (paridade com `add`); aqui é no-op pra evitar dupla
 *  escrita. */
async function doMerge(entry: PlanEntry): Promise<void> {
  if (!entry.sourceNewPath) {
    throw new Error(
      `Entry ${entry.relPath} marcado como merged mas sem sourceNewPath`,
    );
  }
  const baseName = path.basename(entry.relPath);

  if (baseName === ".gitignore") {
    const localContent = (await pathExists(entry.destPath))
      ? await readFile(entry.destPath, "utf8")
      : "";
    const templateContent = await readFile(entry.sourceNewPath, "utf8");
    const merged = mergeGitignore(localContent, templateContent);
    await ensureDir(path.dirname(entry.destPath));
    await writeFile(entry.destPath, merged, "utf8");
    return;
  }

  if (baseName === ".env.example") {
    // .env.example tem fluxo próprio via env-example-editor (paridade com
    // `add` — atualizado em upgrade.ts após executeUpgrade). Aqui é no-op
    // pra evitar dupla escrita. Bloco C (US-3) adiciona dedup ao editor.
    return;
  }

  // Defensivo — se MERGED_FILES ganhar mais entradas no futuro, falha
  // explícita pra forçar implementação aqui.
  throw new Error(
    `doMerge: arquivo '${entry.relPath}' marcado como merged mas sem handler`,
  );
}

async function updateConfigVersion(
  projectDir: string,
  target: "core" | string,
  newVersion: string,
): Promise<void> {
  const config = await readAgenteConfig(projectDir);
  if (target === "core") {
    config.coreVersion = newVersion;
  } else {
    config.modules = { ...config.modules };
    const existing = config.modules[target];
    config.modules[target] = {
      version: newVersion,
      installedAt: existing?.installedAt ?? new Date().toISOString(),
    };
  }
  await writeAgenteConfig(projectDir, config);
}
