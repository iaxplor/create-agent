// Comando `create-agent <nome>` ou `create-agent .`.
//
// Dois modos:
//
//   subdir mode (`create-agent meu-bot`): cria a pasta `meu-bot/` no cwd,
//     baixa template, escreve config, roda `git init`. Comportamento clássico.
//
//   here mode  (`create-agent .`): cria o projeto NO cwd (sem subdir aninhado).
//     Caso de uso: aluno clonou repo Git vazio do GitHub e quer manter o
//     vínculo com o remote. Exige cwd vazio ou só com `.git/`. Pula `git init`
//     se `.git/` já existe. Cleanup em falha NÃO remove o cwd.

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
import {
  validateCwdForHereMode,
  validateProjectName,
} from "../utils/validators.js";

const { ensureDir, pathExists, writeJson } = fsExtra;

/** Token que ativa o hereMode. UNIX-style "current dir". */
const HERE_MODE_TOKEN = ".";

interface ResolvedTarget {
  hereMode: boolean;
  targetDir: string;
  projectName: string;
}

export async function createCommand(nameArg: string): Promise<void> {
  printBanner();

  // 1) Resolve modo + targetDir + projectName + valida pré-condições ---------
  const resolved = await resolveTarget(nameArg);
  const { hereMode, targetDir, projectName } = resolved;

  // 2) Garante que o targetDir existe -----------------------------------------
  // Em hereMode o cwd já existe; em subdir mode, criamos vazio.
  if (!hereMode) {
    await ensureDir(targetDir);
  }

  // 3) Download + cópia do template ------------------------------------------
  const fetchSpinner = createSpinner("Baixando template core...");
  let templateJson: TemplateJson;
  try {
    templateJson = await fetchCoreTemplate(targetDir);
    fetchSpinner.succeed("Template baixado");
  } catch (err) {
    fetchSpinner.fail("Falha ao baixar template");
    // Cleanup CONDICIONAL: nunca remover cwd em hereMode (catastrófico).
    // Em subdir mode, criamos a pasta vazia agora — pode remover sem dó.
    if (!hereMode) {
      await fsExtra.remove(targetDir).catch(() => {
        /* best effort */
      });
    }
    throw err;
  }

  // 4) Geração do agente.config.json ------------------------------------------
  const configSpinner = createSpinner("Configurando projeto...");
  try {
    await writeAgenteConfig({ targetDir, projectName, templateJson });
    configSpinner.succeed("Projeto configurado");
  } catch (err) {
    configSpinner.fail("Falha ao configurar projeto");
    throw err;
  }

  // 5) git init condicional ---------------------------------------------------
  // Se já existe `.git/` (hereMode num clone), pula — não queremos rodar
  // `git init` em cima de repo existente, mesmo sendo no-op silencioso.
  const gitDirExists = await pathExists(path.join(targetDir, ".git"));
  const gitInitialized = gitDirExists ? true : await tryGitInit(targetDir);

  // 6) Mensagem final ---------------------------------------------------------
  printSuccessMessage({ projectName, gitInitialized, hereMode });
}

// ---------------------------------------------------------------------------
// Resolução de alvo (subdir vs hereMode)
// ---------------------------------------------------------------------------

async function resolveTarget(nameArg: string): Promise<ResolvedTarget> {
  if (nameArg === HERE_MODE_TOKEN) {
    return resolveHereMode();
  }
  return resolveSubdirMode(nameArg);
}

