/* ============================================================================
   CS2 BET — Gerador de previsões do 1º mapa a partir da HLTV
   ----------------------------------------------------------------------------
   A HLTV não tem API oficial e bloqueia requisições de navegador (Cloudflare),
   então usamos a lib não-oficial `hltv` em Node para coletar os dados e GERAR
   um index.html estático com as previsões já calculadas. Sem chave de API.

   Uso:
     npm install
     node build.mjs

   ⚠️ A HLTV bane IPs que abusam. Este script é SEQUENCIAL e espaça as
   requisições (DELAY_MS). Não reduza demais o delay nem aumente NUM_GAMES sem
   necessidade.
   ========================================================================== */

import { writeFileSync } from "node:fs";

// import dinâmico p/ dar mensagem amigável se a dependência não estiver instalada
let HLTV;
try {
  ({ HLTV } = await import("hltv"));
} catch (e) {
  console.error("\n✗ Dependência 'hltv' não encontrada. Rode primeiro:\n\n    npm install\n");
  process.exit(1);
}

/* ----------------------------- configuração ----------------------------- */
const NUM_GAMES   = Number(process.env.NUM_GAMES || 8);   // quantos jogos prever
const DELAY_MS    = Number(process.env.DELAY_MS  || 3000); // pausa entre requisições (anti-Cloudflare)
const VETO_SIMS   = 4000;     // simulações Monte Carlo do veto
const VETO_TEMP   = 0.10;     // temperatura da escolha no veto
const ELO_DIVISOR = 0.20;     // sensibilidade da logística (win-rate 0..1)
const SHRINK_K    = 5;        // regularização de win-rate por amostra
const FIRST_MODE  = process.env.FIRST_MODE || "seed"; // seed | underdog | coin
const DEFAULT_POOL = ["Ancient","Anubis","Dust2","Inferno","Mirage","Nuke","Train"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* --------------------------- leitura defensiva -------------------------- */
const pick = (o,...ks)=>{ for(const k of ks){ if(o && o[k]!=null) return o[k]; } return undefined; };
function normMap(n){
  if(!n) return null;
  let s = String(n).replace(/^de_/i,"").trim();
  if(/tba|default|tbd/i.test(s)) return null;
  return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase();
}
function bestOf(v){
  if(v==null) return 3;
  const m = String(v).toLowerCase().match(/\d+/);
  return m ? parseInt(m[0],10) : 3;
}

/* --------------------------- coleta da HLTV ----------------------------- */
async function getRanking(){
  try{
    const r = await HLTV.getTeamRanking();
    const map = {};
    (r||[]).forEach(row=>{
      const id = pick(row.team||{}, "id");
      const place = pick(row,"place","rank");
      const points = pick(row,"points");
      if(id!=null) map[id] = { place, points };
    });
    log(`  ranking: ${Object.keys(map).length} times`);
    return map;
  }catch(e){ log("  ranking indisponível:", e.message); return {}; }
}

async function getUpcoming(){
  const all = await HLTV.getMatches();              // 1 requisição
  const now = Date.now();
  return (all||[])
    .filter(m => m.team1 && m.team2 && m.team1.name && m.team2.name)  // descarta TBD
    .filter(m => !m.live)
    .filter(m => (m.date ?? 0) >= now - 3600000)
    .sort((a,b)=> (a.date??0)-(b.date??0))
    .slice(0, NUM_GAMES);
}

// formato do confronto (Bo1/3/5) via página da partida
async function getFormat(matchId){
  try{
    const m = await HLTV.getMatch({ id: matchId });
    // a lib expõe o formato em 'format' (texto) e/ou no nº de maps
    const f = pick(m,"format");
    if(f && /bo\s*\d/i.test(String(f.name||f))) return bestOf(f.name||f);
    if(Array.isArray(m.maps)) return Math.max(1, m.maps.length);
    return 3;
  }catch(e){ return 3; }
}

// win-rate por mapa de um time
async function getTeamMaps(teamId, teamName){
  try{
    const s = await HLTV.getTeamStats({ id: teamId });
    const raw = s.mapStats || s.maps || {};
    const maps = {};
    for(const [k,v] of Object.entries(raw)){
      const name = normMap(v.name || k);
      if(!name) continue;
      const wins = pick(v,"wins"), losses = pick(v,"losses"), draws = pick(v,"draws")||0;
      const played = pick(v,"played","matches","total") ?? (wins!=null&&losses!=null ? wins+losses+draws : null);
      let rate = pick(v,"winRate","win_rate");
      if(typeof rate==="string") rate = parseFloat(rate);
      if(rate!=null && rate>1) rate = rate/100;
      let wr;
      if(wins!=null && played){ wr = (wins + SHRINK_K*0.5)/(played + SHRINK_K); }
      else if(rate!=null){ wr = rate; }
      else wr = 0.5;
      maps[name] = { wr: Math.min(.95, Math.max(.05, wr)), played: played!=null?Number(played):null, permaban:false };
    }
    return maps;
  }catch(e){ log(`  stats indisponíveis p/ ${teamName}:`, e.message); return {}; }
}

/* ------------------------------- modelo --------------------------------- */
const wrOn = (s,m)=> (s.maps[m] && s.maps[m].wr!=null) ? s.maps[m].wr : 0.5;
const adv  = (s,o,m)=> wrOn(s,m)-wrOn(o,m);
const isPermaban = (s,m)=> !!(s.maps[m] && s.maps[m].permaban);
function mapWinProb(a,b,m){ return 1/(1+Math.pow(10, -((wrOn(a,m)-wrOn(b,m))/ELO_DIVISOR))); }

function softmaxChoose(maps, scoreFn, temp){
  const ex = maps.map(m=>Math.exp(scoreFn(m)/temp));
  const sum = ex.reduce((a,b)=>a+b,0)||1;
  let r=Math.random()*sum, acc=0;
  for(let i=0;i<maps.length;i++){ acc+=ex[i]; if(r<=acc) return maps[i]; }
  return maps[maps.length-1];
}
function simulateVeto(format, pool, A, B, firstIsA){
  const first = firstIsA?A:B, second = firstIsA?B:A;
  let rem = pool.slice();
  const ban = (t,o)=>{ const m=softmaxChoose(rem, x=>-adv(t,o,x)+(isPermaban(t,x)?1.0:0), VETO_TEMP); rem=rem.filter(x=>x!==m); return m; };
  const pk  = (t,o)=>{ const c=rem.filter(x=>!isPermaban(t,x)); const f=c.length?c:rem; const m=softmaxChoose(f, x=>adv(t,o,x), VETO_TEMP); rem=rem.filter(x=>x!==m); return m; };
  if(format===1){ let tf=true; while(rem.length>1){ tf?ban(first,second):ban(second,first); tf=!tf; } return rem[0]; }
  ban(first,second); ban(second,first); return pk(first,second);
}
function teamRating(s){
  if(s.points!=null && !isNaN(s.points)) return Number(s.points);
  const vals = Object.values(s.maps).filter(x=>!x.permaban).map(x=>x.wr);
  let r = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0.5;
  if(s.place!=null && !isNaN(s.place)) r += Math.max(0,(50-Number(s.place)))*0.004;
  return r;
}
function vetoDistribution(format, pool, A, B){
  const dist = {};
  for(let i=0;i<VETO_SIMS;i++){
    let firstIsA;
    if(FIRST_MODE==="coin") firstIsA = Math.random()<0.5;
    else { const aBetter = teamRating(A) >= teamRating(B); firstIsA = FIRST_MODE==="underdog" ? !aBetter : aBetter; }
    const m = simulateVeto(format, pool, A, B, firstIsA);
    dist[m] = (dist[m]||0)+1;
  }
  return Object.entries(dist).map(([map,c])=>({map,p:c/VETO_SIMS})).sort((a,b)=>b.p-a.p);
}
function predictFirstMap(format, A, B){
  let pool = Array.from(new Set([...Object.keys(A.maps),...Object.keys(B.maps)]));
  if(pool.length<2) pool = DEFAULT_POOL.slice();
  const dist = vetoDistribution(format, pool, A, B);
  let pA=0;
  const detail = dist.map(d=>{
    const wp = mapWinProb(A,B,d.map); pA += d.p*wp;
    return { map:d.map, pFirst:d.p, wrA:wrOn(A,d.map), wrB:wrOn(B,d.map), pAwins:wp };
  });
  return { format, pA, pB:1-pA, detail, topMap:detail[0] };
}

/* ------------------------------ HTML ------------------------------------ */
const esc = (s)=> String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pc  = (p)=> Math.round(p*100);
function fmtWhen(ts){
  if(!ts) return "data indefinida";
  const d=new Date(ts), diff=ts-Date.now(), h=Math.round(diff/3600000);
  const rel = h<0?"ao vivo / começando":h<24?("em "+h+"h"):("em "+Math.round(h/24)+" dias");
  return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})+" ("+rel+")";
}

