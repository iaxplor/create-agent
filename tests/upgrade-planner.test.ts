// Testes unitários do upgrade-planner.
//
// Estratégia: cria snapshots FAKE em diretórios temp (files/* com conteúdo
// controlado), chama planUpgrade e asserta o status de cada entry.
// Zero mock — usa o sistema de arquivos real de /tmp pra exercitar o
// código como ele roda em produção.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planUpgrade } from "../src/utils/upgrade-planner.js";

// --------------------------------------------------------------------------- //
//  Helpers de setup
// --------------------------------------------------------------------------- //

interface FakeSnapshot {
  dir: string;
  /** Cria arquivo `files/{relPath}` com conteúdo dado. Cria dirs intermediárias. */
  addFile: (relPath: string, content: string) => Promise<void>;
}

async function makeSnapshot(prefix: string): Promise<FakeSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), `iaxplor-planner-${prefix}-`));
  await mkdir(join(dir, "files"), { recursive: true });
  return {
    dir,
    async addFile(relPath, content) {
      const abs = join(dir, "files", relPath);
      const parent = abs.substring(0, abs.lastIndexOf("/"));
      await mkdir(parent, { recursive: true });
      await writeFile(abs, content, "utf8");
    },
  };
}

async function makeProject(): Promise<{ dir: string; addFile: (p: string, c: string) => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "iaxplor-planner-proj-"));
  return {
    dir,
    async addFile(relPath, content) {
      const abs = join(dir, relPath);
      const parent = abs.substring(0, abs.lastIndexOf("/"));
      await mkdir(parent, { recursive: true });
      await writeFile(abs, content, "utf8");
    },
  };
}

let oldSnap: FakeSnapshot;
let newSnap: FakeSnapshot;
let project: { dir: string; addFile: (p: string, c: string) => Promise<void> };

beforeEach(async () => {
  oldSnap = await makeSnapshot("old");
  newSnap = await makeSnapshot("new");
  project = await makeProject();
});

