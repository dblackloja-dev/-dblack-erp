// CLIENTE BLACK — lógica JS: cotação do PDV, config, cadastro, job diário e rotas.
// As regras de dinheiro (cashback, saldo, nível) rodam em trigger no Postgres
// (loyalty-db.js) para cobrir vendas inseridas por fora da API (dblack-chat).
const express = require('express');

const TIERS = ['BLACK', 'GOLD', 'DIAMOND'];
const TIER_LABEL = { BLACK: 'BLACK', GOLD: 'BLACK GOLD', DIAMOND: 'BLACK DIAMOND' };
const CASH_METHODS = new Set(['PIX', 'DINHEIRO']);
const STRING_KEYS = new Set(['cashback_redeem_from', 'promo_from', 'promo_to', 'last_daily_run']);

const round2 = (n) => Math.round(n * 100) / 100;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const fmtBRL = (n) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
// Data local Brasil YYYY-MM-DD
const todayBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

function isValidCPF(cpf) {
  cpf = onlyDigits(cpf);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(cpf[9]) && calc(10) === parseInt(cpf[10]);
}

// Convenção do banco: dígitos SEM o 55 (como o trigger e o backfill gravam)
function normPhone(p) {
  let d = onlyDigits(p);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d;
}

const genId = () => require('crypto').randomUUID().split('-')[0] + Date.now().toString(36).slice(-4);