async function resolveHereMode(): Promise<ResolvedTarget> {
  const targetDir = process.cwd();
  const projectName = path.basename(targetDir);

  // Nome do projeto vem do nome da pasta — valida com mesmas regras do subdir.
  const nameValidation = validateProjectName(projectName);
  if (!nameValidation.valid) {
    throw new UserError(
      `O nome do diretório atual ('${projectName}') não é um slug válido: ` +
        `${nameValidation.error} ` +
        `Renomeie a pasta ou rode 'create-agent <slug>' em outro local.`,
    );
  }

  // Anti-double-install: se já há um agente.config.json, abortar com mensagem
  // específica (mais útil que o erro genérico de conflito de arquivo).
  if (await pathExists(path.join(targetDir, AGENTE_CONFIG_FILENAME))) {
    throw new UserError(
      `Já existe um '${AGENTE_CONFIG_FILENAME}' neste diretório — ` +
        `o projeto já foi criado. Use 'create-agent upgrade' pra atualizar.`,
    );
  }

  // Cwd precisa estar vazio (ou só com `.git/`) — qualquer outra coisa
  // potencialmente conflita com o template e seria sobrescrita silenciosamente.
  const cwdState = await validateCwdForHereMode(targetDir);
  if (!cwdState.ok) {
    throw new UserError(
      `Diretório atual contém arquivos que conflitam com a criação do projeto: ` +
        `${cwdState.conflicts.join(", ")}. ` +
        `Esperado: pasta vazia ou contendo apenas '.git/'. ` +
        `Limpe o diretório ou rode 'create-agent <slug>' em outro local.`,
    );
  }

  return { hereMode: true, targetDir, projectName };
}

async function resolveSubdirMode(nameArg: string): Promise<ResolvedTarget> {
  const validation = validateProjectName(nameArg);
  if (!validation.valid) {
    throw new UserError(validation.error);
  }

  const targetDir = path.resolve(process.cwd(), nameArg);
  if (await pathExists(targetDir)) {
    throw new UserError(
      `A pasta '${nameArg}' já existe neste diretório. ` +
        `Escolha outro nome ou remova a pasta existente.`,
    );
  }

  return { hereMode: false, targetDir, projectName: nameArg };
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

function printSuccessMessage(args: {
  projectName: string;
  gitInitialized: boolean;
  hereMode: boolean;
}): void {
  const { projectName, gitInitialized, hereMode } = args;

  console.log();
  log.success("Projeto criado com sucesso!");
  console.log();
  if (hereMode) {
    console.log(`  📁 ${chalk.bold(`./ (${projectName})`)}`);
  } else {
    console.log(`  📁 ${chalk.bold(`${projectName}/`)}`);
  }
  console.log();
  console.log(chalk.bold("Próximos passos:"));
  console.log();

  let stepNum = 1;

  // Subdir mode pede `cd <nome>`; hereMode já está na pasta certa.
  if (!hereMode) {
    console.log(`  ${stepNum}. Entre na pasta:`);
    console.log(`     ${chalk.cyan(`cd ${projectName}`)}`);
    console.log();
    stepNum++;
  }

  // .env
  console.log(`  ${stepNum}. Copie o .env.example para .env e preencha as variáveis:`);
  console.log(`     ${chalk.cyan("cp .env.example .env")}`);
  console.log();
  stepNum++;

  // Git: hereMode assume remote já configurado (clone). Subdir mode precisa
  // criar repo no GitHub e configurar origin.
  if (hereMode) {
    console.log(`  ${stepNum}. Faça commit das mudanças e push:`);
    if (!gitInitialized) {
      // Improvável em hereMode (cwd já era um clone), mas cobre fallback.
      console.log(`     ${chalk.cyan("git init")}`);
    }
    console.log(`     ${chalk.cyan("git add .")}`);
    console.log(`     ${chalk.cyan('git commit -m "chore: projeto inicial"')}`);
    console.log(`     ${chalk.cyan("git push origin HEAD")}`);
  } else {
    console.log(`  ${stepNum}. Crie um repositório no GitHub e faça o primeiro push:`);
    if (!gitInitialized) {
      console.log(`     ${chalk.cyan("git init")}`);
    }
    console.log(`     ${chalk.cyan("git add .")}`);
    console.log(`     ${chalk.cyan('git commit -m "chore: projeto inicial"')}`);
    console.log(
      `     ${chalk.cyan(
        "git remote add origin git@github.com:SEU_USUARIO/" + projectName + ".git",
      )}`,
    );
    console.log(`     ${chalk.cyan("git branch -M main")}`);
    console.log(`     ${chalk.cyan("git push -u origin main")}`);
  }
  console.log();
  stepNum++;

  console.log(`  ${stepNum}. Configure o deploy no Dokploy apontando pro repositório`);
  console.log();
  stepNum++;

  console.log(`  ${stepNum}. Acesse https://SEU_DOMINIO/health pra confirmar o funcionamento`);
  console.log();

  console.log(`📚 Documentação: ${chalk.blue.underline(DOCS_URL)}`);
  console.log();
}
