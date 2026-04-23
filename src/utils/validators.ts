// Validação de nome de projeto. Retorna um discriminated union com mensagem
// específica por tipo de erro — o caller imprime direto, sem montar texto.

import {
  PROJECT_NAME_MAX,
  PROJECT_NAME_MIN,
  PROJECT_NAME_REGEX,
} from "../constants.js";
import type { ValidationResult } from "../types.js";

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
