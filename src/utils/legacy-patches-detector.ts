// Detector de patches legados de módulos pre-extension-layer (CLI v0.8.1+).
//
// Contexto: até evolution-api v0.3.x, o módulo patcheava 3 arquivos do core
// (api/main.py, workers/arq_worker.py, core/config.py). A v0.4.0 elimina
// isso (extension layer puro) — mas aluno legado precisa MOVER os patches
// pra agent/* manualmente. Esse helper detecta resíduos via grep.
//
// Pure: zero I/O. Recebe content como string, retorna findings. Caller
// (doctor V9) lê os arquivos e chama estas funções.

/** Tipo de finding usado pelo doctor (alinhado com `Finding` em doctor.ts). */
export interface LegacyPatchFinding {
  file: string;
  message: string;
  hint: string;
}

/** Detecta resíduos de evolution-api 0.3.x em `core/config.py`. */
export function detectEvolutionInCoreConfig(
  content: string,
): LegacyPatchFinding[] {
  // Match linha começando com `evolution_url:` (campo de Settings) — não
  // pega comments ou strings.
  const re = /^\s*evolution_url\s*:\s*str/m;
  if (!re.test(content)) return [];
  return [
    {
      file: "core/config.py",
      message:
        "campos evolution_* declarados no Settings do core (legado v0.3.x)",
      hint: "mover pra agent/config.py:MySettings (ver MIGRATION_v0.4.0.md)",
    },
  ];
}

/** Detecta resíduos em `api/main.py` (registro do EvolutionChannel no
 *  lifespan + include_router de webhook/admin). */
export function detectEvolutionInApiMain(
  content: string,
): LegacyPatchFinding[] {
  const findings: LegacyPatchFinding[] = [];
  // Import direto do módulo no api/main.py é o sinal mais forte.
  if (/from\s+channels\.evolution\s+import/m.test(content)) {
    findings.push({
      file: "api/main.py",
      message:
        "import de channels.evolution detectado (registro legado do canal)",
      hint:
        "mover register_channel + register_outbound_channel pra " +
        "agent/channels_extensions.py:setup_channels()",
    });
  }
  if (/include_router\s*\(\s*evolution_/.test(content)) {
    findings.push({
      file: "api/main.py",
      message:
        "include_router(evolution_*) detectado (router do módulo no core)",
      hint:
        "mover pra agent/api_extensions.py:router via router.include_router(...)",
    });
  }
  return findings;
}

/** Detecta resíduos em `workers/arq_worker.py` (process_evolution_media na
 *  lista functions + ctx['evolution_client'] no on_startup). */
export function detectEvolutionInArqWorker(
  content: string,
): LegacyPatchFinding[] {
  const findings: LegacyPatchFinding[] = [];
  if (/process_evolution_media/.test(content)) {
    findings.push({
      file: "workers/arq_worker.py",
      message:
        "process_evolution_media referenciado (legado, módulo patchava functions)",
      hint:
        "mover pra agent/workers_extensions.py:MY_TASKS = [process_evolution_media]",
    });
  }
  if (/ctx\s*\[\s*['"]evolution_client['"]\s*\]/.test(content)) {
    findings.push({
      file: "workers/arq_worker.py",
      message:
        "ctx['evolution_client'] detectado (cliente injetado via patch legado)",
      hint:
        "remover — em v0.4.0 o cliente é singleton via channels.evolution.get_or_create_client()",
    });
  }
  return findings;
}