function cardHTML(g){
  const { A, B, pred, when, event } = g;
  const p1=pred.pA, p2=pred.pB, fav=p1>=p2?A.name:B.name, favP=Math.max(p1,p2);
  const conf = favP>0.65?"Alta":favP>0.56?"Média":"Baixa";
  const tm = pred.topMap;
  const rows = pred.detail.map(d=>`
    <tr><td>${esc(d.map)}</td>
      <td><span class="mini" style="width:${Math.round(d.pFirst*80)}px"></span> ${pc(d.pFirst)}%</td>
      <td>${pc(d.wrA)}%</td><td>${pc(d.wrB)}%</td><td>${pc(d.pAwins)}%</td></tr>`).join("");
  return `
  <div class="match">
    <div class="meta"><span class="tour">${esc(event||"Partida CS2")}</span>
      <span><span class="fmt">Bo${pred.format}</span> · ${esc(fmtWhen(when))}</span></div>
    <div class="teams">
      <div class="team"><div class="name">${esc(A.name)}</div><div class="rank">${A.place!=null?("Rank #"+A.place):"sem ranking"}</div></div>
      <div class="vs">VS</div>
      <div class="team"><div class="name">${esc(B.name)}</div><div class="rank">${B.place!=null?("Rank #"+B.place):"sem ranking"}</div></div>
    </div>
    <div class="probbar"><div class="p1" style="width:${pc(p1)}%">${pc(p1)}%</div><div class="p2" style="width:${pc(p2)}%">${pc(p2)}%</div></div>
    <div class="pick">Palpite 1º mapa: <b>${esc(fav)}</b> (${pc(favP)}%)<span class="conf">Confiança: ${conf}</span></div>
    <div class="firstmap">1º mapa mais provável: <b>${esc(tm.map)}</b> (${pc(tm.pFirst)}% de ser ele) —
      ${esc(A.name)} vence ${esc(tm.map)} em <b>${pc(tm.wrA)}%</b> · ${esc(B.name)} em <b>${pc(tm.wrB)}%</b>.</div>
    <details><summary>Detalhe do veto (Bo${pred.format}) e cálculo por mapa</summary>
      <table><tr><th>Mapa</th><th>P(ser o 1º)</th><th>WR ${esc(A.name)}</th><th>WR ${esc(B.name)}</th><th>P(${esc(A.name)} vence)</th></tr>${rows}</table>
      <p>P(${esc(A.name)} vencer 1º mapa) = Σ P(mapa ser o 1º) × P(vencer nele) = <b>${pc(p1)}%</b> · ${VETO_SIMS} simulações.</p>
    </details>
  </div>`;
}

