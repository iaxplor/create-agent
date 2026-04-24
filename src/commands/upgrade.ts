// Comando `create-agent upgrade [target] [flags]`.
//
// Targets:
//   - "core" (ou omitido => "all"): upgrade do core
//   - "<modulo>": upgrade de um módulo específico (ex.: "evolution-api")
//   - "all": core + todos os módulos instalados, em sequência
//
// Flags:
//   --yes           aceita sobrescritas/remoções sem prompt (perigoso)
//   --dry-run       só mostra plano, não aplica
//   --no-stash      pula prompt de git stash
//   --template-source <url>   override do repo base (default: iaxplor/agent-templates)
//
// Fluxo de 7 fases documentado em CHANGELOG.md. Este arquivo orquestra.

import path from "node:path";

import chalk from "chalk";

import type { ModuleTemplateJson } from "../types.js";
import { printBanner } from "../utils/banner.js";
import { readAgenteConfig } from "../utils/config-reader.js";
import { confirm } from "../utils/confirm.js";
import { UserError } from "../utils/errors.js";
import { hasGitInstalled, isGitRepo, stashPush } from "../utils/git-stash.js";
import {
  askDeletedAction,
  askModifiedAction,
} from "../utils/interactive-file-action.js";
import { createSpinner, log } from "../utils/logger.js";
import { parseModuleManifest } from "../utils/template-manifest.js";
import {
  cleanupSnapshot,
  fetchCoreLatestVersion,
  fetchCoreSnapshot,
  fetchModuleLatestVersion,
  fetchModuleSnapshot,
  isNewer,
  listProjectComponents,
  resolveInstalledCoreVersion,
} from "../utils/version-manifest.js";
import {
  executeUpgrade,
  type UpgradeDecisions,
  type UpgradeResult,
} from "../utils/upgrade-executor.js";
import { planUpgrade, type UpgradePlan } from "../utils/upgrade-planner.js";

export interface UpgradeOptions {
  templateSource?: string;
  yes?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
}

export async function upgradeCommand(
  target: string | undefined,
  opts: UpgradeOptions = {},
): Promise<void> {
  printBanner();

  const resolvedTarget = target ?? "all";
  const cwd = process.cwd();

  // Validação comum: projeto IAxplor?
  const config = await readAgenteConfig(cwd);

  if (resolvedTarget === "all") {
    await upgradeAll(cwd, config, opts);
    return;
  }

  if (resolvedTarget === "core") {
    await upgradeCore(cwd, config, opts);
    return;
  }

  // Módulo específico.
  if (!config.modules || !config.modules[resolvedTarget]) {
    throw new UserError(
      `Módulo '${resolvedTarget}' não está instalado neste projeto.\n` +
        `  Instale com: create-agent add ${resolvedTarget}`,
    );
  }
  await upgradeModule(cwd, config, resolvedTarget, opts);
}

// --------------------------------------------------------------------------- //
//  upgrade core
// --------------------------------------------------------------------------- //

