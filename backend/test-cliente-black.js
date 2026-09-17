// Teste e2e do CLIENTE BLACK (níveis + cashback) — roda contra servidor LOCAL (porta 4001)
// que usa o banco de produção. Dados 100% fictícios com limpeza completa no final.
// Uso: PORT=4001 node server.js  (em outro terminal)  →  node test-cliente-black.js
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const API = (process.env.API_BASE || 'http://localhost:4001') + '/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const token = jwt.sign({ id: 'test', name: 'TesteCB', role: 'admin', store_id: 'all' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const PHONE = '5533999990002';       // gravado como 33999990002
const DIG = '33999990002';
const PHONE2 = '5533999990003';      // cliente sem CPF
const DIG2 = '33999990003';
const CPF = '52998224725';           // CPF válido de teste
const mm = String(new Date().getMonth() + 1).padStart(2, '0'); // aniversário no mês atual
const SALES = ['testcb-s1', 'testcb-s2', 'testcb-s3', 'testcb-s4', 'testcb-s5'];

// gera CPF válido a partir de 9 dígitos
function genCpf(base9) {
  const d = base9.split('').map(Number);
  const calc = (arr) => { let s = 0; arr.forEach((n, i) => s += n * (arr.length + 1 - i)); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d10 = calc(d); const d11 = calc([...d, d10]);
  return base9 + String(d10) + String(d11);
}
const CPF2 = genCpf('123456788');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FALHOU ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};
const approx = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

