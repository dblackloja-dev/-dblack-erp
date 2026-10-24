// Página do SORTEIO ao vivo — servida pelo próprio backend (mesma origem da API).
// Login de admin/gestor → números girando com suspense → vencedor com confete.
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
  .crown { font-size: 44px; filter: drop-shadow(0 0 18px rgba(212,175,55,.8)); }
  h1 { font-size: clamp(22px, 5vw, 42px); letter-spacing: 8px; color: #D4AF37; font-weight: 900; margin-top: 4px;
       text-shadow: 0 0 24px rgba(212,175,55,.45); }
  .sub { letter-spacing: 5px; font-size: clamp(11px, 2.4vw, 16px); color: #cbb87a; margin-top: 2px; text-transform: uppercase; }
  .chips { display: flex; gap: 10px; margin: 26px 0 8px; flex-wrap: wrap; justify-content: center; }
  .chip { border: 1px solid rgba(212,175,55,.4); border-radius: 999px; padding: 8px 18px; font-size: 14px; color: #e8dcb5;
          background: rgba(212,175,55,.07); }
  .display {
    font-family: 'Courier New', monospace; font-weight: 900; font-size: clamp(84px, 24vw, 220px); line-height: 1;
    color: #D4AF37; letter-spacing: clamp(8px, 2.5vw, 26px); margin: 18px 0 6px; min-height: 1em;
    text-shadow: 0 0 40px rgba(212,175,55,.55), 0 0 90px rgba(212,175,55,.25);
    transition: transform .1s;
  }
  .display.rolling { animation: pulse .22s infinite alternate; }
  @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.035); } }
  .display.winner { animation: pop .6s ease; color: #ffe9a8; }
  @keyframes pop { 0% { transform: scale(.6); } 55% { transform: scale(1.18); } 100% { transform: scale(1); } }
  .winner-name { font-size: clamp(22px, 6vw, 52px); font-weight: 800; color: #fff; margin-top: 6px; min-height: 1.2em;
                 text-shadow: 0 2px 18px rgba(0,0,0,.8); }
  .winner-info { font-size: clamp(13px, 3vw, 20px); color: #cbb87a; margin-top: 8px; min-height: 1.2em; }
  button.go {
    margin-top: 34px; padding: 18px 54px; font-size: clamp(17px, 3.6vw, 24px); font-weight: 900; letter-spacing: 3px;
    color: #0a0a0a; background: linear-gradient(135deg, #f1d978, #D4AF37 55%, #a8842a); border: none; border-radius: 999px;
    cursor: pointer; box-shadow: 0 8px 36px rgba(212,175,55,.35); transition: transform .15s, box-shadow .15s;
    font-family: inherit; text-transform: uppercase;
  }
  button.go:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 12px 48px rgba(212,175,55,.5); }
  button.go:disabled { opacity: .45; cursor: default; transform: none; }
  .history { margin-top: 30px; font-size: 13px; color: #8d8468; max-width: 640px; line-height: 1.9; }
  .history b { color: #D4AF37; }
  .confetti { position: fixed; top: -20px; pointer-events: none; z-index: 50; animation: fall linear forwards; }
  @keyframes fall { to { transform: translateY(110vh) rotate(720deg); opacity: .9; } }
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
  <div class="display" id="display">????</div>
  <div class="winner-name" id="wname"></div>
  <div class="winner-info" id="winfo"></div>
  <button class="go" id="btn" onclick="sortear()" disabled>🎲 SORTEAR</button>
  <div class="history" id="hist"></div>

<script>
const LOJAS = { loja1: 'Divino', loja2: 'São João', loja3: 'Sta Margarida', loja4: 'Lojinha Online', shared_matriz: 'Matriz' };
let token = null, pool = [], drawing = false;
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(4, '0');

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

async function carregar() {
  const d = await api('/api/raffle/entries');
  const validas = d.entries.filter(e => (e.status && e.status !== 'Cancelada') || (!e.status && String(e.sale_id || '').startsWith('ck_')));
  pool = validas.map(e => e.n);
  const compras = new Set(validas.map(e => e.sale_id)).size;
  $('chipNums').textContent = d.count + ' números';
  $('chipCompras').textContent = compras + ' compras concorrendo';
  $('btn').disabled = pool.length === 0;
  renderHist(d.draws || []);
}

function renderHist(draws) {
  if (!draws.length) { $('hist').textContent = ''; return; }
  $('hist').innerHTML = '🏆 Já sorteados: ' + draws.map(w =>
    '<b>' + pad(w.n) + '</b> ' + (w.customer || 'Avulso')).join(' &nbsp;·&nbsp; ');
}

function confete() {
  const cores = ['#D4AF37', '#f1d978', '#ffffff', '#a8842a', '#ffe9a8'];
  for (let i = 0; i < 120; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    const s = 6 + Math.random() * 9;
    c.style.cssText = 'left:' + Math.random() * 100 + 'vw;width:' + s + 'px;height:' + s * (0.4 + Math.random()) +
      'px;background:' + cores[i % cores.length] + ';animation-duration:' + (2 + Math.random() * 2.5) +
      's;animation-delay:' + Math.random() * 0.8 + 's;border-radius:' + (Math.random() > .5 ? '50%' : '2px') + ';';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 6000);
  }
}

async function sortear() {
  if (drawing) return;
  drawing = true;
  $('btn').disabled = true;
  $('wname').textContent = '';
  $('winfo').textContent = '';
  const disp = $('display');
  disp.classList.remove('winner');
  disp.classList.add('rolling');

  // sorteia no servidor já, mas segura o resultado pro suspense
  let winner = null, err = null;
  const promessa = api('/api/raffle/draw', { method: 'POST', body: '{}' }).then(w => winner = w).catch(e => err = e);

  // rolagem com desaceleração (~4.5s) passeando pelos números REAIS
  let delay = 40;
  const t0 = Date.now();
  while (Date.now() - t0 < 4500 || !winner) {
    if (err) break;
    disp.textContent = pad(pool[Math.floor(Math.random() * pool.length)] || Math.ceil(Math.random() * 9999));
    await new Promise(r => setTimeout(r, delay));
    const prog = (Date.now() - t0) / 4500;
    delay = 40 + prog * prog * 360; // acelera o intervalo = desacelera a rolagem
    if (Date.now() - t0 > 8000) break; // trava de segurança se a API demorar
  }
  disp.classList.remove('rolling');

  if (err || !winner) {
    disp.textContent = '????';
    $('wname').textContent = err ? err.message : 'Erro no sorteio';
    $('btn').disabled = false; drawing = false;
    return;
  }

  disp.textContent = pad(winner.n);
  disp.classList.add('winner');
  confete();
  setTimeout(() => confete(), 700);
  $('wname').textContent = '🎉 ' + (winner.customer || 'Avulso');
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
