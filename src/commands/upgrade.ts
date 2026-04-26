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

import fsExtra from "fs-extra";
import chalk from "chalk";

import type {
  EnvVarDefinition,
  ModuleTemplateJson,
  PatchDescription,
} from "../types.js";
import { printBanner } from "../utils/banner.js";
import { readAgenteConfig } from "../utils/config-reader.js";
import { confirm } from "../utils/confirm.js";
import {
  type EnvBlockTarget,
  updateEnvExample,
} from "../utils/env-example-editor.js";
import { UserError } from "../utils/errors.js";
import { hasGitInstalled, isGitRepo, stashPush } from "../utils/git-stash.js";
import {
  askDeletedAction,
  askModifiedAction,
} from "../utils/interactive-file-action.js";
import { createSpinner, log } from "../utils/logger.js";
import { updatePyproject } from "../utils/pyproject-editor.js";
import { parseModuleManifest } from "../utils/template-manifest.js";
import {
  cleanupSnapshot,
  type ComponentVersion,
  fetchCoreLatestVersion,
  fetchCoreSnapshot,
  fetchModuleLatestVersion,
  fetchModuleSnapshot,
  isNewer,
  listProjectComponents,
  resolveInstalledCoreVersion,
  type VersionSourceOptions,
} from "../utils/version-manifest.js";
import { isCompatible } from "../utils/version-check.js";
import {
  executeUpgrade,
  type UpgradeDecisions,
  type UpgradeResult,
} from "../utils/upgrade-executor.js";
import { planUpgrade, type UpgradePlan } from "../utils/upgrade-planner.js";

const { readJson } = fsExtra;

export interface UpgradeOptions {
  templateSource?: string;
  /** Legacy (CLI v0.7.x e anterior): "yes pra tudo". Em v0.8.0+, alias
   *  pra acceptNew + overwriteModified + deleteRemoved (ADR-005). */
  yes?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
  /** Modo CI gate (v0.7.0+): apenas lista components com update disponível
   *  e seta process.exitCode = 1 se houver. Não baixa snapshots, não roda
   *  planUpgrade, não escreve nada. */
  check?: boolean;
  /** v0.8.0+ — aceita arquivos NOVOS sem prompt (não afeta modified). */
  acceptNew?: boolean;
  /** v0.8.0+ — força overwrite em arquivos modified-locally /
   *  changed-remote-no-base. PERIGOSO. Sem isso, modified vira "keep". */
  overwriteModified?: boolean;
  /** v0.8.0+ — força delete em arquivos deleted-in-new. */
  deleteRemoved?: boolean;
}

/** Política de decisão consolidada (ADR-005). Resultado de
 *  resolveDecisionPolicy(opts) — granular, testável, sem efeito colateral. */
export interface DecisionPolicy {
  /** Auto-aceita arquivos novos (sem prompt). */
  acceptNew: boolean;
  /** Auto-overwrite em modified-locally / changed-remote-no-base. */
  overwriteModified: boolean;
  /** Auto-delete em deleted-in-new. */
  deleteRemoved: boolean;
}

/** Normaliza UpgradeOptions em política granular. `--yes` legacy ativa os 3
 *  pra retrocompatibilidade. Sem flags → política conservadora (prompt em
 *  TTY, "keep"/"preserve" em CI). */
export function resolveDecisionPolicy(opts: UpgradeOptions): DecisionPolicy {
  if (opts.yes) {
    return {
      acceptNew: true,
      overwriteModified: true,
      deleteRemoved: true,
    };
  }
  return {
    acceptNew: opts.acceptNew ?? false,
    overwriteModified: opts.overwriteModified ?? false,
    deleteRemoved: opts.deleteRemoved ?? false,
  };
}

/** True se o aluno passou QUALQUER flag de automação (--yes legacy OU
 *  qualquer das 3 granulares). Usado pra skipar o prompt geral "Continuar?"
 *  em runs de CI sem ter que passar --yes inteiro. */
