// Tests do circular-import-detector (CLI v0.8.4+, doctor V11).

import { describe, expect, it } from "vitest";

import {
  extractAutoImportedModules,
  findTopLevelCoreImports,
} from "../src/utils/circular-import-detector.js";

describe("extractAutoImportedModules", () => {
  it("db/models/__init__.py vazio → 0 módulos", () => {
    expect(extractAutoImportedModules("")).toEqual([]);
  });

  it("apenas Customer/OutboundMessage (sem módulos opcionais) → 0 módulos", () => {
    const content = `from db.models.customer import Customer  # noqa: F401
from db.models.outbound_message import OutboundMessage  # noqa: F401
`;
    expect(extractAutoImportedModules(content)).toEqual([]);
  });

  it("auto-import de gcal (try/except indentado) detectado", () => {
    const content = `from db.models.customer import Customer

try:
    from integrations.google_calendar.models import CalendarEvent
except ModuleNotFoundError:
    pass
`;
    expect(extractAutoImportedModules(content)).toEqual([
      "integrations/google_calendar",
    ]);
  });

  it("múltiplos módulos auto-importados (gcal + channel hipotético)", () => {
    const content = `try:
    from integrations.google_calendar.models import CalendarEvent
except ModuleNotFoundError:
    pass
try:
    from channels.evolution.models import EvolutionMessage
except ModuleNotFoundError:
    pass
`;
    expect(extractAutoImportedModules(content)).toEqual([
      "channels/evolution",
      "integrations/google_calendar",
    ]);
  });

  it("comentário com 'from integrations.X' NÃO é detectado", () => {
    const content = `# Exemplo: from integrations.google_calendar.models import CalendarEvent
from db.models.customer import Customer
`;
    expect(extractAutoImportedModules(content)).toEqual([]);
  });
});

describe("findTopLevelCoreImports — só submódulos RISKY (que tocam db.models)", () => {
  it("arquivo sem imports de core → 0", () => {
    const content = `from typing import Any\n`;
    expect(findTopLevelCoreImports(content)).toEqual([]);
  });

  it("`from core.logger` no topo NÃO conta (seguro — não importa db)", () => {
    const content = `from core.logger import logger\n`;
    expect(findTopLevelCoreImports(content)).toEqual([]);
  });

  it("`from core.outbound` no topo CONTA (importa db.models.customer → ciclo)", () => {
    const content = `from core.outbound import cancel_scheduled\n`;
    expect(findTopLevelCoreImports(content)).toEqual(["outbound"]);
  });

  it("`from core.customers` no topo CONTA (importa db.models.customer → ciclo)", () => {
    const content = `from core.customers import find_by_phone\n`;
    expect(findTopLevelCoreImports(content)).toEqual(["customers"]);
  });

  it("import lazy DENTRO de função (indentado) → IGNORADO mesmo se RISKY", () => {
    const content = `def foo() -> None:
    from core.outbound import send_to_customer
    return None
`;
    expect(findTopLevelCoreImports(content)).toEqual([]);
  });

  it("mix: RISKY top-level + seguros + lazy → só RISKY top-level conta", () => {
    const content = `from core.logger import logger
from core.config import get_settings
from core.outbound import cancel_scheduled

def bar() -> None:
    from core.customers import find_by_phone
    return None
`;
    expect(findTopLevelCoreImports(content)).toEqual(["outbound"]);
  });

  it("`from core` puro (sem submódulo) NÃO captura", () => {
    const content = `from core import something\n`;
    expect(findTopLevelCoreImports(content)).toEqual([]);
  });
});
