// Hashing de arquivos via SHA-256 streaming.
//
// Streaming (em vez de `readFile` + hash) mantém uso de memória constante
// mesmo pra arquivos grandes (templates tipicamente têm 1-100KB, mas
// módulos futuros podem trazer binários — seguros por default).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/** SHA-256 hex de um arquivo. Null se o arquivo não existe. */
export async function hashFile(path: string): Promise<string | null> {
  try {
    const stream = createReadStream(path);
    return await hashStream(stream);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** SHA-256 hex de uma string (útil pra comparar conteúdo em memória). */
export function hashString(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function hashStream(stream: Readable): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
