// Teste e2e do Programa Cliente Black (fidelidade) — roda contra servidor LOCAL (porta 4001)
// que usa o banco de produção. Dados 100% fictícios (telefone 5533999990001, stock stk_teste)
// com limpeza completa no final.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const API = 'http://localhost:4001/api';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const token = jwt.sign({ id: 'test', name: 'TesteFidelidade', role: 'admin', store_id: 'all' }, process.env.JWT_SECRET, { expiresIn: '1h' });

const PHONE = '5533999990001';
const S1 = 'testfid-s1', S2 = 'testfid-s2', S3 = 'testfid-s3', S4 = 'testfid-s4', S5 = 'testfid-s5', R1 = 'testfid-r1', R2 = 'testfid-r2';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FALHOU ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
};

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const getCust = async () => (await pool.query("SELECT * FROM customers WHERE whatsapp = $1", ['33999990001'])).rows[0];

async function cleanup() {
  await pool.query("DELETE FROM sales WHERE id IN ($1,$2,$3,$4,$5)", [S1, S2, S3, S4, S5]);
  await pool.query("DELETE FROM loyalty_redemptions WHERE id IN ($1,$2) OR customer_id IN (SELECT id FROM customers WHERE whatsapp='33999990001')", [R1, R2]);
  await pool.query("DELETE FROM customers WHERE whatsapp = '33999990001'");
  await pool.query("DELETE FROM stock WHERE stock_id = 'stk_teste'");
  await pool.query("DELETE FROM stock_movements WHERE stock_id = 'stk_teste'");
}

