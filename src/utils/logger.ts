// Wrapper fino em torno do chalk/ora pra padronizar cores e símbolos em toda
// a CLI. Componentes nunca importam `chalk` direto — sempre usam `log.*` ou
// `createSpinner()` daqui.

import chalk from "chalk";
import ora, { type Ora } from "ora";

export const log = {
  success: (msg: string): void => console.log(chalk.green(`✓ ${msg}`)),
  error: (msg: string): void => console.error(chalk.red(`✗ ${msg}`)),
  warn: (msg: string): void => console.warn(chalk.yellow(`! ${msg}`)),
  info: (msg: string): void => console.log(msg),
  muted: (msg: string): void => console.log(chalk.gray(msg)),

  /** Comando que o aluno deve copiar/executar. Em cyan, sem prefixo. */
  command: (cmd: string): void => console.log(chalk.cyan(cmd)),

  /** URL pra clicar/copiar. Azul sublinhado. */
  url: (url: string): void => console.log(chalk.blue.underline(url)),
};

/**
 * Factory de spinner com mensagem inicial. Caller é responsável por chamar
 * `.succeed()`, `.fail()` ou `.stop()`.
 */
export function createSpinner(text: string): Ora {
  return ora({ text, color: "cyan" }).start();
}