export function isAutomatedRun(opts: UpgradeOptions): boolean {
  return Boolean(
    opts.yes ||
      opts.acceptNew ||
      opts.overwriteModified ||
      opts.deleteRemoved,
  );
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

  // CI gate (v0.7.0+): --check pula TUDO e só reporta. Aplica antes do
  // dispatcher pra também respeitar --check em `upgrade core`/`upgrade <mod>`
  // (caso CI queira filtrar por componente específico no futuro).
  if (opts.check) {
    const result = await runCheckMode(opts);
    printCheckOutput(result);
    process.exitCode = result.exitCode;
    return;
  }

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

/** Resultado do modo --check: lista de componentes com update + exit code
 *  esperado (1 se há updates, 0 se tudo atualizado). Helper isolado pra
 *  testes diretos (sem precisar mockar process.exitCode). */
export interface CheckModeResult {
  updates: ComponentVersion[];
  exitCode: 0 | 1;
}

/** Executa o modo --check: lê config, lista componentes, filtra os que têm
 *  update. Não baixa snapshots, não escreve nada. */
export async function runCheckMode(
  opts: VersionSourceOptions = {},
): Promise<CheckModeResult> {
  const config = await readAgenteConfig(process.cwd());
  const components = await listProjectComponents(config, opts);
  const updates = components.filter((c) => c.hasUpdate);
  return {
    updates,
    exitCode: updates.length > 0 ? 1 : 0,
  };
}

/** Renderiza o resultado do --check no terminal — apenas a tabela de
 *  componentes desatualizados + comando recomendado. */
function printCheckOutput(result: CheckModeResult): void {
  if (result.updates.length === 0) {
    log.success("Tudo atualizado — nenhuma ação necessária.");
    return;
  }
  console.log();
  console.log(chalk.bold(`📦 ${result.updates.length} atualização(ões) pendente(s):`));
  console.log();
  for (const c of result.updates) {
    console.log(
      `   ${chalk.cyan(c.displayName)}   ${c.installedVersion} → ${chalk.green(c.availableVersion)}`,
    );
  }
  console.log();
  console.log(chalk.bold("Aplique com:"));
  log.command("create-agent upgrade   # atualiza tudo");
  console.log();
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
    const decisions = await collectDecisions(plan, resolveDecisionPolicy(opts));

    // Fase 4 — Resumo + confirmação
    printPlanSummary(plan, decisions, installedVersion, availableVersion);

    if (!opts.dryRun && !isAutomatedRun(opts)) {
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

    // Fase 6B — Propagação env_vars (CLI v0.5.0+ — paridade `add`/`upgrade`)
    // Core não tem `dependencies`/`min_core_version`/`patches`, mas tem
    // `env_vars` que podem mudar entre versões (ex.: BUFFER_* da Sessão A).
    const coreEnvTarget = await loadCoreEnvBlockTarget(newSnapshotDir);
    if (coreEnvTarget) {
      const envChanges = await updateEnvExample({
        projectDir: cwd,
        manifest: coreEnvTarget,
        dryRun: opts.dryRun ?? false,
      });
      reportEnvExampleChanges(envChanges, ".env.example");
    }

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

/** Lê `template.json` do snapshot do core e extrai `EnvBlockTarget`.
 *
 *  Core NÃO satisfaz `ModuleTemplateJson` completo (faltam `requires`,
 *  `min_core_version`, `files`, `patches`), então `parseModuleManifest`
 *  não funciona. Aqui parseamos só os 3 campos que o `updateEnvExample`
 *  precisa: `name`, `version`, `env_vars`.
 *
 *  Retorna `null` se algo der errado — caller skipa propagação de env
 *  e segue (degradação graciosa).
 */
export async function loadCoreEnvBlockTarget(
  snapshotDir: string,
): Promise<EnvBlockTarget | null> {
  try {
    const manifestPath = path.join(snapshotDir, "template.json");
    const raw = (await readJson(manifestPath)) as {
      name?: string;
      version?: string;
      env_vars?: unknown[];
    };
    if (typeof raw.name !== "string" || typeof raw.version !== "string") {
      return null;
    }
    if (!Array.isArray(raw.env_vars)) {
      return null;
    }
    const envVars: EnvVarDefinition[] = [];
    for (const v of raw.env_vars) {
      if (
        typeof v === "object" &&
        v !== null &&
        typeof (v as { name?: unknown }).name === "string"
      ) {
        const obj = v as Record<string, unknown>;
        envVars.push({
          name: obj.name as string,
          description:
            typeof obj.description === "string" ? obj.description : undefined,
          required: typeof obj.required === "boolean" ? obj.required : undefined,
          default: typeof obj.default === "string" ? obj.default : undefined,
        });
      }
    }
    return { name: raw.name, version: raw.version, env_vars: envVars };
  } catch {
    return null;
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
    const newManifest: ModuleTemplateJson = await parseModuleManifest(newSnapshotDir);
    const oldManifest = await tryParseModuleManifest(oldSnapshotDir);

    // Validação CLI v0.5.0+: `min_core_version` da nova versão precisa ser
    // compatível com o core instalado. Se incompatível: prompt (cancelável)
    // ou warning silencioso com `--yes`.
    const coreVersion = resolveInstalledCoreVersion(config);
    if (!isCompatible(coreVersion, newManifest.min_core_version)) {
      console.log();
      log.warn(
        `Esta versão de '${moduleName}' (${availableVersion}) requer ` +
          `core >= ${newManifest.min_core_version}, mas seu projeto está ` +
          `em ${coreVersion}.`,
      );
      console.log(
        chalk.gray(
          `   Recomendado: rode 'create-agent upgrade core' antes.`,
        ),
      );
      if (!isAutomatedRun(opts)) {
        const cont = await confirm("Continuar mesmo assim?");
        if (!cont) {
          throw new UserError(
            "Upgrade cancelado por incompatibilidade de versão.",
          );
        }
      } else {
        log.warn("Prosseguindo com flags de automação — sob seu risco.");
      }
    }

    const plan = await planUpgrade({
      projectDir: cwd,
      oldSnapshotDir,
      newSnapshotDir,
    });

    const decisions = await collectDecisions(plan, resolveDecisionPolicy(opts));
    printPlanSummary(plan, decisions, installed.version, availableVersion, moduleName);

    // CLI v0.5.0+: detecta migrations Alembic novas no plano e avisa.
    notifyMigrationsIfPresent(plan, decisions);

    if (!opts.dryRun && !isAutomatedRun(opts)) {
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

    // CLI v0.5.0+ — paridade `add`/`upgrade`: propaga env_vars e
    // dependencies da nova versão. Sem isso, vars novas (ex.: 4
    // GCAL_CONFIRMATION_* da Sessão D) somem do .env.example após
    // upgrade.
    const envChanges = await updateEnvExample({
      projectDir: cwd,
      manifest: newManifest,
      dryRun: opts.dryRun ?? false,
    });
    reportEnvExampleChanges(envChanges, ".env.example");

    const pyprojectChanges = await updatePyproject({
      projectDir: cwd,
      dependencies: newManifest.dependencies,
      dryRun: opts.dryRun ?? false,
    });
    reportPyprojectChanges(pyprojectChanges);

    // CLI v0.5.0+: diff de patches descritivos (re-exibe se mudaram).
    if (oldManifest) {
      reportPatchesDiff(oldManifest.patches, newManifest.patches, moduleName);
    }

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
  policy: DecisionPolicy,
): Promise<UpgradeDecisions> {
  const modified = new Map<string, "overwrite" | "keep">();
  const noBaseDiff = new Map<string, "overwrite" | "keep">();
  const deleted = new Map<string, "delete" | "preserve">();

  for (const entry of plan.entries) {
    if (entry.status === "modified-locally") {
      if (policy.overwriteModified) {
        modified.set(entry.relPath, "overwrite");
      } else if (entry.sourceNewPath) {
        // Sem --overwrite-modified: TTY pergunta; sem TTY (CI) → "keep"
        // (askModifiedAction trata isso defensivamente). Aluno SEM ver
        // prompt em CI tem upgrade seguro: novos copiados, modified intactos.
        const localContent = await readFileSafe(entry.destPath);
        const newContent = await readFileSafe(entry.sourceNewPath);
        modified.set(
          entry.relPath,
          await askModifiedAction(entry.relPath, localContent, newContent),
        );
      }
    } else if (entry.status === "changed-remote-no-base") {
      if (policy.overwriteModified) {
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
      if (policy.deleteRemoved) {
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

// --------------------------------------------------------------------------- //
//  Helpers v0.5.0 — paridade `add`/`upgrade`
// --------------------------------------------------------------------------- //

/** Tenta carregar manifest do snapshot OLD pra comparar patches. Retorna
 *  null se snapshot ausente (modo degradado) ou parse falhou — caller
 *  pula o diff de patches sem erro. */
async function tryParseModuleManifest(
  snapshotDir: string | null,
): Promise<ModuleTemplateJson | null> {
  if (!snapshotDir) return null;
  try {
    return await parseModuleManifest(snapshotDir);
  } catch {
    return null;
  }
}

/** Detecta migrations Alembic no plano (arquivos copiados/sobrescritos
 *  em `migrations/versions/*.py`) e imprime aviso pra rodar `alembic
 *  upgrade head`. CLI NÃO executa — depende de DB up + env vars válidas
 *  no momento, fora do escopo do upgrade.
 */
export function notifyMigrationsIfPresent(
  plan: UpgradePlan,
  decisions: UpgradeDecisions,
): void {
  const willChange = plan.entries.filter((e) => {
    if (!e.relPath.startsWith("migrations/versions/")) return false;
    if (!e.relPath.endsWith(".py")) return false;
    if (e.status === "new") return true;
    if (e.status === "unchanged-from-base") return true; // silent overwrite
    if (e.status === "modified-locally") {
      return decisions.modifiedLocally.get(e.relPath) === "overwrite";
    }
    if (e.status === "changed-remote-no-base") {
      return decisions.changedRemoteNoBase.get(e.relPath) === "overwrite";
    }
    return false;
  });
  if (willChange.length === 0) return;

  console.log();
  console.log(
    chalk.yellow.bold(
      `⚠  Esta atualização traz ${willChange.length} migration(s) Alembic.`,
    ),
  );
  for (const m of willChange) {
    console.log(chalk.yellow(`   • ${m.relPath}`));
  }
  console.log();
  console.log(
    chalk.yellow(`   Após o upgrade terminar, rode no seu projeto:\n`),
  );
  console.log(chalk.cyan(`       uv run alembic upgrade head\n`));
}

/** Imprime resultado do `updateEnvExample` (criado/replaced/duplicates). */
function reportEnvExampleChanges(
  changes: import("../types.js").EnvExampleChanges,
  filename: string,
): void {
  if (!changes.applied) {
    log.warn(
      `${filename} não foi atualizado: ${changes.errorMessage ?? "erro desconhecido"}.`,
    );
    return;
  }
  if (changes.created) {
    log.success(`${filename} criado com bloco do módulo (${changes.varCount} vars).`);
  } else if (changes.replaced) {
    log.success(
      `${filename}: bloco substituído (${changes.varCount} vars na nova versão).`,
    );
  } else {
    log.success(
      `${filename}: bloco adicionado (${changes.varCount} vars).`,
    );
  }
  if (changes.removedDuplicates.length > 0) {
    log.muted(
      `${filename}: ${changes.removedDuplicates.length} duplicata(s) removida(s) automaticamente: ${changes.removedDuplicates.join(", ")}`,
    );
  }
}

/** Imprime resultado do `updatePyproject` (added / alreadyPresent /
 *  versionConflicts). */
function reportPyprojectChanges(
  changes: import("../types.js").PyprojectChanges,
): void {
  if (!changes.applied) {
    log.warn(
      `pyproject.toml não foi atualizado: ${changes.errorMessage ?? "erro desconhecido"}.`,
    );
    return;
  }
  if (changes.added.length > 0) {
    log.success(
      `pyproject.toml: ${changes.added.length} dep(s) adicionada(s) — ${changes.added.join(", ")}.`,
    );
  }
  if (changes.versionConflicts.length > 0) {
    log.warn(
      `pyproject.toml: conflitos de versão (não sobrescrito):\n` +
        changes.versionConflicts
          .map(
            (c) =>
              `   • ${c.name}: instalado '${c.existing}', requerido '${c.requested}'`,
          )
          .join("\n"),
    );
  }
}

/** Compara patches[] do manifest antigo vs novo. Imprime apenas se
 *  houve mudança (added, removed, ou description alterada).
 */
export function reportPatchesDiff(
  oldPatches: PatchDescription[],
  newPatches: PatchDescription[],
  moduleName: string,
): void {
  const oldByFile = new Map(oldPatches.map((p) => [p.file, p.description]));
  const newByFile = new Map(newPatches.map((p) => [p.file, p.description]));

  const added: PatchDescription[] = [];
  const removed: PatchDescription[] = [];
  const changed: { file: string; oldDesc: string; newDesc: string }[] = [];

  for (const [file, desc] of newByFile) {
    if (!oldByFile.has(file)) {
      added.push({ file, description: desc });
    } else if (oldByFile.get(file) !== desc) {
      changed.push({ file, oldDesc: oldByFile.get(file)!, newDesc: desc });
    }
  }
  for (const [file, desc] of oldByFile) {
    if (!newByFile.has(file)) {
      removed.push({ file, description: desc });
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return; // sem mudança — não polui output
  }

  console.log();
  console.log(
    chalk.bold(`📝 Patches do '${moduleName}' alterados nesta versão:`),
  );
  for (const p of added) {
    console.log(chalk.green(`   + ${p.file}`));
    console.log(chalk.gray(`     ${p.description}`));
  }
  for (const p of removed) {
    console.log(chalk.red(`   - ${p.file}`));
    console.log(chalk.gray(`     (era: ${p.description})`));
  }
  for (const c of changed) {
    console.log(chalk.yellow(`   ↻ ${c.file}`));
    console.log(chalk.gray(`     antes: ${c.oldDesc}`));
    console.log(chalk.gray(`     agora: ${c.newDesc}`));
  }
  console.log();
  console.log(
    chalk.gray(
      `   Reaplique manualmente nos arquivos correspondentes (ou consulte o setup_doc).`,
    ),
  );
  console.log();
}
