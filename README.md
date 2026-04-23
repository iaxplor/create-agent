# `@iaxplor/create-agent`

CLI para criar projetos Python de agente de IA (FastAPI + Postgres + Redis + Agno) a partir do template `core` em [`iaxplor/agent-templates`](https://github.com/iaxplor/agent-templates). Otimizado para agentes de atendimento via WhatsApp com deploy em Docker Compose.

## Uso

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

## Regras de nome do projeto

- Entre **3 e 50 caracteres**
- Apenas **letras minúsculas, números e hífen** (ex.: `meu-agente-01`)
- Não pode começar ou terminar com hífen, nem ter hífen duplo consecutivo

## Desenvolvimento

```bash
# Instala deps
pnpm install

# Roda o CLI em dev (tsx)
pnpm dev meu-teste

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
│   └── create.ts          # comando "create"
├── utils/
│   ├── banner.ts          # banner ASCII na abertura
│   ├── errors.ts          # UserError / InternalError + handler global
│   ├── logger.ts          # wrapper chalk + ora
│   ├── template-fetcher.ts # download via giget + parse template.json
│   └── validators.ts      # validação de nome de projeto
├── constants.ts           # URLs, regex, nomes de repo
├── types.ts               # TemplateJson, AgenteConfig
└── index.ts               # entrypoint (shebang + commander)
```

## Licença

[MIT](LICENSE) · © IAxplor
