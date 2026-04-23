// Duas classes de erro para o CLI distinguir "erro do usuário" (mensagem
// limpa, sem stack) de "bug interno" (sugere reportar issue). `handleError`
// é o destino final no try/catch do entrypoint.

import chalk from "chalk";

import { ISSUES_URL } from "../constants.js";

/**
 * Erro causado por algo que o usuário fez ou pelo ambiente (pasta já existe,
 * nome inválido, sem internet). Mensagem limpa, sem stack trace.
 */
export class UserError extends Error {
  public override readonly name = "UserError";
}

/**
 * Erro de bug do CLI ou do template (JSON malformado, ex.). Mensagem + sugere
 * reportar. Stack trace só aparece com `DEBUG=1`.
 */
export class InternalError extends Error {
  public override readonly name = "InternalError";
}

/**
 * Handler global de erros — chamado pelo entrypoint. Sai do processo com
 * código 1 **pelo chamador** (esta função só imprime, não chama `exit`).
 */
export function handleError(err: unknown): void {
  const debug = process.env.DEBUG === "1";

  if (err instanceof UserError) {
    console.error(chalk.red(`\n✗ ${err.message}\n`));
    if (debug && err.stack) {
      console.error(chalk.gray(err.stack));
    }
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`\n✗ Erro inesperado: ${message}`));
  console.error(chalk.gray(`  Isso parece um bug. Reporte em ${ISSUES_URL}\n`));

  if (debug && err instanceof Error && err.stack) {
    console.error(chalk.gray(err.stack));
  } else if (!debug) {
    console.error(chalk.gray("  Rode novamente com DEBUG=1 para ver o stack trace.\n"));
  }
}
