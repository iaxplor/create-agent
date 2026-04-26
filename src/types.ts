// Tipos partilhados entre comandos. Schemas são "abertos" (index signatures
// ou campos opcionais quando faz sentido) pra acompanhar evolução do
// template.json sem obrigar bump do CLI a cada campo novo.

/** Definição de uma variável de ambiente usada por um template/módulo.
 *
 *  `default` é opcional — quando presente, o CLI usa esse valor no
 *  `.env.example` gerado automaticamente. Quando ausente (ex.: template.json
 *  legado, publicado antes do CLI v0.3.0), o CLI deixa o valor vazio
 *  (`VAR_NAME=`) e continua funcionando — degradação graciosa.
 */
export interface EnvVarDefinition {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
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
 *
 *  `setup_doc` é opcional — se presente, aponta pro arquivo de setup do módulo
 *  (relativo à raiz do projeto após cópia, ex.: `"EVOLUTION_SETUP.md"`). Se
 *  ausente, o CLI tenta detectar por convenção (primeiro arquivo `*_SETUP.md`
 *  em `files[]`).
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
  setup_doc?: string;
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

/** Resultado da automação do .env.example — consumido pela mensagem final. */
export interface EnvExampleChanges {
  /** `true` se conseguiu aplicar; `false` se falhou (mensagem fala em fallback). */
  applied: boolean;
  /** `true` se o arquivo foi criado do zero (não existia). */
  created: boolean;
  /** `true` se já existia bloco desse módulo e foi substituído. */
  replaced: boolean;
  /** Número de env vars gravadas no bloco. */
  varCount: number;
  /** Nomes de env vars que já existiam FORA do bloco (warning).
   *  Quando `dedupOutOfBlock: true` (default v0.8.0+), essas são as que
   *  FORAM REMOVIDAS automaticamente; com `dedupOutOfBlock: false`, são
   *  apenas detectadas pra warning manual. */
  outOfBlockDuplicates: string[];
  /** Nomes de vars efetivamente removidas do conteúdo (subset de
   *  outOfBlockDuplicates quando dedup está ativo; vazio caso contrário). */
  removedDuplicates: string[];
  /** Mensagem de erro humano-lido quando `applied === false`. */
  errorMessage?: string;
}

/** Resultado da automação do pyproject.toml. */
export interface PyprojectChanges {
  applied: boolean;
  /** Deps efetivamente adicionadas (nomes sem constraint). */
  added: string[];
  /** Deps que já existiam com mesma versão — puladas, nenhum warning. */
  alreadyPresent: string[];
  /** Deps existentes com constraint diferente — NÃO sobrescritas, warning. */
  versionConflicts: Array<{ name: string; existing: string; requested: string }>;
  errorMessage?: string;
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
