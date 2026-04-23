#!/usr/bin/env node
// Entrypoint do CLI — tsup preserva este shebang em `dist/index.js` e marca
// o arquivo como executável (0o755), permitindo que `npx @iaxplor/create-agent`
// execute direto.

import { Command } from "commander";

import { createCommand } from "./commands/create.js";
import { CLI_VERSION } from "./constants.js";
import { handleError } from "./utils/errors.js";

const program = new Command();

program
  .name("create-agent")
  .description("Cria um novo projeto de agente IAxplor a partir do template core.")
  .version(CLI_VERSION);

program
  .argument("<nome>", "nome do projeto (letras minúsculas, números e hífen)")
  .action(async (nome: string) => {
    await createCommand(nome);
  });

// Commander lança com código 1 em erros de parsing/usage. Nossos erros de
// runtime (UserError/InternalError) passam pelo `parseAsync().catch(...)`.
program.parseAsync().catch((err: unknown) => {
  handleError(err);
  process.exit(1);
});
