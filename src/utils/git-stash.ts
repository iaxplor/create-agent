// Helpers mínimos de git — detecção + stash push.
//
// Usado pelo comando `upgrade` pra oferecer backup automático antes de
// aplicar mudanças. Todas as operações são NON-FATAIS: se git não está
// instalado, projeto não é git repo, ou stash falha, retornamos false e
// caller decide como seguir (tipicamente: avisa usuário e prossegue sem
// backup).

import { execa } from "execa";

/** Retorna true se `git` está disponível no PATH. */
export async function hasGitInstalled(): Promise<boolean> {
  try {
    await execa("git", ["--version"], { reject: false, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Retorna true se `cwd` é uma árvore de trabalho git válida. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await execa(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd, reject: false, timeout: 3000 },
    );
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** `git stash push -m <message>`. Retorna true se stash foi criado.
 *
 *  Falha silenciosa nas 3 situações:
 *    - git não instalado
 *    - cwd não é repo
 *    - nada pra stash (working tree limpo → exit 0 sem stash criado)
 *
 *  A diferença entre "nenhuma mudança" e "falha real" é sutil; como o
 *  upgrade não depende do stash ter sido criado, tratamos ambos como OK.
 */
export async function stashPush(
  cwd: string,
  message: string,
): Promise<boolean> {
  try {
    const result = await execa(
      "git",
      ["stash", "push", "--include-untracked", "-m", message],
      { cwd, reject: false, timeout: 10_000 },
    );
    // Se stash não criou nada (nothing to stash), stdout tem "No local changes..."
    // Ainda retornamos true — operação foi bem-sucedida, só não havia mudanças.
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
