#!/usr/bin/env node
// Entrypoint do CLI.

import { Command } from "commander";

import { addCommand } from "./commands/add.js";
import { createCommand } from "./commands/create.js";
import { listCommand } from "./commands/list.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { CLI_VERSION } from "./constants.js";
import { handleError } from "./utils/errors.js";

const program = new Command();

program
  .name("create-agent")
  .description(
    "CLI do IAxplor — cria projetos Python de agente de IA e gerencia módulos/upgrades.",
  )
  .version(CLI_VERSION);

// --- Comando default (sem subcomando): cria um projeto novo ---------------
program
  .argument("[nome]", "nome do projeto (quando rodado sem subcomando)")
  .action(async (nome: string | undefined) => {
    if (!nome) {
      program.help();
      return;
    }
    await createCommand(nome);
  });

// --- Subcomando `add` -----------------------------------------------------
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

// --- Subcomando `list` ----------------------------------------------------
program
  .command("list")
  .description(
    "Lista versões do core + módulos instalados e mostra upgrades disponíveis.",
  )
  .option(
    "--template-source <url>",
    "override do repo base (default: github:iaxplor/agent-templates)",
  )
  .action(async (options: { templateSource?: string }) => {
    await listCommand(options);
  });

// --- Subcomando `upgrade` -------------------------------------------------
program
  .command("upgrade [target]")
  .description(
    "Atualiza core, um módulo específico, ou tudo. Se omitir target, atualiza tudo.",
  )
  .option(
    "--template-source <url>",
    "override do repo base (default: github:iaxplor/agent-templates)",
  )
  .option("--dry-run", "mostra o plano sem aplicar mudanças")
  .option("--yes", "aceita sobrescritas e remoções sem prompt (cuidado)")
  .option("--no-stash", "pula o prompt de git stash de backup")
  .action(
    async (
      target: string | undefined,
      options: {
        templateSource?: string;
        dryRun?: boolean;
        yes?: boolean;
        stash?: boolean;
      },
    ) => {
      // commander `--no-stash` seta `stash: false`. Normalizamos pra flag `noStash`.
      await upgradeCommand(target, {
        templateSource: options.templateSource,
        dryRun: options.dryRun,
        yes: options.yes,
        noStash: options.stash === false,
      });
    },
  );

program.parseAsync().catch((err: unknown) => {
  handleError(err);
  process.exit(1);
});
