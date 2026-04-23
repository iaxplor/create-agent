// Tipos partilhados entre comandos. Schemas são "abertos" (index signatures
// ou campos opcionais quando faz sentido) pra acompanhar evolução do
// template.json sem obrigar bump do CLI a cada campo novo.

/** Definição de uma variável de ambiente usada por um template/módulo. */
export interface EnvVarDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

/** Schema de `core/template.json` no repositório de templates. */
export interface TemplateJson {
  name: string;
  version: string;
  description?: string;
  required?: boolean;
  python_version?: string;
  dependencies?: string[];
  env_vars?: EnvVarDefinition[];
}

/** Mapping `from → to` em `template.json.files[]` de um módulo.
 *
 * `from` é relativo à raiz do módulo baixado. `to` é relativo à raiz do projeto.
 * Se `from` termina com `/` (ou aponta pra diretório), a cópia é recursiva.
 */
export interface FileMapping {
  from: string;
  to: string;
}

/** Descrição de um patch manual documentado no módulo. O CLI não aplica
 *  patches automaticamente — apenas informa o usuário.
 */
export interface PatchDescription {
  file: string;
  description: string;
}

/** Schema de `template.json` de um MÓDULO (diferente do core).
 *
 *  Superset do `TemplateJson`: módulos declaram requisitos (`requires`,
 *  `min_core_version`), mapeamento explícito de arquivos (`files[]`) e
 *  patches manuais (`patches[]`).
 */
export interface ModuleTemplateJson {
  name: string;
  version: string;
  description: string;
  requires: string[];
  min_core_version: string;
  dependencies: string[];
  env_vars: EnvVarDefinition[];
  files: FileMapping[];
  patches: PatchDescription[];
}

/** Plano expandido de cópia — o que `file-installer` gera antes de escrever. */
export interface InstallPlan {
  /** Arquivos destino que já existem no projeto e serão sobrescritos. */
  conflicts: string[];
  /** Caminhos source+dest já expandidos (diretórios viram N arquivos). */
  operations: Array<{ sourceAbs: string; destAbs: string; destRel: string }>;
}

/** Resultado da instalação após a cópia ser executada. */
export interface InstallResult {
  copiedCount: number;
  dryRun: boolean;
}

/** Metadados de um módulo instalado no projeto. */
export interface InstalledModule {
  version: string;
  installedAt: string;
}

/** Schema de `agente.config.json` gravado na raiz do projeto. */
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
