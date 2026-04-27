// Detector de ciclo potencial entre módulo IAxplor e `core.*` (CLI v0.8.4+).
//
// Contexto: bug do gcal 0.4.1 + core 0.6.0+ — `db/models/__init__.py`
// auto-importa `integrations.google_calendar.models.CalendarEvent` (pra
// Alembic auto-detectar a tabela), e o `service.py` do gcal importava
// `from core.outbound import ...` no top-level. Os 2 imports juntos
// fechavam ciclo. v0.4.2 corrigiu via lazy imports, mas a V11 alerta
// preventivamente pra qualquer módulo futuro com mesmo padrão.
//
// Heurística:
//   1. Lê db/models/__init__.py — extrai módulos auto-importados via
//      `from integrations.<X>...` ou `from channels.<X>...`
//   2. Pra cada módulo auto-importado, scaneia os .py do dir do módulo
//   3. Se algum tem `from core.X import ...` no TOP-LEVEL (não lazy),
//      reporta ciclo potencial
//
// Lazy imports (dentro de função, com indentação) NÃO são reportados —
// regex exige início de linha sem whitespace.
//
// Pure: zero I/O. Caller (doctor V11) lê arquivos e chama estas funções.

/** Extrai nomes de módulos IAxplor auto-importados em db/models/__init__.py.
 *  Procura `from integrations.<X>...` e `from channels.<X>...` (com ou
 *  sem try/except). Comentários ignorados. Retorna paths relativos
 *  ao projectDir (ex.: `integrations/google_calendar`). */
export function extractAutoImportedModules(content: string): string[] {
  const modules = new Set<string>();
  const lines = content.split(/\r?\n/);
  // Match `from integrations.<X>...` ou `from channels.<X>...`. Permite
  // whitespace inicial (pra cobrir try/except blocks com indent). Ignora
  // comentários (linhas que começam com #).
  const re = /^\s*from\s+(integrations|channels)\.([A-Za-z_][A-Za-z0-9_]*)/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const match = re.exec(line);
    if (match && match[1] && match[2]) {
      modules.add(`${match[1]}/${match[2]}`);
    }
  }
  return [...modules].sort();
}

/** Submódulos do core que importam `db.models.*` (e portanto criam ciclo
 *  quando o módulo é auto-importado em `db/models/__init__.py`). Submódulos
 *  fora desta lista (ex.: `core.logger`, `core.config`, `core.utils`,
 *  `core.extension_loader`) são SEGUROS — não há cadeia de importação
 *  que feche ciclo.
 *
 *  Manter conservador: adicionar entrada quando um submódulo novo do core
 *  passar a importar db.models. Falso negativo (esquecer entrada) =
 *  doctor não alerta; falso positivo (colocar a mais) = doctor warna
 *  desnecessariamente. Conservador = poucos falsos positivos. */
const RISKY_CORE_SUBMODULES: ReadonlySet<string> = new Set([
  "outbound",   // outbound/service.py: from db.models.customer import Customer
  "customers",  // customers/service.py: from db.models.customer import Customer
]);

/** Retorna lista de submódulos RISKY de `core` (que tocam db.models)
 *  importados no TOP-LEVEL do arquivo (sem indentação inicial). Imports
 *  DENTRO de funções (lazy, indentados) são ignorados. Submódulos seguros
 *  (`core.logger`, `core.config`, etc.) também são ignorados.
 *
 *  Ex.: `from core.outbound import cancel_scheduled` no topo → ["outbound"]
 *       `from core.logger import logger` no topo → []  (seguro)
 *       `    from core.outbound import ...` (indentado) → []  (lazy) */
export function findTopLevelCoreImports(content: string): string[] {
  const submodules = new Set<string>();
  const lines = content.split(/\r?\n/);
  // Top-level = início de linha SEM whitespace. Casa `from core.<sub>`
  // mas captura o submódulo.
  const re = /^from\s+core\.([A-Za-z_][A-Za-z0-9_]*)/;
  for (const line of lines) {
    const match = re.exec(line);
    if (match && match[1] && RISKY_CORE_SUBMODULES.has(match[1])) {
      submodules.add(match[1]);
    }
  }
  return [...submodules].sort();
}
