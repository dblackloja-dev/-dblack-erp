// ═══════════════════════════════════════════════════
// ═══  D'Black ERP — API Client com Fila Offline  ═══
// ═══════════════════════════════════════════════════
const BASE = '/api';

// ─── Token JWT ───
const getToken = () => localStorage.getItem('dblack_token');
const setToken = (t) => {
  try {
    localStorage.setItem('dblack_token', t);
  } catch (e) {
    // Se localStorage estourou, limpa dados antigos e tenta de novo
    console.warn('[STORAGE] Quota excedida ao salvar token — limpando dados antigos...');
    ['dblack_sales','dblack_exchanges','dblack_payrolls','dblack_investments','dblack_withdrawals','dblack_advances'].forEach(k => {
      try { localStorage.removeItem(k); } catch {}
    });
    try { localStorage.setItem('dblack_token', t); } catch {}
  }
};
const clearToken = () => localStorage.removeItem('dblack_token');

// ═══════════════════════════════════════════════════
// ═══  FILA OFFLINE — guarda ações para sincronizar
// ═══════════════════════════════════════════════════
const QUEUE_KEY = 'dblack_offline_queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  // Dispara evento para o App.jsx atualizar o contador
  window.dispatchEvent(new CustomEvent('offlineQueueChange', { detail: { count: queue.length } }));
}

function addToQueue(path, options) {
  const queue = getQueue();
  queue.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    path,
    method: options.method || 'GET',
    body: options.body || null,
    createdAt: new Date().toISOString(),
  });
  saveQueue(queue);
  console.log('[OFFLINE] Ação enfileirada:', options.method, path, '| Fila:', queue.length);
}

function removeFromQueue(id) {
  const queue = getQueue().filter(q => q.id !== id);
  saveQueue(queue);
}

// Sincroniza a fila quando volta a internet
let syncing = false;
async function syncQueue() {
  if (syncing) return;
  const queue = getQueue();
  if (queue.length === 0) return;

  syncing = true;
  console.log('[SYNC] Iniciando sincronização de', queue.length, 'ações offline...');

  let successCount = 0;
  let authFailed = false;
  for (const item of queue) {
    try {
      const token = getToken();
      if (!token) {
        console.warn('[SYNC] Sem token — aguardando login para sincronizar');
        authFailed = true;
        break;
      }

      const res = await fetch(`${BASE}${item.path}`, {
        method: item.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: item.body ? JSON.stringify(item.body) : undefined,
      });

      if (res.ok || res.status === 409) {
        // 409 = conflito (já existe), considera como sucesso
        removeFromQueue(item.id);
        successCount++;
      } else if (res.status === 401) {
        // Token expirado — não para tudo, tenta renovar na próxima rodada
        console.warn('[SYNC] Token expirado — tentando novamente em 30s');
        authFailed = true;
        break;
      } else if (res.status >= 400 && res.status < 500) {
        // Erro do cliente (400, 403, 404, 422...) — erro permanente, remove da fila
        const errBody = await res.json().catch(() => ({}));
        console.warn('[SYNC] Erro permanente', res.status, 'em', item.path, ':', errBody.error || 'erro desconhecido', '— removendo da fila');
        removeFromQueue(item.id);
        successCount++;
      } else {
        // Erro do servidor (500+) — pode ser chave duplicada ou erro temporário
        const errBody = await res.json().catch(() => ({}));
        const errMsg = (errBody.error || '').toLowerCase();
        // Se for erro de duplicata, remove da fila (a venda já existe no banco)
        if (errMsg.includes('duplicate') || errMsg.includes('unique') || errMsg.includes('already') || errMsg.includes('violates')) {
          console.warn('[SYNC] Item duplicado em', item.path, '— removendo da fila');
          removeFromQueue(item.id);
          successCount++;
        } else {
          // Incrementa tentativas — após 5 falhas, remove
          item._retries = (item._retries || 0) + 1;
          if (item._retries >= 5) {
            console.warn('[SYNC] Item falhou 5 vezes em', item.path, '— removendo da fila:', errMsg);
            removeFromQueue(item.id);
          } else {
            console.warn('[SYNC] Erro', res.status, 'em', item.path, '(tentativa', item._retries + '/5) — mantendo na fila');
            // Atualiza o contador de retries no localStorage
            const q = getQueue();
            const idx = q.findIndex(qi => qi.id === item.id);
            if (idx >= 0) { q[idx]._retries = item._retries; localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
          }
        }
      }
    } catch (e) {
      // Ainda sem internet — para de tentar
      console.log('[SYNC] Ainda sem internet, tentando depois');
      break;
    }
  }

  syncing = false;
  const remaining = getQueue().length;
  console.log(`[SYNC] Concluído: ${successCount} enviados, ${remaining} pendentes`);

  // Dispara evento de sync completo
  window.dispatchEvent(new CustomEvent('offlineSyncDone', { detail: { sent: successCount, remaining } }));

  // Se falhou por auth e ainda tem itens, tenta de novo em 30s (o usuário pode re-logar)
  if (authFailed && remaining > 0) {
    setTimeout(syncQueue, 30000);
  }
}

// Tenta sincronizar quando volta a internet
// Também roda retry periódico enquanto houver itens na fila
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[ONLINE] Internet voltou! Sincronizando...');
    setTimeout(syncQueue, 1000);
  });

  // Retry periódico: a cada 30s verifica se tem itens na fila e tenta sincronizar
  setInterval(() => {
    if (navigator.onLine && getQueue().length > 0) {
      console.log('[SYNC] Retry periódico — tentando sincronizar fila pendente...');
      syncQueue();
    }
  }, 30000);
}

