// Lê e escreve `agente.config.json` na raiz do projeto IAxplor.
//
// É usado pelo comando `add` pra:
//   1. Verificar que estamos dentro de um projeto IAxplor (existência do arquivo)
//   2. Ler `coreVersion` pra validar compatibilidade com o módulo
//   3. Escrever o registro do módulo em `modules` após instalação bem-sucedida

import path from "node:path";

import fsExtra from "fs-extra";

import { AGENTE_CONFIG_FILENAME } from "../constants.js";
import type { AgenteConfig, InstalledModule } from "../types.js";
import { InternalError, UserError } from "./errors.js";

const { pathExists, readJson, writeJson } = fsExtra;

/** Resolve o path absoluto do `agente.config.json` a partir do cwd. */
export function resolveConfigPath(cwd: string): string {
  return path.join(cwd, AGENTE_CONFIG_FILENAME);
}

/** Lê `agente.config.json` do cwd.
 *
 *  Levanta `UserError` se não existir (usuário está no diretório errado).
 *  Levanta `InternalError` se existe mas é inválido (JSON mal formado).
 */
export async function readAgenteConfig(cwd: string): Promise<AgenteConfig> {
  const configPath = resolveConfigPath(cwd);

  if (!(await pathExists(configPath))) {
    throw new UserError(
      `Este comando deve ser executado na raiz de um projeto IAxplor. ` +
        `Arquivo '${AGENTE_CONFIG_FILENAME}' não encontrado em: ${cwd}`,
    );
  }

  try {
    return (await readJson(configPath)) as AgenteConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternalError(
      `Falha ao parsear '${AGENTE_CONFIG_FILENAME}': ${msg}`,
    );
  }
}

/** Escreve `agente.config.json` preservando indentação. */
export async function writeAgenteConfig(
  cwd: string,
  config: AgenteConfig,
): Promise<void> {
  await writeJson(resolveConfigPath(cwd), config, { spaces: 2 });
}

/** Registra um módulo instalado no `agente.config.json.modules` e persiste. */
export async function recordInstalledModule(
  cwd: string,
  moduleName: string,
  version: string,
): Promise<void> {
  const config = await readAgenteConfig(cwd);
  const entry: InstalledModule = {
    version,
    installedAt: new Date().toISOString(),
  };
  config.modules = { ...config.modules, [moduleName]: entry };
  await writeAgenteConfig(cwd, config);
}
