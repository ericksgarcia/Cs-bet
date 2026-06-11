# CS2 Bet — Previsão de vitória no 1º mapa

Sistema que estima a **probabilidade de cada time vencer o primeiro mapa** das
próximas partidas de Counter-Strike 2, **simulando o veto do torneio**. Usa a
[BALLDONTLIE CS2 API](https://cs.balldontlie.io/) e gera uma página HTML
(`index.html`) ordenada pelos jogos **mais próximos de acontecer**.

> ⚠️ Projeto educacional/estatístico. **Não é aconselhamento de apostas.**

## Como usar

Abra o `index.html` no navegador (duplo clique ou via GitHub Pages). A API key já
vem embutida e a análise roda automaticamente.

Controles: nº de jogos, dias à frente, e **quem escolhe primeiro** (melhor seed,
azarão ou sorteio).

## A grande sacada: o 1º mapa vem do VETO, não é aleatório

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

## Pipeline

1. **`/matches`** — próximas partidas, ordenadas pelo horário.
2. **`/team_map_pool`** — win-rate de cada time **por mapa**.
3. **Simulação Monte Carlo do veto** (4.000 iterações): aplica bans/picks com
   escolha estocástica (*softmax* sobre a vantagem de win-rate) → **distribuição de
   qual será o 1º mapa**.
4. **Probabilidade por mapa**: para cada mapa candidato,
   `P(time1 vence) = 1/(1+10^(-(WR1−WR2)/0.20))` (curva logística da diferença de
   win-rate **naquele mapa específico**).
5. **Agregação**:
   `P(vencer 1º mapa) = Σ P(mapa ser o 1º) × P(vencer naquele mapa)`.

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
index.html      # app de previsão: UI + coleta + simulação de veto + modelo
explorer.html   # diagnóstico: busca e inspeciona os dados crus da API
README.md       # esta documentação
```

Fonte de dados: [BALLDONTLIE CS2 API](https://cs.balldontlie.io/).
