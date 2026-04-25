// Helpers de alto nível sobre versões: detecta quais componentes do projeto
// têm atualização disponível, comparando `agente.config.json` com a versão
// mais recente publicada no repositório de templates (via giget).
//
// Usado pelo comando `list` e pelo warning pós-upgrade do `upgrade core`.

import os from "node:os";
import path from "node:path";

import fsExtra from "fs-extra";
import { downloadTemplate } from "giget";

import {
  CORE_TEMPLATE_PATH,
  ISSUES_URL,
  MODULES_PATH,
  TEMPLATES_BRANCH,
  TEMPLATES_REPO,
} from "../constants.js";
import type { AgenteConfig } from "../types.js";
import { parseSemver } from "./version-check.js";

const { mkdtemp, pathExists, readJson, remove } = fsExtra;

/** Estado de uma "coisa atualizável" (core ou módulo). */
export interface ComponentVersion {
  target: "core" | string; // "core" | nome do módulo
  displayName: string;
  installedVersion: string;
  availableVersion: string;
  hasUpdate: boolean;
}

/** Opções do fetch — permite override do repo base (flag `--template-source`). */
export interface VersionSourceOptions {
  templateSource?: string;
}

/**
 * Schema do `modules-index.json` mantido na raiz do branch main do repo
 * `agent-templates`. Mapeia explicitamente `{moduleName, version}` → tag
 * do repo onde aquela versão do módulo foi publicada.
 *
 * Existe porque a numeração das versões dos módulos NÃO casa com as tags
 * do repo (release do core/repo é independente da release de cada módulo).
 * Ex.: `google-calendar` v0.1.0 nasceu na tag `v0.2.4` do repo, v0.2.0 na
 * tag `v0.3.0`. Sem este índice, o CLI tentava baixar `v0.1.0.tar.gz` —
 * que é o release do core, e não tem `modules/google-calendar/`.
 *
 * Issue de origem: https://github.com/iaxplor/create-agent/issues/1
 */
export interface ModulesIndex {
  [moduleName: string]: {
    [moduleVersion: string]: string; // → tag do repo
  };
}

/** Lista componentes do projeto (core + módulos instalados) com suas versões. */
export async function listProjectComponents(
  config: AgenteConfig,
  opts: VersionSourceOptions = {},
): Promise<ComponentVersion[]> {
  const out: ComponentVersion[] = [];

  // --- Core --------------------------------------------------------------
  const installedCore = resolveInstalledCoreVersion(config);
  const availableCore = await fetchCoreLatestVersion(opts);
  out.push({
    target: "core",
    displayName: "core",
    installedVersion: installedCore,
    availableVersion: availableCore,
    hasUpdate: isNewer(availableCore, installedCore),
  });

  // --- Módulos instalados -----------------------------------------------
  const moduleNames = Object.keys(config.modules ?? {});
  for (const name of moduleNames) {
    const entry = config.modules[name];
    if (!entry) continue;
    const availableModule = await fetchModuleLatestVersion(name, opts);
    out.push({
      target: name,
      displayName: name,
      installedVersion: entry.version,
      availableVersion: availableModule ?? entry.version,
      hasUpdate:
        availableModule !== null && isNewer(availableModule, entry.version),
    });
  }

  return out;
}

/** Retorna `config.coreVersion` ou "0.1.0" se ausente (Q2). */
export function resolveInstalledCoreVersion(config: AgenteConfig): string {
  return config.coreVersion || "0.1.0";
}

/** Compara semver: retorna true se `candidate` > `base`. */
export function isNewer(candidate: string, base: string): boolean {
  const [ca, cb, cc] = parseSemver(candidate);
  const [ba, bb, bc] = parseSemver(base);
  if (ca !== ba) return ca > ba;
  if (cb !== bb) return cb > bb;
  return cc > bc;
}

// --------------------------------------------------------------------------- //
//  Fetchers (usam giget, baixam só template.json pra ler version)
// --------------------------------------------------------------------------- //

/** Baixa `template.json` do core no `main` do repo e retorna a versão. */
export async function fetchCoreLatestVersion(
  opts: VersionSourceOptions = {},
): Promise<string> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;
  const source = `${base}/${CORE_TEMPLATE_PATH}#${TEMPLATES_BRANCH}`;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "iaxplor-core-ver-"));
  try {
    await downloadTemplate(source, { dir: tmpDir, force: true });
    const manifestPath = path.join(tmpDir, "template.json");
    if (!(await pathExists(manifestPath))) {
      return "0.0.0"; // manifesto ausente — marca como "desconhecido"
    }
    const manifest = (await readJson(manifestPath)) as { version?: string };
    return manifest.version ?? "0.0.0";
  } finally {
    await remove(tmpDir).catch(() => {
      /* best effort */
    });
  }
}

/** Baixa `template.json` de um módulo e retorna a versão. Null se não existe. */
export async function fetchModuleLatestVersion(
  moduleName: string,
  opts: VersionSourceOptions = {},
): Promise<string | null> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;
  const source = `${base}/${MODULES_PATH}/${moduleName}#${TEMPLATES_BRANCH}`;

  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), `iaxplor-${moduleName}-ver-`),
  );
  try {
    await downloadTemplate(source, { dir: tmpDir, force: true });
    const manifestPath = path.join(tmpDir, "template.json");
    if (!(await pathExists(manifestPath))) {
      return null;
    }
    const manifest = (await readJson(manifestPath)) as { version?: string };
    return manifest.version ?? null;
  } catch {
    // Repo/subpath inexistente — módulo foi renomeado/removido do repo?
    return null;
  } finally {
    await remove(tmpDir).catch(() => {
      /* best effort */
    });
  }
}

