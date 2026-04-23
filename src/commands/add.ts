// Comando `create-agent add <module-name>`.
//
// Fluxo:
//   1. Valida que estamos dentro de um projeto IAxplor (agente.config.json existe)
//   2. Baixa `modules/<name>/` do repo de templates pra diretório temporário
//   3. Parseia e valida template.json do módulo
//   4. Checa compatibilidade de core via min_core_version
//   5. Expande files[] em operações concretas e detecta conflitos
//   6. Se há conflitos: prompt y/N (ou skip via --yes)
//   7. Copia os arquivos (ou simula se --dry-run)
//   8. Registra módulo em agente.config.json (exceto em --dry-run)
//   9. Imprime mensagem final com patches, env vars, deps e próximos passos

import path from "node:path";

import chalk from "chalk";

import { printBanner } from "../utils/banner.js";
import {
  readAgenteConfig,
  recordInstalledModule,
} from "../utils/config-reader.js";
import { confirm } from "../utils/confirm.js";
import { updateEnvExample } from "../utils/env-example-editor.js";
import { UserError } from "../utils/errors.js";
import { executeInstall, planInstall } from "../utils/file-installer.js";
import { printInstallSuccess } from "../utils/final-instructions.js";
import { createSpinner, log } from "../utils/logger.js";
import { updatePyproject } from "../utils/pyproject-editor.js";
import {
  cleanupModuleTemp,
  fetchModuleToTemp,
} from "../utils/template-fetcher.js";
import { parseModuleManifest } from "../utils/template-manifest.js";
import { isCompatible } from "../utils/version-check.js";

export interface AddCommandOptions {
  /** Opcional: override do repo base (default: github:iaxplor/agent-templates). */
  templateSource?: string;
  /** Se true, mostra o plano sem copiar nada. */
  dryRun?: boolean;
  /** Se true, ignora detecção de conflitos e sobrescreve sem perguntar. */
  yes?: boolean;
}