(async () => {
  await cleanup(); // estado limpo caso rode 2x

  console.log('A) venda nova com whatsapp cria cliente e acumula');
  const saleBase = { store_id: 'loja_teste', customer: 'Cliente Teste Fid', customer_whatsapp: PHONE, seller: 'TesteFidelidade', items: [{ id: 'x', qty: 1, price: 250 }], subtotal: 250, total: 250, stock_id: '', cupom: 'TST-1' };
  let r = await api('POST', '/sales', { ...saleBase, id: S1 });
  check('POST /sales 200', r.status === 200, r);
  let c = await getCust();
  check('cliente criado', !!c, c);
  check('25 pontos (R$250)', c && c.points === 25, c && c.points);
  check('total_spent 250', c && parseFloat(c.total_spent) === 250, c && c.total_spent);
  check('visits 1', c && c.visits === 1);
  check('nome do cliente veio da venda', c && c.name === 'Cliente Teste Fid', c && c.name);
  let sale = (await pool.query('SELECT customer_id FROM sales WHERE id=$1', [S1])).rows[0];
  check('venda vinculada ao cliente', c && sale && sale.customer_id === c.id, sale);

  console.log('B) replay da mesma venda NAO duplica pontos');
  await api('POST', '/sales', { ...saleBase, id: S1 });
  c = await getCust();
  check('pontos continuam 25', c.points === 25, c.points);
  check('visits continua 1', c.visits === 1, c.visits);

  console.log('C) segunda venda mesmo telefone acumula no mesmo cliente');
  r = await api('POST', '/sales', { ...saleBase, id: S2, total: 100, subtotal: 100, items: [{ id: 'x', qty: 1, price: 100 }], cupom: 'TST-2' });
  c = await getCust();
  check('35 pontos', c.points === 35, c.points);
  check('visits 2', c.visits === 2, c.visits);
  check('so 1 cliente com esse fone', (await pool.query("SELECT COUNT(*)::int n FROM customers WHERE whatsapp='33999990001'")).rows[0].n === 1);

  console.log('D) cancelamento reverte o acumulo');
  r = await api('PUT', '/sales/' + S2, { status: 'Cancelada', canceled_by: 'teste', canceled_at: new Date().toISOString() });
  check('PUT cancel 200', r.status === 200, r);
  c = await getCust();
  check('volta a 25 pontos', c.points === 25, c.points);
  check('total_spent volta a 250', parseFloat(c.total_spent) === 250, c.total_spent);
  check('visits volta a 1', c.visits === 1, c.visits);

  console.log('E) resgate idempotente');
  r = await api('POST', '/customers/' + c.id + '/redeem', { id: R1, points: 10 });
  check('resgate 200 e saldo 15', r.status === 200 && r.body.points === 15, r.body);
  r = await api('POST', '/customers/' + c.id + '/redeem', { id: R1, points: 10 });
  check('replay do resgate nao desconta de novo', r.body.points === 15 && r.body.applied === false, r.body);
  r = await api('POST', '/customers/' + c.id + '/redeem', { id: R2, points: 999 });
  check('resgate acima do saldo trava em 0', r.body.points === 0, r.body);

  console.log('F) replay de venda NAO baixa estoque duas vezes');
  await pool.query("INSERT INTO stock (stock_id, product_id, quantity) VALUES ('stk_teste','prod_teste',10) ON CONFLICT DO NOTHING");
  r = await api('POST', '/sales', { ...saleBase, id: S3, stock_id: 'stk_teste', items: [{ id: 'prod_teste', qty: 2, price: 50 }], total: 100, subtotal: 100, cupom: 'TST-3' });
  let q = (await pool.query("SELECT quantity FROM stock WHERE stock_id='stk_teste' AND product_id='prod_teste'")).rows[0].quantity;
  check('estoque 10->8', q === 8, q);
  await api('POST', '/sales', { ...saleBase, id: S3, stock_id: 'stk_teste', items: [{ id: 'prod_teste', qty: 2, price: 50 }], total: 100, subtotal: 100, cupom: 'TST-3' });
  q = (await pool.query("SELECT quantity FROM stock WHERE stock_id='stk_teste' AND product_id='prod_teste'")).rows[0].quantity;
  check('replay: estoque continua 8', q === 8, q);

  console.log('G) pontos usados na venda voltam se a venda for cancelada');
  // após F o cliente tem 10 pts (venda S3 de R$100)
  await api('POST', '/sales', { ...saleBase, id: S5, total: 200, subtotal: 200, items: [{ id: 'x', qty: 1, price: 200 }], cupom: 'TST-5' });
  c = await getCust();
  check('S5 acumula: 30 pts', c.points === 30, c.points);
  r = await api('POST', '/customers/' + c.id + '/redeem', { id: 'sale-' + S5, points: 8, reason: 'Desconto na venda TST-5' });
  check('8 pts usados na venda: saldo 22', r.body.points === 22, r.body);
  await api('PUT', '/sales/' + S5, { status: 'Cancelada', canceled_by: 'teste', canceled_at: new Date().toISOString() });
  c = await getCust();
  check('cancelou: tira os 20 ganhos e devolve os 8 usados = 10', c.points === 10, c.points);
  check('resgate da venda removido (replay-safe)', (await pool.query("SELECT COUNT(*)::int n FROM loyalty_redemptions WHERE id=$1", ['sale-' + S5])).rows[0].n === 0);

  console.log('H) cliente com tag Interno vincula mas NAO pontua');
  await pool.query('UPDATE customers SET tags=$1 WHERE id=$2', ['["Interno"]', c.id]);
  const beforeVisits = c.visits;
  await api('POST', '/sales', { ...saleBase, id: S4, total: 300, subtotal: 300, items: [{ id: 'x', qty: 1, price: 300 }], cupom: 'TST-4' });
  c = await getCust();
  check('pontos nao mudam', c.points === 10, c.points);
  check('visits nao muda', c.visits === beforeVisits, c.visits);
  sale = (await pool.query('SELECT customer_id FROM sales WHERE id=$1', [S4])).rows[0];
  check('venda mesmo assim vinculada ao cliente', sale.customer_id === c.id, sale);

  await cleanup();
  const leftovers = (await pool.query("SELECT COUNT(*)::int n FROM customers WHERE whatsapp='33999990001'")).rows[0].n;
  check('limpeza ok', leftovers === 0);

  console.log(`\n${pass} ok, ${fail} falhas`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error('ERRO:', e); try { await cleanup(); } catch {} process.exit(1); });
