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

**Patches manuais**: o CLI **não** modifica automaticamente arquivos existentes no projeto (`api/main.py`, `workers/arq_worker.py`, `core/config.py`). Cada módulo documenta seus patches em um arquivo `<NOME>_SETUP.md` que é copiado junto — a última mensagem do comando orienta qual abrir.

## Convenção de nomenclatura de módulos

Módulos novos devem seguir estas convenções:

- **Diretório no repo**: `modules/<nome-kebab-case>/` (ex.: `modules/evolution-api/`, `modules/crm-plugazap/`)
- **Arquivo de setup**: `{NOME_MODULO_UPPERCASE}_SETUP.md` (ex.: `EVOLUTION_SETUP.md`, `CRM_PLUGAZAP_SETUP.md`) — evita colisão quando múltiplos módulos forem instalados no mesmo projeto
- **`template.json` obrigatório** com campos: `name`, `version`, `description`, `requires`, `min_core_version`, `dependencies`, `env_vars`, `files`, `patches`
- **Arquivos em `files/`** dentro do módulo, mapeados pra destinos no projeto via `files[]` do `template.json`

Veja [`iaxplor/agent-templates/modules/evolution-api/`](https://github.com/iaxplor/agent-templates/tree/main/modules/evolution-api) como referência.

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
