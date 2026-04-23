#!/usr/bin/env node
// Entrypoint do CLI — tsup preserva este shebang em `dist/index.js` e marca
// o arquivo como executável (0o755), permitindo que `npx @iaxplor/create-agent`
// execute direto.

import { Command } from "commander";

import { addCommand } from "./commands/add.js";
import { createCommand } from "./commands/create.js";
import { CLI_VERSION } from "./constants.js";
import { handleError } from "./utils/errors.js";

const program = new Command();

program
  .name("create-agent")
  .description(
    "CLI do IAxplor — cria projetos Python de agente de IA e instala módulos adicionais.",
  )
  .version(CLI_VERSION);

// --- Comando default (sem subcomando): cria um projeto novo ---------------
//
// Uso: `npx @iaxplor/create-agent meu-projeto`
// Se `<nome>` não for fornecido, commander imprime usage. Se o valor coincidir
// com um nome de subcomando (ex.: `add`), commander roteia pro subcomando.
program
  .argument("[nome]", "nome do projeto (quando rodado sem subcomando)")
  .action(async (nome: string | undefined) => {
    if (!nome) {
      program.help();
      return;
    }
    await createCommand(nome);
  });

// --- Subcomando `add`: instala um módulo num projeto existente ------------
program
  .command("add <module-name>")
  .description(
    "Instala um módulo adicional em um projeto IAxplor existente (ex.: evolution-api).",
  )
  .option(
    "--template-source <url>",
    "override do repo base (default: github:iaxplor/agent-templates)",
  )
  .option("--dry-run", "mostra o plano sem copiar nem modificar nada")
  .option("--yes", "aceita automaticamente sobrescrever arquivos em conflito")
  .action(
    async (
      moduleName: string,
      options: {
        templateSource?: string;
        dryRun?: boolean;
        yes?: boolean;
      },
    ) => {
      await addCommand(moduleName, options);
    },
  );

// Commander lança com código 1 em erros de parsing/usage. Nossos erros de
// runtime (UserError/InternalError) passam pelo `parseAsync().catch(...)`.
program.parseAsync().catch((err: unknown) => {
  handleError(err);
  process.exit(1);
});
