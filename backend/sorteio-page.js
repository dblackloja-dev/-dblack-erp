// Página do SORTEIO ao vivo — servida pelo próprio backend (mesma origem da API).
// Login de admin/gestor → dígitos travando um a um (caça-níquel) com som de
// suspense → vencedor com tremida, flash dourado e chuva de confete.
// Feita pra filmar: preto + dourado, tipografia gigante, funciona no celular e no PC.
module.exports = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sorteio D'Black</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at 50% 30%, #1a1407 0%, #0a0a0a 55%, #000 100%);
    color: #f5f0e6; font-family: 'Segoe UI', system-ui, sans-serif; overflow: hidden; padding: 20px; text-align: center;
  }
  body.shake { animation: shake .5s; }
  @keyframes shake { 0%,100%{transform:translate(0)} 20%{transform:translate(-8px,4px)} 40%{transform:translate(8px,-4px)} 60%{transform:translate(-6px,-3px)} 80%{transform:translate(6px,3px)} }
  .crown { font-size: 44px; filter: drop-shadow(0 0 18px rgba(212,175,55,.8)); }
  h1 { font-size: clamp(22px, 5vw, 42px); letter-spacing: 8px; color: #D4AF37; font-weight: 900; margin-top: 4px;
       text-shadow: 0 0 24px rgba(212,175,55,.45); }
  .sub { letter-spacing: 5px; font-size: clamp(11px, 2.4vw, 16px); color: #cbb87a; margin-top: 2px; text-transform: uppercase; }
  .chips { display: flex; gap: 10px; margin: 22px 0 6px; flex-wrap: wrap; justify-content: center; }
  .chip { border: 1px solid rgba(212,175,55,.4); border-radius: 999px; padding: 8px 18px; font-size: 14px; color: #e8dcb5;
          background: rgba(212,175,55,.07); }
  .frase { height: 28px; margin-top: 14px; font-size: clamp(14px, 3.4vw, 22px); color: #ffe9a8; letter-spacing: 2px;
           font-weight: 700; text-transform: uppercase; }
  .slots { display: flex; gap: clamp(8px, 2vw, 18px); justify-content: center; margin: 14px 0 4px; }
  .digit {
    width: clamp(64px, 17vw, 150px); height: clamp(92px, 24vw, 210px); border-radius: 18px;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Courier New', monospace; font-weight: 900; font-size: clamp(60px, 16vw, 150px);
    color: #D4AF37; background: linear-gradient(180deg, #171310, #0c0a08 60%, #171310);
    border: 2px solid rgba(212,175,55,.35); box-shadow: inset 0 10px 30px rgba(0,0,0,.8), 0 0 24px rgba(212,175,55,.12);
    transition: border-color .2s, box-shadow .2s, transform .15s;
  }
  .digit.rolling { color: #9a8650; animation: blur .12s infinite alternate; }
  @keyframes blur { from { filter: blur(0); } to { filter: blur(1.6px); } }
  .digit.locked {
    color: #ffe9a8; border-color: #D4AF37; transform: scale(1.06);
    box-shadow: inset 0 10px 30px rgba(0,0,0,.6), 0 0 42px rgba(212,175,55,.6);
    animation: lockpop .35s ease;
  }
  @keyframes lockpop { 0% { transform: scale(.8); } 60% { transform: scale(1.14); } 100% { transform: scale(1.06); } }
  .winner-name { font-size: clamp(24px, 6.5vw, 56px); font-weight: 900; color: #fff; margin-top: 14px; min-height: 1.25em;
                 text-shadow: 0 2px 22px rgba(212,175,55,.5); }
  .winner-info { font-size: clamp(13px, 3vw, 20px); color: #cbb87a; margin-top: 8px; min-height: 1.2em; }
  button.go {
    margin-top: 28px; padding: 18px 54px; font-size: clamp(17px, 3.6vw, 24px); font-weight: 900; letter-spacing: 3px;
    color: #0a0a0a; background: linear-gradient(135deg, #f1d978, #D4AF37 55%, #a8842a); border: none; border-radius: 999px;
    cursor: pointer; box-shadow: 0 8px 36px rgba(212,175,55,.35); transition: transform .15s, box-shadow .15s;
    font-family: inherit; text-transform: uppercase;
  }
  button.go:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 12px 48px rgba(212,175,55,.5); }
  button.go:disabled { opacity: .45; cursor: default; transform: none; }
  .history { margin-top: 26px; font-size: 13px; color: #8d8468; max-width: 680px; line-height: 1.9; }
  .history b { color: #D4AF37; }
  .confetti { position: fixed; top: -20px; pointer-events: none; z-index: 50; animation: fall linear forwards; }
  @keyframes fall { to { transform: translateY(110vh) rotate(720deg); opacity: .9; } }
  #flash { position: fixed; inset: 0; background: radial-gradient(circle, rgba(255,233,168,.85), rgba(212,175,55,.3) 60%, transparent);
           opacity: 0; pointer-events: none; z-index: 40; }
  #flash.on { animation: flashAnim .9s ease-out; }
  @keyframes flashAnim { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
  /* login */
  #login { position: fixed; inset: 0; background: rgba(0,0,0,.92); display: flex; align-items: center; justify-content: center; z-index: 100; }
  #login .box { background: #141210; border: 1px solid rgba(212,175,55,.35); border-radius: 18px; padding: 34px 30px; width: min(92vw, 360px); }
  #login h2 { color: #D4AF37; letter-spacing: 3px; font-size: 18px; margin-bottom: 18px; }
  #login input { width: 100%; padding: 13px 14px; margin-bottom: 12px; border-radius: 10px; border: 1px solid #3a342a;
                 background: #0d0c0a; color: #f5f0e6; font-size: 15px; font-family: inherit; }
  #login button { width: 100%; padding: 13px; border-radius: 10px; border: none; font-weight: 800; font-size: 15px;
                  background: linear-gradient(135deg, #f1d978, #D4AF37); color: #0a0a0a; cursor: pointer; font-family: inherit; }
  #login .err { color: #ff6b6b; font-size: 13px; min-height: 18px; margin-top: 8px; }
</style>
</head>
<body>
  <div id="flash"></div>
  <div id="login">
    <div class="box">
      <div class="crown">👑</div>
      <h2>SORTEIO D'BLACK</h2>
      <input id="user" placeholder="Usuário" autocomplete="username">
      <input id="pass" type="password" placeholder="Senha" autocomplete="current-password">
      <button onclick="doLogin()">ENTRAR</button>
      <div class="err" id="loginErr"></div>
    </div>
  </div>

  <div class="crown">👑</div>
  <h1>D'BLACK STORE</h1>
  <div class="sub">Sorteio Número da Sorte</div>
  <div class="chips">
    <span class="chip" id="chipNums">— números</span>
    <span class="chip" id="chipCompras">— compras concorrendo</span>
  </div>
  <div class="frase" id="frase"></div>
  <div class="slots">
    <div class="digit" id="d0">?</div>
    <div class="digit" id="d1">?</div>
    <div class="digit" id="d2">?</div>
    <div class="digit" id="d3">?</div>
  </div>
  <div class="winner-name" id="wname"></div>
  <div class="winner-info" id="winfo"></div>
  <button class="go" id="btn" onclick="sortear()" disabled>🎲 SORTEAR</button>
  <div class="history" id="hist"></div>

<script>
const LOJAS = { loja1: 'Divino', loja2: 'São João', loja3: 'Sta Margarida', loja4: 'Lojinha Online', shared_matriz: 'Matriz' };
let token = null, pool = [], drawing = false;
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(4, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = [0,1,2,3].map(i => $('d' + i));

/* ─── SOM (WebAudio — liberado pelo clique no botão) ─── */
let actx = null;
function som(freq, dur = 0.05, tipo = 'square', vol = 0.05) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = tipo; o.frequency.value = freq;
    g.gain.value = vol; o.connect(g); g.connect(actx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.stop(actx.currentTime + dur);
  } catch (e) {}
}
const tick = p => som(480 + p * 420, 0.035, 'square', 0.04);
const thud = () => { som(170, 0.22, 'sine', 0.12); som(85, 0.3, 'sine', 0.1); };
const fanfarra = () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => setTimeout(() => som(f, 0.4, 'triangle', 0.09), i * 130));

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
  return j;
}

async function doLogin() {
  $('loginErr').textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('user').value.trim(), password: $('pass').value }) });
    const j = await r.json();
    if (!r.ok || !j.token) throw new Error(j.error || 'Login inválido');
    if (!['admin', 'gestor'].includes(j.role)) throw new Error('Só admin/gestor pode sortear');
    token = j.token;
    $('login').style.display = 'none';
    await carregar();
  } catch (e) { $('loginErr').textContent = e.message; }
}
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function naoAvulso(e) { const n = String(e.customer || '').trim(); return n && !/^avulso$/i.test(n); }

