// Health checks runtime opt-in (CLI v0.8.6+, doctor V13).
//
// Diferente de V1-V12 (estático + manifest fetch via giget), V13 faz
// network call REAL contra a infra do aluno (Evolution API, etc.) — só
// roda quando aluno passa `doctor --health` explicitamente. Pega cenário
// "produção em loop de erro" antes do worker subir e gastar reconnects.
//
// Pure-ish: faz HTTP fetch (Node 20+ nativo). Timeout curto (5s) pra
// não travar doctor se host está fora.

const DEFAULT_TIMEOUT_MS = 5000;

export interface HealthResult {
  /** `true` se o serviço respondeu E está em estado saudável. */
  ok: boolean;
  /** Categoria: "ok" | "degraded" (responde mas estado ruim) | "unreachable" (sem resposta). */
  status: "ok" | "degraded" | "unreachable";
  /** Mensagem humano-lida pra log do doctor. Sempre populada. */
  message: string;
}

/** Health check da Evolution API: GET `/instance/connectionState/<name>`.
 *
 *  Retorno esperado da Evolution: `{instance: {state: "open" | "connecting"
 *  | "close"}}`. Estado `open` = conectado ao WhatsApp; outros = degradado
 *  (precisa intervenção pra reconectar).
 *
 *  Erros tratados:
 *    - Timeout (5s) → "unreachable"
 *    - Connection refused / DNS / SSL → "unreachable"
 *    - 401/403 (apiKey errada) → "unreachable" + msg específica
 *    - 5xx → "unreachable" + status
 *    - Body sem `instance.state` → "degraded"
 *    - state !== "open" → "degraded"
 */
export async function checkEvolutionHealth(opts: {
  url: string;
  apiKey: string;
  instanceName: string;
  timeoutMs?: number;
}): Promise<HealthResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${opts.url.replace(/\/$/, "")}/instance/connectionState/${opts.instanceName}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { apikey: opts.apiKey },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: "unreachable",
        message: `Evolution rejeitou autenticação (HTTP ${response.status}) — verifique EVOLUTION_API_KEY`,
      };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        status: "unreachable",
        message: `Evolution server error (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: "unreachable",
        message: `Evolution respondeu HTTP ${response.status} — instance '${opts.instanceName}' existe?`,
      };
    }

    const body = (await response.json()) as { instance?: { state?: string } };
    const state = body.instance?.state;
    if (!state) {
      return {
        ok: false,
        status: "degraded",
        message: `Evolution respondeu mas sem campo 'instance.state' — schema inesperado`,
      };
    }
    if (state !== "open") {
      return {
        ok: false,
        status: "degraded",
        message: `Evolution acessível mas estado='${state}' (esperado 'open' — WhatsApp desconectado?)`,
      };
    }
    return {
      ok: true,
      status: "ok",
      message: `Evolution acessível, instance '${opts.instanceName}' state=open`,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "AbortError") {
      return {
        ok: false,
        status: "unreachable",
        message: `Evolution timeout após ${timeout}ms — host inacessível?`,
      };
    }
    return {
      ok: false,
      status: "unreachable",
      message: `Evolution unreachable: ${name}: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
