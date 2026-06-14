# CS2 Bet — Previsão de vitória no 1º mapa

Sistema que estima a **probabilidade de cada time vencer o primeiro mapa** das
próximas partidas de Counter-Strike 2, **simulando o veto do torneio**. Gera uma
página HTML (`index.html`) ordenada pelos jogos **mais próximos de acontecer**.

> ⚠️ Projeto educacional/estatístico. **Não é aconselhamento de apostas.**

## Duas fontes de dados disponíveis

| Fonte | Arquivo | Como funciona | Chave |
|-------|---------|---------------|-------|
| **HLTV** (recomendado) | `build.mjs` → `index.html` | Script Node faz scraping e **gera HTML estático** | Não precisa |
| BALLDONTLIE CS2 | `balldontlie.html` | App que consulta a API **ao vivo no navegador** | Precisa (planos ALL-STAR/GOAT) |

### Por que a HLTV precisa de um build em Node (e não roda no navegador)?

A HLTV **não tem API oficial**; usamos a lib não-oficial [`hltv` (gigobyte/HLTV)](https://github.com/gigobyte/HLTV),
que faz *scraping*. O site usa **Cloudflare**, que bloqueia requisições feitas
por navegador (CORS + anti-bot). Por isso um script Node coleta os dados e
**escreve o `index.html`** já com as previsões calculadas — você abre o HTML sem
nenhuma requisição nem chave.

> ⚠️ A HLTV **bane IPs que abusam**. O `build.mjs` é sequencial e espaça as
> requisições (`DELAY_MS`, padrão 3s). Não reduza demais nem aumente `NUM_GAMES`
> sem necessidade.

## Como gerar (HLTV)

```bash
npm install
node build.mjs        # gera o index.html

# opções:
NUM_GAMES=8 DELAY_MS=3000 FIRST_MODE=seed node build.mjs
```

- `NUM_GAMES` — quantos jogos prever (padrão 8).
- `DELAY_MS` — pausa entre requisições, anti-ban (padrão 3000).
- `FIRST_MODE` — quem escolhe o 1º mapa: `seed` (melhor ranking), `underdog`, `coin`.

Dados coletados da HLTV: `getMatches()` (próximos jogos + data), `getMatch()`
(formato Bo1/3/5), `getTeamStats()` (win-rate por mapa) e `getTeamRanking()`
(ranking mundial + pontos).

## Pipeline e modelo

Em CS2 o primeiro mapa é resultado do processo de **ban/pick** (veto), que depende
do **formato** e de **quem escolhe primeiro**. O modelo reproduz isso:

| Formato | Ordem do veto | Quem é o 1º mapa |
|---------|---------------|------------------|
| **Bo1** | ban·ban·ban·ban·ban·ban → sobra 1 | o mapa que **sobra** (tende a ser neutro) |
| **Bo3** | ban·ban·**PICK**·pick·ban·ban → decider | o **PICK de quem escolhe primeiro** |
| **Bo5** | ban·ban·**PICK**·pick·pick·pick → decider | o **PICK de quem escolhe primeiro** |

Consequência prática captada pelo modelo: em Bo3/Bo5, quem escolhe primeiro tende
a pegar **o seu mapa mais forte** — então o 1º mapa costuma favorecer quem escolhe.
Em Bo1, os bans removem os mapas fortes dos dois lados e sobra um mapa equilibrado.

## Pipeline (campos reais da OpenAPI CS2)

1. **`GET /matches`** (filtro `dates[]`) — próximas partidas, ordenadas pelo horário;
   descarta as que já têm `winner`.
2. **`GET /rankings`** (`ranking_type=BO1`) — `rank` e `points` de cada time. O BO1 é
   o mais relevante para um **mapa único**. Define quem é o melhor seed (escolhe 1º) e
   entra como força do time.
3. **`GET /team_map_pool`** — por mapa: `wins`, `losses`, `matches_played`, `win_rate`
   (escala 0–100) e **`is_permaban`**. A win-rate é **regularizada** (encolhida para 50%
   quando há poucos jogos): `wr = (wins + 2.5)/(jogos + 5)`.
4. **Simulação Monte Carlo do veto** (4.000 iterações): bans/picks com escolha
   estocástica (*softmax* sobre a vantagem de win-rate). O **`is_permaban`** é usado de
   verdade — o time quase sempre bane seu permaban e **nunca o escolhe** como pick →
   **distribuição realista de qual será o 1º mapa**.
5. **Probabilidade por mapa**:
   `P(time1 vence) = 1/(1+10^(-(WR1−WR2)/0.20))` (logística da diferença de win-rate
   **naquele mapa específico**).
6. **Agregação**:
   `P(vencer 1º mapa) = Σ P(mapa ser o 1º) × P(vencer naquele mapa)`.

> ℹ️ **Planos da API**: `team_map_pool` e `rankings` exigem plano **ALL-STAR**;
> `matches`/`match_maps` exigem **GOAT**. Se a sua key não tiver acesso, esses
> endpoints retornam erro — o modelo degrada com elegância (usa 50%/pool padrão).
> O `explorer.html` mostra exatamente a quais endpoints sua key tem acesso.

Cada card mostra: probabilidade final de cada time, o **1º mapa mais provável**, a
**win-rate dos dois times nesse mapa**, e uma tabela com a distribuição completa do
veto e o cálculo por mapa.

### Quem escolhe primeiro?

A API normalmente não expõe a ordem do veto antes do jogo, então é **configurável**:

- **Melhor seed/ranking** (padrão) — o time mais forte escolhe primeiro.
- **Azarão** — o time mais fraco escolhe (alguns formatos dão a vez ao lower seed).
- **Sorteio** — 50/50 (knife round / coin flip).

## Respeito ao limite de 5 req/min

- **Fila** que espaça as chamadas em ~13s.
- **Cache** local (`localStorage`, 6h).
- **Dedupe de times** — win-rate de cada time é buscada uma única vez.

## Limitações / evoluções

- Leitura **defensiva** dos campos da API (vários nomes possíveis); win-rate
  desconhecida vira 50%.
- O *pool* de mapas é a união dos mapas conhecidos dos dois times (fallback: pool
  ativo padrão do CS2).
- Sem head-to-head nem forma recente ainda — boas próximas melhorias, assim como
  usar a ordem de veto real quando a API expuser.
- A API key fica embutida no HTML (necessário no navegador); para uso público,
  prefira um proxy server-side.

## Explorador de dados (`explorer.html`)

Como a estrutura exata dos campos da API só dá pra confirmar fazendo a chamada
real, há uma ferramenta de diagnóstico: abra `explorer.html`, clique em
**Buscar tudo** e ela:

- Chama `/matches`, `/teams`, `/team_map_pool` e `/match_maps` (5 requisições,
  respeitando o limite com fila de ~13s).
- Mostra o **JSON cru** e a **lista de campos** de cada item.
- Faz uma **checagem ✓/✗** dizendo se cada campo que o modelo precisa existe (e
  com qual nome).
- Permite **exportar** tudo num `cs2-api-dump.json`.

Use isso para validar os nomes reais e, se algo vier diferente, é só ajustar o
mapeamento defensivo no `index.html`.

## Estrutura

```
build.mjs         # GERADOR (HLTV): scraping em Node -> escreve index.html
index.html        # saída gerada com as previsões (placeholder até rodar build.mjs)
package.json      # dependência 'hltv' e script de build
balldontlie.html  # app alternativo: BALLDONTLIE CS2 ao vivo no navegador
explorer.html     # diagnóstico dos endpoints da BALLDONTLIE
README.md         # esta documentação
```

> Nota: o pipeline com nomes de campos da OpenAPI descrito abaixo refere-se à
> versão **BALLDONTLIE** (`balldontlie.html`). A versão **HLTV** usa o mesmo
> modelo de veto, porém alimentado pelos métodos da lib `hltv`.

Fonte de dados: [BALLDONTLIE CS2 API](https://cs.balldontlie.io/).