async function carregar() {
  const d = await api('/api/raffle/entries');
  const validas = d.entries.filter(e => naoAvulso(e) &&
    ((e.status && e.status !== 'Cancelada') || (!e.status && String(e.sale_id || '').startsWith('ck_'))));
  pool = validas.map(e => e.n);
  const compras = new Set(validas.map(e => e.sale_id)).size;
  $('chipNums').textContent = pool.length + ' números';
  $('chipCompras').textContent = compras + ' compras concorrendo';
  $('btn').disabled = pool.length === 0;
  renderHist(d.draws || []);
}

function renderHist(draws) {
  $('hist').innerHTML = draws.length
    ? '🏆 Já sorteados: ' + draws.map(w => '<b>' + pad(w.n) + '</b> ' + (w.customer || '')).join(' &nbsp;·&nbsp; ')
    : '';
}

function confete(qtd = 140) {
  const cores = ['#D4AF37', '#f1d978', '#ffffff', '#a8842a', '#ffe9a8'];
  for (let i = 0; i < qtd; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    const s = 6 + Math.random() * 10;
    c.style.cssText = 'left:' + Math.random() * 100 + 'vw;width:' + s + 'px;height:' + s * (0.4 + Math.random()) +
      'px;background:' + cores[i % cores.length] + ';animation-duration:' + (2 + Math.random() * 2.5) +
      's;animation-delay:' + Math.random() * 0.9 + 's;border-radius:' + (Math.random() > .5 ? '50%' : '2px') + ';';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 6500);
  }
}