async function api(method, path, body, noAuth) {
  const r = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', ...(noAuth ? {} : { Authorization: 'Bearer ' + token }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const getCust = async (dig = DIG) => (await pool.query('SELECT * FROM customers WHERE whatsapp = $1', [dig])).rows[0];
const balance = async (cid) => Number((await pool.query('SELECT loyalty_balance($1) b', [cid])).rows[0].b);

async function cleanup() {
  const ids = (await pool.query('SELECT id FROM customers WHERE whatsapp IN ($1,$2) OR cpf IN ($3,$4)', [DIG, DIG2, CPF, CPF2])).rows.map(r => r.id);
  await pool.query('DELETE FROM sales WHERE id = ANY($1) OR customer_id = ANY($2)', [SALES, ids.length ? ids : ['x']]);
  if (ids.length) {
    await pool.query('DELETE FROM cashback_ledger WHERE customer_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM tier_history WHERE customer_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM loyalty_events WHERE customer_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM customers WHERE id = ANY($1)', [ids]);
  }
  await pool.query(`UPDATE loyalty_config SET value='2026-10-01' WHERE key='cashback_redeem_from'`);
  await pool.query(`UPDATE loyalty_config SET value='0' WHERE key='promo_active'`);
}

(async () => {
  await cleanup();

  console.log('A) adesão com CPF');
  let r = await api('POST', '/loyalty/enroll', { name: 'Cliente CB Teste', whatsapp: PHONE, cpf: CPF, birthdate: `1990-${mm}-15` });
  check('enroll 200 tier BLACK', r.status === 200 && r.body.tier === 'BLACK', r.body);
  let c = await getCust();
  check('cpf gravado', c && c.cpf === CPF);
  check('lgpd registrado', !!c.lgpd_consent_at);
  check('evento welcome criado', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='welcome'`, [c.id])).rows[0].n === 1);
  r = await api('POST', '/loyalty/enroll', { name: 'Outro Nome', whatsapp: PHONE2, cpf: CPF });
  check('mesmo CPF em outro fone é recusado', r.status === 409, r);
  r = await api('POST', '/loyalty/enroll', { name: 'X', whatsapp: '5533999990009', cpf: '11111111111' });
  check('CPF inválido é recusado', r.status === 400, r);

  console.log('B) cotação');
  r = await api('POST', '/sales/quote', { customer_id: c.id, subtotal: 200, payment_method: 'PIX', max_item_promo_pct: 0, use_balance: 0 });
  check('PIX: 10% de nível (−R$20)', r.body.tierDiscountPct === 10 && approx(r.body.tierDiscountValue, 20), r.body);
  check('cashback 2% sobre 180 = 3,60', approx(r.body.cashbackValue, 3.6), r.body.cashbackValue);
  r = await api('POST', '/sales/quote', { customer_id: c.id, subtotal: 200, payment_method: 'CREDITO' });
  check('crédito: sem desconto de nível', r.body.tierDiscountPct === 0, r.body);
  r = await api('POST', '/sales/quote', { customer_id: c.id, subtotal: 200, payment_method: 'PIX', max_item_promo_pct: 15 });
  check('promoção: sem desconto de nível', r.body.tierDiscountPct === 0, r.body);

  console.log('C) venda com desconto de nível gera cashback (e replay não duplica)');
  const saleBase = { store_id: 'loja_teste', customer: 'Cliente CB Teste', customer_id: c.id, customer_whatsapp: PHONE, seller: 'TesteCB', items: [{ id: 'x', qty: 1, price: 200 }], stock_id: '', payments: [{ method: 'PIX', value: 180 }] };
  r = await api('POST', '/sales', { ...saleBase, id: SALES[0], subtotal: 200, discount: 20, tier_discount_pct: 10, tier_discount_value: 20, total: 180, cupom: 'CB-1' });
  check('POST /sales 200', r.status === 200, r);
  let led = (await pool.query(`SELECT * FROM cashback_ledger WHERE id='earn-'||$1`, [SALES[0]])).rows[0];
  check('earn 3,60 no ledger', led && approx(led.amount, 3.6), led);
  let sale = (await pool.query('SELECT tier_at_sale, cashback_value FROM sales WHERE id=$1', [SALES[0]])).rows[0];
  check('venda carimbada BLACK / 3,60', sale.tier_at_sale === 'BLACK' && approx(sale.cashback_value, 3.6), sale);
  check('evento sale_receipt', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='sale_receipt'`, [c.id])).rows[0].n === 1);
  await api('POST', '/sales', { ...saleBase, id: SALES[0], subtotal: 200, discount: 20, total: 180, cupom: 'CB-1' });
  check('replay: saldo continua 3,60', approx(await balance(c.id), 3.6), await balance(c.id));

  console.log('D) sobe para GOLD por valor (>= R$500 na janela)');
  await api('POST', '/sales', { ...saleBase, id: SALES[1], subtotal: 400, discount: 0, total: 400, cupom: 'CB-2', payments: [{ method: 'PIX', value: 400 }] });
  c = await getCust();
  check('tier GOLD', c.tier === 'GOLD', c.tier);
  check('evento tier_up', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='tier_up'`, [c.id])).rows[0].n === 1);

  console.log('E) aniversário NÃO dobra: GOLD no mês do aniversário segue 3%');
  r = await api('POST', '/sales/quote', { customer_id: c.id, subtotal: 100, payment_method: 'PIX' });
  check('quote 3% de volta', approx(r.body.cashbackPct, 3), r.body.cashbackPct);
  await api('POST', '/sales', { ...saleBase, id: SALES[2], subtotal: 100, discount: 12, tier_discount_pct: 12, tier_discount_value: 12, total: 88, cupom: 'CB-3', payments: [{ method: 'PIX', value: 88 }] });
  led = (await pool.query(`SELECT * FROM cashback_ledger WHERE id='earn-'||$1`, [SALES[2]])).rows[0];
  check('earn 88×3% = 2,64', led && approx(led.amount, 2.64), led && led.amount);

  console.log('F) usar saldo (libera resgate p/ teste)');
  await api('PUT', '/loyalty/config', { cashback_redeem_from: '2026-01-01' });
  const balAntes = await balance(c.id); // 3,60 + 8,00 + 2,64 = 14,24
  check('saldo acumulado 14,24', approx(balAntes, 14.24), balAntes);
  r = await api('POST', '/sales/quote', { customer_id: c.id, subtotal: 50, payment_method: 'PIX', use_balance: 999999 });
  check('quote usa todo saldo (14,24)', approx(r.body.balanceUsed, 14.24), r.body);
  const total4 = Math.round((50 - 6 - 14.24) * 100) / 100; // 12% GOLD = 6
  await api('POST', '/sales', { ...saleBase, id: SALES[3], subtotal: 50, discount: Math.round((6 + 14.24) * 100) / 100, tier_discount_pct: 12, tier_discount_value: 6, balance_used: 14.24, total: total4, cupom: 'CB-4', payments: [{ method: 'PIX', value: total4 }] });
  const balDepois = await balance(c.id); // zerou e ganhou 29,76×3% = 0,89
  check('saldo consumido e novo earn 0,89', approx(balDepois, 0.89), balDepois);
  check('redeem no ledger', (await pool.query(`SELECT COUNT(*)::int n FROM cashback_ledger WHERE id='redeem-'||$1`, [SALES[3]])).rows[0].n === 1);

  console.log('G) venda com saldo maior que o disponível é recusada');
  r = await api('POST', '/sales', { ...saleBase, id: SALES[4], subtotal: 100, balance_used: 999, total: 1, cupom: 'CB-5' });
  check('409 saldo insuficiente', r.status === 409, r);

  console.log('H) cancelamento devolve saldo usado e estorna cashback');
  await api('PUT', '/sales/' + SALES[3], { status: 'Cancelada', canceled_by: 'teste', canceled_at: new Date().toISOString() });
  const balCancel = await balance(c.id); // 0,89 estornado; 14,24 devolvido
  check('saldo volta a 14,24', approx(balCancel, 14.24), balCancel);
  check('reversal no ledger', (await pool.query(`SELECT COUNT(*)::int n FROM cashback_ledger WHERE id='reversal-'||$1`, [SALES[3]])).rows[0].n === 1);

  console.log('I) job diário: expiração e aviso de vencimento');
  await pool.query(`INSERT INTO cashback_ledger (id, customer_id, type, amount, remaining, expires_at) VALUES
    ('testcb-exp1', $1, 'earn', 5, 5, NOW() - interval '1 day'),
    ('testcb-exp2', $1, 'earn', 7, 7, NOW() + interval '5 days')`, [c.id]);
  r = await api('POST', '/loyalty/daily-job', {});
  check('job expira saldo vencido', r.body.expired >= 1, r.body);
  check('job avisa saldo vencendo', r.body.expiring_notified >= 1, r.body);
  check('evento expiring', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='expiring'`, [c.id])).rows[0].n >= 1);

  console.log('J) carência e rebaixamento');
  await pool.query(`UPDATE sales SET created_at = NOW() - interval '95 days' WHERE customer_id = $1`, [c.id]);
  await api('POST', '/loyalty/recalc', {});
  c = await getCust();
  check('entrou em carência (ainda GOLD)', c.tier === 'GOLD' && !!c.grace_until, { tier: c.tier, grace: c.grace_until });
  check('evento grace_warning', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='grace_warning'`, [c.id])).rows[0].n >= 1);
  await pool.query(`UPDATE customers SET grace_until = NOW() - interval '1 day' WHERE id = $1`, [c.id]);
  await api('POST', '/loyalty/recalc', {});
  c = await getCust();
  check('rebaixado para BLACK', c.tier === 'BLACK' && !c.grace_until, c.tier);
  check('evento tier_down', (await pool.query(`SELECT COUNT(*)::int n FROM loyalty_events WHERE customer_id=$1 AND event='tier_down'`, [c.id])).rows[0].n === 1);

  console.log('K) venda de cliente SEM CPF: vincula e conta CRM, sem cashback');
  await api('POST', '/sales', { store_id: 'loja_teste', customer: 'Sem CPF Teste', customer_whatsapp: PHONE2, seller: 'TesteCB', items: [{ id: 'x', qty: 1, price: 90 }], stock_id: '', subtotal: 90, total: 90, id: 'testcb-nocpf', cupom: 'CB-6' });
  const c2 = await getCust(DIG2);
  check('cliente criado sem cashback', c2 && (await balance(c2.id)) === 0 && Number(c2.total_spent) === 90, c2 && c2.total_spent);
  await pool.query('DELETE FROM sales WHERE id = $1', ['testcb-nocpf']);

  console.log('L) pré-cadastro público (sem token, rate limit)');
  r = await api('POST', '/loyalty/public-signup', { name: 'Público Teste', whatsapp: '5533999990004', cpf: CPF2 }, true);
  check('signup público 200', r.status === 200 && r.body.ok, r);
  await pool.query('DELETE FROM loyalty_events WHERE customer_id IN (SELECT id FROM customers WHERE cpf=$1)', [CPF2]);
  await pool.query('DELETE FROM customers WHERE cpf = $1', [CPF2]);

  await cleanup();
  check('limpeza ok', !(await getCust()) && !(await getCust(DIG2)));

  console.log(`\n${pass} ok, ${fail} falhas`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERRO:', e); try { await cleanup(); } catch {} process.exit(1); });
