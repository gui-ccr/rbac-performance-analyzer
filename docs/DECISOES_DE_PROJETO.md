# Decisões de Projeto

Registro das decisões técnicas tomadas e o porquê — útil tanto para manter consistência ao longo da implementação quanto como material para a seção de metodologia da tese.

## 1. Duas APIs separadas (não uma API com flag de modo)

**Decisão:** `api-rls` e `api-middleware` são dois serviços Node.js independentes, em vez de uma única API com um `ACCESS_STRATEGY=rls|middleware` alternável.

**Motivo:** isolamento total entre as duas implementações evita que código condicional (`if (strategy === 'rls')`) introduza diferenças sutis de caminho de execução entre os dois modos, o que poderia confundir o efeito medido. O custo é manter os dois serviços em sincronia manualmente (mesmo schema, mesmos endpoints, mesma regra de RBAC) — mitigado documentando o contrato comum em [`ARQUITETURA.md`](ARQUITETURA.md).

## 2. TypeScript

**Decisão:** as duas APIs, os scripts de seed e os scripts de relatório são escritos em TypeScript.

**Motivo:** o projeto depende de manter dois códigos "espelhados" consistentes (mesmos tipos de request/response, mesmo modelo de dados) — tipagem estática ajuda a garantir que `api-rls` e `api-middleware` não divirjam de contrato sem querer.

## 3. Express (em vez de Fastify)

**Decisão:** Express como framework HTTP das duas APIs.

**Motivo:**
- O overhead do framework é uma constante presente igualmente nas duas APIs (mesmo framework nos dois lados), então não enviesa a comparação RLS vs Middleware — só eleva o baseline absoluto de latência, o que é aceitável e pode ser mencionado como limitação/contexto nos resultados.
- Express deixa a implementação da abordagem "Middleware" didaticamente explícita (`app.use(authorizeRecordsAccess)`), o que ajuda tanto na revisão do código quanto na exposição do trabalho.
- Ecossistema mais familiar para debugging e para quem for revisar/avaliar o projeto.

**Trade-off aceito:** números de latência absolutos serão mais altos do que seriam com Fastify; isso deve ser mencionado no relatório final como característica do ambiente de teste, não como resultado do experimento.

## 4. k6 como ferramenta de teste de carga

**Decisão:** k6, em vez de Artillery, autocannon ou JMeter.

**Motivo:** scripts em JavaScript (mesma linguagem do restante do projeto), métricas de latência/throughput/erro nativas com percentis, e saída em JSON compatível com o pipeline de relatórios (JSON bruto → CSV) já definido pelo autor do projeto.

## 5. Supabase como banco de dados

**Decisão:** PostgreSQL gerenciado via Supabase, em vez de Postgres local (Docker).

**Motivo:** suporta RLS nativamente (é o caso de uso principal do produto) e remove a dependência da máquina do autor para rodar os testes — importante porque testes de carga em Postgres local competiriam por CPU com o próprio gerador de carga e com o SO, invalidando a medição.

**Implicação a monitorar:** por ser um ambiente gerenciado e multi-tenant, o Supabase introduz ruído fora do controle do experimento (outros clientes na mesma infraestrutura, autoscaling, cold starts). Mitigado por repetições múltiplas por cenário (ver [`METODOLOGIA.md`](METODOLOGIA.md#8-ameaças-à-validade)).

## 6. Relatórios: JSON bruto → CSV consolidado

**Decisão:** cada execução de teste de carga gera um JSON bruto (saída nativa do k6); um script separado consolida todos os JSONs relevantes em um único CSV.

**Motivo:** o JSON preserva a granularidade total da execução (útil para reprocessar métricas depois, sem precisar rodar o teste de novo); o CSV é o formato mais direto para importar em Excel/Python/R na hora de gerar os gráficos e estatísticas da tese.

---

## Pendências (a decidir antes da implementação)

### Onde rodar `api-rls` / `api-middleware` durante os testes

Se as APIs rodarem na máquina local do autor enquanto o k6 também roda localmente, há contenção de recursos entre gerador de carga e servidor testado, o que pode distorcer tanto a latência quanto a leitura de CPU da API. Opções a avaliar:

- Rodar a API em uma VM/serviço gratuito (Render, Railway, Fly.io) separado da máquina que roda o k6.
- Rodar o k6 na nuvem (k6 Cloud tem free tier limitado) apontando para a API local — inverte o problema, não resolve sozinho.
- Se ambos rodarem localmente, ao menos documentar como limitação e evitar tirar conclusões de CPU da própria API (manter o foco na CPU do banco, que é o objeto central da hipótese).

**Ação:** decidir antes de escrever os scripts de teste de carga, pois define a `BASE_URL` usada nos cenários k6.

### Plano do Supabase e granularidade de métricas de CPU

Confirmar se o plano gratuito do Supabase expõe métricas de CPU do banco com granularidade suficiente (painel *Database → Reports*) para as janelas de teste (minutos), ou se será necessário um plano pago / coleta alternativa (ex. `pg_stat_activity`, extensões de observabilidade).

**Ação:** validar no painel do Supabase antes de finalizar `docs/TESTES_DE_CARGA.md#coleta-de-cpu-fora-do-k6`.
