// Tests do version-drift-detector (CLI v0.9.0+, doctor V14).

import { describe, expect, it } from "vitest";

import {
  _internals,
  detectVersionDrift,
  extractDepEntry,
  extractLockedVersion,
} from "../src/utils/version-drift-detector.js";

const { extractConstraint, extractUpperBound, isVersionBelow } = _internals;

describe("extractDepEntry", () => {
  it("retorna entry bruta pro pacote pedido", () => {
    const content = `[project]
dependencies = [
    "agno>=2.6.4,<2.7",
    "fastapi>=0.115,<0.120",
]
`;
    expect(extractDepEntry(content, "agno")).toBe("agno>=2.6.4,<2.7");
    expect(extractDepEntry(content, "fastapi")).toBe("fastapi>=0.115,<0.120");
  });

  it("retorna null se pacote ausente", () => {
    const content = `[project]\ndependencies = ["fastapi>=0.115"]\n`;
    expect(extractDepEntry(content, "agno")).toBeNull();
  });

  it("retorna null se pyproject malformado", () => {
    expect(extractDepEntry("not-toml{{{", "agno")).toBeNull();
  });

  it("normaliza case do pacote pedido", () => {
    const content = `[project]\ndependencies = ["Agno>=2.6.4,<2.7"]\n`;
    // Lookup com lowercase deve achar "Agno" (parseDep normaliza pra agno)
    expect(extractDepEntry(content, "agno")).toBe("Agno>=2.6.4,<2.7");
  });
});

describe("extractLockedVersion", () => {
  it("extrai versão do uv.lock", () => {
    const content = `version = 1
revision = 3

[[package]]
name = "agno"
version = "2.6.4"

[[package]]
name = "fastapi"
version = "0.119.2"
`;
    expect(extractLockedVersion(content, "agno")).toBe("2.6.4");
    expect(extractLockedVersion(content, "fastapi")).toBe("0.119.2");
  });

  it("retorna null se pacote ausente do lock", () => {
    const content = `[[package]]\nname = "fastapi"\nversion = "0.119.0"\n`;
    expect(extractLockedVersion(content, "agno")).toBeNull();
  });

  it("retorna null se uv.lock malformado", () => {
    expect(extractLockedVersion("not-toml{{{", "agno")).toBeNull();
  });
});

describe("extractConstraint / extractUpperBound / isVersionBelow", () => {
  it("extractConstraint pega só a parte da versão", () => {
    expect(extractConstraint("agno>=2.6.4,<2.7")).toBe(">=2.6.4,<2.7");
    expect(extractConstraint("agno")).toBe("");
  });

  it("extractUpperBound pega o cap superior", () => {
    expect(extractUpperBound(">=2.6.4,<2.7")).toBe("2.7");
    expect(extractUpperBound(">=2.6.4")).toBeNull();
    expect(extractUpperBound(">=2.0,<2.1")).toBe("2.1");
  });

  it("isVersionBelow compara semver corretamente", () => {
    expect(isVersionBelow("2.6.4", "2.7")).toBe(true);
    expect(isVersionBelow("2.6.99", "2.7")).toBe(true);
    expect(isVersionBelow("2.7.0", "2.7")).toBe(false);
    expect(isVersionBelow("2.7.0", "2.7.0")).toBe(false);
    expect(isVersionBelow("3.0.0", "2.7")).toBe(false);
  });
});

describe("detectVersionDrift", () => {
  const TEMPLATE_PYPROJECT = `[project]
dependencies = [
    "agno>=2.6.4,<2.7",
    "fastapi>=0.115,<0.120",
]
`;

  it("zero drift: ranges batem + lock dentro do range", () => {
    const localPyproject = TEMPLATE_PYPROJECT;
    const localLock = `[[package]]\nname = "agno"\nversion = "2.6.4"\n`;
    const findings = detectVersionDrift({
      localPyproject,
      localLock,
      expectedPyproject: TEMPLATE_PYPROJECT,
    });
    expect(findings).toEqual([]);
  });

  it("range drift: aluno em range antigo", () => {
    const localPyproject = `[project]
dependencies = ["agno>=2.5.17"]
`;
    const findings = detectVersionDrift({
      localPyproject,
      localLock: null,
      expectedPyproject: TEMPLATE_PYPROJECT,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pkg).toBe("agno");
    expect(findings[0]?.kind).toBe("range-drift");
    expect(findings[0]?.local).toBe("agno>=2.5.17");
    expect(findings[0]?.expected).toBe("agno>=2.6.4,<2.7");
    expect(findings[0]?.message).toContain("upgrade core");
  });

  it("lock drift: lock aponta versão acima do upper bound do template", () => {
    const localPyproject = TEMPLATE_PYPROJECT; // range bate
    const localLock = `[[package]]\nname = "agno"\nversion = "2.7.1"\n`; // mas lock está fora
    const findings = detectVersionDrift({
      localPyproject,
      localLock,
      expectedPyproject: TEMPLATE_PYPROJECT,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pkg).toBe("agno");
    expect(findings[0]?.kind).toBe("lock-drift");
    expect(findings[0]?.local).toBe("2.7.1");
    expect(findings[0]?.message).toContain("uv.lock");
    expect(findings[0]?.message).toContain("upgrade-package");
  });

  it("agno ausente do pyproject local: warna como range-drift", () => {
    const localPyproject = `[project]\ndependencies = ["fastapi>=0.115"]\n`;
    const findings = detectVersionDrift({
      localPyproject,
      localLock: null,
      expectedPyproject: TEMPLATE_PYPROJECT,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.local).toBe("(ausente)");
  });

  it("ambos drifts simultâneos (range velho + lock acima)", () => {
    const localPyproject = `[project]\ndependencies = ["agno>=2.5.17"]\n`;
    const localLock = `[[package]]\nname = "agno"\nversion = "2.7.0"\n`;
    const findings = detectVersionDrift({
      localPyproject,
      localLock,
      expectedPyproject: TEMPLATE_PYPROJECT,
    });
    // 1 range-drift (range velho) + 0 lock-drift (porque expected constraint
    // local é ">=2.5.17" sem upper bound — não dá pra avaliar drift do lock).
    // Mas comparamos contra expectedConstraint do TEMPLATE, que tem upper bound.
    // Então deve detectar AMBOS.
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("range-drift");
    expect(kinds).toContain("lock-drift");
  });
});