function pageHTML(cards){
  const generated = new Date().toLocaleString("pt-BR");
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>CS2 Bet — Previsão de Vitória no 1º Mapa (HLTV)</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--border:#283041;--txt:#e6edf3;--muted:#8b949e;--accent:#f0a500;--green:#2ea043;--red:#f85149;--blue:#388bfd;--purple:#a371f7}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--txt);line-height:1.5}
header{padding:24px 20px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,#11161f,#0d1117)}
header h1{margin:0;font-size:22px}header h1 span{color:var(--accent)}header p{margin:6px 0 0;color:var(--muted);font-size:13px;max-width:820px}
.wrap{max-width:980px;margin:0 auto;padding:20px}
.match{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
.match .meta{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:12px;flex-wrap:wrap;gap:6px}
.match .meta .tour{color:var(--accent)}.match .meta .fmt{color:var(--purple);font-weight:700}
.teams{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px}
.team{text-align:center}.team .name{font-size:16px;font-weight:700;margin-bottom:4px}.team .rank{font-size:11px;color:var(--muted)}
.vs{color:var(--muted);font-size:12px;font-weight:700}
.probbar{margin-top:14px;height:30px;border-radius:6px;overflow:hidden;display:flex;font-size:13px;font-weight:700}
.probbar .p1{background:var(--blue);display:flex;align-items:center;padding-left:10px;color:#fff}
.probbar .p2{background:var(--red);display:flex;align-items:center;justify-content:flex-end;padding-right:10px;color:#fff}
.pick{margin-top:12px;font-size:13px;padding:10px 12px;border-radius:8px;background:var(--panel2);border:1px solid var(--border)}
.pick b{color:var(--green)}.pick .conf{float:right;color:var(--muted)}
.firstmap{margin-top:10px;font-size:12px;color:var(--muted);padding:8px 12px;border-left:3px solid var(--purple);background:#171c26}
.firstmap b{color:var(--purple)}
details{margin-top:10px;font-size:12px;color:var(--muted)}details summary{cursor:pointer;color:var(--blue)}
details table{width:100%;border-collapse:collapse;margin-top:8px}details th,details td{padding:3px 6px;border-bottom:1px solid var(--border);text-align:left}details th{color:var(--muted)}
.mini{display:inline-block;height:8px;background:var(--purple);border-radius:2px;vertical-align:middle}
footer{color:var(--muted);font-size:12px;text-align:center;padding:30px 20px}
.empty{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;color:var(--muted)}
</style></head><body>
<header><h1>CS2 <span>Bet</span> — Previsão de Vitória no 1º Mapa</h1>
<p>Previsões estáticas geradas a partir de dados da <b>HLTV</b> (lib não-oficial), simulando o
veto do torneio (Bo1/Bo3/Bo5): quem escolhe primeiro, ordem de bans/picks, probabilidade de cada
mapa ser o 1º e win-rate dos times naquele mapa. Ordenado pelos jogos mais próximos.
<b>Não é aconselhamento de apostas.</b></p></header>
<div class="wrap">
${cards || '<div class="empty">Nenhuma partida futura com dados suficientes foi encontrada. Rode <code>node build.mjs</code> novamente mais tarde.</div>'}
</div>
<footer>Fonte: HLTV (scraping via lib não-oficial) · Gerado em ${esc(generated)} · Modelo de veto Monte Carlo</footer>
</body></html>`;
}

/* ------------------------------ orquestra ------------------------------- */
async function main(){
  log("CS2 Bet — coletando dados da HLTV (sequencial, com delays)...");
  const ranking = await getRanking();
  await sleep(DELAY_MS);

  log("Buscando próximas partidas...");
  const matches = await getUpcoming();
  log(`  ${matches.length} partidas selecionadas.`);

  const teamCache = new Map();
  async function teamStrength(team){
    const id = team.id;
    if(teamCache.has(id)) return teamCache.get(id);
    await sleep(DELAY_MS);
    const maps = id!=null ? await getTeamMaps(id, team.name) : {};
    const r = id!=null ? ranking[id] : null;
    const s = { id, name:team.name, maps, place:r?.place ?? null, points:r?.points ?? null };
    teamCache.set(id, s);
    return s;
  }

  const games = [];
  for(const m of matches){
    log(`Processando: ${m.team1.name} vs ${m.team2.name}`);
    await sleep(DELAY_MS);
    const format = await getFormat(m.id);
    const A = await teamStrength(m.team1);
    const B = await teamStrength(m.team2);
    const pred = predictFirstMap(format, A, B);
    games.push({ A, B, pred, when:m.date, event: m.event?.name || m.event });
  }

  const cards = games.map(cardHTML).join("\n");
  writeFileSync(new URL("./index.html", import.meta.url), pageHTML(cards));
  log(`\n✓ index.html gerado com ${games.length} previsões.`);
}

main().catch(e=>{
  // Não sobrescreve o index.html: preserva as últimas previsões boas.
  // (ex.: se a HLTV bloquear o runner do GitHub via Cloudflare, o site
  //  publicado continua mostrando a última geração bem-sucedida.)
  console.error("\n✗ Falhou:", e.message);
  console.error("  index.html anterior preservado.");
  process.exit(1);
});
