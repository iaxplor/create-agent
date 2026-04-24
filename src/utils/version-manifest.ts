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

/** Mesmo que `fetchCoreSnapshot` mas pra módulos. */
export async function fetchModuleSnapshot(
  moduleName: string,
  version: string,
  opts: VersionSourceOptions = {},
): Promise<string | null> {
  const base = opts.templateSource ?? `github:${TEMPLATES_REPO}`;
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