async function upgradeCore(
  cwd: string,
  config: import("../types.js").AgenteConfig,
  opts: UpgradeOptions,
): Promise<void> {
  // Fase 1 — Validação inicial
  const installedVersion = resolveInstalledCoreVersion(config);
  if (!config.coreVersion) {
    log.warn(
      `agente.config.json sem campo 'coreVersion'. Assumindo 0.1.0 ` +
        `(primeira versão). Se souber que é outra, edite antes de continuar.`,
    );
  }

  const availableVersion = await fetchCoreLatestVersion(opts);

  if (!isNewer(availableVersion, installedVersion)) {
    log.success(`Core já está atualizado em v${installedVersion}.`);
    return;
  }

  console.log();
  console.log(
    chalk.bold(
      `📦 Upgrade disponível: core v${installedVersion} → v${availableVersion}`,
    ),
  );

  // Fase 2 — Baixar snapshots
  const spinner = createSpinner("Baixando snapshots pra comparação...");
  const oldSnapshotDir = await fetchCoreSnapshot(installedVersion, opts);
  const newSnapshotDir = await fetchCoreSnapshot(availableVersion, opts);
  if (newSnapshotDir === null) {
    spinner.fail("Falha ao baixar versão nova do core");
    throw new UserError(
      `Não consegui baixar core@${availableVersion}. Verifique que a tag ` +
        `v${availableVersion} existe em iaxplor/agent-templates.`,
    );
  }
  spinner.succeed(
    oldSnapshotDir
      ? "Snapshots baixados (antigo + novo)"
      : "Snapshot novo baixado (modo degradado — sem versão base)",
  );

  if (!oldSnapshotDir) {
    log.warn(
      `Tag v${installedVersion} não encontrada no repositório. ` +
        `Operando em modo degradado: qualquer arquivo diferente da nova ` +
        `versão será marcado como modificado (pode gerar falsos positivos).`,
    );
  }

  try {
    // Fase 3 — Análise
    const planSpinner = createSpinner("Analisando arquivos...");
    const plan = await planUpgrade({
      projectDir: cwd,
      oldSnapshotDir,
      newSnapshotDir,
    });
    planSpinner.succeed(`Plano gerado (${plan.entries.length} arquivos analisados)`);

    // Fase 3B — Prompts interativos
    const decisions = await collectDecisions(plan, opts.yes ?? false);

    // Fase 4 — Resumo + confirmação
    printPlanSummary(plan, decisions, installedVersion, availableVersion);

    if (!opts.dryRun && !opts.yes) {
      const proceed = await confirm("Continuar?");
      if (!proceed) {
        throw new UserError("Upgrade cancelado pelo usuário. Nada foi modificado.");
      }
    }

    // Fase 5 — Git stash
    if (!opts.dryRun && !opts.noStash) {
      await offerStash(cwd, `Pre-upgrade core v${installedVersion}→${availableVersion}`);
    }

    // Fase 6 — Aplicação
    const execSpinner = createSpinner(
      opts.dryRun ? "Simulando upgrade (dry-run)..." : "Aplicando upgrade...",
    );
    const result = await executeUpgrade({
      plan,
      decisions,
      projectDir: cwd,
      newVersion: availableVersion,
      target: "core",
      dryRun: opts.dryRun ?? false,
    });
    execSpinner.succeed(
      opts.dryRun
        ? `Simulação OK`
        : `Core atualizado de v${installedVersion} pra v${availableVersion}`,
    );

    // Fase 7 — Mensagem pós-upgrade
    await printPostUpgradeMessage({
      cwd,
      config,
      oldVersion: installedVersion,
      newVersion: availableVersion,
      result,
      opts,
    });
  } finally {
    await Promise.all([
      cleanupSnapshot(oldSnapshotDir),
      cleanupSnapshot(newSnapshotDir),
    ]);
  }
}

// --------------------------------------------------------------------------- //
//  upgrade <modulo>
// --------------------------------------------------------------------------- //

