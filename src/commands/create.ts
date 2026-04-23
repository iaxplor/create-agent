// Comando `create-agent <nome>`.
//
// Fluxo:
//   1. Valida o nome (utils/validators)
//   2. Resolve path absoluto e confere que a pasta não existe
//   3. Cria a pasta
//   4. Baixa template via utils/template-fetcher (spinner)
//   5. Escreve `agente.config.json` (spinner)
//   6. Tenta `git init` (best effort)
//   7. Imprime mensagem final — com passo extra de `git init` se falhou

import path from "node:path";

import chalk from "chalk";
import { execa } from "execa";
import fsExtra from "fs-extra";

import {
  AGENTE_CONFIG_FILENAME,
  DEFAULT_PYTHON_VERSION,
  DOCS_URL,
} from "../constants.js";
import type { AgenteConfig, TemplateJson } from "../types.js";
import { printBanner } from "../utils/banner.js";
import { UserError } from "../utils/errors.js";
import { createSpinner, log } from "../utils/logger.js";
import { fetchCoreTemplate } from "../utils/template-fetcher.js";
import { validateProjectName } from "../utils/validators.js";

const { ensureDir, pathExists, writeJson } = fsExtra;

export async function createCommand(projectName: string): Promise<void> {
  printBanner();

  // 1) Validação de nome ---------------------------------------------------
  const validation = validateProjectName(projectName);
  if (!validation.valid) {
    throw new UserError(validation.error);
  }

  // 2) Path de destino e pre-check de existência ---------------------------
  const targetDir = path.resolve(process.cwd(), projectName);
  if (await pathExists(targetDir)) {
    throw new UserError(
      `A pasta '${projectName}' já existe neste diretório. ` +
        `Escolha outro nome ou remova a pasta existente.`,
    );
  }

  // 3) Cria a pasta vazia --------------------------------------------------
  await ensureDir(targetDir);

  // 4) Download + cópia do template ---------------------------------------
  const fetchSpinner = createSpinner("Baixando template core...");
  let templateJson: TemplateJson;
  try {
    templateJson = await fetchCoreTemplate(targetDir);
    fetchSpinner.succeed("Template baixado");
  } catch (err) {
    fetchSpinner.fail("Falha ao baixar template");
    // Limpa a pasta criada no passo 3 pra não deixar lixo após o erro.
    await fsExtra.remove(targetDir).catch(() => {
      /* best effort */
    });
    throw err;
  }

  // 5) Geração do agente.config.json --------------------------------------
  const configSpinner = createSpinner("Configurando projeto...");
  try {
    await writeAgenteConfig({ targetDir, projectName, templateJson });
    configSpinner.succeed("Projeto configurado");
  } catch (err) {
    configSpinner.fail("Falha ao configurar projeto");
    throw err;
  }

  // 6) git init (best effort) ---------------------------------------------
  const gitInitialized = await tryGitInit(targetDir);

  // 7) Mensagem final ------------------------------------------------------
  printSuccessMessage({ projectName, gitInitialized });
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

async function writeAgenteConfig(args: {
  targetDir: string;
  projectName: string;
  templateJson: TemplateJson;
}): Promise<void> {
  const { targetDir, projectName, templateJson } = args;

  // python.version: tenta template.json.python_version; se ausente/inválido,
  // cai pro default e avisa (não quebra o fluxo).
  let pythonVersion = templateJson.python_version;
  if (!pythonVersion || typeof pythonVersion !== "string") {
    log.warn(
      `template.json sem 'python_version' válido — usando default ${DEFAULT_PYTHON_VERSION}.`,
    );
    pythonVersion = DEFAULT_PYTHON_VERSION;
  }

  const config: AgenteConfig = {
    name: projectName,
    version: "0.1.0",
    coreVersion: templateJson.version,
    createdAt: new Date().toISOString(),
    modules: {},
    python: {
      packageManager: "uv",
      version: pythonVersion,
    },
  };

  await writeJson(path.join(targetDir, AGENTE_CONFIG_FILENAME), config, { spaces: 2 });
}

/**
 * Tenta rodar `git init` no targetDir. Retorna true se conseguiu, false se
 * falhou (git não instalado, por ex.). Não lança — o fluxo continua sem git.
 */
async function tryGitInit(targetDir: string): Promise<boolean> {
  try {
    await execa("git", ["init"], { cwd: targetDir, stdio: "ignore" });
    return true;
  } catch {
    log.warn("Não foi possível inicializar o Git. Você pode rodar 'git init' manualmente depois.");
    return false;
  }
}

function printSuccessMessage(args: { projectName: string; gitInitialized: boolean }): void {
  const { projectName, gitInitialized } = args;

  console.log();
  log.success("Projeto criado com sucesso!");
  console.log();
  console.log(`  📁 ${chalk.bold(`${projectName}/`)}`);
  console.log();
  console.log(chalk.bold("Próximos passos:"));
  console.log();

  // Passo 1 — cd sempre
  console.log("  1. Entre na pasta:");
  console.log(`     ${chalk.cyan(`cd ${projectName}`)}`);
  console.log();

  // Passo 2 — .env
  console.log("  2. Copie o .env.example para .env e preencha as variáveis:");
  console.log(`     ${chalk.cyan("cp .env.example .env")}`);
  console.log();

  // Passo 3 — git (muda conforme gitInitialized)
  console.log("  3. Crie um repositório no GitHub e faça o primeiro push:");
  if (!gitInitialized) {
    // Precisa inicializar antes do resto.
    console.log(`     ${chalk.cyan("git init")}`);
  }
  console.log(`     ${chalk.cyan("git add .")}`);
  console.log(`     ${chalk.cyan('git commit -m "chore: projeto inicial"')}`);
  console.log(`     ${chalk.cyan("git remote add origin git@github.com:SEU_USUARIO/" + projectName + ".git")}`);
  console.log(`     ${chalk.cyan("git branch -M main")}`);
  console.log(`     ${chalk.cyan("git push -u origin main")}`);
  console.log();

  console.log("  4. Configure o deploy no Dokploy apontando pro repositório");
  console.log();
  console.log("  5. Acesse https://SEU_DOMINIO/health pra confirmar o funcionamento");
  console.log();
  console.log(`📚 Documentação: ${chalk.blue.underline(DOCS_URL)}`);
  console.log();
}
