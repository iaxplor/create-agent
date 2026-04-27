# `@iaxplor/create-agent`

CLI para criar projetos Python de agente de IA (FastAPI + Postgres + Redis + Agno) a partir do template `core` em [`iaxplor/agent-templates`](https://github.com/iaxplor/agent-templates). Otimizado para agentes de atendimento via WhatsApp com deploy em Docker Compose.

## Comandos

### `create <nome>` — criar novo projeto

```bash
npx @iaxplor/create-agent meu-agente
```

O CLI vai:

1. Validar o nome do projeto
2. Baixar o template `core` direto do GitHub
3. Gerar `agente.config.json` (metadados do projeto)
4. Rodar `git init` na pasta criada
5. Mostrar os próximos passos (configurar `.env`, criar repo no GitHub, deploy)

Após criação, configure as variáveis de ambiente (`.env`) e faça o deploy da forma que preferir.

**Regras de nome do projeto:**

- Entre **3 e 50 caracteres**
- Apenas **letras minúsculas, números e hífen** (ex.: `meu-agente-01`)
- Não pode começar ou terminar com hífen, nem ter hífen duplo consecutivo

### `add <module>` — instalar módulo em projeto existente

```bash
cd meu-agente
npx @iaxplor/create-agent add evolution-api
```

O comando:

1. Verifica que o diretório atual é um projeto IAxplor (existência de `agente.config.json`)
2. Baixa `modules/<module>/` do repo `iaxplor/agent-templates`
3. Valida compatibilidade de versão (módulo declara `min_core_version`)
4. Detecta conflitos (arquivos que já existem no projeto) e pede confirmação
5. Copia os arquivos conforme o mapping declarado no `template.json` do módulo
6. Atualiza `agente.config.json.modules` com o registro da instalação
7. Imprime patches manuais necessários, env vars requeridas e dependências Python pra adicionar no `pyproject.toml`

**Opções:**

- `--dry-run` — mostra o plano sem copiar nem modificar nada
- `--yes` — aceita automaticamente sobrescrever arquivos em conflito (útil em CI)
- `--template-source <url>` — override do repo base (default: `github:iaxplor/agent-templates`)

**Automações aplicadas automaticamente** (v0.3.0+):

1. **`.env.example`**: adiciona bloco delimitado com as env vars do módulo (defaults preenchidos, obrigatórias vazias). Re-instalação de versão diferente **substitui** o bloco antigo — nunca duplica. Vars que já existem fora do bloco geram warning.
2. **`pyproject.toml`**: adiciona as dependências Python novas em `[project].dependencies` preservando comentários e formato. Deps já presentes são puladas; conflitos de versão geram warning **sem** sobrescrever.
3. **`agente.config.json`**: registra o módulo instalado em `modules.<name>`.

**Patches manuais**: o CLI **não** modifica automaticamente arquivos existentes do projeto (`api/main.py`, `workers/arq_worker.py`, `core/config.py`). Cada módulo documenta seus patches em um arquivo `<NOME>_SETUP.md` que é copiado junto. A mensagem final do comando inclui um prompt pronto pra colar em IDE com IA (Cursor, Claude Code, Copilot) — aplica os patches em 1 comando.

### `list` — listar versões e atualizações disponíveis

```bash
cd meu-agente
npx @iaxplor/create-agent list
```

Read-only. Consulta `agente.config.json` local e compara com as versões mais recentes no repositório de templates. Mostra tabela com **severity badges** (v0.7.0+) — `(patch)` cinza pra bug fix, `(minor)` amarelo pra feature nova, `(major)` vermelho pra breaking change. Calibra urgência sem precisar abrir o CHANGELOG:

```
core            0.5.0 → 0.6.0  (atualização disponível)  (minor)
evolution-api   0.3.0 → 0.4.0  (atualização disponível)  (minor)
google-calendar 0.4.0 → 0.4.1  (atualização disponível)  (patch)
```

Se tudo estiver em dia, mostra `✅ Tudo atualizado.`

### `doctor` — diagnóstico read-only do projeto _(v0.6.0+)_

```bash
cd meu-agente
npx @iaxplor/create-agent doctor
```

Validador read-only que cruza `agente.config.json` com o estado real do projeto. Reporta findings agrupados por seção, com sumário no final. **Sempre exit 0** — informativo, não CI gate.

Roda 4 verificações:

| # | Categoria | Detecta |
|---|-----------|---------|
| **V1** | Estrutura de `agente.config.json` | Campos obrigatórios ausentes, semver inválido em `coreVersion` ou `module.version` |
| **V2** | Versões disponíveis | Core ou módulos com atualização pendente (reusa `list`) |
| **V3** | `min_core_version` | Módulo instalado requer core mais novo do que o do projeto (raro, indica edição manual ou downgrade do core) |
| **V4** | Env vars `required` | Vars `required: true` no `template.json` ausentes no `.env.example` |
| **V8** _(v0.8.0+)_ | `agent/*.template` pendentes | Arquivos `.template` gerados por upgrade PROTECTED esperando revisão manual |
| **V9** _(v0.8.1+)_ | Patches legados em `core/api/workers` | Resíduos de módulos pre-extension-layer (ex.: evolution-api ≤ 0.3.x). Hint pra MIGRATION_v0.4.0.md |
| **V10** _(v0.8.2+)_ | Conflito `MY_CHANNELS` + `setup_channels()` | Migração incompleta — registro duplicado silencioso. Hint pra zerar `MY_CHANNELS=[]` |
| **V11** _(v0.8.4+)_ | Ciclo potencial módulo ↔ core | Módulo auto-importado em `db/models/__init__.py` + `from core.X import` no top-level → bloqueio no boot. Hint pra lazy import |
| **V12** _(v0.8.5+)_ | Deps de módulos × `pyproject.toml` | Deps declaradas em `manifest.dependencies` ausentes em `pyproject.toml` (silent break após `upgrade core --overwrite-modified`). Hint: `npx create-agent add <module>` (idempotente) |

Output exemplo:

```
agente.config.json
  ✓ estrutura válida

core 0.6.0
  ✓ última versão

google-calendar 0.4.0
  ⚠ atualização disponível: 0.4.1 (rode 'create-agent upgrade google-calendar')
  ✓ compatível com core 0.6.0 (requer >= 0.5.0)

.env.example (google-calendar)
  ✗ GCAL_CLIENT_ID (required) ausente no .env.example
  ✗ GCAL_CLIENT_SECRET (required) ausente no .env.example

────────────────────────────────────────
2 erro(s), 1 warning(s), 4 OK
```

**Out of scope v0.6.0** (vira `doctor v2`): modelos SQLModel não registrados em `db/models/__init__.py` (precisa AST), tools de módulo não importadas em `agent/agent.py` (precisa metadata futura), migrations pendentes (precisa DB up).

**Opções:**

- `--template-source <url>` — override do repo base
- `--strict` _(v0.7.0+)_ — modo CI gate: exit 1 se há findings de nível `error`. Warnings continuam exit 0. Útil em Github Actions:

  ```yaml
  - run: npx -y @iaxplor/create-agent@latest doctor --strict
    working-directory: ./meu-bot
  ```

### `upgrade [target]` — atualizar core ou módulo

```bash
# Atualizar tudo (core + módulos) em sequência
npx @iaxplor/create-agent upgrade

# Só o core
npx @iaxplor/create-agent upgrade core

# Só um módulo
npx @iaxplor/create-agent upgrade evolution-api

# Core + todos os módulos (igual ao default)
npx @iaxplor/create-agent upgrade all
```

O comando:

1. Valida que é projeto IAxplor (`agente.config.json`)
2. Baixa snapshots da versão instalada e da nova via git tags (`v0.1.0`, `v0.2.0`, etc.)
3. **(Módulos, v0.5.0+)** Valida `min_core_version` da nova versão contra o core instalado — prompt cancelável se incompatível
4. Pra cada arquivo do core/módulo, classifica: novo, inalterado, modificado localmente, deletado upstream
5. Prompta o usuário pra arquivos modificados: `[S]obrescrever / [M]anter / [D]iff`
6. **(v0.5.0+)** Detecta migrations Alembic novas no plano e avisa pra rodar `uv run alembic upgrade head` após o upgrade
7. Oferece backup via `git stash push` antes de aplicar
8. Aplica mudanças + atualiza `agente.config.json.coreVersion`
9. **(v0.5.0+)** Propaga `env_vars` da nova versão pro `.env.example` (paridade com `add`)
10. **(v0.5.0+, módulos)** Propaga `dependencies` da nova versão pro `pyproject.toml` (paridade com `add`)
11. **(v0.5.0+, módulos)** Re-exibe `patches[]` se a descrição mudou entre versões (added/removed/changed)
12. Mostra warnings sobre módulos afetados (patches manuais sobrescritos)

**Opções:**

- `--dry-run` — mostra plano sem aplicar
- `--yes` _(legacy)_ — alias pra `--accept-new --overwrite-modified --delete-removed`. Mantido por retrocompatibilidade
- `--accept-new` _(v0.8.0+)_ — aceita arquivos NOVOS sem prompt. Não afeta arquivos modificados localmente. **Default seguro pra CI**
- `--overwrite-modified` _(v0.8.0+)_ — força overwrite em arquivos `modified-locally`. **PERIGOSO** — perde customizações
- `--delete-removed` _(v0.8.0+)_ — força delete em arquivos que sumiram do template
- `--no-stash` — pula prompt de git stash
- `--template-source <url>` — override do repo base
- `--check` _(v0.7.0+)_ — modo dry-run: lista atualizações pendentes, exit 1 se há (CI gate)

**Categorias de proteção (CLI v0.8.0+)** — o upgrade trata arquivos diferente conforme localização:

| Categoria | Comportamento | Exemplos |
|---|---|---|
| **PROTECTED** | NUNCA tocado pelo upgrade. Se template difere, gera `<arquivo>.template` lateral pra revisão manual | `agent/instructions.py`, `agent/agent.py`, `agent/tools/*` |
| **MERGED** | Merge custom append-only + security baseline (.gitignore) ou dedup automático (.env.example) | `.gitignore`, `.env.example` |
| **TRACKED** (default) | 3-way merge tradicional com prompt em arquivos modificados | `core/*`, `db/*`, `api/*`, `workers/*` |

**Modo degradado**: se a tag da versão instalada não existir no repositório, o CLI opera sem snapshot base — qualquer arquivo diferente da nova versão é marcado como "modificado". Gera falsos positivos mas é seguro (nada é sobrescrito sem confirmação).

> **Nota v0.5.0**: até v0.4.x, o `upgrade` não chamava 3 dos 4 utilitários que `add` chama (env vars, deps, validação `min_core_version`). Quando google-calendar 0.4.0 introduziu 4 env vars novas (`GCAL_CONFIRMATION_*`), o bug ficou visível. v0.5.0 fecha essa paridade — `add` e `upgrade` agora têm o mesmo comportamento de propagação.

> **Nota v0.6.0**: comando `doctor` adicionado (read-only, sempre exit 0).

> **Nota v0.7.0**: 3 melhorias agrupadas — `doctor --strict` + `upgrade --check` (CI gates) + severity badges no `list` (`major`/`minor`/`patch`).

> ⚠️ **Nota v0.8.0 — Safe Upgrade (BREAKING SOFT)**: o `upgrade` agora protege `agent/*` (zona do aluno) E o `.gitignore` (security baseline). Mudanças visíveis:
>
> - **`agent/*` PROTECTED**: `upgrade --yes` NÃO sobrescreve mais arquivos em `agent/`. Se template do core trouxe atualizações, gera `<arquivo>.template` lateral. Comando `doctor` (V8) lembra dos pendentes.
> - **`.gitignore` MERGED + security baseline**: append-only (preserva linhas custom do aluno) + reinjeta `credentials.json`/`client_secret_*.json`/`*.pem`/`*.key`/etc. mesmo se foram removidos.
> - **`.env.example` dedup automático**: `add` e `upgrade` agora REMOVEM ocorrências duplicadas das vars do bloco gerenciado fora dele. Sem mais 38 ocorrências de `DOMAIN` em 167 linhas.
> - **`--yes` SPLIT** em 3 flags granulares: `--accept-new` (seguro, default em CI), `--overwrite-modified` (explícito, perigoso), `--delete-removed` (explícito). `--yes` legacy = alias dos 3 (compat).
> - **Recovery**: se você foi vítima de upgrade que apagou `agent/instructions.py` em versão anterior, recupere via `git log --oneline -- agent/instructions.py` + `git checkout <hash>~1 -- agent/instructions.py`. Stash automático antes do upgrade continua funcionando: `git stash list` + `git stash apply`.
>
> Follow-ups: `doctor v2` (modelos não registrados, tools não importadas, migrations pendentes), `--json` output, primeiro vertical pack (clínica/odonto).

## Convenção de nomenclatura de módulos

Módulos novos devem seguir estas convenções:

- **Diretório no repo**: `modules/<nome-kebab-case>/` (ex.: `modules/evolution-api/`, `modules/crm-plugazap/`)
- **Arquivo de setup**: `{NOME_MODULO_UPPERCASE}_SETUP.md` (ex.: `EVOLUTION_SETUP.md`, `CRM_PLUGAZAP_SETUP.md`) — evita colisão quando múltiplos módulos forem instalados no mesmo projeto
- **`template.json` obrigatório** com campos: `name`, `version`, `description`, `requires`, `min_core_version`, `dependencies`, `env_vars`, `files`, `patches`
- **Arquivos em `files/`** dentro do módulo, mapeados pra destinos no projeto via `files[]` do `template.json`

**Campos opcionais úteis em `template.json`:**

- `setup_doc: string` — caminho do arquivo de setup (ex.: `"EVOLUTION_SETUP.md"`). Se ausente, o CLI detecta por convenção (primeiro `*_SETUP.md` em `files[]`).
- `env_vars[].default: string` — valor pré-preenchido pra variáveis opcionais no `.env.example`. Ausente = linha vazia (`VAR=`).

Templates antigos sem esses campos continuam funcionando — degradação graciosa.

Veja [`iaxplor/agent-templates/modules/evolution-api/`](https://github.com/iaxplor/agent-templates/tree/main/modules/evolution-api) como referência.

### Resolução de versões em upgrades — `modules-index.json`

Desde v0.4.1, o CLI resolve a tag do repo correspondente a uma versão de módulo via [`modules-index.json`](https://github.com/iaxplor/agent-templates/blob/main/modules-index.json) na raiz do branch `main` do `agent-templates`. Formato:

```json
{
  "google-calendar": {
    "0.1.0": "v0.2.4",
    "0.2.0": "v0.3.0",
    "0.3.1": "v0.4.1"
  },
  "evolution-api": {
    "0.1.0": "v0.1.0",
    "0.2.3": "v0.2.3"
  }
}
```

Por que existe: a versão de cada módulo evolui de forma independente das tags do repo (release do core/conjunto). Sem o índice, o CLI tentava baixar a tag `v{moduleVersion}` por convenção — funcionava por coincidência só enquanto as numerações casavam, e quebrava sempre que o módulo nascia/atualizava em uma tag posterior do repo. Bug original: [iaxplor/create-agent#1](https://github.com/iaxplor/create-agent/issues/1).

Quando uma nova versão de módulo é lançada, manter o `modules-index.json` sincronizado é parte do release. Se o índice ficar desatualizado, o CLI cai em fallback (tenta `v{version}` / `{version}` por convenção) com warning visível.

## Desenvolvimento

```bash
# Instala deps
pnpm install

# Roda o CLI em dev (tsx)
pnpm dev meu-teste              # equivalente a `create meu-teste`
pnpm dev add evolution-api      # roda o comando `add`

# Typecheck
pnpm typecheck

# Lint
pnpm lint

# Build (gera dist/index.js)
pnpm build

# Executa o build (útil pra reproduzir bugs de produção)
pnpm start meu-teste
```

Para testar a CLI compilada como se estivesse instalada globalmente:

```bash
pnpm build
pnpm link --global

# Em outro diretório:
cd /tmp
create-agent meu-teste
cd meu-teste
create-agent add evolution-api
```

Variáveis de ambiente úteis em dev:

- `DEBUG=1` — mostra o stack trace completo quando algo falha
- `GIGET_AUTH=<token>` — token GitHub pra evitar rate limit em CI/dev pesado

## Publicação no npm

O pacote é scoped público (`@iaxplor/create-agent`). Publicar requer ser membro da org `iaxplor` no npm.

```bash
pnpm build
npm publish
```

O script `prepublishOnly` já garante que o build roda antes do publish.

## Estrutura

```
src/
├── commands/
│   ├── create.ts              # comando "create"
│   └── add.ts                 # comando "add"
├── utils/
│   ├── banner.ts              # banner ASCII na abertura
│   ├── errors.ts              # UserError / InternalError + handler global
│   ├── logger.ts              # wrapper chalk + ora
│   ├── template-fetcher.ts    # download via giget (core e módulos)
│   ├── template-manifest.ts   # parse + validação do template.json de módulo
│   ├── config-reader.ts       # leitura/escrita de agente.config.json
│   ├── file-installer.ts      # expansão de files[] + detecção de conflito + cópia
│   ├── final-instructions.ts  # mensagem final formatada do `add`
│   ├── version-check.ts       # comparação semver simples (sem dep externa)
│   ├── confirm.ts             # prompt y/N via readline (sem dep externa)
│   └── validators.ts          # validação de nome de projeto
├── constants.ts               # URLs, regex, nomes de repo
├── types.ts                   # TemplateJson, ModuleTemplateJson, AgenteConfig, etc.
└── index.ts                   # entrypoint (shebang + commander)
```

## Licença

[MIT](LICENSE) · © IAxplor
