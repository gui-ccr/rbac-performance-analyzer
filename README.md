# RBAC Performance Analyzer

> Controle de Acesso em Larga Escala: Impacto do Volume de Dados na Performance de Row-Level Security (RLS) versus Middleware.

Projeto experimental desenvolvido para a disciplina de Metodologia Científica. Compara duas estratégias de controle de acesso baseado em papéis (RBAC) em sistemas multi-tenant — **Row-Level Security (RLS)** no PostgreSQL e **Middleware** na camada de aplicação — medindo como cada abordagem se comporta conforme o volume de dados cresce.

## Hipótese

> RLS degrada a performance mais do que Middleware conforme a densidade do banco de dados aumenta, transferindo o gargalo computacional para uma camada de difícil escalabilidade horizontal.

## Status do projeto

- [x] Definição do escopo e da metodologia
- [x] Decisões de arquitetura e stack
- [ ] Modelagem do schema e dados de seed
- [ ] Implementação da API `api-rls`
- [ ] Implementação da API `api-middleware`
- [ ] Scripts de seed (10k / 50k / 100k registros)
- [ ] Scripts de teste de carga (k6)
- [ ] Pipeline de relatório (JSON → CSV)
- [ ] Coleta de dados e análise estatística
- [ ] Redação dos resultados

## Documentação

Leia nesta ordem:

1. [`docs/METODOLOGIA.md`](docs/METODOLOGIA.md) — desenho experimental: variáveis, hipóteses, métricas, procedimento, ameaças à validade.
2. [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — modelo de dados, políticas de RLS, design do middleware, endpoints.
3. [`docs/TESTES_DE_CARGA.md`](docs/TESTES_DE_CARGA.md) — cenários de carga, ferramentas (k6), coleta e conversão dos relatórios.
4. [`docs/DECISOES_DE_PROJETO.md`](docs/DECISOES_DE_PROJETO.md) — registro das decisões técnicas e o porquê de cada uma (ADR-style).

## Stack técnica

| Camada | Escolha | Motivo (resumo — detalhes em [DECISOES_DE_PROJETO.md](docs/DECISOES_DE_PROJETO.md)) |
|---|---|---|
| Linguagem | TypeScript | Tipagem estática reduz erros na implementação dos dois experimentos, que precisam ser comparáveis. |
| API | Node.js + Express (duas instâncias separadas) | Isolamento total entre as duas abordagens; overhead do framework é constante entre as duas variantes, não enviesa a comparação. |
| Banco de dados | PostgreSQL via Supabase | Suporta RLS nativamente; hospedado, então os testes não dependem da máquina local. |
| Testes de carga | k6 | Scripts em JS, métricas de latência/RPS nativas, saída em JSON fácil de tratar. |
| Relatórios | JSON (bruto) → CSV (consolidado) | JSON preserva a saída completa do k6; CSV facilita a análise estatística (Excel/Python/R). |

## Estrutura do repositório (planejada)

```
rbac-performance-analyzer/
├── apps/
│   ├── api-rls/            # API com autorização delegada ao Postgres (RLS)
│   └── api-middleware/     # API com autorização na camada de aplicação
├── packages/
│   └── shared/             # Tipos, schema do banco, gerador de dados de seed
├── load-tests/
│   └── k6/                 # Scripts de teste de carga, um por cenário
├── scripts/
│   ├── seed/                # Popula o Supabase com 10k/50k/100k registros
│   └── report/               # Converte a saída JSON do k6 em CSV consolidado
├── reports/
│   ├── json/                 # Saída bruta dos testes de carga
│   └── csv/                   # CSV consolidado para análise
├── docs/
├── .env.example
└── package.json
```

> Estrutura ainda não escaffoldada — este README documenta o plano. Ver checklist acima.

## Como rodar (previsto)

```bash
# 1. Instalar dependências (workspaces npm)
npm install

# 2. Configurar variáveis de ambiente (uma Supabase project por API, ou schemas separados)
cp .env.example apps/api-rls/.env
cp .env.example apps/api-middleware/.env

# 3. Popular o banco com um volume de dados
npm run seed -- --volume=10000

# 4. Subir as duas APIs
npm run dev --workspace=apps/api-rls
npm run dev --workspace=apps/api-middleware

# 5. Rodar os testes de carga
k6 run load-tests/k6/scenario-<volume>.js --out json=reports/json/<run-id>.json

# 6. Converter o relatório para CSV
npm run report -- reports/json/<run-id>.json
```

## Licença / natureza do projeto

Projeto acadêmico, sem licença de distribuição definida. Uso restrito ao contexto da disciplina.
