// Planner do upgrade: classifica cada arquivo em 1 de 8 estados possíveis.
//
// PURE: não faz I/O além de leitura/hashing. Não prompts, não escreve.
// Retorna uma estrutura imutável que o executor + orchestration layer
// consomem pra decidir (prompts) e aplicar (writes).
//
// Categorização (CLI v0.8.0+, ADR-006):
//   IMMUTABLE — exact match em IMMUTABLE_FILES. Ignorado pelo planner; CLI
//               atualiza programaticamente via outros helpers (ex.: config-reader).
//   PROTECTED — prefix match em PROTECTED_PATH_PREFIXES. NUNCA copia. Se
//               template difere, gera <path>.template lateral pro aluno
//               revisar manualmente. Cobre `agent/**` (zona do aluno).
//   MERGED    — exact match em MERGED_FILES. Merge custom (append-only,
//               dedup), nunca overwrite cego. Cobre `.gitignore`, `.env.example`.
//   TRACKED   — tudo o mais. 3-way merge tradicional com prompt em
//               modified-locally.
//
// Os 8 estados (FileStatus):
//   - "new":                       TRACKED, existe no novo, não existe local → copy silent
//   - "same-as-new":               local já == novo (em dia) → skip
//   - "unchanged-from-base":       TRACKED, local == base, upstream mudou → copy silent
//   - "modified-locally":          TRACKED, local != base e local != novo → prompt [S/M/D]
//   - "changed-remote-no-base":    TRACKED, base não disponível, local != novo → prompt com warning
//   - "deleted-in-new":            TRACKED, existe local + base, não existe novo → prompt [R/K]
//   - "protected-skipped":         PROTECTED, template difere ou ausente local → gera .template
//   - "merged":                    MERGED, custom merge (gitignore-merger / env-dedup)

import path from "node:path";

import fsExtra from "fs-extra";

import { hashFile } from "./file-hasher.js";

const { pathExists, readdir } = fsExtra;

/**
 * IMMUTABLE — arquivos NUNCA tocados pelo planner. CLI atualiza via outros
 * helpers (ex.: `agente.config.json` é gerenciado pelo `config-reader`).
 */
const IMMUTABLE_FILES = new Set<string>([
  "agente.config.json",
]);

/**
 * PROTECTED — prefixos de path em que o upgrade NUNCA modifica nada. Se
 * template difere, gera `<path>.template` lateral pro aluno revisar.
 * Cobre `agent/**` (zona de extensão do aluno: instructions, tools,
 * customer_metadata, etc.). ADR-001.
 */
const PROTECTED_PATH_PREFIXES: readonly string[] = ["agent/"];

/**
 * MERGED — arquivos com merge custom (append-only / dedup). Implementação
 * do merge fica no executor. ADR-002 (.gitignore) + ADR-003 (.env.example).
 */
const MERGED_FILES = new Set<string>([
  ".gitignore",
  ".env.example",
]);

/** True se o path está em PROTECTED (prefix-match). Normaliza separador
 *  pra Unix (CLI compara paths relativos sempre com `/`). */
export function isProtected(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  return PROTECTED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** True se o path é IMMUTABLE (exact match). */
export function isImmutable(relPath: string): boolean {
  return IMMUTABLE_FILES.has(relPath);
}

/** True se o path requer merge custom (exact match). */
export function isMerged(relPath: string): boolean {
  return MERGED_FILES.has(relPath);
}

export type FileStatus =
  | "new"
  | "same-as-new"
  | "unchanged-from-base"
  | "modified-locally"
  | "changed-remote-no-base"
  | "deleted-in-new"
  | "protected-skipped"
  | "merged";

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
    // IMMUTABLE — ignorado pelo planner; gerenciado por outro caminho
    // (ex.: agente.config.json via config-reader).
    if (isImmutable(relPath)) continue;

    const sourceNewPath = path.join(newFilesRoot, relPath);
    const destPath = path.join(opts.projectDir, relPath);
    const sourceOldPath = oldFilesRoot ? path.join(oldFilesRoot, relPath) : undefined;
    const destExists = await pathExists(destPath);

    // PROTECTED (CLI v0.8.0+) — agent/* nunca é tocado. Se template difere
    // OU arquivo não existe local, gera .template lateral. Se existir
    // idêntico, marca como same-as-new (no-op silencioso).
    if (isProtected(relPath)) {
      if (!destExists) {
        // Skeleton novo no template — aluno vê o .template e decide se quer.
        entries.push({
          relPath,
          status: "protected-skipped",
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
        // Aluno tem versão idêntica do skeleton — sem necessidade de .template.
        entries.push({
          relPath,
          status: "same-as-new",
          sourceNewPath,
          sourceOldPath,
          destPath,
        });
      } else {
        // Aluno modificou OU template mudou — gera .template lateral.
        entries.push({
          relPath,
          status: "protected-skipped",
          sourceNewPath,
          sourceOldPath,
          destPath,
        });
      }
      continue;
    }

    // MERGED (CLI v0.8.0+) — arquivos com merge custom (.gitignore, .env.example).
    // Sempre marca como "merged"; executor faz a fusão. Sem hash check no
    // planner (merge é idempotente, executor decide se há mudança real).
    if (isMerged(relPath)) {
      entries.push({
        relPath,
        status: "merged",
        sourceNewPath,
        sourceOldPath,
        destPath,
      });
      continue;
    }

    // TRACKED (default) — fluxo 3-way merge tradicional.
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