async function upgradeModule(
  cwd: string,
  config: import("../types.js").AgenteConfig,
  moduleName: string,
  opts: UpgradeOptions,
): Promise<void> {
  const installed = config.modules[moduleName];
  if (!installed) {
    throw new UserError(`Módulo '${moduleName}' não instalado.`);
  }

  const availableVersion = await fetchModuleLatestVersion(moduleName, opts);
  if (!availableVersion) {
    throw new UserError(
      `Não consegui baixar template.json do módulo '${moduleName}'. ` +
        `Módulo foi renomeado ou removido do repositório?`,
    );
  }

  if (!isNewer(availableVersion, installed.version)) {
    log.success(`Módulo '${moduleName}' já está atualizado em v${installed.version}.`);
    return;
  }

  console.log();
  console.log(
    chalk.bold(
      `📦 Upgrade disponível: ${moduleName} v${installed.version} → v${availableVersion}`,
    ),
  );

  const oldSnapshotDir = await fetchModuleSnapshot(
    moduleName,
    installed.version,
    opts,
  );
  const newSnapshotDir = await fetchModuleSnapshot(
    moduleName,
    availableVersion,
    opts,
  );

  if (!newSnapshotDir) {
    throw new UserError(
      `Falha ao baixar ${moduleName}@${availableVersion}. ` +
        `Verifique que a tag v${availableVersion} existe.`,
    );
  }

  try {
    // Pra módulos, files[] do template.json dita o mapeamento. Usamos o
    // mesmo planner com filesSubdir="files" — e os relPaths dentro do
    // planner já estão relativos a files/, que é o que a gente quer
    // comparar contra o projeto. OK.
    //
    // Mas: os paths destino NÃO são necessariamente os relativos do
    // snapshot (ex.: files/channels/evolution/* → channels/evolution/*
    // — happen to match nesse módulo). Pra MVP, suporta quando from===to.
    const manifestPath = path.join(newSnapshotDir, "template.json");
    const manifest: ModuleTemplateJson = await parseModuleManifest(newSnapshotDir);
    void manifest; // (reservado pra validações futuras de mapping)
    void manifestPath;

    const plan = await planUpgrade({
      projectDir: cwd,
      oldSnapshotDir,
      newSnapshotDir,
    });

    const decisions = await collectDecisions(plan, opts.yes ?? false);
    printPlanSummary(plan, decisions, installed.version, availableVersion, moduleName);

    if (!opts.dryRun && !opts.yes) {
      const proceed = await confirm("Continuar?");
      if (!proceed) {
        throw new UserError("Upgrade cancelado. Nada foi modificado.");
      }
    }

    if (!opts.dryRun && !opts.noStash) {
      await offerStash(cwd, `Pre-upgrade ${moduleName} v${installed.version}→${availableVersion}`);
    }

    const result = await executeUpgrade({
      plan,
      decisions,
      projectDir: cwd,
      newVersion: availableVersion,
      target: moduleName,
      dryRun: opts.dryRun ?? false,
    });

    console.log();
    log.success(
      opts.dryRun
        ? `Dry-run concluído. ${result.copied.length + result.overwritten.length} arquivo(s) seriam modificados.`
        : `Módulo '${moduleName}' atualizado pra v${availableVersion}.`,
    );
  } finally {
    await Promise.all([
      cleanupSnapshot(oldSnapshotDir),
      cleanupSnapshot(newSnapshotDir),
    ]);
  }
}

// --------------------------------------------------------------------------- //
//  upgrade all
// --------------------------------------------------------------------------- //

async function upgradeAll(
  cwd: string,
  config: import("../types.js").AgenteConfig,
  opts: UpgradeOptions,
): Promise<void> {
  const components = await listProjectComponents(config, opts);
  const pending = components.filter((c) => c.hasUpdate);

  if (pending.length === 0) {
    log.success("Tudo atualizado.");
    return;
  }

  console.log();
  console.log(chalk.bold(`📦 ${pending.length} componente(s) com upgrade disponível:`));
  for (const c of pending) {
    console.log(
      `   • ${chalk.cyan(c.displayName)} ${c.installedVersion} → ${c.availableVersion}`,
    );
  }
  console.log();

  // Core primeiro, depois módulos na ordem original.
  for (const c of pending) {
    if (c.target === "core") {
      await upgradeCore(cwd, config, opts);
      // Re-ler config porque upgradeCore atualizou coreVersion.
      config = await readAgenteConfig(cwd);
    }
  }
  for (const c of pending) {
    if (c.target !== "core") {
      await upgradeModule(cwd, config, c.target, opts);
      config = await readAgenteConfig(cwd);
    }
  }
}

// --------------------------------------------------------------------------- //
//  Helpers de orquestração
// --------------------------------------------------------------------------- //

async function collectDecisions(
  plan: UpgradePlan,
  autoYes: boolean,
): Promise<UpgradeDecisions> {
  const modified = new Map<string, "overwrite" | "keep">();
  const noBaseDiff = new Map<string, "overwrite" | "keep">();
  const deleted = new Map<string, "delete" | "preserve">();

  for (const entry of plan.entries) {
    if (entry.status === "modified-locally") {
      if (autoYes) {
        modified.set(entry.relPath, "overwrite");
      } else if (entry.sourceNewPath) {
        const localContent = await readFileSafe(entry.destPath);
        const newContent = await readFileSafe(entry.sourceNewPath);
        modified.set(
          entry.relPath,
          await askModifiedAction(entry.relPath, localContent, newContent),
        );
      }
    } else if (entry.status === "changed-remote-no-base") {
      if (autoYes) {
        noBaseDiff.set(entry.relPath, "overwrite");
      } else if (entry.sourceNewPath) {
        const localContent = await readFileSafe(entry.destPath);
        const newContent = await readFileSafe(entry.sourceNewPath);
        noBaseDiff.set(
          entry.relPath,
          await askModifiedAction(entry.relPath, localContent, newContent, {
            noBase: true,
          }),
        );
      }
    } else if (entry.status === "deleted-in-new") {
      if (autoYes) {
        deleted.set(entry.relPath, "delete");
      } else {
        deleted.set(entry.relPath, await askDeletedAction(entry.relPath));
      }
    }
  }

  return {
    modifiedLocally: modified,
    changedRemoteNoBase: noBaseDiff,
    deletedInNew: deleted,
  };
}

