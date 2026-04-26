// Lê `.env.example` da raiz do projeto e extrai os NOMES das variáveis
// declaradas. Read-only puro (não escreve nada) — separado do
// `env-example-editor` (que é write-only com lógica de blocos versionados).
//
// Usado pelo comando `doctor` pra cruzar com `template.json.env_vars[]`
// e detectar required vars ausentes.
//
// Por que não retornar valores: a v0.6.0 só checa presença/ausência da
// declaração (VAR=algo). Validar VALOR exige conhecer o que cada var
// representa (URL, secret, número), o que sai do escopo. Se for útil
// no futuro (ex.: warning pra "required sem default declarada vazia"),
// trocar pra `Map<string, string>` é não-breaking.

import path from "node:path";

import fsExtra from "fs-extra";

const { pathExists, readFile } = fsExtra;

const ENV_EXAMPLE_FILENAME = ".env.example";

// Convenção: nomes começam com letra/underscore, seguidos de letra/dígito/underscore.
// Maiúsculas-only é convenção, mas o regex aceita case insensitive pra tolerar
// variantes que o aluno tenha adicionado (ex.: `myCamelCase`).
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Coleta os nomes de TODAS as variáveis declaradas no `.env.example`.
 *
 *  Linhas em branco, comentários (`# ...`), e linhas malformadas são
 *  ignoradas. Linhas com VAR vazia (`KEY=`) entram no Set — o aluno
 *  declarou a var mesmo sem preencher.
 *
 *  Se o arquivo não existir, retorna Set vazio (sem erro). Caller decide
 *  se "ausência total do .env.example" é problema (geralmente é).
 */
export async function readEnvExampleVars(
  projectDir: string,
): Promise<Set<string>> {
  const filePath = path.join(projectDir, ENV_EXAMPLE_FILENAME);
  if (!(await pathExists(filePath))) {
    return new Set();
  }

  const content = await readFile(filePath, "utf8");
  const names = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = ENV_LINE_RE.exec(line);
    if (match && match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}
