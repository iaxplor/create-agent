// Comando `create-agent doctor` — validador read-only do projeto IAxplor.
//
// Cruza `agente.config.json` com o estado real (versões instaladas vs disponíveis,
// .env.example vs env vars required dos manifests, min_core_version dos módulos
// instalados vs coreVersion do projeto) e reporta findings num único output.
//
// Read-only e offline-friendly (exceto pelos downloads de manifests via giget,
// que são cacheados). Sempre `process.exit(0)` — informativo, não CI gate.
//
// Out of scope v0.6.0 (vide plan #H6.1+):
//   - V5: modelos SQLModel não registrados em db/models/__init__.py (precisa AST)
//   - V6: tools de módulo não importadas em agent/agent.py (precisa metadata futura)
//   - V7: migrations pendentes (precisa DB up — viola "offline-friendly")

import path from "node:path";

import chalk from "chalk";
import fsExtra from "fs-extra";

import { printBanner } from "../utils/banner.js";
import { readAgenteConfig } from "../utils/config-reader.js";
import { readEnvExampleVars } from "../utils/env-example-reader.js";
import {
  detectEvolutionInApiMain,
  detectEvolutionInArqWorker,
  detectEvolutionInCoreConfig,
  type LegacyPatchFinding,
} from "../utils/legacy-patches-detector.js";
import { createSpinner, log } from "../utils/logger.js";
import { parseModuleManifest } from "../utils/template-manifest.js";
import {
  cleanupSnapshot,
  fetchCoreSnapshot,
  fetchModuleSnapshot,
  listProjectComponents,
  type ComponentVersion,
} from "../utils/version-manifest.js";
import { isCompatible } from "../utils/version-check.js";
import type {
  AgenteConfig,
  EnvVarDefinition,
  ModuleTemplateJson,
  TemplateJson,
} from "../types.js";

const { pathExists, readFile, readJson, readdir } = fsExtra;

export interface DoctorOptions {
  templateSource?: string;
  /** Modo CI gate: se true e há findings de level "error", seta
   *  process.exitCode = 1. Warnings continuam exit 0. */
  strict?: boolean;
}

/** Severidade de cada finding. `ok` é positivo (✓ verde), `warn` é amarelo,
 *  `error` é vermelho. Não afeta exit code (sempre 0 na v0.6.0). */
export type FindingLevel = "ok" | "warn" | "error";

export interface Finding {
  section: string;
  level: FindingLevel;
  message: string;
}

// --------------------------------------------------------------------------- //
//  V1 — Estrutura de agente.config.json
// --------------------------------------------------------------------------- //

/** Valida campos obrigatórios + semver de coreVersion + module versions. */
export function validateConfigStructure(config: AgenteConfig): Finding[] {
  const findings: Finding[] = [];
  const section = "agente.config.json";

  if (!config.name || typeof config.name !== "string") {
    findings.push({
      section,
      level: "error",
      message: "campo 'name' ausente ou inválido",
    });
  }
  if (!config.coreVersion || typeof config.coreVersion !== "string") {
    findings.push({
      section,
      level: "error",
      message: "campo 'coreVersion' ausente ou inválido",
    });
  } else if (!isValidSemver(config.coreVersion)) {
    findings.push({
      section,
      level: "error",
      message: `coreVersion '${config.coreVersion}' não é semver válido (esperado X.Y.Z)`,
    });
  }
  if (!config.modules || typeof config.modules !== "object") {
    findings.push({
      section,
      level: "error",
      message: "campo 'modules' ausente ou inválido (esperado objeto)",
    });
  } else {
    for (const [name, mod] of Object.entries(config.modules)) {
      if (!mod || typeof mod !== "object" || !("version" in mod)) {
        findings.push({
          section,
          level: "error",
          message: `módulo '${name}': estrutura inválida (esperado {version, installedAt})`,
        });
        continue;
      }
      if (!isValidSemver(mod.version)) {
        findings.push({
          section,
          level: "error",
          message: `módulo '${name}': version '${mod.version}' não é semver válido`,
        });
      }
    }
  }

  if (findings.length === 0) {
    findings.push({ section, level: "ok", message: "estrutura válida" });
  }
  return findings;
}

/** Heurística de semver válido — exige 3 partes inteiras. `parseSemver` é
 *  tolerante (parts inválidas viram 0); aqui validamos formato estrito. */
function isValidSemver(v: string): boolean {
  if (typeof v !== "string") return false;
  const core = v.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => /^\d+$/.test(p));
}

