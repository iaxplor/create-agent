// Tests do split --yes em --accept-new/--overwrite-modified/--delete-removed
// (US-4, ADR-005, CLI v0.8.0+).
//
// Estratégia: testa helpers puros `resolveDecisionPolicy` e `isAutomatedRun`.
// Comportamento end-to-end de prompts cobertos por interactive-file-action
// já existente.

import { describe, expect, it } from "vitest";

import {
  isAutomatedRun,
  resolveDecisionPolicy,
  type UpgradeOptions,
} from "../src/commands/upgrade.js";

describe("resolveDecisionPolicy", () => {
  it("default (sem flags) → policy conservadora (todas false)", () => {
    expect(resolveDecisionPolicy({})).toEqual({
      acceptNew: false,
      overwriteModified: false,
      deleteRemoved: false,
    });
  });

  it("--accept-new sozinho → ativa só acceptNew", () => {
    const opts: UpgradeOptions = { acceptNew: true };
    expect(resolveDecisionPolicy(opts)).toEqual({
      acceptNew: true,
      overwriteModified: false,
      deleteRemoved: false,
    });
  });

  it("--accept-new + --overwrite-modified → ativa os 2 (delete fica false)", () => {
    expect(
      resolveDecisionPolicy({ acceptNew: true, overwriteModified: true }),
    ).toEqual({
      acceptNew: true,
      overwriteModified: true,
      deleteRemoved: false,
    });
  });

  it("--yes legacy → ativa os 3 (alias retrocompatível)", () => {
    expect(resolveDecisionPolicy({ yes: true })).toEqual({
      acceptNew: true,
      overwriteModified: true,
      deleteRemoved: true,
    });
  });

  it("--yes vence sobre flags granulares (sem ambiguidade)", () => {
    // Mesmo se aluno passar --yes + --accept-new (redundante), continua
    // alias dos 3.
    expect(
      resolveDecisionPolicy({
        yes: true,
        acceptNew: true,
        overwriteModified: false,
        deleteRemoved: false,
      }),
    ).toEqual({
      acceptNew: true,
      overwriteModified: true,
      deleteRemoved: true,
    });
  });
});

describe("isAutomatedRun", () => {
  it("default (sem flags) → false (rodada interativa)", () => {
    expect(isAutomatedRun({})).toBe(false);
  });

  it("--yes → true", () => {
    expect(isAutomatedRun({ yes: true })).toBe(true);
  });

  it("--accept-new sozinho → true (skipa prompt geral)", () => {
    expect(isAutomatedRun({ acceptNew: true })).toBe(true);
  });

  it("--overwrite-modified sozinho → true", () => {
    expect(isAutomatedRun({ overwriteModified: true })).toBe(true);
  });

  it("--delete-removed sozinho → true", () => {
    expect(isAutomatedRun({ deleteRemoved: true })).toBe(true);
  });

  it("--dry-run sem flags de automação → false (ainda interativo)", () => {
    expect(isAutomatedRun({ dryRun: true })).toBe(false);
  });
});
