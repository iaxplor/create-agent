// Orquestra o download do template `core/` do repositório `agent-templates`
// e a cópia dos arquivos pro diretório do projeto final.
//
// Fluxo:
//   1. `downloadTemplate` do giget puxa `core/` completo para um temp dir.
//   2. Lemos `core/template.json` e convertemos para nosso `TemplateJson`.
//   3. Copiamos `core/files/*` pro diretório final do projeto.
//   4. Removemos o temp dir.
//
// Exposição: `fetchCoreTemplate(targetDir)` encapsula tudo e devolve o
// `template.json` parseado. O caller não precisa saber de temp dir.

import os from "node:os";
import path from "node:path";

import fsExtra from "fs-extra";
import { downloadTemplate } from "giget";

import {
  CORE_TEMPLATE_PATH,
  MODULES_PATH,
  TEMPLATES_BRANCH,
  TEMPLATES_REPO,
} from "../constants.js";
import type { TemplateJson } from "../types.js";
import { InternalError, UserError } from "./errors.js";

// fs-extra é CJS com default export; desestruturar para ficar legível.
const { mkdtemp, pathExists, readJson, copy, remove } = fsExtra;

export async function fetchCoreTemplate(targetDir: string): Promise<TemplateJson> {
  // Diretório temp único — `os.tmpdir()/iaxplor-create-agent-XXXXXX`.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "iaxplor-create-agent-"));

  try {
    // `github:org/repo/path#branch` → giget baixa só essa subpasta.
    const source = `github:${TEMPLATES_REPO}/${CORE_TEMPLATE_PATH}#${TEMPLATES_BRANCH}`;

    try {
      await downloadTemplate(source, {
        dir: tmpDir,
        force: true,
        // `offline: false` é o default — CI/dev consegue usar cache local
        // do giget se já tiver baixado antes.
      });
    } catch (err) {
      // Erro de rede, rate limit ou repo indisponível. Tratamos como UserError
      // porque o usuário consegue agir (verificar conexão, aguardar, etc.).
      const msg = err instanceof Error ? err.message : String(err);
      throw new UserError(
        `Não foi possível baixar o template. Verifique sua conexão e tente novamente.\n` +
          `  Detalhe: ${msg}`,
      );
    }

    // Parse do template.json (obrigatório).
    const templateJsonPath = path.join(tmpDir, "template.json");
    if (!(await pathExists(templateJsonPath))) {
      throw new InternalError(
        "Template inválido: arquivo 'template.json' não encontrado após download.",
      );
    }

    let templateJson: TemplateJson;
    try {
      templateJson = (await readJson(templateJsonPath)) as TemplateJson;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InternalError(`Falha ao parsear template.json: ${msg}`);
    }

    // Copia `files/*` pro diretório final. `files/` é a subpasta que contém a
    // árvore exata que vai pro projeto final.
    const filesDir = path.join(tmpDir, "files");
    if (!(await pathExists(filesDir))) {
      throw new InternalError(
        "Template inválido: pasta 'files/' não encontrada no template core.",
      );
    }
    await copy(filesDir, targetDir, { overwrite: false, errorOnExist: true });

    return templateJson;
  } finally {
    // Sempre limpa o temp, mesmo em caso de erro.
    await remove(tmpDir).catch(() => {
      // Falha de limpeza não é bloqueante — next run do giget tolera.
    });
  }
}

/** Baixa um MÓDULO (`modules/<name>/`) do repo de templates pra um diretório
 *  temporário e retorna o path. O caller é responsável por ler o `template.json`
 *  de lá e copiar os arquivos conforme o mapping — ver `file-installer.ts`.
 *
 *  Diferente de `fetchCoreTemplate`, esta função NÃO copia nada pro projeto
 *  final — só baixa. A cópia seletiva acontece em etapa posterior após
 *  validação de compatibilidade e detecção de conflitos.
 *
 *  `templateSource` permite sobrescrever o repo base (flag `--template-source`
 *  do comando `add`). Default: `github:iaxplor/agent-templates`.
 *
 *  Retorna o path absoluto do diretório temp. Caller DEVE chamar
 *  `cleanupModuleTemp(path)` quando terminar.
 */
export async function fetchModuleToTemp(
  moduleName: string,
  opts?: { templateSource?: string },
): Promise<string> {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), `iaxplor-add-${moduleName}-`),
  );

  const base = opts?.templateSource ?? `github:${TEMPLATES_REPO}`;
  // `base/modules/<name>#branch` — giget aceita subpath via `/`.
  const source = `${base}/${MODULES_PATH}/${moduleName}#${TEMPLATES_BRANCH}`;

  try {
    await downloadTemplate(source, {
      dir: tmpDir,
      force: true,
    });
  } catch (err) {
    // Limpa o temp antes de propagar.
    await remove(tmpDir).catch(() => {
      /* best effort */
    });
    const msg = err instanceof Error ? err.message : String(err);
    throw new UserError(
      `Não foi possível baixar o módulo '${moduleName}'. Verifique sua ` +
        `conexão, o nome do módulo, ou o --template-source.\n` +
        `  Detalhe: ${msg}`,
    );
  }

  return tmpDir;
}

/** Remove o diretório temp criado por `fetchModuleToTemp`. Best-effort. */
export async function cleanupModuleTemp(tmpDir: string): Promise<void> {
  await remove(tmpDir).catch(() => {
    /* best effort */
  });
}
