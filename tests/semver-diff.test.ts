// Tests pro `severityOfBump` — classificação semver de major/minor/patch.

import { describe, expect, it } from "vitest";

import { severityOfBump } from "../src/utils/semver-diff.js";

describe("severityOfBump", () => {
  it.each([
    ["1.0.0", "1.0.1", "patch"],
    ["1.0.0", "1.1.0", "minor"],
    ["1.0.0", "2.0.0", "major"],
    ["0.4.0", "0.4.1", "patch"],
    ["0.5.0", "0.6.0", "minor"],
    ["0.6.0", "1.0.0", "major"],
    // Pre-release metadata é descartada pelo parseSemver — bump conta só
    // os dígitos X.Y.Z.
    ["1.0.0", "1.0.1-rc.1", "patch"],
    ["1.0.0", "2.0.0+build.1", "major"],
  ] as const)("severityOfBump(%s, %s) → %s", (installed, available, expected) => {
    expect(severityOfBump(installed, available)).toBe(expected);
  });

  it.each([
    // Versões iguais — sem bump.
    ["1.0.0", "1.0.0"],
    ["0.6.0", "0.6.0"],
    // Downgrade — não badgeamos (caller só chama quando hasUpdate=true,
    // mas garantimos comportamento defensivo).
    ["2.0.0", "1.0.0"],
    ["1.5.0", "1.4.9"],
  ] as const)("severityOfBump(%s, %s) → null (sem bump)", (installed, available) => {
    expect(severityOfBump(installed, available)).toBeNull();
  });
});