async function readFileSafe(filePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function printPlanSummary(
  plan: UpgradePlan,
  decisions: UpgradeDecisions,
  oldVersion: string,
  newVersion: string,
  componentName = "core",
): void {
  const newFiles = plan.entries.filter((e) => e.status === "new");
  const silentUpgrade = plan.entries.filter((e) => e.status === "unchanged-from-base");
  const skipped = plan.entries.filter((e) => e.status === "same-as-new");

  const overwrites: typeof plan.entries = [];
  const keeps: typeof plan.entries = [];
  for (const e of plan.entries) {
    if (e.status === "modified-locally" || e.status === "changed-remote-no-base") {
      const map =
        e.status === "modified-locally"
          ? decisions.modifiedLocally
          : decisions.changedRemoteNoBase;
      if (map.get(e.relPath) === "overwrite") overwrites.push(e);
      else keeps.push(e);
    }
  }

  const deletes: typeof plan.entries = [];
  const preserves: typeof plan.entries = [];
  for (const e of plan.entries) {
    if (e.status === "deleted-in-new") {
      if (decisions.deletedInNew.get(e.relPath) === "delete") deletes.push(e);
      else preserves.push(e);
    }
  }

  console.log();
  console.log(
    chalk.bold(
      `📋 Plano de upgrade: ${componentName} v${oldVersion} → v${newVersion}`,
    ),
  );
  console.log();
  printList("Arquivos novos", newFiles.map((e) => e.relPath), chalk.green("+"));
  printList("Silent upgrade (você não modificou)", silentUpgrade.map((e) => e.relPath), "✓");
  printList("Sobrescrevendo (você confirmou)", overwrites.map((e) => e.relPath), chalk.cyan("↻"));
  printList("Mantendo (suas mods preservadas)", keeps.map((e) => e.relPath), chalk.yellow("⏸"));
  printList("Deletando (você confirmou)", deletes.map((e) => e.relPath), chalk.red("✗"));
  printList("Preservando deletados", preserves.map((e) => e.relPath), chalk.gray("~"));
  if (skipped.length > 0) {
    console.log(chalk.gray(`   (${skipped.length} arquivos já em dia, skip)`));
  }
  console.log();
}

function printList(title: string, items: string[], bullet: string): void {
  if (items.length === 0) return;
  console.log(chalk.bold(`${title} (${items.length}):`));
  const toShow = items.slice(0, 10);
  for (const item of toShow) {
    console.log(`   ${bullet} ${item}`);
  }
  if (items.length > 10) {
    console.log(chalk.gray(`   ... e mais ${items.length - 10}`));
  }
  console.log();
}

async function offerStash(cwd: string, message: string): Promise<void> {
  if (!(await hasGitInstalled())) {
    log.warn("Git não encontrado — pulando backup via stash.");
    return;
  }
  if (!(await isGitRepo(cwd))) {
    log.warn("Projeto não é um git repo — pulando backup via stash.");
    return;
  }
  const ok = await confirm("💾 Fazer backup via git stash antes? (recomendado)");
  if (!ok) {
    log.warn("Sem backup — suas mods não commitadas serão misturadas com o upgrade.");
    return;
  }
  const done = await stashPush(cwd, message);
  if (done) {
    log.success("Backup feito. Recupere com: git stash pop");
  } else {
    log.warn("Falha ao fazer stash. Prosseguindo sem backup.");
  }
}

// --------------------------------------------------------------------------- //
//  Fase 7 — Mensagem pós-upgrade
// --------------------------------------------------------------------------- //

interface PostUpgradeOptions {
  cwd: string;
  config: import("../types.js").AgenteConfig;
  oldVersion: string;
  newVersion: string;
  result: UpgradeResult;
  opts: UpgradeOptions;
}

async function printPostUpgradeMessage(args: PostUpgradeOptions): Promise<void> {
  const { config, oldVersion, newVersion, result, opts } = args;

  console.log();
  if (result.dryRun) {
    console.log(chalk.yellow(`⚠  Dry-run: nenhuma modificação foi feita.`));
    return;
  }

  console.log(chalk.green.bold(`✅ Core atualizado: v${oldVersion} → v${newVersion}`));
  console.log();

  // Módulos possivelmente afetados pelo warning expandido (OBS 2)
  await printModuleImpactWarning(config, result, opts);

  // Módulos com nova versão disponível
  await printModuleUpgradesAvailable(config, opts);

  console.log(chalk.bold("📋 Próximos passos:"));
  console.log();
  console.log("   1. Revisar mudanças: " + chalk.cyan("git diff"));
  console.log(
    `   2. ${chalk.cyan(`git add . && git commit -m "chore: upgrade core to ${newVersion}"`)}`,
  );
  console.log(`   3. ${chalk.cyan("git push")}`);
  console.log("   4. Aguardar redeploy no Dokploy");
  console.log();
  console.log(chalk.gray("💡 Em caso de problema, recupere o backup: git stash pop"));
  console.log();
}

/** Warning específico (OBS 2) quando arquivos sobrescritos são sabidamente
 *  patchados por módulos instalados — significa que patches manuais foram
 *  perdidos e precisam ser re-aplicados.
 */
async function printModuleImpactWarning(
  config: import("../types.js").AgenteConfig,
  result: UpgradeResult,
  opts: UpgradeOptions,
): Promise<void> {
  const overwrittenSet = new Set(result.overwritten);
  if (overwrittenSet.size === 0) return;

  const affected: Array<{ module: string; patchedFiles: string[] }> = [];

  for (const moduleName of Object.keys(config.modules ?? {})) {
    const entry = config.modules[moduleName];
    if (!entry) continue;
    const snapshot = await fetchModuleSnapshot(moduleName, entry.version, opts);
    if (!snapshot) continue;
    try {
      const manifest = await parseModuleManifest(snapshot);
      const patched = manifest.patches.map((p) => p.file);
      const overlap = patched.filter((f) => overwrittenSet.has(f));
      if (overlap.length > 0) {
        affected.push({ module: moduleName, patchedFiles: overlap });
      }
    } catch {
      /* ignora — manifest inválido */
    } finally {
      await cleanupSnapshot(snapshot);
    }
  }

  if (affected.length === 0) return;

  console.log(chalk.yellow.bold("⚠  IMPORTANTE:"));
  console.log(
    chalk.yellow(
      `   você sobrescreveu arquivos que são patchados por módulos instalados.`,
    ),
  );
  console.log();
  for (const a of affected) {
    console.log(`   • ${chalk.cyan(a.module)} patcha: ${a.patchedFiles.join(", ")}`);
  }
  console.log();
  console.log(
    "   Os patches manuais foram PERDIDOS no sobrescrito. Execute:",
  );
  for (const a of affected) {
    console.log(`     ${chalk.cyan(`create-agent upgrade ${a.module}`)}`);
  }
  console.log("   Pra re-aplicar os patches na versão nova do core.");
  console.log();
  console.log(
    chalk.gray(
      "   Se você preferiu [M]anter os arquivos, o core novo pode ter comportamento",
    ),
  );
  console.log(
    chalk.gray(
      "   inconsistente com os módulos antigos — considere atualizar os módulos logo.",
    ),
  );
  console.log();
}

async function printModuleUpgradesAvailable(
  config: import("../types.js").AgenteConfig,
  opts: UpgradeOptions,
): Promise<void> {
  const components = await listProjectComponents(config, opts);
  const pending = components.filter((c) => c.target !== "core" && c.hasUpdate);
  if (pending.length === 0) return;

  console.log(chalk.bold("📦 Módulos com nova versão disponível:"));
  for (const c of pending) {
    console.log(
      `   • ${chalk.cyan(c.displayName)} ${c.installedVersion} → ${c.availableVersion}`,
    );
  }
  console.log(
    chalk.gray(
      `   Execute ${chalk.cyan("create-agent upgrade <modulo>")} pra atualizar individualmente ` +
        `ou ${chalk.cyan("create-agent upgrade all")} pra todos.`,
    ),
  );
  console.log();
}
