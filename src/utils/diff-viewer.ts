// Exibe diff colorido entre dois conteúdos textuais no terminal.
//
// Usa a lib `diff` (createTwoFilesPatch) que gera unified diff padrão
// compatível com `diff -u`. Depois coloca cor linha por linha.
//
// Truncamento: diff grande polui terminal. Teto de 200 linhas; acima,
// mostra cabeçalho + primeiras 100 + rodapé instruindo `git diff` local.

import chalk from "chalk";
import { createTwoFilesPatch } from "diff";

const DEFAULT_MAX_LINES = 200;

export function printFileDiff(
  oldContent: string,
  newContent: string,
  filename: string,
  maxLines = DEFAULT_MAX_LINES,
): void {
  const patch = createTwoFilesPatch(
    `${filename} (local)`,
    `${filename} (nova versão)`,
    oldContent,
    newContent,
    "",
    "",
    { context: 3 },
  );

  const lines = patch.split("\n");

  if (lines.length === 0) {
    console.log(chalk.gray("  (sem diferenças)"));
    return;
  }

  console.log();
  console.log(chalk.bold(`─── Diff: ${filename} ───`));

  const toShow = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  for (const line of toShow) {
    console.log(colorizeLine(line));
  }

  if (lines.length > maxLines) {
    const remaining = lines.length - maxLines;
    console.log(
      chalk.gray(
        `  (... ${remaining} linhas truncadas. ` +
          `Use \`git diff -- ${filename}\` pra ver completo.)`,
      ),
    );
  }
  console.log();
}

function colorizeLine(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return chalk.green(line);
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return chalk.red(line);
  }
  if (line.startsWith("@@")) {
    return chalk.cyan(line);
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return chalk.bold(line);
  }
  return chalk.gray(line);
}
