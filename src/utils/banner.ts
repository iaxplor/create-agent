// Banner minimalista — 2 linhas coloridas. Evitamos libs de ASCII art pra
// não inflar o binário publicado no npm.

import chalk from "chalk";

import { CLI_VERSION } from "../constants.js";

export function printBanner(): void {
  console.log();
  console.log(chalk.bold.cyan(`▸ IAxplor · create-agent`) + chalk.gray(` v${CLI_VERSION}`));
  console.log(chalk.gray(`  Agentes de IA para WhatsApp`));
  console.log();
}