// ═══════════════════════════════════════════════════
// ═══  REQUEST — com fallback offline automático   ═══
// ═══════════════════════════════════════════════════
async function request(path, options = {}) {
  const token = getToken();
  const isWrite = options.method && options.method !== 'GET';

  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401) {
      // Não recarrega a página inteira — apenas limpa o token
      // O app vai detectar e mostrar a tela de login sem perder a aba atual
      clearToken();
      // Dispara evento para o app reagir sem reload
      window.dispatchEvent(new CustomEvent('authExpired'));
      return null;
    }
    if (!res.ok) {
      // Se é escrita e o servidor deu erro, enfileira para não perder dados
      if (isWrite && res.status >= 500) {
        console.warn('[REQUEST] Erro', res.status, 'em', path, '— enfileirando para retry');
        addToQueue(path, options);
        return { _offline: true, _queued: true };
      }
      // Para vendas (POST /sales), enfileira mesmo com 400 para não perder a venda
      if (isWrite && res.status >= 400 && path === '/sales') {
        console.warn('[REQUEST] Erro', res.status, 'em venda — enfileirando para retry');
        addToQueue(path, options);
        return { _offline: true, _queued: true };
      }
      const err = await res.json().catch(() => ({ error: 'Erro de rede' }));
      throw new Error(err.error || 'Erro na requisição');
    }
    return res.json();
  } catch (e) {
    // Se é uma escrita (POST/PUT/DELETE) e falhou por qualquer motivo, enfileira
    if (isWrite) {
      addToQueue(path, options);
      // Retorna resposta fake para o app continuar funcionando
      return { _offline: true, _queued: true };
    }

    // Para leituras (GET) offline, retorna null silenciosamente
    if (!navigator.onLine) {
      console.log('[OFFLINE] Leitura ignorada (sem internet):', path);
      return null;
    }

    throw e;
  }
}

