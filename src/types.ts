// Tipos partilhados entre comandos. Schemas são "abertos" (index signatures
// ou campos opcionais quando faz sentido) pra acompanhar evolução do
// template.json sem obrigar bump do CLI a cada campo novo.

/** Schema de `core/template.json` no repositório de templates. */
export interface TemplateJson {
  name: string;
  version: string;
  description?: string;
  required?: boolean;
  python_version?: string;
  dependencies?: string[];
  env_vars?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** Metadados de um módulo instalado no projeto do aluno. */
export interface InstalledModule {
  version: string;
  installedAt: string;
}

/** Schema de `agente.config.json` gravado na raiz do projeto do aluno. */
export interface AgenteConfig {
  name: string;
  version: string;
  coreVersion: string;
  createdAt: string;
  modules: Record<string, InstalledModule>;
  python: {
    packageManager: "uv";
    version: string;
  };
}

/** Resultado estruturado da validação de nome de projeto. */
export type ValidationResult = { valid: true } | { valid: false; error: string };