export async function addCommand(
  moduleName: string,
  opts: AddCommandOptions = {},
): Promise<void> {
  printBanner();

  const cwd = process.cwd();
  const dryRun = opts.dryRun ?? false;

  // 1) Valida projeto IAxplor -----------------------------------------------
  const projectConfig = await readAgenteConfig(cwd);
  log.muted(
    `Projeto: ${chalk.bold(projectConfig.name)} ` +
      `(core v${projectConfig.coreVersion})`,
  );

  // 2) Download do módulo ---------------------------------------------------
  const fetchSpinner = createSpinner(`Baixando módulo '${moduleName}'...`);
  let tmpDir: string;
  try {
    tmpDir = await fetchModuleToTemp(moduleName, {
      templateSource: opts.templateSource,
    });
    fetchSpinner.succeed(`Módulo '${moduleName}' baixado`);
  } catch (err) {
    fetchSpinner.fail(`Falha ao baixar módulo '${moduleName}'`);
    throw err;
  }

  try {
    // 3) Parse + validação do manifest -------------------------------------
    const manifest = await parseModuleManifest(tmpDir);

    console.log();
    console.log(
      chalk.bold(`🧪 Instalando módulo: ${manifest.name} v${manifest.version}`),
    );
    if (manifest.description) {
      console.log(chalk.gray(`📦 ${manifest.description}`));
    }
    console.log();

    // 4) Compatibilidade com core ------------------------------------------
    if (!isCompatible(projectConfig.coreVersion, manifest.min_core_version)) {
      throw new UserError(
        `Módulo '${manifest.name}' requer core >= ${manifest.min_core_version}, ` +
          `mas o projeto está em ${projectConfig.coreVersion}. ` +
          `Atualize o template core antes de instalar este módulo.`,
      );
    }
    log.success(`Compatível com core v${manifest.min_core_version}+`);

    // 5) Expande mappings e detecta conflitos ------------------------------
    const plan = await planInstall({
      mappings: manifest.files,
      moduleDir: tmpDir,
      projectDir: cwd,
    });

    console.log();
    console.log(chalk.bold(`📋 Plano de instalação:`));
    console.log(
      chalk.gray(
        `   ${plan.operations.length} arquivo(s) ` +
          `mapeado(s) em ${manifest.files.length} entrada(s).`,
      ),
    );
    if (opts.templateSource) {
      console.log(chalk.gray(`   Source: ${opts.templateSource}`));
    }
    console.log();

    // 6) Confirmação de conflitos ------------------------------------------
    if (plan.conflicts.length > 0 && !opts.yes) {
      console.log(
        chalk.yellow(
          `⚠  ${plan.conflicts.length} arquivo(s) já existe(m) e serão sobrescritos:`,
        ),
      );
      for (const c of plan.conflicts) {
        console.log(`   • ${chalk.cyan(c)}`);
      }
      console.log();

      if (dryRun) {
        log.muted("(dry-run: nenhuma confirmação necessária, simulando aprovação)");
      } else {
        const ok = await confirm("Sobrescrever esses arquivos?");
        if (!ok) {
          throw new UserError(
            "Instalação abortada pelo usuário. Nenhum arquivo foi modificado.",
          );
        }
      }
    } else if (plan.conflicts.length > 0 && opts.yes) {
      log.warn(
        `${plan.conflicts.length} conflito(s) aceitos automaticamente via --yes.`,
      );
    }

    // 7) Execução da cópia -------------------------------------------------
    const copySpinner = createSpinner(
      dryRun ? "Simulando cópia (dry-run)..." : "Copiando arquivos...",
    );
    const result = await executeInstall(plan, { dryRun });
    copySpinner.succeed(
      dryRun
        ? `Simulação OK — ${result.copiedCount} arquivo(s) seriam copiados`
        : `${result.copiedCount} arquivo(s) copiados`,
    );

    // 8) Registra módulo no agente.config.json ------------------------------
    if (!dryRun) {
      await recordInstalledModule(cwd, manifest.name, manifest.version);
      log.muted(
        `Registrado em agente.config.json → modules.${manifest.name}`,
      );
    }

    // 9) Atualiza .env.example (automação 1) ------------------------------
    //    Não aborta em caso de erro — só loga e propaga pra mensagem final.
    const envChanges = await updateEnvExample({
      projectDir: cwd,
      manifest,
      dryRun,
    });
    if (envChanges.applied) {
      log.muted(
        `.env.example ${envChanges.created ? "criado" : envChanges.replaced ? "atualizado (bloco existente substituído)" : "atualizado (bloco adicionado)"}`,
      );
      if (envChanges.outOfBlockDuplicates.length > 0) {
        for (const varName of envChanges.outOfBlockDuplicates) {
          log.warn(
            `${varName} já existe fora do bloco do módulo. Verifique duplicação.`,
          );
        }
      }
    } else {
      log.warn(
        `Não foi possível atualizar .env.example automaticamente: ${envChanges.errorMessage ?? "erro desconhecido"}`,
      );
    }

    // 10) Atualiza pyproject.toml (automação 2) ---------------------------
    const pyprojectChanges = await updatePyproject({
      projectDir: cwd,
      dependencies: manifest.dependencies,
      dryRun,
    });
    if (pyprojectChanges.applied) {
      if (pyprojectChanges.added.length > 0) {
        log.muted(
          `pyproject.toml: ${pyprojectChanges.added.length} dep(s) adicionada(s)`,
        );
      }
      for (const conflict of pyprojectChanges.versionConflicts) {
        log.warn(
          `${conflict.name} já existe em pyproject.toml com constraint ` +
            `'${conflict.existing}'. Módulo requer '${conflict.requested}'. ` +
            `Verifique compatibilidade manualmente.`,
        );
      }
    } else {
      log.warn(
        `Não foi possível atualizar pyproject.toml automaticamente: ${pyprojectChanges.errorMessage ?? "erro desconhecido"}`,
      );
    }

    // 11) Mensagem final ---------------------------------------------------
    const setupFilename = manifest.setup_doc ?? detectSetupFilename(plan);
    printInstallSuccess({
      manifest,
      copiedCount: result.copiedCount,
      setupFilename,
      dryRun,
      envChanges,
      pyprojectChanges,
    });
  } finally {
    // Sempre limpa o temp, mesmo em caso de erro.
    await cleanupModuleTemp(tmpDir);
  }
}

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //

/** Detecta se algum dos arquivos copiados é o SETUP.md do módulo.
 *
 *  Convenção (documentada no README): módulos nomeiam arquivos de setup como
 *  `{NOME_MODULO_UPPERCASE}_SETUP.md`. Ex.: `EVOLUTION_SETUP.md`.
 *  Retorna o caminho relativo pro usuário clicar/abrir, ou null se não há.
 */
function detectSetupFilename(plan: {
  operations: Array<{ destRel: string }>;
}): string | null {
  for (const op of plan.operations) {
    const base = path.basename(op.destRel);
    if (/_SETUP\.md$/i.test(base)) {
      return op.destRel;
    }
  }
  return null;
}