afterEach(async () => {
  await rm(oldSnap.dir, { recursive: true, force: true });
  await rm(newSnap.dir, { recursive: true, force: true });
  await rm(project.dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- //
//  Testes dos 6 estados
// --------------------------------------------------------------------------- //

describe("planUpgrade — estado por arquivo", () => {
  it("'new' — arquivo no novo, não existe local", async () => {
    await oldSnap.addFile("core/config.py", "v1");
    await newSnap.addFile("core/config.py", "v1"); // mesmo conteúdo
    await newSnap.addFile("core/buffer.py", "novo arquivo"); // NOVO na v0.2.0
    await project.addFile("core/config.py", "v1"); // projeto só tem o antigo

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const buffer = plan.entries.find((e) => e.relPath === "core/buffer.py");
    expect(buffer?.status).toBe("new");
  });

  it("'same-as-new' — local == novo (já atualizado)", async () => {
    await oldSnap.addFile("api/main.py", "v1");
    await newSnap.addFile("api/main.py", "v2 novo");
    await project.addFile("api/main.py", "v2 novo"); // aluno já tem o novo

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const entry = plan.entries.find((e) => e.relPath === "api/main.py");
    expect(entry?.status).toBe("same-as-new");
  });

  it("'unchanged-from-base' — aluno não mexeu, upstream mudou", async () => {
    await oldSnap.addFile("api/health.py", "v1 original");
    await newSnap.addFile("api/health.py", "v2 melhorado");
    await project.addFile("api/health.py", "v1 original"); // igual ao antigo

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const entry = plan.entries.find((e) => e.relPath === "api/health.py");
    expect(entry?.status).toBe("unchanged-from-base");
  });

  it("'modified-locally' — aluno editou E upstream mudou", async () => {
    await oldSnap.addFile("core/config.py", "original v1");
    await newSnap.addFile("core/config.py", "upstream mudou v2");
    await project.addFile("core/config.py", "aluno modificou v1"); // != antigo, != novo

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const entry = plan.entries.find((e) => e.relPath === "core/config.py");
    expect(entry?.status).toBe("modified-locally");
  });

  it("'changed-remote-no-base' — sem snapshot antigo, local != novo", async () => {
    await newSnap.addFile("core/config.py", "nova");
    await project.addFile("core/config.py", "local diferente");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: null, // modo degradado
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.baseAvailable).toBe(false);
    const entry = plan.entries.find((e) => e.relPath === "core/config.py");
    expect(entry?.status).toBe("changed-remote-no-base");
  });

  it("'deleted-in-new' — existia no antigo, sumiu no novo, aluno ainda tem", async () => {
    await oldSnap.addFile("workers/_noop.py", "antigo placeholder");
    // newSnap NÃO tem workers/_noop.py
    await project.addFile("workers/_noop.py", "antigo placeholder");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const entry = plan.entries.find((e) => e.relPath === "workers/_noop.py");
    expect(entry?.status).toBe("deleted-in-new");
  });
});

// --------------------------------------------------------------------------- //
//  Cenários de integração
// --------------------------------------------------------------------------- //

describe("planUpgrade — combinações reais", () => {
  it("upgrade típico: novo + inalterado + modificado + deletado", async () => {
    // Base: 3 arquivos
    await oldSnap.addFile("core/config.py", "original");
    await oldSnap.addFile("api/main.py", "original main");
    await oldSnap.addFile("workers/_noop.py", "placeholder");

    // Novo: config mudou, main mudou, noop sumiu, buffer novo
    await newSnap.addFile("core/config.py", "versão 2");
    await newSnap.addFile("api/main.py", "main v2");
    await newSnap.addFile("core/buffer.py", "feature nova");

    // Projeto: config modificado pelo aluno, main inalterado, noop ainda tem
    await project.addFile("core/config.py", "aluno editou");
    await project.addFile("api/main.py", "original main");
    await project.addFile("workers/_noop.py", "placeholder");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const byPath = new Map(plan.entries.map((e) => [e.relPath, e.status]));
    expect(byPath.get("core/config.py")).toBe("modified-locally");
    expect(byPath.get("api/main.py")).toBe("unchanged-from-base");
    expect(byPath.get("core/buffer.py")).toBe("new");
    expect(byPath.get("workers/_noop.py")).toBe("deleted-in-new");
  });

  it("entries sempre ordenadas alfabeticamente por relPath", async () => {
    await oldSnap.addFile("zzz.py", "x");
    await newSnap.addFile("aaa.py", "y");
    await newSnap.addFile("mmm.py", "z");
    await newSnap.addFile("zzz.py", "diff");
    await project.addFile("zzz.py", "x"); // unchanged-from-base

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    const paths = plan.entries.map((e) => e.relPath);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it("arquivo mesmo conteúdo em todos os 3 → 'same-as-new', skip", async () => {
    await oldSnap.addFile("a.py", "same");
    await newSnap.addFile("a.py", "same");
    await project.addFile("a.py", "same");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("same-as-new");
  });

  it("arquivo no novo + projeto, mas não no antigo → conservador: 'modified-locally'", async () => {
    // Cenário raro: aluno criou por conta própria um arquivo que depois foi
    // adicionado upstream (colisão). Sem base pra comparar conteúdo original,
    // planner trata como se fosse modificação local (prompt é acionado).
    await newSnap.addFile("overlap.py", "upstream");
    await project.addFile("overlap.py", "aluno criou");
    // oldSnap NÃO tem overlap.py

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("modified-locally");
  });
});

// =========================================================================== //
//  PROTECTED — agent/* (ADR-001, CLI v0.8.0+)
// =========================================================================== //

describe("planUpgrade — categoria PROTECTED (agent/*)", () => {
  it("agent/instructions.py modificado pelo aluno → 'protected-skipped' (gera .template, não toca)", async () => {
    await oldSnap.addFile("agent/instructions.py", "skeleton vazio");
    await newSnap.addFile("agent/instructions.py", "skeleton novo do template");
    await project.addFile("agent/instructions.py", "70 linhas de system prompt do aluno");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("protected-skipped");
    expect(plan.entries[0]?.relPath).toBe("agent/instructions.py");
  });

  it("agent/skeleton_novo.py não existe local → 'protected-skipped' (gera .template, sem auto-criar)", async () => {
    await newSnap.addFile("agent/feedback_extensions.py", "skeleton vazio");
    // project NÃO tem agent/feedback_extensions.py

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("protected-skipped");
  });

  it("agent/customer_metadata.py idêntico ao template → 'same-as-new' (no-op silencioso, sem .template)", async () => {
    const content = "from pydantic import BaseModel\nclass CustomerMetadata(BaseModel): pass\n";
    await newSnap.addFile("agent/customer_metadata.py", content);
    await project.addFile("agent/customer_metadata.py", content);

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("same-as-new");
  });
});

// =========================================================================== //
//  MERGED — .gitignore, .env.example (ADR-002, CLI v0.8.0+)
// =========================================================================== //

describe("planUpgrade — categoria MERGED (.gitignore, .env.example)", () => {
  it(".gitignore com qualquer estado → 'merged' (executor faz fusão custom)", async () => {
    await newSnap.addFile(".gitignore", "*.pyc\n.env\n");
    await project.addFile(".gitignore", "*.pyc\n.env\ncredentials.json\n");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("merged");
    expect(plan.entries[0]?.relPath).toBe(".gitignore");
  });

  it(".env.example sempre cai em 'merged' (sem hash check no planner)", async () => {
    await newSnap.addFile(".env.example", "DOMAIN=\nDATABASE_URL=\n");
    await project.addFile(".env.example", "DOMAIN=meudominio.com\nDATABASE_URL=postgres://\n");

    const plan = await planUpgrade({
      projectDir: project.dir,
      oldSnapshotDir: oldSnap.dir,
      newSnapshotDir: newSnap.dir,
    });

    expect(plan.entries[0]?.status).toBe("merged");
  });
});