// ═══════════════════════════════════════════════════
// ═══  API METHODS                                ═══
// ═══════════════════════════════════════════════════
const api = {
  // Stores
  getStores: () => request('/stores'),

  // Auth
  login: async (login, password) => {
    const data = await request('/auth/login', { method: 'POST', body: { login, password } });
    if (data?.token) {
      setToken(data.token);
      // Salva dados do usuário para login offline
      localStorage.setItem('dblack_user', JSON.stringify(data.user || data));
    }
    return data;
  },
  me: async () => {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch(`${BASE}/auth/me`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        // Se offline, retorna dados salvos do último login
        if (!navigator.onLine) {
          const saved = localStorage.getItem('dblack_user');
          if (saved) {
            console.log('[OFFLINE] Usando sessão salva');
            return JSON.parse(saved);
          }
        }
        clearToken();
        return null;
      }
      const user = await res.json();
      // Atualiza dados salvos
      localStorage.setItem('dblack_user', JSON.stringify(user));
      return user;
    } catch (e) {
      // Sem internet: retorna sessão salva
      if (!navigator.onLine || e.name === 'TypeError') {
        const saved = localStorage.getItem('dblack_user');
        if (saved) {
          console.log('[OFFLINE] Usando sessão salva');
          return JSON.parse(saved);
        }
      }
      clearToken();
      return null;
    }
  },
  logout: () => { clearToken(); localStorage.removeItem('dblack_user'); },

  // Users
  getUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: data }),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // Products
  getProducts: () => request('/products'),
  getProductPhotos: () => request('/products/photos'),
  createProduct: (data) => request('/products', { method: 'POST', body: data }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PUT', body: data }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  uploadPhoto: async (id, file) => {
    if (!navigator.onLine) {
      console.warn('[OFFLINE] Upload de foto não disponível offline');
      return { error: 'Upload não disponível offline' };
    }
    const form = new FormData();
    form.append('photo', file);
    const token = getToken();
    const res = await fetch(`${BASE}/products/${id}/photo`, {
      method: 'POST',
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  },

  // Categories
  getCategories: () => request('/categories'),
  createCategory: (name) => request('/categories', { method: 'POST', body: { name } }),
  deleteCategory: (name) => request(`/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Stock
  getStock: () => request('/stock'),
  getStoreStock: (stockId) => request(`/stock/${stockId}`),
  adjustStock: (stockId, productId, data) => request(`/stock/${stockId}/${productId}`, { method: 'PUT', body: data }),
  transferStock: (data) => request('/stock/transfer', { method: 'POST', body: data }),
  getMovements: (stockId) => request(`/stock/movements/${stockId}`),

  // Sales
  getSales: (storeId) => request(`/sales${storeId ? `?store_id=${storeId}` : ''}`),
  createSale: (data) => request('/sales', { method: 'POST', body: data }),
  updateSale: (id, data) => request(`/sales/${id}`, { method: 'PUT', body: data }),
  getEmployeePurchases: (month) => request(`/sales/employee-purchases?month=${month}`),
  getEmployeePurchaseDetails: (empId, month) => request(`/sales/employee-purchases/${empId}?month=${month}`),

  // Customers
  getCustomers: () => request('/customers'),
  createCustomer: (data) => request('/customers', { method: 'POST', body: data }),
  updateCustomer: (id, data) => request(`/customers/${id}`, { method: 'PUT', body: data }),

  // Expenses
  getExpenses: (storeId) => request(`/expenses${storeId ? `?store_id=${storeId}` : ''}`),
  createExpense: (data) => request('/expenses', { method: 'POST', body: data }),
  updateExpense: (id, data) => request(`/expenses/${id}`, { method: 'PUT', body: data }),
  deleteExpense: (id) => request(`/expenses/${id}`, { method: 'DELETE' }),

  // Expense Categories
  getExpenseCategories: () => request('/expense-categories'),
  createExpenseCategory: (name) => request('/expense-categories', { method: 'POST', body: { name } }),
  deleteExpenseCategory: (name) => request(`/expense-categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Cash
  getCash: (storeId, userId) => request(`/cash/${storeId}${userId ? `?user_id=${userId}` : ''}`),
  cashAction: (storeId, data) => request(`/cash/${storeId}`, { method: 'POST', body: data }),

  // Employees
  getEmployees: () => request('/employees'),
  createEmployee: (data) => request('/employees', { method: 'POST', body: data }),
  updateEmployee: (id, data) => request(`/employees/${id}`, { method: 'PUT', body: data }),
  deleteEmployee: (id) => request(`/employees/${id}`, { method: 'DELETE' }),

  // Payrolls
  getPayrolls: () => request('/payrolls'),
  createPayroll: (data) => request('/payrolls', { method: 'POST', body: data }),
  updatePayroll: (id, data) => request(`/payrolls/${id}`, { method: 'PUT', body: data }),
  deletePayroll: (id) => request(`/payrolls/${id}`, { method: 'DELETE' }),

  // Cash Withdrawals (Retiradas)
  getWithdrawals: (storeId) => request(`/withdrawals${storeId ? `?store_id=${storeId}` : ''}`),
  createWithdrawal: (data) => request('/withdrawals', { method: 'POST', body: data }),
  deleteWithdrawal: (id) => request(`/withdrawals/${id}`, { method: 'DELETE' }),

  // Cash Advances (Vales)
  getAdvances: (storeId) => request(`/advances${storeId ? `?store_id=${storeId}` : ''}`),
  createAdvance: (data) => request('/advances', { method: 'POST', body: data }),
  deleteAdvance: (id) => request(`/advances/${id}`, { method: 'DELETE' }),
  getAdvancesSummary: (month) => request(`/advances/summary?month=${month}`),

  // Sellers
  getSellers: () => request('/sellers'),
  updateSeller: (id, data) => request(`/sellers/${id}`, { method: 'PUT', body: data }),

  // Exchanges
  getExchanges: (storeId) => request(`/exchanges${storeId ? `?store_id=${storeId}` : ''}`),
  createExchange: (data) => request('/exchanges', { method: 'POST', body: data }),
  cancelExchange: (id) => request(`/exchanges/${id}/cancel`, { method: 'PUT' }),

  // Promos
  getPromos: () => request('/promos'),
  createPromo: (data) => request('/promos', { method: 'POST', body: data }),
  updatePromo: (id, data) => request(`/promos/${id}`, { method: 'PUT', body: data }),

  // Investments
  getInvestments: () => request('/investments'),
  createInvestment: (data) => request('/investments', { method: 'POST', body: data }),

  // ─── BLACK IA — Agente de Suporte ───
  agentChat: (data) => request('/agent/chat', { method: 'POST', body: data }),
  agentConversations: () => request('/agent/conversations'),
  agentLogs: (convId) => request(`/agent/conversations/${convId}/logs`),
  agentAlerts: () => request('/agent/alerts'),

  // ─── UTILITÁRIOS OFFLINE ───
  getQueueCount: () => getQueue().length,
  getQueue: () => getQueue(),
  syncNow: () => syncQueue(),
  clearQueue: () => saveQueue([]),
  isOnline: () => navigator.onLine,
};

export default api;
