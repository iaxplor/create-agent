// Testes unitários do helper `resolveTagFromIndex` (v0.4.1+).
//
// `fetchModulesIndex` e `fetchModuleSnapshot` fazem I/O de rede via giget e
// não são cobertos aqui — mockar a stack inteira (download + extração)
// custaria mais do que entrega. A integração é exercitada manualmente via
// `pnpm dev upgrade <módulo>` num projeto real.

import { describe, expect, it } from "vitest";

import {
  type ModulesIndex,
  resolveTagFromIndex,
} from "../src/utils/version-manifest.js";

const FIXTURE: ModulesIndex = {
  "google-calendar": {
    "0.1.0": "v0.2.4",
    "0.2.0": "v0.3.0",
    "0.3.1": "v0.4.1",
  },
  "evolution-api": {
    "0.1.0": "v0.1.0",
    "0.2.3": "v0.2.3",
  },
};

describe("resolveTagFromIndex", () => {
  it("retorna a tag correta pra {módulo, versão} existente", () => {
    expect(resolveTagFromIndex(FIXTURE, "google-calendar", "0.2.0")).toBe(
      "v0.3.0",
    );
    expect(resolveTagFromIndex(FIXTURE, "evolution-api", "0.2.3")).toBe(
      "v0.2.3",
    );
  });

  it("retorna null pra módulo inexistente no índice", () => {
    expect(resolveTagFromIndex(FIXTURE, "modulo-nao-existe", "1.0.0")).toBe(
      null,
    );
  });

  it("retorna null pra versão inexistente do módulo", () => {
    expect(resolveTagFromIndex(FIXTURE, "google-calendar", "9.9.9")).toBe(
      null,
    );
  });

  it("retorna null se índice é null (offline / erro de fetch)", () => {
    expect(resolveTagFromIndex(null, "google-calendar", "0.2.0")).toBe(null);
  });
});
