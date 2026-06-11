# CS2 Bet — Previsão de vitória no 1º mapa

Sistema que estima a **probabilidade de cada time vencer o primeiro mapa** das
próximas partidas de Counter-Strike 2, usando a [BALLDONTLIE CS2 API](https://cs.balldontlie.io/).
O resultado é uma página HTML (`index.html`) ordenada pelos jogos **mais próximos de acontecer**.

> ⚠️ Projeto educacional/estatístico. **Não é aconselhamento de apostas.**

## Como usar

Abra o `index.html` no navegador (basta dar duplo clique ou hospedar com GitHub Pages).
Ele já vem com a API key embutida e roda automaticamente ao carregar.

- **Nº de jogos** — quantas partidas futuras analisar.
- **Dias à frente** — janela de tempo para buscar partidas.
- **Limpar cache** — descarta os dados salvos localmente.

## Por que tudo roda no navegador?

A API só responde com a `Authorization` header (a API key) e impõe **limite de
5 requisições/minuto**. Para isso o front-end:

1. **Fila com rate-limit** — espaça as chamadas em ~13s (≤5/min).
2. **Cache local** (`localStorage`, 6h) — evita gastar requisições repetidas.
3. **Dedupe de times** — busca as estatísticas de cada time uma única vez.

## O que o modelo precisa (e como decide)

Para prever o vencedor do 1º mapa o sistema combina, por time:

| Sinal | Endpoint | Papel no modelo |
|-------|----------|-----------------|
| Win-rate médio no pool de mapas | `/team_map_pool?team_id=` | proxy direto de força no mapa |
| Ranking mundial Valve | campo `ranking`/`rank` da partida/time | bônus de força para times do topo |
| Partidas futuras | `/matches?start_date=&end_date=` | quem joga e quando |

### Modelo (estilo Elo + curva logística)

Cada time recebe um **rating**:

```
rating = 1000 + (winRateMédioMapas - 0.5) * 800        // win-rate -> ±400 pts
       + max(0, 50 - rankingMundial) * 6               // bônus por estar no top
```

E a probabilidade do time 1 vencer o primeiro mapa:

```
P(time1) = 1 / (1 + 10^(-(R1 - R2) / 400))
```

A **confiança** do palpite é classificada em Alta (>65%), Média (>56%) e Baixa.

### Por que essa abordagem

O mapa específico do 1º jogo só é definido no *veto*, logo antes da partida, e
normalmente não está disponível com antecedência. Por isso o modelo usa a
**força média do time nos mapas** (que captura consistência no pool) em vez de
um mapa fixo. Quando a API expuser o mapa já vetado, dá para evoluir para usar a
win-rate daquele mapa específico de cada lado.

## Limitações / próximos passos

- A API pode variar nomes de campos; o código lê de forma **defensiva** (vários
  nomes possíveis). Se algum campo não existir, ele usa valores neutros (50%).
- Não há histórico head-to-head nem forma recente (últimas N partidas) — são
  boas evoluções para aumentar a acurácia.
- A API key fica embutida no HTML (necessário para funcionar no navegador). Para
  uso público, troque por um proxy server-side que guarde a chave.

## Estrutura

```
index.html   # app completo (UI + lógica + modelo), sem dependências
README.md    # esta documentação
```

Fonte de dados: [BALLDONTLIE CS2 API](https://cs.balldontlie.io/).