// --------------------------------------------------------------------------- //
//  V2 — Versões disponíveis (reusa listProjectComponents)
// --------------------------------------------------------------------------- //

/** Converte cada `ComponentVersion` em finding (`ok` se atualizado, `warn` se
 *  há update). Nome da seção = nome do componente (`core`, `<módulo>`). */
export function reportVersionAvailability(
  components: ComponentVersion[],
): Finding[] {
  return components.map((c) => {
    const section = `${c.displayName} ${c.installedVersion}`;
    if (c.hasUpdate) {
      return {
        section,
        level: "warn" as const,
        message: `atualização disponível: ${c.availableVersion} (rode 'create-agent upgrade ${c.target}')`,
      };
    }
    return {
      section,
      level: "ok" as const,
      message: "última versão",
    };
  });
}

// --------------------------------------------------------------------------- //
//  V3 — min_core_version violation
// --------------------------------------------------------------------------- //

/** Para um módulo já com manifest baixado, checa se o `coreVersion` do
 *  projeto satisfaz `min_core_version`. Retorna OK ou error. */
export function checkMinCoreVersion(
  moduleName: string,
  installedModuleVersion: string,
  manifest: ModuleTemplateJson,
  projectCoreVersion: string,
): Finding[] {
  const section = `${moduleName} ${installedModuleVersion}`;
  if (isCompatible(projectCoreVersion, manifest.min_core_version)) {
    return [
      {
        section,
        level: "ok",
        message: `compatível com core ${projectCoreVersion} (requer >= ${manifest.min_core_version})`,
      },
    ];
  }
  return [
    {
      section,
      level: "error",
      message:
        `requer core >= ${manifest.min_core_version} mas projeto está em ` +
        `${projectCoreVersion}. Faça 'create-agent upgrade core' antes.`,
    },
  ];
}

// --------------------------------------------------------------------------- //
//  V4 — Env vars required ausentes em .env.example
// --------------------------------------------------------------------------- //

/** Diff entre vars `required: true` declaradas no manifest e vars presentes
 *  no `.env.example`. Cada ausente vira finding `error`. Se nenhuma falta,
 *  retorna 1 finding `ok` com a contagem. */
export function checkRequiredEnvVars(
  sectionLabel: string,
  envVars: EnvVarDefinition[],
  declaredVars: Set<string>,
): Finding[] {
  const required = envVars.filter((v) => v.required === true);
  const missing = required.filter((v) => !declaredVars.has(v.name));

  if (missing.length === 0) {
    return [
      {
        section: sectionLabel,
        level: "ok",
        message: `${required.length} env var(s) required declaradas`,
      },
    ];
  }
  return missing.map((v) => ({
    section: sectionLabel,
    level: "error" as const,
    message: `${v.name} (required) ausente no .env.example`,
  }));
}

// --------------------------------------------------------------------------- //
//  V8 — `.template` files em agent/ (CLI v0.8.0+, US-6)
// --------------------------------------------------------------------------- //

/** Walk recursivo em `agent/` procurando arquivos `*.template`.
 *  Retorna paths relativos a `projectDir`. Vazio se diretório não existe. */
async function findTemplateFiles(projectDir: string): Promise<string[]> {
  const agentDir = path.join(projectDir, "agent");
  if (!(await pathExists(agentDir))) return [];
  const out: string[] = [];
  await walkAgent(agentDir, projectDir, out);
  return out.sort();
}

async function walkAgent(
  dir: string,
  projectDir: string,
  acc: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip __pycache__ e similares — ruído.
      if (entry.name.startsWith("__")) continue;
      await walkAgent(abs, projectDir, acc);
    } else if (entry.isFile() && entry.name.endsWith(".template")) {
      acc.push(path.relative(projectDir, abs));
    }
  }
}

/** Valida presença de `.template` files em agent/ (gerados por upgrade
 *  PROTECTED — US-1). Cada arquivo encontrado vira finding `warn` —
 *  lembrete pra aluno revisar e mesclar/remover. */
export async function checkTemplateFiles(
  projectDir: string,
): Promise<Finding[]> {
  const templates = await findTemplateFiles(projectDir);
  if (templates.length === 0) {
    return [
      {
        section: "agent/ template files",
        level: "ok",
        message: "nenhum .template pendente",
      },
    ];
  }
  return templates.map((relPath) => ({
    section: "agent/ template files",
    level: "warn" as const,
    message: `${relPath} — revise e mescle ou remova (gerado por upgrade PROTECTED)`,
  }));
}

