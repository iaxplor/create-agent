// Mensagem final do comando `add` — versão compacta v0.3.0.
//
// Reorganiza a saída pra reduzir overwhelm:
//   - "Ações automáticas concluídas" (checkmarks)
//   - "Ação manual necessária: aplicar N patches" (se houver)
//   - Prompt pronto pra colar em IDE com IA (Cursor, Claude Code, etc.)
//   - Próximos passos numerados (máximo 5)
//   - Fallback: se alguma automação falhou, adiciona instrução manual

import chalk from "chalk";

import type {
  EnvExampleChanges,
  ModuleTemplateJson,
  PyprojectChanges,
} from "../types.js";

export interface PrintSuccessOptions {
  manifest: ModuleTemplateJson;
  copiedCount: number;
  setupFilename: string | null;
  dryRun: boolean;
  envChanges: EnvExampleChanges;
  pyprojectChanges: PyprojectChanges;
}

/** Imprime a mensagem final compacta. */
export function printInstallSuccess(opts: PrintSuccessOptions): void {
  const {
    manifest,
    copiedCount,
    setupFilename,
    dryRun,
    envChanges,
    pyprojectChanges,
  } = opts;

  console.log();
  if (dryRun) {
    console.log(
      chalk.yellow(
        `⚠  Dry-run: nenhuma modificação feita. Veja acima o que seria aplicado.`,
      ),
    );
    console.log();
    return;
  }

  // ═══ Cabeçalho ═══
  console.log(
    chalk.green.bold(
      `✅ Módulo '${manifest.name}' v${manifest.version} instalado`,
    ),
  );
  console.log();

  // ═══ Ações automáticas ═══
  console.log(chalk.bold("Ações automáticas concluídas:"));
  console.log(chalk.green(`   ✓ ${copiedCount} arquivo(s) copiados`));
  console.log(chalk.green(`   ✓ agente.config.json atualizado`));

  if (envChanges.applied) {
    console.log(
      chalk.green(
        `   ✓ .env.example atualizado (${envChanges.varCount} variáveis)`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(`   ⚠ .env.example não atualizado automaticamente`),
    );
  }

  if (pyprojectChanges.applied) {
    if (pyprojectChanges.added.length > 0) {
      console.log(
        chalk.green(
          `   ✓ pyproject.toml atualizado (${pyprojectChanges.added.length} dependência(s))`,
        ),
      );
    } else if (manifest.dependencies.length === 0) {
      // Módulo sem deps Python — não lista nada.
    } else {
      // Todas já estavam presentes.
      console.log(
        chalk.gray(
          `   • pyproject.toml: nenhuma dependência nova a adicionar`,
        ),
      );
    }
  } else {
    console.log(
      chalk.yellow(`   ⚠ pyproject.toml não atualizado automaticamente`),
    );
  }
  console.log();

  // ═══ Ação manual (patches) ═══
  const patchCount = manifest.patches.length;
  if (patchCount === 0) {
    console.log(chalk.green.bold("✅ Zero patches manuais necessários"));
    console.log();
  } else {
    console.log(
      chalk.yellow.bold(
        `⚠  ${patchCount} ação manual necessária: aplicar ${patchCount} patch(es)`,
      ),
    );
    console.log();
    console.log("Você pode aplicar de duas formas:");
    console.log();
    if (setupFilename) {
      console.log(chalk.bold("[A] Manual —"));
      console.log(`    abra ${chalk.cyan(setupFilename)} §8 e copie os blocos`);
    } else {
      console.log(chalk.bold("[A] Manual — consulte a documentação do módulo"));
    }
    console.log();
    console.log(chalk.bold("[B] Com IA (Cursor, Claude Code, VSCode + Copilot, etc.) —"));
    console.log("    cole este prompt na ferramenta que você usa:");
    console.log();
    printAIPromptBox(manifest, setupFilename);
    console.log();
  }

  // ═══ Fallback: ações manuais se automações falharam ═══
  if (!envChanges.applied) {
    printEnvFallback(manifest);
  }
  if (!pyprojectChanges.applied && manifest.dependencies.length > 0) {
    printPyprojectFallback(manifest.dependencies);
  }

  // ═══ Warnings estruturais de conflito ═══
  if (pyprojectChanges.versionConflicts.length > 0) {
    console.log(chalk.yellow.bold("⚠  Conflitos de versão de dependência:"));
    for (const c of pyprojectChanges.versionConflicts) {
      console.log(
        chalk.yellow(
          `   ${c.name}: projeto tem '${c.existing}', módulo pede '${c.requested}'`,
        ),
      );
    }
    console.log(chalk.gray(`   Revise manualmente no pyproject.toml.`));
    console.log();
  }

  // ═══ Depois dos patches ═══
  console.log(chalk.bold("Depois dos patches:"));
  console.log();
  const steps: string[] = [];
  if (manifest.env_vars.some((v) => v.required)) {
    steps.push(
      `Preencher valores vazios no ${chalk.cyan(".env.example")} e configurar no painel Dokploy`,
    );
  }
  steps.push(
    `${chalk.cyan(`git add . && git commit -m "feat: instalar módulo ${manifest.name}"`)}`,
  );
  steps.push(`${chalk.cyan("git push")}`);
  steps.push("Aguardar redeploy no Dokploy (~2 min)");
  if (setupFilename) {
    steps.push(
      `Seguir ${chalk.cyan(setupFilename)} a partir da seção de configuração`,
    );
  }
  for (let i = 0; i < steps.length; i++) {
    console.log(`   ${i + 1}. ${steps[i]}`);
  }
  console.log();

  // ═══ Dica final ═══
  if (setupFilename) {
    console.log(
      chalk.gray(`💡 ${chalk.cyan(`cat ${setupFilename}`)} para ver detalhes completos`),
    );
    console.log();
  }
}

// --------------------------------------------------------------------------- //
//  Helpers de apresentação
// --------------------------------------------------------------------------- //

function printAIPromptBox(
  manifest: ModuleTemplateJson,
  setupFilename: string | null,
): void {
  const target = setupFilename ?? "a documentação do módulo";
  const patchFiles = manifest.patches.map((p) => `\`${p.file}\``).join(", ");
  const sectionRefs = manifest.patches
    .map((_p, i) => `§8.${i + 1}`)
    .join(", ");
  const lines = [
    `Aplique os ${manifest.patches.length} patches documentados em ${target}`,
    `na seção 8 (${sectionRefs}). Os arquivos a modificar são`,
    `${patchFiles}.`,
    `Os blocos de código prontos estão no próprio ${target}.`,
  ];
  const divider = chalk.gray("─".repeat(65));
  console.log(divider);
  for (const line of lines) {
    console.log(line);
  }
  console.log(divider);
}

function printEnvFallback(manifest: ModuleTemplateJson): void {
  console.log(chalk.yellow("   Adicione manualmente ao .env.example:"));
  for (const v of manifest.env_vars) {
    const value = v.default ?? "";
    console.log(`     ${chalk.cyan(`${v.name}=${value}`)}`);
  }
  console.log();
}

function printPyprojectFallback(deps: string[]): void {
  console.log(
    chalk.yellow(
      "   Adicione manualmente ao array [project].dependencies em pyproject.toml:",
    ),
  );
  for (const d of deps) {
    console.log(`     ${chalk.cyan(`"${d}",`)}`);
  }
  console.log();
}