function rand9() { return Math.floor(Math.random() * 10); }

async function sortear() {
  if (drawing) return;
  drawing = true;
  $('btn').disabled = true;
  $('wname').textContent = '';
  $('winfo').textContent = '';
  $('frase').textContent = '';
  digits.forEach(d => { d.classList.remove('locked'); d.classList.add('rolling'); });

  // sorteia no servidor JÁ, mas segura o resultado pro show
  let winner = null, err = null;
  api('/api/raffle/draw', { method: 'POST', body: '{}' }).then(w => winner = w).catch(e => err = e);

  // fase 1: tudo girando até o servidor responder (mínimo 2s)
  const t0 = Date.now();
  let i = 0;
  while ((!winner && !err) || Date.now() - t0 < 2000) {
    digits.forEach(d => { if (!d.classList.contains('locked')) d.textContent = rand9(); });
    if (i++ % 2 === 0) tick(0);
    await sleep(55);
    if (Date.now() - t0 > 9000) break;
  }
  if (err || !winner) {
    digits.forEach(d => { d.classList.remove('rolling'); d.textContent = '?'; });
    $('wname').textContent = err ? err.message : 'Erro no sorteio';
    $('btn').disabled = false; drawing = false;
    return;
  }

  const alvo = pad(winner.n).split('');
  const frases = ['Valendo...', 'Atenção...', 'Tá chegando...', 'E o número da sorte é...'];

  // fase 2: trava dígito por dígito (caça-níquel)
  for (let d = 0; d < 4; d++) {
    $('frase').textContent = frases[d];
    const dur = d === 3 ? 3200 : 1500; // último dígito sofre mais
    const td = Date.now();
    let delay = 60;
    while (Date.now() - td < dur) {
      for (let k = d; k < 4; k++) digits[k].textContent = rand9();
      tick((d + (Date.now() - td) / dur) / 4);
      await sleep(delay);
      if (d === 3) { const p = (Date.now() - td) / dur; delay = 60 + p * p * 420; } // desacelera no final
    }
    digits[d].textContent = alvo[d];
    digits[d].classList.remove('rolling');
    digits[d].classList.add('locked');
    thud();
    await sleep(d === 2 ? 650 : 350); // respiro extra antes do último
  }

  // REVELAÇÃO
  $('frase').textContent = '';
  document.body.classList.add('shake');
  $('flash').classList.add('on');
  setTimeout(() => { document.body.classList.remove('shake'); $('flash').classList.remove('on'); }, 950);
  fanfarra();
  confete(160);
  setTimeout(() => confete(120), 800);
  setTimeout(() => confete(100), 1700);

  // nome aparece letra por letra
  const nome = '🎉 ' + (winner.customer || '');
  for (let c = 1; c <= nome.length; c++) {
    $('wname').textContent = nome.slice(0, c);
    await sleep(45);
  }
  $('winfo').textContent = (LOJAS[winner.store_id] || winner.store_id || '') +
    (winner.cupom ? ' · ' + winner.cupom : '') +
    (winner.total ? ' · compra de R$ ' + (+winner.total).toFixed(2).replace('.', ',') : '');
  $('btn').textContent = '🎲 SORTEAR OUTRO PRÊMIO';
  $('btn').disabled = false;
  drawing = false;
  carregar();
}
</script>
</body>
</html>`;
