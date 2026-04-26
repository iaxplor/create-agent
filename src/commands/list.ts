// Comando `create-agent list` — mostra versões do projeto + atualizações disponíveis.
//
// Read-only, útil como diagnóstico rápido antes de decidir fazer `upgrade`.
// Não modifica nada.

import chalk from "chalk";

import { printBanner } from "../utils/banner.js";
import { readAgenteConfig } from "../utils/config-reader.js";
import { createSpinner, log } from "../utils/logger.js";
import { severityOfBump, type Severity } from "../utils/semver-diff.js";
import {
  listProjectComponents,
  type ComponentVersion,
} from "../utils/version-manifest.js";

export interface ListOptions {
  templateSource?: string;
}

export async function listCommand(opts: ListOptions = {}): Promise<void> {
  printBanner();

  const cwd = process.cwd();
  const config = await readAgenteConfig(cwd);

  const spinner = createSpinner("Consultando versões disponíveis...");
  let components: ComponentVersion[];
  try {
    components = await listProjectComponents(config, opts);
    spinner.succeed("Versões consultadas");
  } catch (err) {
    spinner.fail("Falha ao consultar versões");
    throw err;
  }

  console.log();
  console.log(chalk.bold("📦 Versões do projeto:"));
  console.log();

  const nameWidth = Math.max(...components.map((c) => c.displayName.length), 8);
  const versionWidth = Math.max(
    ...components.map((c) => c.installedVersion.length),
    6,
  );

  for (const c of components) {
    const name = c.displayName.padEnd(nameWidth);
    const installed = c.installedVersion.padEnd(versionWidth);
    if (c.hasUpdate) {
      const severity = severityOfBump(c.installedVersion, c.availableVersion);
      const badge = severity ? `  ${formatSeverityBadge(severity)}` : "";
      console.log(
        `   ${chalk.cyan(name)}   ${installed} → ${chalk.green(c.availableVersion)}  ${chalk.yellow("(atualização disponível)")}${badge}`,
      );
    } else {
      console.log(
        `   ${chalk.gray(name)}   ${installed} → ${c.availableVersion}  ${chalk.gray("(atualizado)")}`,
      );
    }
  }
  console.log();

  const pending = components.filter((c) => c.hasUpdate);
  if (pending.length === 0) {
    log.success("Tudo atualizado.");
    return;
  }

  console.log(chalk.bold("Próximos passos:"));
  if (pending.some((c) => c.target === "core")) {
    console.log(`   • ${chalk.cyan("create-agent upgrade core")}`);
  }
  for (const c of pending.filter((c) => c.target !== "core")) {
    console.log(`   • ${chalk.cyan(`create-agent upgrade ${c.target}`)}`);
  }
  console.log(`   • ${chalk.cyan("create-agent upgrade all")} — atualiza tudo em sequência`);
  console.log();
}

/** Renderiza badge colorido pra severity (red=major, yellow=minor, gray=patch).
 *  Cores escolhidas pra intuição visual padrão (vermelho = atenção alta). */
function formatSeverityBadge(severity: Severity): string {
  switch (severity) {
    case "major":
      return chalk.red("(major)");
    case "minor":
      return chalk.yellow("(minor)");
    case "patch":
      return chalk.gray("(patch)");
  }
}