// --------------------------------------------------------------------------- //
//  V9 — patches legados de módulos pre-extension-layer (CLI v0.8.1+, US-6)
// --------------------------------------------------------------------------- //

/** Mapeamento de arquivos do projeto pra detector correspondente.
 *  Centralizado pra ficar fácil expandir quando novos módulos migrarem
 *  pra extension layer (z-api, telegram, etc.). */
const LEGACY_DETECTORS: ReadonlyArray<{
  relPath: string;
  detect: (content: string) => LegacyPatchFinding[];
}> = [
  { relPath: "core/config.py", detect: detectEvolutionInCoreConfig },
  { relPath: "api/main.py", detect: detectEvolutionInApiMain },
  { relPath: "workers/arq_worker.py", detect: detectEvolutionInArqWorker },
];

/** Roda os detectores em arquivos do projeto, agrupando findings por
 *  arquivo. Cada finding warn aponta migration via MIGRATION_v0.4.0.md. */
export async function checkLegacyPatches(
  projectDir: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { relPath, detect } of LEGACY_DETECTORS) {
    const abs = path.join(projectDir, relPath);
    if (!(await pathExists(abs))) continue;
    const content = await readFile(abs, "utf8");
    const detected = detect(content);
    for (const f of detected) {
      findings.push({
        section: "patches legados (módulos pre-extension-layer)",
        level: "warn",
        message: `${f.file}: ${f.message} — ${f.hint}`,
      });
    }
  }
  if (findings.length === 0) {
    return [
      {
        section: "patches legados (módulos pre-extension-layer)",
        level: "ok",
        message: "nenhum patch legado em core/api/workers",
      },
    ];
  }
  return findings;
}

// --------------------------------------------------------------------------- //
//  Orquestração + output
// --------------------------------------------------------------------------- //

/** Carrega o `template.json` do core a partir de um snapshot dir baixado.
 *  Diferente de `parseModuleManifest`, o core tem schema mais simples
 *  (sem `requires`/`min_core_version`/`files`/`patches`). */
async function loadCoreManifestFromSnapshot(
  snapshotDir: string,
): Promise<TemplateJson | null> {
  const manifestPath = path.join(snapshotDir, "template.json");
  if (!(await pathExists(manifestPath))) return null;
  try {
    return (await readJson(manifestPath)) as TemplateJson;
  } catch {
    return null;
  }
}

/** Renderiza findings agrupados por seção, com sumário no final. */
export function renderFindings(findings: Finding[]): void {
  // Preserva ordem de inserção das seções (Map mantém insertion order).
  const grouped = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = grouped.get(f.section);
    if (list) {
      list.push(f);
    } else {
      grouped.set(f.section, [f]);
    }
  }

  console.log();
  for (const [section, items] of grouped) {
    console.log(chalk.bold(section));
    for (const f of items) {
      console.log(`  ${formatLevel(f.level)} ${f.message}`);
    }
    console.log();
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const oks = findings.filter((f) => f.level === "ok").length;

  console.log(chalk.gray("─".repeat(40)));
  if (errors === 0 && warns === 0) {
    log.success(`Tudo OK (${oks} verificações passaram)`);
  } else {
    const parts: string[] = [];
    if (errors > 0) parts.push(chalk.red(`${errors} erro(s)`));
    if (warns > 0) parts.push(chalk.yellow(`${warns} warning(s)`));
    parts.push(chalk.gray(`${oks} OK`));
    console.log(parts.join(", "));
  }
  console.log();
}

function formatLevel(level: FindingLevel): string {
  switch (level) {
    case "ok":
      return chalk.green("✓");
    case "warn":
      return chalk.yellow("⚠");
    case "error":
      return chalk.red("✗");
  }
}

