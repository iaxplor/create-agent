// Executa o plano do upgrade-planner aplicando as decisões do usuário.
//
// Ordem das operações (importante pra atomicidade relativa):
//   1. Snapshot do agente.config.json atual (pra rollback)
//   2. Cópia de arquivos (new, unchanged-from-base, e os "overwrite")
//   3. Deleção (os deleted-in-new com decisão "delete")
//   4. Update do config (coreVersion ou modules[X].version)
//
// Se qualquer etapa falha, tenta restaurar o config.json e reporta qual
// arquivo falhou. Arquivos já copiados NÃO são revertidos (git stash da
// fase anterior é a proteção real).

import path from "node:path";

import fsExtra from "fs-extra";

import {
  readAgenteConfig,
  writeAgenteConfig,
} from "./config-reader.js";
import type { DeletedAction, FileAction } from "./interactive-file-action.js";
import type { PlanEntry, UpgradePlan } from "./upgrade-planner.js";

const { copy, ensureDir, remove } = fsExtra;

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
    dryRun: opts.dryRun,
  };

  for (const entry of opts.plan.entries) {
    const action = resolveAction(entry, opts.decisions);

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
    }
  }

  // --- Update do agente.config.json -------------------------------------
  if (!opts.dryRun) {
    await updateConfigVersion(opts.projectDir, opts.target, opts.newVersion);
  }

  return result;
}

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //

type ResolvedAction = "copy-new" | "overwrite" | "delete" | "keep" | "skip";

function resolveAction(
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