// ─── Config ───
async function getConfig(pool) {
  const { rows } = await pool.query('SELECT key, value FROM loyalty_config');
  const cfg = {};
  for (const r of rows) cfg[r.key] = STRING_KEYS.has(r.key) ? r.value : (Number(r.value) || 0);
  return cfg;
}
async function setConfig(pool, obj, by) {
  const ALLOWED = new Set(['window_days','min_valid_sale','gold_min_sales','gold_min_value','diamond_min_sales','diamond_min_value',
    'grace_days','discount_BLACK','discount_GOLD','discount_DIAMOND','cashback_BLACK','cashback_GOLD','cashback_DIAMOND',
    'cashback_expiry_days','min_redeem','max_promo_discount_for_redeem','cashback_redeem_from','promo_active','promo_from','promo_to',
    'notify_days_before_expiry','notify_grace_days_before']);
  for (const [k, v] of Object.entries(obj || {})) {
    if (!ALLOWED.has(k)) continue;
    await pool.query(`INSERT INTO loyalty_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
  }
  return getConfig(pool);
}
function isPromoActive(cfg) {
  if (Number(cfg.promo_active) === 1) return true;
  if (cfg.promo_from && cfg.promo_to) { const t = todayBR(); return t >= cfg.promo_from && t <= cfg.promo_to; }
  return false;
}

// ─── Cliente ───
const isEnrolled = (c) => !!c && onlyDigits(c.cpf).length === 11 && !String(c.tags || '').includes('Interno');

async function findCustomer(pool, { id, cpf, phone }) {
  if (id) return (await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0] || null;
  if (cpf) return (await pool.query('SELECT * FROM customers WHERE cpf = $1', [onlyDigits(cpf)])).rows[0] || null;
  if (phone) {
    const d = normPhone(phone);
    if (d.length < 8) return null;
    return (await pool.query(
      `SELECT * FROM customers
       WHERE regexp_replace(COALESCE(whatsapp,''),'[^0-9]','','g') IN ($1, '55'||$1)
          OR regexp_replace(COALESCE(phone,''),'[^0-9]','','g') IN ($1, '55'||$1)
       ORDER BY created_at LIMIT 1`, [d])).rows[0] || null;
  }
  return null;
}

function progressTexts(p) {
  if (!p) return {};
  const out = {};
  if (p.next_tier) {
    const s = Number(p.sales_missing || 0), v = Number(p.value_missing || 0);
    out.nextText = `Faltam ${s} compra${s === 1 ? '' : 's'} ou ${fmtBRL(v)} para ${TIER_LABEL[p.next_tier]}`;
  } else out.nextText = 'Você está no nível máximo';
  if (p.keep_sales_missing !== undefined) {
    const s = Number(p.keep_sales_missing || 0), v = Number(p.keep_value_missing || 0);
    out.keepText = (s === 0 || v === 0) ? `Mantém ${TIER_LABEL[p.tier]}` : `${s} compra${s === 1 ? '' : 's'} ou ${fmtBRL(v)}`;
    if (p.grace_until) out.keepText += ` até ${String(p.grace_until).split('-').reverse().join('/')}`;
  }
  return out;
}

async function customerSummary(pool, c) {
  if (!c) return null;
  const cfg = await getConfig(pool);
  const enrolled = isEnrolled(c);
  const tier = enrolled ? (c.tier || 'BLACK') : null;
  const bal = enrolled ? (await pool.query('SELECT loyalty_balance($1) b', [c.id])).rows[0].b : 0;
  const prog = enrolled ? (await pool.query('SELECT loyalty_progress($1) p', [c.id])).rows[0].p : null;
  const nx = enrolled ? (await pool.query(
    `SELECT remaining amount, to_char(expires_at,'YYYY-MM-DD') expires_at FROM cashback_ledger
     WHERE customer_id=$1 AND type='earn' AND remaining>0 AND expires_at>NOW() ORDER BY expires_at LIMIT 1`, [c.id])).rows[0] : null;
  return {
    id: c.id, name: c.name, cpf: c.cpf, whatsapp: c.whatsapp, birthdate: c.birthdate, enrolled,
    tier, tier_label: tier ? TIER_LABEL[tier] : null, tier_since: c.tier_since, grace_until: c.grace_until,
    discount_pct: tier ? cfg['discount_' + tier] : 0, cashback_pct: tier ? cfg['cashback_' + tier] : 0,
    balance: round2(Number(bal) || 0), next_expiring: nx || null,
    progress: prog ? { ...prog, ...progressTexts(prog) } : null,
  };
}

/**
 * Cadastro/adesão: exige CPF válido. Se já existir cliente com o mesmo telefone e
 * sem CPF (base do backfill), completa o cadastro em vez de duplicar.
 */
async function enrollCustomer(pool, data) {
  const cpf = onlyDigits(data.cpf);
  if (!isValidCPF(cpf)) throw Object.assign(new Error('CPF inválido'), { status: 400 });
  const phone = normPhone(data.whatsapp || data.phone);
  if (phone.length < 10) throw Object.assign(new Error('WhatsApp obrigatório (com DDD)'), { status: 400 });
  const name = String(data.name || '').trim();

  const byCpf = await findCustomer(pool, { cpf });
  const byPhone = await findCustomer(pool, { phone });
  if (byCpf && byPhone && byCpf.id !== byPhone.id) throw Object.assign(new Error('CPF já cadastrado em outro número'), { status: 409 });
  // CPF existe mas com outro WhatsApp → não troca sozinho (anti-fraude; atendente ajusta no CRM)
  if (byCpf && !byPhone && normPhone(byCpf.whatsapp || byCpf.phone) !== phone)
    throw Object.assign(new Error('CPF já cadastrado com outro WhatsApp — fale com uma atendente para atualizar'), { status: 409 });

  let c = byCpf || byPhone;
  if (c && onlyDigits(c.cpf).length === 11 && onlyDigits(c.cpf) !== cpf) throw Object.assign(new Error('Este número já tem outro CPF cadastrado'), { status: 409 });

  if (c) {
    await pool.query(
      `UPDATE customers SET cpf=$1, whatsapp=COALESCE(NULLIF(whatsapp,''),$2),
        name=CASE WHEN $3<>'' AND (name LIKE 'Cliente %' OR name='') THEN $3 ELSE name END,
        birthdate=COALESCE(NULLIF($4,''), birthdate), lgpd_consent_at=COALESCE(lgpd_consent_at, NOW()),
        tier_since=COALESCE(tier_since, NOW())
       WHERE id=$5`, [cpf, phone, name, data.birthdate || '', c.id]);
  } else {
    if (!name) throw Object.assign(new Error('Nome obrigatório'), { status: 400 });
    c = { id: genId() };
    await pool.query(
      `INSERT INTO customers (id, name, phone, whatsapp, cpf, birthdate, tags, lgpd_consent_at, tier, tier_since)
       VALUES ($1,$2,$3,$3,$4,$5,'["Novo"]',NOW(),'BLACK',NOW())`,
      [c.id, name, phone, cpf, data.birthdate || '']);
  }
  await pool.query('SELECT loyalty_apply_tier($1)', [c.id]); // histórico de 90d pode dar upgrade imediato
  const fresh = await findCustomer(pool, { id: c.id });
  const cfg = await getConfig(pool);
  const t = fresh.tier || 'BLACK';
  await pool.query(`SELECT loyalty_emit('welcome', $1, 'welcome', $2::jsonb)`,
    [fresh.id, JSON.stringify({ nivel: t, desconto: cfg['discount_' + t], cashback: cfg['cashback_' + t] })]);
  return { customer: fresh, created: !byCpf && !byPhone };
}

// ─── Cotação (PDV chama a cada mudança de carrinho/pagamento) ───
async function quoteSale(pool, p) {
  const cfg = await getConfig(pool);
  const c = p.customer_id ? await findCustomer(pool, { id: p.customer_id })
    : p.phone ? await findCustomer(pool, { phone: p.phone }) : null;
  const enrolled = isEnrolled(c);
  const tier = enrolled ? (c.tier || 'BLACK') : null;
  const subtotal = round2(Number(p.subtotal) || 0);
  const maxPromo = Number(p.max_item_promo_pct) || 0;
  const promo = isPromoActive(cfg) || maxPromo > 0;
  const cash = CASH_METHODS.has(String(p.payment_method || '').toUpperCase());
  const warnings = [];

  let discountPct = 0;
  if (enrolled && cash && !promo) discountPct = Number(cfg['discount_' + tier]) || 0;
  if (!c) warnings.push('Cadastre o cliente (CPF) para desconto à vista e cashback.');
  else if (!enrolled) warnings.push('Cliente sem CPF — cadastre o CPF para ativar os benefícios Cliente Black.');
  if (enrolled && promo && cash) warnings.push('Promoção ativa: desconto de nível não se aplica nesta venda.');
  if (enrolled && !cash) warnings.push('Desconto de nível só à vista (PIX/Dinheiro).');
  const discountValue = round2(subtotal * discountPct / 100);
  const afterDiscount = round2(subtotal - discountValue);

  const balanceAvailable = enrolled ? round2(Number((await pool.query('SELECT loyalty_balance($1) b', [c.id])).rows[0].b) || 0) : 0;
  let balanceUsable = 0;
  if (enrolled && balanceAvailable > 0) {
    if (todayBR() < String(cfg.cashback_redeem_from)) warnings.push(`Resgate de saldo abre em ${String(cfg.cashback_redeem_from).split('-').reverse().join('/')}.`);
    else if (maxPromo > Number(cfg.max_promo_discount_for_redeem)) warnings.push(`Saldo não vale com liquidação acima de ${cfg.max_promo_discount_for_redeem}%.`);
    else if (balanceAvailable < Number(cfg.min_redeem)) warnings.push(`Saldo mínimo para resgate: ${fmtBRL(cfg.min_redeem)}.`);
    else balanceUsable = Math.min(balanceAvailable, afterDiscount);
  }
  const balanceUsed = round2(Math.min(Number(p.use_balance) || 0, balanceUsable));
  const totalPago = round2(afterDiscount - balanceUsed);

  const cashbackPct = enrolled ? (Number(cfg['cashback_' + tier]) || 0) : 0;
  const cashbackValue = round2(totalPago * cashbackPct / 100);

  let prog = null;
  if (enrolled) {
    const pr = (await pool.query('SELECT loyalty_progress($1) p', [c.id])).rows[0].p;
    prog = pr ? { ...pr, ...progressTexts(pr) } : null;
  }

  return {
    customer: c ? { id: c.id, name: c.name, enrolled, tier, tier_label: tier ? TIER_LABEL[tier] : null, grace_until: c.grace_until } : null,
    tier, tierDiscountPct: discountPct, tierDiscountValue: discountValue,
    subtotal, afterDiscount, balanceAvailable, balanceUsable, balanceUsed, totalPago,
    cashbackPct, cashbackValue, promoActive: promo, maxItemPromoPct: maxPromo,
    progress: prog, warnings,
  };
}

// ─── Job diário (03h BRT; também disparável via POST /api/loyalty/daily-job) ───
async function dailyJob(pool) {
  const cfg = await getConfig(pool);
  const stats = { expired: 0, expiring_notified: 0, evaluated: 0, grace_notified: 0 };

  // 1) expira saldo vencido
  const ex = await pool.query(`
    WITH ex AS (
      UPDATE cashback_ledger SET remaining = 0
      WHERE type='earn' AND remaining>0 AND expires_at<=NOW()
      RETURNING id, customer_id, remaining AS r
    )
    INSERT INTO cashback_ledger (id, customer_id, type, amount, note)
    SELECT 'expire-'||id, customer_id, 'expire', -ROUND(r,2), 'vencimento' FROM ex
    ON CONFLICT (id) DO NOTHING`);
  stats.expired = ex.rowCount;

  // 2) avisa saldo vencendo
  const expiring = await pool.query(`
    SELECT id, customer_id, remaining, expires_at, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW()))/86400)::int dias
    FROM cashback_ledger
    WHERE type='earn' AND remaining>0 AND expiry_notified_at IS NULL
      AND expires_at > NOW() AND expires_at <= NOW() + ($1::int || ' days')::interval`,
    [Number(cfg.notify_days_before_expiry) || 15]);
  for (const e of expiring.rows) {
    await pool.query(`SELECT loyalty_emit('expiring', $1, $2, $3::jsonb)`,
      [e.customer_id, 'ledger:' + e.id, JSON.stringify({ valor: round2(Number(e.remaining)), dias: e.dias })]);
    await pool.query('UPDATE cashback_ledger SET expiry_notified_at = NOW() WHERE id = $1', [e.id]);
    stats.expiring_notified++;
  }

  // 3) varredura de níveis (inscritos com movimento recente, em carência ou acima de BLACK)
  const winPlus = (Number(cfg.window_days) || 90) + (Number(cfg.grace_days) || 30) + 1;
  const ids = await pool.query(`
    SELECT DISTINCT c.id FROM customers c
    WHERE length(regexp_replace(COALESCE(c.cpf,''),'[^0-9]','','g')) = 11 AND c.tags NOT LIKE '%Interno%'
      AND (c.grace_until IS NOT NULL OR COALESCE(NULLIF(c.tier,''),'BLACK') <> 'BLACK'
           OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.created_at >= NOW() - ($1::int||' days')::interval))`,
    [winPlus]);
  for (const r of ids.rows) {
    await pool.query('SELECT loyalty_apply_tier($1)', [r.id]);
    stats.evaluated++;
  }

  // lembrete de carência N dias antes do fim
  const graces = await pool.query(`
    SELECT id, tier, grace_until FROM customers
    WHERE grace_until IS NOT NULL AND grace_notified_at IS NULL
      AND grace_until <= NOW() + ($1::int || ' days')::interval`,
    [Number(cfg.notify_grace_days_before) || 10]);
  for (const g of graces.rows) {
    const pr = (await pool.query('SELECT loyalty_progress($1) p', [g.id])).rows[0].p;
    await pool.query(`SELECT loyalty_emit('grace_warning', $1, $2, $3::jsonb)`,
      [g.id, 'remind:' + String(g.grace_until).slice(0, 10),
       JSON.stringify({ nivel: g.tier, data: String(g.grace_until).slice(0, 10), progresso: pr })]);
    await pool.query('UPDATE customers SET grace_notified_at = NOW() WHERE id = $1', [g.id]);
    stats.grace_notified++;
  }

  const t = todayBR();
  await pool.query(`INSERT INTO loyalty_config (key, value) VALUES ('last_daily_run', $1)
                    ON CONFLICT (key) DO UPDATE SET value = $1`, [t]);
  return stats;
}

// Agendador: checa a cada 30 min; roda 1x/dia a partir das 3h BRT (persistido em loyalty_config)
function scheduleDailyJob(pool) {
  const tick = async () => {
    try {
      const hourBR = new Date(Date.now() - 3 * 3600000).getUTCHours();
      if (hourBR < 3) return;
      const last = (await pool.query(`SELECT value FROM loyalty_config WHERE key='last_daily_run'`)).rows[0]?.value;
      if (last === todayBR()) return;
      const stats = await dailyJob(pool);
      console.log('🖤 Cliente Black daily job:', JSON.stringify(stats));
    } catch (e) { console.error('loyalty daily job:', e.message); }
  };
  setInterval(tick, 30 * 60 * 1000);
  setTimeout(tick, 60 * 1000); // primeira checagem 1 min após o boot
}

// ─── Rotas (montadas sob /api, depois do authMiddleware) ───
function router(pool, { requireRole }) {
  const r = express.Router();
  const admin = requireRole ? requireRole('admin', 'gestor') : (req, res, next) => next();

  r.post('/sales/quote', async (req, res) => {
    try { res.json(await quoteSale(pool, req.body || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/loyalty/enroll', async (req, res) => {
    try {
      const { customer, created } = await enrollCustomer(pool, req.body || {});
      res.json({ created, ...(await customerSummary(pool, customer)) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  r.get('/loyalty/lookup', async (req, res) => {
    try {
      const q = String(req.query.q || '');
      const d = onlyDigits(q);
      const c = d.length === 11 && isValidCPF(d) ? await findCustomer(pool, { cpf: d })
        : d.length >= 8 ? await findCustomer(pool, { phone: d }) : null;
      if (!c) return res.status(404).json({ error: 'not_found' });
      res.json(await customerSummary(pool, c));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/loyalty/customers/:id', async (req, res) => {
    try {
      const c = await findCustomer(pool, { id: req.params.id });
      if (!c) return res.status(404).json({ error: 'not_found' });
      const summary = await customerSummary(pool, c);
      const ledger = (await pool.query('SELECT * FROM cashback_ledger WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100', [c.id])).rows;
      const history = (await pool.query('SELECT * FROM tier_history WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50', [c.id])).rows;
      res.json({ ...summary, ledger, history });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/loyalty/config', admin, async (req, res) => {
    try { res.json(await getConfig(pool)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.put('/loyalty/config', admin, async (req, res) => {
    try { res.json(await setConfig(pool, req.body || {}, req.user?.name)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/loyalty/recalc', admin, async (req, res) => {
    try {
      const ids = await pool.query(`SELECT id FROM customers WHERE length(regexp_replace(COALESCE(cpf,''),'[^0-9]','','g'))=11 AND tags NOT LIKE '%Interno%'`);
      let up = 0;
      for (const r2 of ids.rows) {
        const before = (await pool.query('SELECT tier FROM customers WHERE id=$1', [r2.id])).rows[0].tier;
        await pool.query('SELECT loyalty_apply_tier($1)', [r2.id]);
        const after = (await pool.query('SELECT tier FROM customers WHERE id=$1', [r2.id])).rows[0].tier;
        if (after !== before) up++;
      }
      res.json({ evaluated: ids.rows.length, changed: up });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/loyalty/daily-job', admin, async (req, res) => {
    try { res.json(await dailyJob(pool)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/loyalty/dashboard', admin, async (req, res) => {
    try {
      const enrolledCond = `length(regexp_replace(COALESCE(cpf,''),'[^0-9]','','g'))=11 AND tags NOT LIKE '%Interno%'`;
      const byTier = (await pool.query(`SELECT COALESCE(NULLIF(tier,''),'BLACK') tier, COUNT(*)::int n FROM customers WHERE ${enrolledCond} GROUP BY 1`)).rows;
      const inGrace = (await pool.query(`SELECT COUNT(*)::int n FROM customers WHERE grace_until IS NOT NULL AND ${enrolledCond}`)).rows[0].n;
      const bal = (await pool.query(`SELECT ROUND(COALESCE(SUM(remaining),0),2) s FROM cashback_ledger WHERE type='earn' AND remaining>0 AND expires_at>NOW()`)).rows[0].s;
      const exp15 = (await pool.query(`SELECT ROUND(COALESCE(SUM(remaining),0),2) s FROM cashback_ledger WHERE type='earn' AND remaining>0 AND expires_at>NOW() AND expires_at<=NOW()+interval '15 days'`)).rows[0].s;
      const earned30 = (await pool.query(`SELECT ROUND(COALESCE(SUM(amount),0),2) s FROM cashback_ledger WHERE type='earn' AND created_at>=NOW()-interval '30 days'`)).rows[0].s;
      const redeemed30 = (await pool.query(`SELECT ROUND(COALESCE(-SUM(amount),0),2) s FROM cashback_ledger WHERE type='redeem' AND created_at>=NOW()-interval '30 days'`)).rows[0].s;
      const top = (await pool.query(`
        SELECT c.id, c.name, COALESCE(NULLIF(c.tier,''),'BLACK') tier, c.grace_until,
               ROUND(COALESCE(SUM(l.remaining) FILTER (WHERE l.type='earn' AND l.remaining>0 AND l.expires_at>NOW()),0),2) balance,
               ROUND(c.total_spent) gasto, c.visits
        FROM customers c LEFT JOIN cashback_ledger l ON l.customer_id = c.id
        WHERE ${enrolledCond.replace(/cpf/g, 'c.cpf').replace(/tags/g, 'c.tags')}
        GROUP BY c.id ORDER BY balance DESC, c.total_spent DESC LIMIT 50`)).rows;
      res.json({ by_tier: byTier, in_grace: inGrace, balance_total: bal, expiring_15d: exp15, earned_30d: earned30, redeemed_30d: redeemed30, top });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}

// Pré-cadastro público (link na bio) — montar ANTES do authMiddleware, com rate limit simples
function publicSignupHandler(pool) {
  const hits = new Map(); // ip -> [timestamps]
  return async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '?';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (arr.length >= 10) return res.status(429).json({ error: 'Muitas tentativas — aguarde um minuto.' });
    arr.push(now); hits.set(ip, arr);
    try {
      const { customer } = await enrollCustomer(pool, { ...req.body, lgpd_consent: true });
      res.json({ ok: true, tier: customer.tier || 'BLACK' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
}

module.exports = {
  TIERS, TIER_LABEL, CASH_METHODS, fmtBRL, isValidCPF, normPhone, onlyDigits,
  getConfig, setConfig, isPromoActive, quoteSale, enrollCustomer, customerSummary,
  findCustomer, dailyJob, scheduleDailyJob, router, publicSignupHandler,
};