/** Comando principal. Sempre exit 0 — informativo. */
export async function doctorCommand(opts: DoctorOptions = {}): Promise<void> {
  printBanner();

  const cwd = process.cwd();
  const config = await readAgenteConfig(cwd);

  const findings: Finding[] = [];

  // V1 — estrutura
  findings.push(...validateConfigStructure(config));

  // V2 — versões disponíveis (faz network: lista LATEST do core + módulos)
  const spinner = createSpinner("Consultando versões disponíveis...");
  let components: ComponentVersion[] = [];
  try {
    components = await listProjectComponents(config, opts);
    spinner.succeed("Versões consultadas");
  } catch (err) {
    spinner.fail("Falha ao consultar versões (offline?)");
    const msg = err instanceof Error ? err.message : String(err);
    findings.push({
      section: "rede",
      level: "warn",
      message: `não consegui consultar versões disponíveis: ${msg}`,
    });
  }
  findings.push(...reportVersionAvailability(components));

  // V3 + V4 — baixa manifests das versões INSTALADAS (1 snapshot por componente).
  // Reusamos cada snapshot pra ambas validações antes de liberar.
  const snapshotsToCleanup: string[] = [];
  try {
    // Core
    const declaredVars = await readEnvExampleVars(cwd);
    const coreSnap = await fetchCoreSnapshot(config.coreVersion, opts);
    if (coreSnap) {
      snapshotsToCleanup.push(coreSnap);
      const coreManifest = await loadCoreManifestFromSnapshot(coreSnap);
      if (coreManifest?.env_vars) {
        findings.push(
          ...checkRequiredEnvVars(
            ".env.example (core)",
            coreManifest.env_vars,
            declaredVars,
          ),
        );
      }
    } else {
      findings.push({
        section: `core ${config.coreVersion}`,
        level: "warn",
        message:
          "manifest da versão instalada não encontrado no repo " +
          "(tag deletada?). Pulando V3/V4 do core.",
      });
    }

    // Módulos
    for (const [name, mod] of Object.entries(config.modules ?? {})) {
      const snap = await fetchModuleSnapshot(name, mod.version, opts);
      if (!snap) {
        findings.push({
          section: `${name} ${mod.version}`,
          level: "warn",
          message:
            "manifest da versão instalada não encontrado no repo " +
            "(tag deletada?). Pulando V3/V4 deste módulo.",
        });
        continue;
      }
      snapshotsToCleanup.push(snap);
      let manifest: ModuleTemplateJson;
      try {
        manifest = await parseModuleManifest(snap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          section: `${name} ${mod.version}`,
          level: "warn",
          message: `template.json inválido nesta versão: ${msg}`,
        });
        continue;
      }
      // V3
      findings.push(
        ...checkMinCoreVersion(name, mod.version, manifest, config.coreVersion),
      );
      // V4
      findings.push(
        ...checkRequiredEnvVars(
          `.env.example (${name})`,
          manifest.env_vars,
          declaredVars,
        ),
      );
    }
  } finally {
    for (const dir of snapshotsToCleanup) {
      await cleanupSnapshot(dir);
    }
  }

  // V8 (CLI v0.8.0+) — alerta sobre arquivos .template pendentes em agent/
  // gerados por upgrades PROTECTED (US-1). Aluno deve revisar/mesclar.
  findings.push(...await checkTemplateFiles(cwd));

  // V9 (CLI v0.8.1+) — detecta patches legados de módulos pre-extension-layer
  // (ex.: evolution-api ≤ 0.3.x patcheava core/api/workers). Aluno legado vê
  // checklist do que mover pra agent/* via MIGRATION_v0.4.0.md.
  findings.push(...await checkLegacyPatches(cwd));

  renderFindings(findings);

  // Hint final pra próximos passos quando há issues acionáveis.
  const hasUpdates = components.some((c) => c.hasUpdate);
  const hasIncompat = findings.some(
    (f) => f.level === "error" && f.message.includes("requer core"),
  );
  if (hasUpdates || hasIncompat) {
    console.log(chalk.bold("Próximos passos:"));
    if (hasIncompat) {
      log.command("create-agent upgrade core");
    } else if (hasUpdates) {
      log.command("create-agent upgrade   # atualiza tudo");
    }
    console.log();
  }

  // CI gate (v0.7.0+): --strict transforma errors em exit 1. Warnings
  // continuam exit 0 — semântica do warning é "preste atenção", do error
  // é "ação requerida". Sem --strict, sempre exit 0 (default informativo).
  if (shouldExitStrict(findings, opts)) {
    process.exitCode = 1;
  }
}

/** Helper isolado pro CI gate `--strict`. Retorna true se aluno passou
 *  `--strict` E há pelo menos 1 finding de nível "error". Exportado pra
 *  testes diretos (sem precisar mockar process.exitCode). */
export function shouldExitStrict(
  findings: Finding[],
  opts: DoctorOptions,
): boolean {
  return opts.strict === true && findings.some((f) => f.level === "error");
}

/** Re-exports só pros testes (vitest importa direto). */
export const _internals = {
  isValidSemver,
  loadCoreManifestFromSnapshot,
};
