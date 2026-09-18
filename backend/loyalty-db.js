// CLIENTE BLACK — schema e regras de dinheiro no Postgres.
// Tudo que mexe com saldo/cashback/nível roda em trigger/função no banco porque
// as vendas entram por DOIS caminhos (API do ERP e INSERT direto do dblack-chat).
// Triggers têm EXCEPTION: fidelidade nunca pode bloquear uma venda.
// Substitui o sistema de pontos de 14/09 (aposentado; dados ficam em customers.points).

async function migrateLoyalty(pool) {
  const run = (sql, label) => pool.query(sql).catch(e => console.error('loyalty-db ' + label + ':', e.message));

  // ─── Tabelas ───
  await run(`
    CREATE TABLE IF NOT EXISTS cashback_ledger (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      sale_id TEXT,
      type TEXT NOT NULL,              -- earn | redeem | expire | reversal
      amount NUMERIC NOT NULL,
      remaining NUMERIC,
      expires_at TIMESTAMP,
      expiry_notified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_customer ON cashback_ledger(customer_id, type, expires_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_sale ON cashback_ledger(sale_id);

    CREATE TABLE IF NOT EXISTS tier_history (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      from_tier TEXT,
      to_tier TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS loyalty_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- Outbox de eventos: o dblack-chat lê daqui e envia o WhatsApp (worker próprio)
    CREATE TABLE IF NOT EXISTS loyalty_events (
      id TEXT PRIMARY KEY,
      event_id TEXT UNIQUE,            -- idempotência (evento:cliente:chave)
      event TEXT NOT NULL,             -- welcome|sale_receipt|tier_up|grace_warning|tier_down|expiring|birthday
      customer_id TEXT,
      payload TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      notified_at TIMESTAMP,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loyalty_events_pending ON loyalty_events(created_at) WHERE notified_at IS NULL;
  `, 'tables');

  // ─── Colunas novas ───
  await run(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS lgpd_consent_at TIMESTAMP;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_opt_out INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'BLACK';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS tier_since TIMESTAMP;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS grace_until TIMESTAMP;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS grace_target_tier TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS grace_notified_at TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tier_at_sale TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tier_discount_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tier_discount_value NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashback_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashback_value NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS balance_used NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS max_item_promo_pct NUMERIC NOT NULL DEFAULT 0;
  `, 'columns');

  // CPF único quando preenchido (cadastros sem CPF continuam permitidos, sem benefícios)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_cpf_unique ON customers(cpf) WHERE cpf IS NOT NULL AND cpf <> ''`, 'cpf-index');

  // ─── Config default (espec Cliente Black) ───
  const DEFAULTS = {
    window_days: 90, min_valid_sale: 83.50,
    gold_min_sales: 6, gold_min_value: 500,
    diamond_min_sales: 12, diamond_min_value: 1000,
    grace_days: 30,
    discount_BLACK: 10, discount_GOLD: 12, discount_DIAMOND: 14,
    cashback_BLACK: 1, cashback_GOLD: 3, cashback_DIAMOND: 5,
    cashback_expiry_days: 90, min_redeem: 10, max_promo_discount_for_redeem: 30,
    cashback_redeem_from: '2026-10-01',
    promo_active: 0, promo_from: '', promo_to: '',
    notify_days_before_expiry: 15, notify_grace_days_before: 10,
  };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    await run(`INSERT INTO loyalty_config (key, value) VALUES ('${k}', '${String(v)}') ON CONFLICT (key) DO NOTHING`, 'cfg-' + k);
  }

  // ─── Funções utilitárias ───
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_cfg(k TEXT) RETURNS TEXT AS $fn$
      SELECT value FROM loyalty_config WHERE key = k;
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-cfg');

  await run(`
    CREATE OR REPLACE FUNCTION loyalty_cfg_num(k TEXT) RETURNS NUMERIC AS $fn$
      SELECT COALESCE(NULLIF(loyalty_cfg(k),'')::numeric, 0);
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-cfg-num');

  await run(`
    CREATE OR REPLACE FUNCTION loyalty_tier_rank(t TEXT) RETURNS INT AS $fn$
      SELECT CASE t WHEN 'DIAMOND' THEN 2 WHEN 'GOLD' THEN 1 ELSE 0 END;
    $fn$ LANGUAGE sql IMMUTABLE;
  `, 'fn-rank');

  await run(`
    CREATE OR REPLACE FUNCTION loyalty_is_promo() RETURNS BOOLEAN AS $fn$
      SELECT loyalty_cfg('promo_active') = '1'
          OR (COALESCE(loyalty_cfg('promo_from'),'') <> '' AND COALESCE(loyalty_cfg('promo_to'),'') <> ''
              AND to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') BETWEEN loyalty_cfg('promo_from') AND loyalty_cfg('promo_to'));
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-promo');

  // Inscrito no programa = CPF preenchido (11 dígitos). Sem CPF: vincula venda e CRM, sem benefícios.
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_enrolled(cid TEXT) RETURNS BOOLEAN AS $fn$
      SELECT EXISTS (SELECT 1 FROM customers WHERE id = cid
                     AND length(regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')) = 11
                     AND tags NOT LIKE '%Interno%');
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-enrolled');

  // Dia do aniversário (birthdate 'YYYY-MM-DD' do CRM ou 'MM-DD'/'MM/DD')
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_is_birthday_day(cid TEXT) RETURNS BOOLEAN AS $fn$
      SELECT CASE
        WHEN c.birthdate ~ '^[0-9]{4}-' THEN substr(c.birthdate,6,5)
        WHEN c.birthdate ~ '^[0-9]{2}[-/][0-9]{2}' THEN substr(c.birthdate,1,2)||'-'||substr(c.birthdate,4,2)
        ELSE '' END = to_char(NOW() AT TIME ZONE 'America/Sao_Paulo','MM-DD')
      FROM customers c WHERE c.id = cid;
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-birthday-day');

  await run(`
    CREATE OR REPLACE FUNCTION loyalty_balance(cid TEXT) RETURNS NUMERIC AS $fn$
      SELECT ROUND(COALESCE(SUM(remaining),0), 2) FROM cashback_ledger
      WHERE customer_id = cid AND type = 'earn' AND remaining > 0 AND expires_at > NOW();
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-balance');

  // Estatísticas da janela: compras válidas = dias distintos com venda ACIMA de min_valid_sale
  // (estritamente maior — regra do dono 14/09: "o que conta são compras acima de 83,50")
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_window_stats(cid TEXT, OUT valid_sales INT, OUT total_spent NUMERIC) AS $fn$
      SELECT
        COUNT(DISTINCT s.date) FILTER (WHERE s.total > loyalty_cfg_num('min_valid_sale'))::int,
        ROUND(COALESCE(SUM(s.total),0), 2)
      FROM sales s
      WHERE s.customer_id = cid AND s.status <> 'Cancelada'
        AND s.created_at >= NOW() - (loyalty_cfg_num('window_days')::int || ' days')::interval;
    $fn$ LANGUAGE sql STABLE;
  `, 'fn-window');

  await run(`
    CREATE OR REPLACE FUNCTION loyalty_tier_calc(cid TEXT) RETURNS TEXT AS $fn$
    DECLARE vs INT; ts NUMERIC; byf TEXT; byv TEXT;
    BEGIN
      SELECT valid_sales, total_spent INTO vs, ts FROM loyalty_window_stats(cid);
      byf := CASE WHEN vs >= loyalty_cfg_num('diamond_min_sales') THEN 'DIAMOND'
                  WHEN vs >= loyalty_cfg_num('gold_min_sales') THEN 'GOLD' ELSE 'BLACK' END;
      byv := CASE WHEN ts >= loyalty_cfg_num('diamond_min_value') THEN 'DIAMOND'
                  WHEN ts >= loyalty_cfg_num('gold_min_value') THEN 'GOLD' ELSE 'BLACK' END;
      RETURN CASE WHEN loyalty_tier_rank(byf) >= loyalty_tier_rank(byv) THEN byf ELSE byv END;
    END;
    $fn$ LANGUAGE plpgsql STABLE;
  `, 'fn-tier-calc');

  // Progresso (números crus — o texto é montado por quem exibe: PDV ou worker do chat)
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_progress(cid TEXT) RETURNS JSONB AS $fn$
    DECLARE c RECORD; vs INT; ts NUMERIC; nt TEXT; o JSONB;
    BEGIN
      SELECT * INTO c FROM customers WHERE id = cid;
      IF c IS NULL THEN RETURN NULL; END IF;
      SELECT valid_sales, total_spent INTO vs, ts FROM loyalty_window_stats(cid);
      o := jsonb_build_object('tier', COALESCE(NULLIF(c.tier,''),'BLACK'), 'valid_sales', vs, 'total_spent', ts,
                              'grace_until', to_char(c.grace_until,'YYYY-MM-DD'));
      IF COALESCE(NULLIF(c.tier,''),'BLACK') <> 'DIAMOND' THEN
        nt := CASE WHEN COALESCE(NULLIF(c.tier,''),'BLACK') = 'BLACK' THEN 'GOLD' ELSE 'DIAMOND' END;
        o := o || jsonb_build_object('next_tier', nt,
          'sales_missing', GREATEST(0, loyalty_cfg_num(lower(nt)||'_min_sales')::int - vs),
          'value_missing', ROUND(GREATEST(0, loyalty_cfg_num(lower(nt)||'_min_value') - ts),2));
      END IF;
      IF COALESCE(NULLIF(c.tier,''),'BLACK') <> 'BLACK' THEN
        o := o || jsonb_build_object(
          'keep_sales_missing', GREATEST(0, loyalty_cfg_num(lower(c.tier)||'_min_sales')::int - vs),
          'keep_value_missing', ROUND(GREATEST(0, loyalty_cfg_num(lower(c.tier)||'_min_value') - ts),2));
      END IF;
      RETURN o;
    END;
    $fn$ LANGUAGE plpgsql STABLE;
  `, 'fn-progress');

  // Emite evento idempotente (outbox); pula opt-out, sem whatsapp e internos
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_emit(evt TEXT, cid TEXT, k TEXT, payload JSONB) RETURNS VOID AS $fn$
    DECLARE c RECORD;
    BEGIN
      SELECT * INTO c FROM customers WHERE id = cid;
      IF c IS NULL OR COALESCE(c.whatsapp,'') = '' OR COALESCE(c.whatsapp_opt_out,0) = 1 OR c.tags LIKE '%Interno%' THEN RETURN; END IF;
      INSERT INTO loyalty_events (id, event_id, event, customer_id, payload)
      VALUES (substr(md5(random()::text||clock_timestamp()::text),1,16), evt||':'||cid||':'||k, evt, cid, payload::text)
      ON CONFLICT (event_id) DO NOTHING;
    END;
    $fn$ LANGUAGE plpgsql;
  `, 'fn-emit');

  // Reavaliação de nível: sobe na hora; descida entra em carência; carência vencida rebaixa
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_apply_tier(cid TEXT) RETURNS TEXT AS $fn$
    DECLARE c RECORD; calc TEXT; cur TEXT; gu TIMESTAMP;
    BEGIN
      SELECT * INTO c FROM customers WHERE id = cid;
      IF c IS NULL OR NOT loyalty_enrolled(cid) THEN RETURN NULL; END IF;
      calc := loyalty_tier_calc(cid);
      cur := COALESCE(NULLIF(c.tier,''),'BLACK');

      IF loyalty_tier_rank(calc) > loyalty_tier_rank(cur) THEN
        UPDATE customers SET tier = calc, tier_since = NOW(), grace_until = NULL, grace_target_tier = NULL, grace_notified_at = NULL WHERE id = cid;
        INSERT INTO tier_history (id, customer_id, from_tier, to_tier, reason)
        VALUES (substr(md5(random()::text||clock_timestamp()::text),1,16), cid, cur, calc, 'upgrade');
        PERFORM loyalty_emit('tier_up', cid, calc||':'||to_char(NOW(),'YYYY-MM-DD'),
          jsonb_build_object('nivel', calc, 'desconto', loyalty_cfg_num('discount_'||calc), 'cashback', loyalty_cfg_num('cashback_'||calc)));
        RETURN calc;
      END IF;

      IF loyalty_tier_rank(calc) = loyalty_tier_rank(cur) THEN
        IF c.grace_until IS NOT NULL THEN
          UPDATE customers SET grace_until = NULL, grace_target_tier = NULL, grace_notified_at = NULL WHERE id = cid;
          INSERT INTO tier_history (id, customer_id, from_tier, to_tier, reason)
          VALUES (substr(md5(random()::text||clock_timestamp()::text),1,16), cid, cur, cur, 'grace_recovered');
        END IF;
        RETURN cur;
      END IF;

      -- nível calculado abaixo do atual
      IF c.grace_until IS NULL THEN
        gu := NOW() + (loyalty_cfg_num('grace_days')::int || ' days')::interval;
        UPDATE customers SET grace_until = gu, grace_target_tier = calc WHERE id = cid;
        INSERT INTO tier_history (id, customer_id, from_tier, to_tier, reason)
        VALUES (substr(md5(random()::text||clock_timestamp()::text),1,16), cid, cur, cur, 'grace_start');
        PERFORM loyalty_emit('grace_warning', cid, 'start:'||to_char(gu,'YYYY-MM-DD'),
          jsonb_build_object('nivel', cur, 'data', to_char(gu,'YYYY-MM-DD'), 'progresso', loyalty_progress(cid)));
      ELSIF c.grace_until <= NOW() THEN
        UPDATE customers SET tier = calc, tier_since = NOW(), grace_until = NULL, grace_target_tier = NULL, grace_notified_at = NULL WHERE id = cid;
        INSERT INTO tier_history (id, customer_id, from_tier, to_tier, reason)
        VALUES (substr(md5(random()::text||clock_timestamp()::text),1,16), cid, cur, calc, 'grace_end_downgrade');
        PERFORM loyalty_emit('tier_down', cid, to_char(NOW(),'YYYY-MM-DD'),
          jsonb_build_object('nivel', calc, 'progresso', loyalty_progress(cid)));
        RETURN calc;
      END IF;
      RETURN cur;
    END;
    $fn$ LANGUAGE plpgsql;
  `, 'fn-apply-tier');

  // Consome saldo FIFO (mais antigo primeiro), com lock. Consome o que houver (clamp) e registra redeem.
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_consume_balance(cid TEXT, amount NUMERIC, sid TEXT) RETURNS NUMERIC AS $fn$
    DECLARE e RECORD; left_amt NUMERIC := ROUND(amount,2); take NUMERIC; consumed NUMERIC := 0;
    BEGIN
      FOR e IN SELECT id, remaining FROM cashback_ledger
               WHERE customer_id = cid AND type = 'earn' AND remaining > 0 AND expires_at > NOW()
               ORDER BY expires_at ASC FOR UPDATE LOOP
        EXIT WHEN left_amt <= 0;
        take := LEAST(e.remaining, left_amt);
        UPDATE cashback_ledger SET remaining = ROUND(remaining - take,2) WHERE id = e.id;
        left_amt := ROUND(left_amt - take,2);
        consumed := ROUND(consumed + take,2);
      END LOOP;
      IF consumed > 0 THEN
        INSERT INTO cashback_ledger (id, customer_id, sale_id, type, amount)
        VALUES ('redeem-'||sid, cid, sid, 'redeem', -consumed)
        ON CONFLICT (id) DO NOTHING;
      END IF;
      RETURN consumed;
    END;
    $fn$ LANGUAGE plpgsql;
  `, 'fn-consume');

  // ─── Trigger principal: venda inserida ───
  // Mantém do sistema anterior: vincular cliente pelo WhatsApp e CRM (gasto/visitas).
  // Novo: consumo de saldo, cashback por nível (dobro no dia do aniversário p/ GOLD+), reavaliação de nível, recibo.
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_sale_insert() RETURNS trigger AS $fn$
    DECLARE
      digits TEXT; cid TEXT; pct NUMERIC; cb NUMERIC; consumed NUMERIC; t TEXT;
    BEGIN
      IF COALESCE(NEW.status,'') = 'Cancelada' THEN RETURN NULL; END IF;

      -- 1) achar/criar cliente pelo WhatsApp (mesma lógica do sistema de pontos)
      digits := regexp_replace(COALESCE(NEW.customer_whatsapp,''), '[^0-9]', '', 'g');
      IF length(digits) >= 12 AND digits LIKE '55%' THEN digits := substr(digits, 3); END IF;
      IF length(digits) >= 8 THEN
        SELECT c.id INTO cid FROM customers c
         WHERE regexp_replace(COALESCE(c.whatsapp,''),'[^0-9]','','g') IN (digits, '55'||digits)
            OR regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') IN (digits, '55'||digits)
         ORDER BY c.created_at LIMIT 1;
        IF cid IS NULL THEN
          cid := substr(md5(random()::text || clock_timestamp()::text), 1, 12);
          INSERT INTO customers (id, name, phone, whatsapp, tags, total_spent, visits, last_visit)
          VALUES (cid,
                  CASE WHEN COALESCE(NEW.customer,'') NOT IN ('','Avulso','Cliente WhatsApp') THEN NEW.customer
                       ELSE 'Cliente '||right(digits,4) END,
                  digits, digits, '["Novo"]', 0, 0, NEW.date);
        END IF;
      ELSIF COALESCE(NEW.customer_id,'') <> '' THEN
        SELECT id INTO cid FROM customers WHERE id = NEW.customer_id;
      END IF;
      IF cid IS NULL THEN RETURN NULL; END IF;

      UPDATE sales SET customer_id = cid WHERE id = NEW.id AND COALESCE(customer_id,'') <> cid;

      -- interno: só vincula
      IF EXISTS (SELECT 1 FROM customers WHERE id = cid AND tags LIKE '%Interno%') THEN RETURN NULL; END IF;

      -- 2) CRM
      UPDATE customers SET total_spent = total_spent + COALESCE(NEW.total,0), visits = visits + 1, last_visit = NEW.date,
        name = CASE WHEN COALESCE(NEW.customer,'') NOT IN ('','Avulso','Cliente WhatsApp') AND name LIKE 'Cliente %' THEN NEW.customer ELSE name END
      WHERE id = cid;

      -- 3) benefícios só para inscritos (CPF válido)
      IF NOT loyalty_enrolled(cid) THEN RETURN NULL; END IF;

      IF COALESCE(NEW.balance_used,0) > 0 THEN
        consumed := loyalty_consume_balance(cid, NEW.balance_used, NEW.id);
        IF consumed < ROUND(COALESCE(NEW.balance_used,0),2) THEN
          UPDATE sales SET balance_used = consumed WHERE id = NEW.id;
          PERFORM loyalty_emit('balance_shortfall', cid, 'sale:'||NEW.id,
            jsonb_build_object('pedido', NEW.balance_used, 'consumido', consumed));
        END IF;
      END IF;

      t := COALESCE(NULLIF((SELECT tier FROM customers WHERE id = cid),''),'BLACK');
      pct := loyalty_cfg_num('cashback_'||t);
      IF t <> 'BLACK' AND loyalty_is_birthday_day(cid) THEN pct := pct * 2; END IF;
      cb := ROUND(COALESCE(NEW.total,0) * pct / 100, 2);
      IF cb > 0 THEN
        INSERT INTO cashback_ledger (id, customer_id, sale_id, type, amount, remaining, expires_at)
        VALUES ('earn-'||NEW.id, cid, NEW.id, 'earn', cb, cb,
                NOW() + (loyalty_cfg_num('cashback_expiry_days')::int || ' days')::interval)
        ON CONFLICT (id) DO NOTHING;
      END IF;
      UPDATE sales SET tier_at_sale = t, cashback_pct = pct, cashback_value = cb WHERE id = NEW.id;

      PERFORM loyalty_apply_tier(cid);
      PERFORM loyalty_emit('sale_receipt', cid, 'sale:'||NEW.id,
        jsonb_build_object('valor', ROUND(COALESCE(NEW.total,0),2), 'cashback', cb,
                           'saldo', loyalty_balance(cid), 'progresso', loyalty_progress(cid)));
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
    $fn$ LANGUAGE plpgsql;
  `, 'fn-sale-insert');

  // ─── Trigger de cancelamento ───
  await run(`
    CREATE OR REPLACE FUNCTION loyalty_sale_cancel() RETURNS trigger AS $fn$
    DECLARE e RECORD; used NUMERIC;
    BEGIN
      IF COALESCE(OLD.status,'') <> 'Cancelada' AND NEW.status = 'Cancelada' AND COALESCE(OLD.customer_id,'') <> '' THEN
        UPDATE customers SET total_spent = GREATEST(0, total_spent - COALESCE(OLD.total,0)), visits = GREATEST(0, visits - 1)
        WHERE id = OLD.customer_id;

        SELECT * INTO e FROM cashback_ledger WHERE id = 'earn-'||OLD.id AND type = 'earn';
        IF e.id IS NOT NULL THEN
          UPDATE cashback_ledger SET remaining = 0 WHERE id = e.id;
          INSERT INTO cashback_ledger (id, customer_id, sale_id, type, amount, note)
          VALUES ('reversal-'||OLD.id, OLD.customer_id, OLD.id, 'reversal', -ROUND(e.amount,2),
                  CASE WHEN e.remaining < e.amount THEN 'consumido '||ROUND(e.amount - e.remaining,2)||' antes do cancelamento' END)
          ON CONFLICT (id) DO NOTHING;
        END IF;

        used := ROUND(COALESCE(OLD.balance_used,0),2);
        IF used > 0 THEN
          INSERT INTO cashback_ledger (id, customer_id, sale_id, type, amount, remaining, expires_at, note)
          VALUES ('refund-'||OLD.id, OLD.customer_id, OLD.id, 'earn', used, used,
                  NOW() + (loyalty_cfg_num('cashback_expiry_days')::int || ' days')::interval,
                  'devolução de saldo por cancelamento')
          ON CONFLICT (id) DO NOTHING;
        END IF;

        PERFORM loyalty_apply_tier(OLD.customer_id);
      END IF;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `, 'fn-sale-cancel');

  // ─── Instala triggers (substitui os do sistema de pontos) ───
  await run(`DROP TRIGGER IF EXISTS trg_loyalty_accrue ON sales`, 'drop-old-accrue');
  await run(`DROP TRIGGER IF EXISTS trg_loyalty_reverse ON sales`, 'drop-old-reverse');
  await run(`DROP FUNCTION IF EXISTS loyalty_accrue()`, 'drop-old-fn-accrue');
  await run(`DROP FUNCTION IF EXISTS loyalty_reverse()`, 'drop-old-fn-reverse');
  await run(`DROP TRIGGER IF EXISTS trg_cb_sale_insert ON sales`, 'drop-cb-insert');
  await run(`CREATE TRIGGER trg_cb_sale_insert AFTER INSERT ON sales FOR EACH ROW EXECUTE FUNCTION loyalty_sale_insert()`, 'trg-insert');
  await run(`DROP TRIGGER IF EXISTS trg_cb_sale_cancel ON sales`, 'drop-cb-cancel');
  await run(`CREATE TRIGGER trg_cb_sale_cancel BEFORE UPDATE OF status ON sales FOR EACH ROW EXECUTE FUNCTION loyalty_sale_cancel()`, 'trg-cancel');
}

module.exports = { migrateLoyalty };
