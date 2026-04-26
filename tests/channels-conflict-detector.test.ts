// Tests do channels-conflict-detector (CLI v0.8.2+, V10 do doctor).

import { describe, expect, it } from "vitest";

import { detectChannelsConflict } from "../src/utils/channels-conflict-detector.js";

describe("detectChannelsConflict", () => {
  it("arquivo skeleton padrão (MY_CHANNELS=[] vazio, sem setup_channels) → sem conflito", () => {
    const content = `from __future__ import annotations\nMY_CHANNELS: list = []\n`;
    const result = detectChannelsConflict(content);
    expect(result.hasSetupChannels).toBe(false);
    expect(result.hasNonEmptyMyChannels).toBe(false);
  });

  it("só setup_channels definida (extension layer puro v0.4.0+) → sem conflito", () => {
    const content = `def setup_channels() -> None:
    from channels import register_channel
    register_channel(...)

MY_CHANNELS: list = []
`;
    const result = detectChannelsConflict(content);
    expect(result.hasSetupChannels).toBe(true);
    expect(result.hasNonEmptyMyChannels).toBe(false);
  });

  it("só MY_CHANNELS não-vazio (canal custom do aluno, sem módulos IAxplor migrados) → sem conflito", () => {
    const content = `from agent.telegram_channel import MeuTelegramChannel
MY_CHANNELS = [MeuTelegramChannel(bot_token="x")]
`;
    const result = detectChannelsConflict(content);
    expect(result.hasSetupChannels).toBe(false);
    expect(result.hasNonEmptyMyChannels).toBe(true);
  });

  it("AMBOS presentes (aluno migrou evolution-api mas esqueceu de remover MY_CHANNELS) → CONFLITO", () => {
    const content = `def setup_channels() -> None:
    from channels.evolution import EvolutionChannel, get_or_create_client
    from channels import register_channel
    register_channel(EvolutionChannel(get_or_create_client()))

# Esquecido após migração — provoca registro duplicado:
from channels.evolution import EvolutionChannel
MY_CHANNELS = [EvolutionChannel(...)]
`;
    const result = detectChannelsConflict(content);
    expect(result.hasSetupChannels).toBe(true);
    expect(result.hasNonEmptyMyChannels).toBe(true);
  });

  it("setup_channels async é detectada igual à síncrona", () => {
    const content = `async def setup_channels() -> None:
    pass
MY_CHANNELS = []
`;
    expect(detectChannelsConflict(content).hasSetupChannels).toBe(true);
  });

  it("setup_channels em comentário NÃO é detectada", () => {
    const content = `# Exemplo: def setup_channels() -> None:
MY_CHANNELS: list = []
`;
    expect(detectChannelsConflict(content).hasSetupChannels).toBe(false);
  });
});
