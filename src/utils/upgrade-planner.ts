// Planner do upgrade: classifica cada arquivo em 1 de 6 estados possíveis.
//
// PURE: não faz I/O além de leitura/hashing. Não prompts, não escreve.
// Retorna uma estrutura imutável que o executor + orchestration layer
// consomem pra decidir (prompts) e aplicar (writes).
//
// Os 6 estados:
//   - "new":                       existe no novo, não existe local → copy silent
//   - "same-as-new":               local já == novo (em dia) → skip
//   - "unchanged-from-base":       local == base (aluno não mexeu, upstream mudou) → copy silent
//   - "modified-locally":          local != base e local != novo → prompt [S/M/D]
//   - "changed-remote-no-base":    base não disponível, local != novo → prompt com warning
//   - "deleted-in-new":            existe local + base, não existe novo → prompt [R/K]

import path from "node:path";

import fsExtra from "fs-extra";

import { hashFile } from "./file-hasher.js";

const { pathExists, readdir } = fsExtra;

/**
 * Arquivos que NUNCA devem ser tocados pelo upgrade — são "state vivo" do
 * projeto (config do aluno, não template).
 *
 * `agente.config.json` em especial: contém a lista de módulos instalados
 * e metadata. O CLI atualiza `coreVersion`/`modules` programaticamente via
 * `config-reader`, nunca copiando do template.
 */
const PROTECTED_FILES = new Set<string>([
  "agente.config.json",
]);

export type FileStatus =
  | "new"
  | "same-as-new"
  | "unchanged-from-base"
  | "modified-locally"
  | "changed-remote-no-base"
  | "deleted-in-new";

export interface PlanEntry {
  relPath: string;
  status: FileStatus;
  /** Path absoluto no snapshot novo (undefined em `deleted-in-new`). */
  sourceNewPath?: string;
  /** Path absoluto no snapshot antigo (se base disponível). */
  sourceOldPath?: string;
  /** Path absoluto no projeto do aluno. */
  destPath: string;
}

export interface UpgradePlan {
  entries: PlanEntry[];
  baseAvailable: boolean;
}

export interface PlanCoreUpgradeOptions {
  projectDir: string;
  /** Path absoluto do snapshot da versão instalada. Null = modo degradado. */
  oldSnapshotDir: string | null;
  /** Path absoluto do snapshot da versão nova. */
  newSnapshotDir: string;
  /**
   * Subdiretório relativo dentro dos snapshots que contém os arquivos a
   * comparar. Pro core: "files". Pros módulos futuros: idem.
   */
  filesSubdir?: string;
}

/** Gera o plano de upgrade comparando `projectDir` vs dois snapshots. */
export async function planUpgrade(
  opts: PlanCoreUpgradeOptions,
): Promise<UpgradePlan> {
  const filesSubdir = opts.filesSubdir ?? "files";
  const newFilesRoot = path.join(opts.newSnapshotDir, filesSubdir);
  const oldFilesRoot = opts.oldSnapshotDir
    ? path.join(opts.oldSnapshotDir, filesSubdir)
    : null;
  const baseAvailable = oldFilesRoot !== null && (await pathExists(oldFilesRoot));

  // Lista de arquivos relativos em ambos os snapshots.
  const newRelPaths = await listFilesRecursive(newFilesRoot);
  const oldRelPaths = baseAvailable && oldFilesRoot
    ? await listFilesRecursive(oldFilesRoot)
    : [];

  const entries: PlanEntry[] = [];

  // --- Arquivos presentes no snapshot NOVO ---
  for (const relPath of newRelPaths) {
    // Arquivos protegidos (agente.config.json) são ignorados pelo planner —
    // jamais copiados/sobrescritos pelo upgrade. O config é atualizado
    // programaticamente pelo executor via config-reader.
    if (PROTECTED_FILES.has(relPath)) continue;

    const sourceNewPath = path.join(newFilesRoot, relPath);
    const destPath = path.join(opts.projectDir, relPath);
    const sourceOldPath = oldFilesRoot ? path.join(oldFilesRoot, relPath) : undefined;

    const destExists = await pathExists(destPath);
    if (!destExists) {
      entries.push({
        relPath,
        status: "new",
        sourceNewPath,
        sourceOldPath,
        destPath,
      });
      continue;
    }

    const [localHash, newHash] = await Promise.all([
      hashFile(destPath),
      hashFile(sourceNewPath),
    ]);

    if (localHash === newHash) {
      entries.push({
        relPath,
        status: "same-as-new",
        sourceNewPath,
        sourceOldPath,
        destPath,
      });
      continue;
    }

    // local != new. Precisamos do base pra decidir se aluno mexeu.
    if (!baseAvailable) {
      entries.push({
        relPath,
        status: "changed-remote-no-base",
        sourceNewPath,
        sourceOldPath: undefined,
        destPath,
      });
      continue;
    }

    const oldHash = sourceOldPath ? await hashFile(sourceOldPath) : null;
    if (oldHash === null) {
      // arquivo existe no novo E no local, MAS NÃO no antigo → é "novo
      // na versão atual" mas aluno já tem algo com o mesmo nome (criou
      // manualmente? copiou de outro projeto?). Trata como modificado
      // localmente (conservador).
      entries.push({
        relPath,
        status: "modified-locally",
        sourceNewPath,
        sourceOldPath,
        destPath,
      });
      continue;
    }

    if (localHash === oldHash) {
      // Aluno não modificou; upstream mudou. Copy silent.
      entries.push({
        relPath,
        status: "unchanged-from-base",
        sourceNewPath,
        sourceOldPath,
        destPath,
      });
      continue;
    }

    // local != old e local != new → aluno modificou.
    entries.push({
      relPath,
      status: "modified-locally",
      sourceNewPath,
      sourceOldPath,
      destPath,
    });
  }

  // --- Arquivos que existiam no antigo e sumiram no novo ---
  if (baseAvailable) {
    const newSet = new Set(newRelPaths);
    for (const relPath of oldRelPaths) {
      if (newSet.has(relPath)) continue;

      const destPath = path.join(opts.projectDir, relPath);
      if (!(await pathExists(destPath))) continue; // local já não tem

      entries.push({
        relPath,
        status: "deleted-in-new",
        sourceNewPath: undefined,
        sourceOldPath: oldFilesRoot ? path.join(oldFilesRoot, relPath) : undefined,
        destPath,
      });
    }
  }

  // Ordena alfabeticamente pra previsibilidade dos prompts.
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { entries, baseAvailable };
}

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //

/** Walk recursivo retornando paths relativos a `root` (só arquivos). */
async function listFilesRecursive(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const out: string[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(
  absDir: string,
  root: string,
  accumulator: string[],
): Promise<void> {
  const dirents = await readdir(absDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const abs = path.join(absDir, dirent.name);
    if (dirent.isDirectory()) {
      await walk(abs, root, accumulator);
    } else if (dirent.isFile()) {
      accumulator.push(path.relative(root, abs));
    }
  }
}

// Exposto pra testes unitários (stubbing de hash sem I/O).
export const _internals = {
  listFilesRecursive,
};
