// Detector de conflito entre `MY_CHANNELS` legacy (core ≤ 0.6.x) e
// `setup_channels()` novo (core 0.7.0+) no mesmo projeto. CLI v0.8.2+.
//
// Cenário típico: aluno migrou evolution-api 0.3.x → 0.4.0 (que usa
// setup_channels) MAS esqueceu de remover MY_CHANNELS = [...] antigo. Como
// o registry de channels é idempotente (overwrite silencioso), tudo
// funciona — mas ambos rodam e fica confuso pra debug futuro. Doctor V10
// alerta com warn pra aluno limpar.
//
// Pure: zero I/O. Caller (doctor V10) lê o arquivo e chama esta função.

export interface ChannelsConflict {
  hasSetupChannels: boolean;
  hasNonEmptyMyChannels: boolean;
}

/** Analisa conteúdo de `agent/channels_extensions.py` procurando os 2
 *  pontos de extensão coexistindo. Retorna flags pra caller decidir
 *  severidade da mensagem. */
export function detectChannelsConflict(content: string): ChannelsConflict {
  // setup_channels: função top-level (def síncrona ou async). Match não-greedy
  // pra cobrir ambas formas. Não pega comentários (regex exige início de linha).
  const setupRe = /^(?:async\s+)?def\s+setup_channels\s*\(/m;
  const hasSetupChannels = setupRe.test(content);

  // MY_CHANNELS não-vazio: lista com pelo menos 1 item entre []. Aceita
  // multi-linha. Lista vazia explícita (`MY_CHANNELS = []`) NÃO é conflito —
  // é o skeleton padrão do core.
  const myChannelsRe = /^MY_CHANNELS\s*(?::\s*[^=]+)?\s*=\s*\[\s*([^\]\s])/m;
  const hasNonEmptyMyChannels = myChannelsRe.test(content);

  return { hasSetupChannels, hasNonEmptyMyChannels };
}
