// Fonte única de strings "estáticas" do CLI — mudanças de repo ou regra de
// validação de nome ficam aqui, não espalhadas pelo código.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versão do próprio CLI, exibida no banner e no `--version`.
 *
 * Lemos do `package.json` em runtime pra evitar drift entre a versão
 * publicada (que o npm valida via `package.json:version`) e a string
 * mostrada pro usuário. Antes, era hardcoded e ficou em `0.8.6` mesmo
 * após o bump pra v0.9.0 — bug visual que confundia quem rodava
 * `--version` ou olhava o banner.
 *
 * Resolução do path: o CLI é distribuído como `dist/index.js`, então
 * `dirname(fileURLToPath(import.meta.url)) + ../package.json` aponta pra
 * raiz do pacote tanto em dev (`src/`) quanto em prod (`dist/`).
 */
const _pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const _pkg = JSON.parse(readFileSync(_pkgPath, "utf8")) as { version: string };
export const CLI_VERSION: string = _pkg.version;

/** Repositório dos templates (sem `github:` na frente — o giget adiciona). */
export const TEMPLATES_REPO = "iaxplor/agent-core";

/** Branch do repositório de templates que baixamos. */
export const TEMPLATES_BRANCH = "main";

/**
 * Caminho da pasta `core/` dentro do repo de templates. O giget baixa esta
 * pasta inteira (incluindo `template.json` + `files/`) pra um diretório
 * temporário; o fluxo em `template-fetcher.ts` separa os dois.
 */
export const CORE_TEMPLATE_PATH = "core";

/** Caminho da pasta `modules/` dentro do repo de templates. O comando `add`
 *  baixa `modules/{name}/` sob demanda.
 */
export const MODULES_PATH = "modules";

// --- Delimitadores de bloco no .env.example -------------------------------
// Permitem detectar+substituir blocos de módulo em reinstalações sem duplicar.
export const envBlockStart = (name: string, version: string): string =>
  `# --- ${name} (${version}) ---`;
export const envBlockEnd = (name: string): string =>
  `# --- Fim ${name} ---`;

/** Arquivo que o CLI grava na raiz do projeto novo com o estado atual. */
export const AGENTE_CONFIG_FILENAME = "agente.config.json";

/** Versão padrão do Python caso `template.json.python_version` esteja ausente. */
export const DEFAULT_PYTHON_VERSION = "3.11";

// --- Validação de nome de projeto -----------------------------------------
// Letras minúsculas + dígitos + hífen. Não começa/termina com hífen, sem hífen duplo.
// Ex.: "meu-agente-01" OK; "Meu", "-meu", "meu-", "meu--agente" falham.
export const PROJECT_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PROJECT_NAME_MIN = 3;
export const PROJECT_NAME_MAX = 50;

// --- URLs públicas --------------------------------------------------------
export const DOCS_URL = "https://github.com/iaxplor/agent-core";
export const ISSUES_URL = "https://github.com/iaxplor/create-agent/issues";
