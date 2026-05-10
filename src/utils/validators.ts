// Validação de nome de projeto. Retorna um discriminated union com mensagem
// específica por tipo de erro — o caller imprime direto, sem montar texto.

import fsExtra from "fs-extra";

import {
  PROJECT_NAME_MAX,
  PROJECT_NAME_MIN,
  PROJECT_NAME_REGEX,
} from "../constants.js";
import type { ValidationResult } from "../types.js";

const { readdir } = fsExtra;

export function validateProjectName(name: string): ValidationResult {
  // Ordem importa: checa comprimento antes do regex pra dar mensagem específica.
  if (name.length < PROJECT_NAME_MIN) {
    return {
      valid: false,
      error: `Nome muito curto (mínimo ${PROJECT_NAME_MIN} caracteres).`,
    };
  }

  if (name.length > PROJECT_NAME_MAX) {
    return {
      valid: false,
      error: `Nome muito longo (máximo ${PROJECT_NAME_MAX} caracteres).`,
    };
  }

  if (!PROJECT_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error:
        "Nome inválido. Use apenas letras minúsculas, números e hífen. " +
        "Não pode começar/terminar com hífen nem ter hífen duplo (ex.: 'meu-agente-01').",
    };
  }

  return { valid: true };
}

/** Resultado da validação do cwd em modo `create-agent .` (hereMode). */
export interface CwdHereModeResult {
  ok: boolean;
  /** Entradas presentes no cwd que não são esperadas (i.e., fora do whitelist). */
  conflicts: string[];
}

/**
 * Whitelist de entradas toleradas no cwd em hereMode. `.git/` cobre o caso
 * principal: aluno clonou repo vazio do GitHub. Set permite expansão futura
 * sem mudar a lógica.
 */
const ALLOWED_IN_HERE_MODE = new Set<string>([".git"]);

/**
 * Valida que o cwd está OK pra `create-agent .` (hereMode).
 * Permitido: vazio OU contendo apenas entradas do whitelist (`.git/`).
 * Qualquer outra coisa vira `conflicts[]` pra a CLI listar na mensagem de erro.
 */
export async function validateCwdForHereMode(
  cwd: string,
): Promise<CwdHereModeResult> {
  const entries = await readdir(cwd);
  const conflicts = entries.filter((e) => !ALLOWED_IN_HERE_MODE.has(e));
  return { ok: conflicts.length === 0, conflicts };
}