/** Baixa snapshot completo de UMA versão do core (pra comparação de SHAs).
 *
 *  Tenta tags `v{version}` e `{version}`. Se nenhuma existe, retorna null —
 *  caller cai em modo degradado (sem comparação base).
 */
export async function fetchCoreSnapshot(
  version: string,
  opts: VersionSourceOptions = {},
): Promise<string | null> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;
  const candidateRefs = [`v${version}`, version];

  for (const ref of candidateRefs) {
    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), `iaxplor-core-snap-${ref}-`),
    );
    try {
      await downloadTemplate(`${base}/${CORE_TEMPLATE_PATH}#${ref}`, {
        dir: tmpDir,
        force: true,
      });
      return tmpDir;
    } catch {
      // Tag não existe — tenta próximo ref.
      await remove(tmpDir).catch(() => {
        /* best effort */
      });
    }
  }

  return null;
}

/**
 * Baixa `modules-index.json` da raiz do branch main do repo de templates.
 *
 * Retorna `null` em qualquer falha (rede off, branch sem o arquivo,
 * JSON inválido). Modo degradado intencional — o caller (`fetchModuleSnapshot`)
 * faz fallback pra convenção de tag direta com warning.
 */
export async function fetchModulesIndex(
  opts: VersionSourceOptions = {},
): Promise<ModulesIndex | null> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;
  const source = `${base}#${TEMPLATES_BRANCH}`;

  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "iaxplor-modules-index-"),
  );
  try {
    await downloadTemplate(source, { dir: tmpDir, force: true });
    const indexPath = path.join(tmpDir, "modules-index.json");
    if (!(await pathExists(indexPath))) {
      return null;
    }
    return (await readJson(indexPath)) as ModulesIndex;
  } catch {
    return null;
  } finally {
    await remove(tmpDir).catch(() => {
      /* best effort */
    });
  }
}

/**
 * Resolve a tag do repo pra `{moduleName, version}` consultando o índice.
 * Retorna `null` se o índice é null OU se não tem entrada — caller decide
 * fallback (tentar convenção de tag) ou erro.
 */
export function resolveTagFromIndex(
  index: ModulesIndex | null,
  moduleName: string,
  version: string,
): string | null {
  if (!index) return null;
  const moduleEntries = index[moduleName];
  if (!moduleEntries) return null;
  return moduleEntries[version] ?? null;
}

/** Mesmo que `fetchCoreSnapshot` mas pra módulos.
 *
 *  Estratégia em 2 camadas:
 *  1) Consulta `modules-index.json` (caminho preferido — funciona pra
 *     qualquer módulo cuja versão divirja da tag do repo).
 *  2) Fallback pra convenção de tag direta (`v{version}` / `{version}`)
 *     pra cobrir índice ausente, módulo third-party ou erro de manutenção
 *     do índice. Warning visível quando índice existe mas não tem a entrada
 *     — sinal de manutenção esquecida.
 */
export async function fetchModuleSnapshot(
  moduleName: string,
  version: string,
  opts: VersionSourceOptions = {},
): Promise<string | null> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;

  // 1) Caminho preferido: consultar o índice central.
  const index = await fetchModulesIndex(opts);
  const indexedTag = resolveTagFromIndex(index, moduleName, version);

  if (indexedTag) {
    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), `iaxplor-${moduleName}-snap-${indexedTag}-`),
    );
    try {
      await downloadTemplate(
        `${base}/${MODULES_PATH}/${moduleName}#${indexedTag}`,
        { dir: tmpDir, force: true },
      );
      return tmpDir;
    } catch {
      await remove(tmpDir).catch(() => {
        /* best effort */
      });
      // Cai pro fallback abaixo — tag listada no índice mas inexistente
      // no repo (estado raro, p.ex. tag deletada após indexação).
    }
  }

  // 2) Fallback: tenta tags por convenção (comportamento pré-v0.4.1).
  // Warning visível se índice estava disponível mas não tinha a entrada
  // — alerta o aluno que o índice ficou desatualizado.
  if (index !== null && !indexedTag) {
    console.warn(
      `  ! Aviso: módulo '${moduleName}' v${version} não encontrado em ` +
        `modules-index.json. Tentando convenção de tag direta. ` +
        `Se falhar, abra issue em ${ISSUES_URL}.`,
    );
  }

  const candidateRefs = [`v${version}`, version];
  for (const ref of candidateRefs) {
    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), `iaxplor-${moduleName}-snap-${ref}-`),
    );
    try {
      await downloadTemplate(
        `${base}/${MODULES_PATH}/${moduleName}#${ref}`,
        { dir: tmpDir, force: true },
      );
      return tmpDir;
    } catch {
      await remove(tmpDir).catch(() => {
        /* best effort */
      });
    }
  }

  return null;
}

export async function cleanupSnapshot(snapshotDir: string | null): Promise<void> {
  if (!snapshotDir) return;
  await remove(snapshotDir).catch(() => {
    /* best effort */
  });
}
