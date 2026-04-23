// Formata e imprime a mensagem final do comando `add`.
//
// Centraliza toda a apresentação (env vars, deps, patches, próximos passos)
// num único módulo pra manter `commands/add.ts` focado em orquestração.

import chalk from "chalk";

import type { ModuleTemplateJson } from "../types.js";

export interface PrintSuccessOptions {
  manifest: ModuleTemplateJson;
  copiedCount: number;
  /** Nome do arquivo SETUP.md copiado junto, se houver (ex.: "EVOLUTION_SETUP.md"). */
  setupFilename: string | null;
  dryRun: boolean;
}

/** Imprime a mensagem final completa. */
export function printInstallSuccess(opts: PrintSuccessOptions): void {
  const { manifest, copiedCount, setupFilename, dryRun } = opts;

  // -------- Linha de status principal ------------
  console.log();
  if (dryRun) {
    console.log(
      chalk.yellow(
        `⚠  Dry-run: nenhuma modificação feita. ` +
          `${copiedCount} arquivo(s) seriam copiados.`,
      ),
    );
  } else {
    console.log(chalk.green(`✅ Módulo '${manifest.name}' instalado com sucesso!`));
    console.log(chalk.gray(`   ${copiedCount} arquivo(s) copiados.`));
  }
  console.log();

  // -------- Patches manuais --------
  if (manifest.patches.length > 0) {
    console.log(
      chalk.yellow(`⚠  ${manifest.patches.length} patch(es) manual(is) necessário(s)`),
    );
    console.log();

    if (setupFilename) {
      console.log(
        `Abra ${chalk.bold(setupFilename)} e siga a Seção 8 — "Instalação manual":`,
      );
    } else {
      console.log("Aplique manualmente as seguintes mudanças:");
    }

    for (let i = 0; i < manifest.patches.length; i++) {
      const patch = manifest.patches[i];
      if (!patch) continue;
      const num = String(i + 1).padStart(2, " ");
      console.log(
        `   ${num}. ${chalk.cyan(patch.file)}  → ${chalk.gray(patch.description)}`,
      );
    }
    console.log();
  }

  // -------- Env vars --------
  if (manifest.env_vars.length > 0) {
    console.log(chalk.bold("📝 Variáveis de ambiente necessárias:"));
    console.log();
    for (const v of manifest.env_vars) {
      const mark = v.required ? chalk.red("(obrigatória)") : chalk.gray("(opcional)");
      console.log(`   • ${chalk.cyan(v.name)} ${mark}`);
      if (v.description) {
        console.log(`     ${chalk.gray(truncate(v.description, 100))}`);
      }
    }
    console.log();
  }

  // -------- Dependências Python --------
  if (manifest.dependencies.length > 0) {
    console.log(chalk.bold("📦 Dependências Python necessárias:"));
    console.log();
    console.log(chalk.gray(`   Adicione ao array de dependências em [project] do pyproject.toml:`));
    console.log();
    console.log(chalk.cyan("       dependencies = ["));
    console.log(chalk.gray(`         # ... deps atuais ...`));
    for (const dep of manifest.dependencies) {
      console.log(chalk.cyan(`         "${dep}",`));
    }
    console.log(chalk.cyan("       ]"));
    console.log();
    console.log(
      chalk.gray(
        "   Após commit+push, o Dokploy reinstala automaticamente no próximo build.",
      ),
    );
    console.log();
  }

  // -------- Próximos passos --------
  console.log(chalk.bold("✅ Próximos passos:"));
  console.log();
  const steps: string[] = [];
  if (manifest.patches.length > 0) {
    const target = setupFilename ?? "a documentação do módulo";
    steps.push(`Aplicar os ${manifest.patches.length} patches de ${target}`);
  }
  if (manifest.dependencies.length > 0) {
    steps.push("Atualizar pyproject.toml com as deps listadas acima");
  }
  if (manifest.env_vars.some((v) => v.required)) {
    steps.push("Configurar env vars obrigatórias no painel Dokploy");
  }
  steps.push(
    `${chalk.cyan(`git add . && git commit -m "feat: instalar módulo ${manifest.name}"`)}`,
  );
  steps.push(`${chalk.cyan("git push")}`);
  steps.push("Aguardar redeploy no Dokploy");
  if (setupFilename) {
    steps.push(
      `Seguir ${chalk.bold(setupFilename)} a partir da seção de configuração`,
    );
  }
  for (let i = 0; i < steps.length; i++) {
    console.log(`   ${i + 1}. ${steps[i]}`);
  }
  console.log();
}

/** Truncar descrição longa pra não poluir terminal. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
