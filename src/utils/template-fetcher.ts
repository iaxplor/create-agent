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
