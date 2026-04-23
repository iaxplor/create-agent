// Confirmação interativa y/N via `readline/promises` do node — zero dep.
//
// Comportamento:
//   - Input "y" ou "yes" (case-insensitive) → retorna true.
//   - Qualquer outra coisa (incluindo string vazia / EOF) → retorna false.
//   - Sem TTY (pipe, CI) → retorna false silenciosamente. Flag `--yes` do
//     comando deve bypassar esta função nesse cenário.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Exibe `question` e espera resposta do usuário. Default N. */
export async function confirm(question: string): Promise<boolean> {
  // Sem TTY, não dá pra interagir — trata como "N".
  if (!stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
