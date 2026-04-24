// Prompts interativos pra decisões por arquivo durante `upgrade`.
//
// 2 fluxos:
//   - askModifiedAction: arquivo foi modificado localmente (ou diverge sem
//     base pra comparar). [S]obrescrever / [M]anter / [D]iff → decide.
//   - askDeletedAction: arquivo sumiu na nova versão do core. [R]emover /
//     [K]eep.
//
// Input via `readline/promises` (zero dep). Sem TTY → assume conservador:
//   - askModifiedAction → "keep" (preserva modificação)
//   - askDeletedAction → "preserve" (não deleta)
// Isso é seguro pra CI: nada é sobrescrito nem removido sem confirmação.

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import chalk from "chalk";

import { printFileDiff } from "./diff-viewer.js";

export type FileAction = "overwrite" | "keep";
export type DeletedAction = "delete" | "preserve";

export interface AskModifiedOptions {
  /** `true` quando não temos a versão base pra comparar — mostra warning extra. */
  noBase?: boolean;
}

export async function askModifiedAction(
  relPath: string,
  localContent: string,
  newContent: string,
  opts: AskModifiedOptions = {},
): Promise<FileAction> {
  if (!stdin.isTTY) {
    // CI-safe: conservador.
    return "keep";
  }

  const warning = opts.noBase
    ? chalk.yellow(
        "  (⚠  sem versão base pra comparar — pode ser sua mod OU só mudou upstream)",
      )
    : "";

  while (true) {
    console.log();
    console.log(
      chalk.yellow(`⚠  Arquivo ${chalk.cyan(relPath)} foi modificado localmente.`),
    );
    if (warning) {
      console.log(warning);
    }
    console.log("   O que fazer?");
    console.log(`   ${chalk.bold("[S]")} Sobrescrever com a versão nova (sua modificação será perdida)`);
    console.log(`   ${chalk.bold("[M]")} Manter a versão local (pode quebrar com core novo)`);
    console.log(`   ${chalk.bold("[D]")} Ver diff primeiro`);

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const raw = (await rl.question("   Escolha [S/M/D]: ")).trim().toLowerCase();
    rl.close();

    if (raw === "s") return "overwrite";
    if (raw === "m") return "keep";
    if (raw === "d") {
      printFileDiff(localContent, newContent, relPath);
      continue;
    }
    // Input inválido — repete.
    console.log(chalk.gray("   (Resposta inválida — responda S, M ou D.)"));
  }
}

export async function askDeletedAction(relPath: string): Promise<DeletedAction> {
  if (!stdin.isTTY) {
    return "preserve";
  }

  console.log();
  console.log(
    chalk.yellow(
      `⚠  Arquivo ${chalk.cyan(relPath)} não existe mais na versão nova.`,
    ),
  );
  console.log("   O que fazer?");
  console.log(`   ${chalk.bold("[R]")} Remover do projeto`);
  console.log(`   ${chalk.bold("[K]")} Manter (ficará órfão, pode quebrar imports)`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const raw = (await rl.question("   Escolha [R/K]: ")).trim().toLowerCase();
    return raw === "r" ? "delete" : "preserve";
  } finally {
    rl.close();
  }
}
