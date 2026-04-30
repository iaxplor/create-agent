# `@iaxplor/create-agent` — CHANGELOG

CLI da IAxplor pra criar projetos de agente IA e gerenciar módulos opcionais. Histórico de releases, breaking changes e features. Mais recente no topo.

---

## v0.9.0 — Doctor V14: drift de versão de deps críticas (Fase 3 do versionamento determinístico)

Continua o trabalho do agent-templates v0.11.9 (upper bounds — Fase 1) e v0.12.0 (lockfile distribuído + Dockerfile `--frozen` — Fase 2). Esta release entrega a Fase 3: validator no `doctor` que detecta se aluno tem `pyproject.toml` ou `uv.lock` divergente das versões testadas pelo CI da IAxplor.

### Adicionado

- **`src/utils/version-drift-detector.ts`** — helper read-only que detecta 2 tipos de drift de versão de pacotes monitorados (hoje só `agno`):
  - **range-drift**: `pyproject.toml` local declara range diferente do range esperado pelo template (ex.: aluno em projeto antigo com `agno>=2.5.17` vs template novo com `agno>=2.6.4,<2.7`)
  - **lock-drift**: versão exata no `uv.lock` está fora do upper bound testado (ex.: aluno fez `uv lock --upgrade-package agno` e pegou `2.7.0`, mas template só validou até `2.6.x`)
- **Doctor V14** (`checkVersionDrift` em `src/commands/doctor.ts`) — integra o detector, reusa o snapshot do core já baixado pelo V3/V4. Roda automaticamente em `npx create-agent doctor`.
- **15 cases de tests** em `tests/version-drift-detector.test.ts` (cobertura de extract, parse, compare, drift detection).

### Comportamento

V14 é **warn-only** (não bloqueia exit code). Aluno avançado pode escolher conscientemente usar versão mais nova; o doctor só sinaliza que é responsabilidade dele.

Saída típica quando há drift de range:

```
deps × template (V14) — agno
  ⚠ Range do agno no seu projeto (`agno>=2.5.17`) difere do range testado
    pelo template IAxplor (`agno>=2.6.4,<2.7`). Considere
    `npx create-agent upgrade core` pra alinhar.
```

Saída quando tudo bate:

```
deps × template (V14)
  ✓ ranges + lock alinhados com versões testadas pelo template
```

### Pré-requisitos do projeto pra V14 funcionar

- `pyproject.toml` presente no projeto (criado pelo `npx create-agent`)
- `uv.lock` opcional — se presente, V14 também valida versão exata vs upper bound

### Out of scope

- **Outros pacotes monitorados**: hoje a lista (`MONITORED_DEPS` no detector) é só `["agno"]`. Adicionar `fastapi`, `pydantic`, etc. é trivial — só adicionar à constante. Foi mantido conservador pra evitar warns false-positive em deps que ainda não tiveram histórico de breaking change real.
- **Comparação semver completa**: comparação de range hoje é string-equality (`>=2.6.4,<2.7` vs `>=2.6.4, <2.7` com espaço diferem). Iteração futura pode usar parser semver pra ignorar diferenças cosméticas.
- **Auto-fix**: V14 só warna. Não roda `uv lock --upgrade-package` automático. Decisão: aluno deve aprovar mudança de versão consciente.

---

## v0.8.x — Histórico anterior

Release notes de versões anteriores (v0.8.0 a v0.8.6) estão registradas no commit history e nas tags Git. Daqui em diante toda release nova ganha entry neste arquivo.

Principais marcos do range v0.8.x:

- **v0.8.0** (US-1): categoria PROTECTED em `agent/*` — upgrades nunca sobrescrevem código do aluno
- **v0.8.1**: Doctor V9 — detecta patches legados de módulos pre-extension-layer
- **v0.8.2**: Doctor V10 — detecta uso simultâneo de `MY_CHANNELS` legacy e `setup_channels()` novo
- **v0.8.3**: extension_loader detecta atributos opcionais sem warnings espúrios
- **v0.8.4**: Doctor V11 — detecta padrão de import circular potencial entre módulo + core
- **v0.8.5**: Doctor V12 — detecta deps de módulos ausentes no `pyproject.toml`
- **v0.8.6**: Doctor V13 (opt-in `--health`) — health check runtime contra Evolution API
