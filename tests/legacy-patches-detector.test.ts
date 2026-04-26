// Tests do legacy-patches-detector (CLI v0.8.1+, US-6).

import { describe, expect, it } from "vitest";

import {
  detectEvolutionInApiMain,
  detectEvolutionInArqWorker,
  detectEvolutionInCoreConfig,
} from "../src/utils/legacy-patches-detector.js";

describe("detectEvolutionInCoreConfig", () => {
  it("config sem patches → 0 findings", () => {
    const content = `class Settings(BaseSettings):
    database_url: str
    redis_url: str
`;
    expect(detectEvolutionInCoreConfig(content)).toEqual([]);
  });

  it("config com evolution_url declarado → 1 finding com hint MySettings", () => {
    const content = `class Settings(BaseSettings):
    database_url: str
    evolution_url: str | None = None
    evolution_api_key: str | None = None
`;
    const findings = detectEvolutionInCoreConfig(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("core/config.py");
    expect(findings[0]?.hint).toContain("agent/config.py:MySettings");
  });

  it("comentário com 'evolution_url' NÃO conta como patch", () => {
    const content = `class Settings(BaseSettings):
    # exemplo de campo: evolution_url: str | None = None
    database_url: str
`;
    expect(detectEvolutionInCoreConfig(content)).toEqual([]);
  });
});

describe("detectEvolutionInApiMain", () => {
  it("api/main.py limpo → 0 findings", () => {
    const content = `from fastapi import FastAPI
app = FastAPI()
`;
    expect(detectEvolutionInApiMain(content)).toEqual([]);
  });

  it("import de channels.evolution + include_router → 2 findings", () => {
    const content = `from channels.evolution import EvolutionChannel, EvolutionClient
from fastapi import FastAPI

app = FastAPI()
app.include_router(evolution_webhook_router)
app.include_router(evolution_api_router)
`;
    const findings = detectEvolutionInApiMain(content);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining("import de channels.evolution"),
      expect.stringContaining("include_router(evolution_*)"),
    ]);
  });
});

describe("detectEvolutionInArqWorker", () => {
  it("worker limpo → 0 findings", () => {
    const content = `from arq.connections import RedisSettings

class WorkerSettings:
    functions = []
`;
    expect(detectEvolutionInArqWorker(content)).toEqual([]);
  });

  it("process_evolution_media + ctx['evolution_client'] → 2 findings", () => {
    const content = `from workers.tasks.evolution_process_media import process_evolution_media

class WorkerSettings:
    functions = [process_evolution_media]

async def on_startup(ctx):
    ctx["evolution_client"] = EvolutionClient(...)
`;
    const findings = detectEvolutionInArqWorker(content);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.hint)).toEqual([
      expect.stringContaining("agent/workers_extensions.py"),
      expect.stringContaining("get_or_create_client"),
    ]);
  });
});
