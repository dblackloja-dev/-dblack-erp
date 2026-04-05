// ─── API Client ───
// Em produção usa a URL do Render. Em dev, usa o proxy do Vite (localhost:3001)
const BASE = (import.meta.env.VITE_API_URL || '') + '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erro de rede' }));
    throw new Error(err.error || 'Erro na requisição');
  }
  return res.json();
}

const api = {
  // Stores
  getStores: () => request('/stores'),

  // Auth
  login: (login, password) => request('/auth/login', { method: 'POST', body: { login, password } }),

  // Users
  getUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: data }),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),

  // Products
  getProducts: () => request('/products'),
  createProduct: (data) => request('/products', { method: 'POST', body: data }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PUT', body: data }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  uploadPhoto: async (id, file) => {
    const form = new FormData();
    form.append('photo', file);
    const res = await fetch(`${BASE}/products/${id}/photo`, { method: 'POST', body: form });
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

  // Customers
  getCustomers: () => request('/customers'),
  createCustomer: (data) => request('/customers', { method: 'POST', body: data }),
  updateCustomer: (id, data) => request(`/customers/${id}`, { method: 'PUT', body: data }),

  // Expenses
  getExpenses: (storeId) => request(`/expenses${storeId ? `?store_id=${storeId}` : ''}`),
  createExpense: (data) => request('/expenses', { method: 'POST', body: data }),

  // Cash
  getCash: (storeId) => request(`/cash/${storeId}`),
  cashAction: (storeId, data) => request(`/cash/${storeId}`, { method: 'POST', body: data }),

  // Employees
  getEmployees: () => request('/employees'),
  createEmployee: (data) => request('/employees', { method: 'POST', body: data }),
  updateEmployee: (id, data) => request(`/employees/${id}`, { method: 'PUT', body: data }),

  // Payrolls
  getPayrolls: () => request('/payrolls'),
  createPayroll: (data) => request('/payrolls', { method: 'POST', body: data }),

  // Sellers
  getSellers: () => request('/sellers'),
  updateSeller: (id, data) => request(`/sellers/${id}`, { method: 'PUT', body: data }),

  // Exchanges
  getExchanges: (storeId) => request(`/exchanges${storeId ? `?store_id=${storeId}` : ''}`),
  createExchange: (data) => request('/exchanges', { method: 'POST', body: data }),

  // Promos
  getPromos: () => request('/promos'),
  createPromo: (data) => request('/promos', { method: 'POST', body: data }),
  updatePromo: (id, data) => request(`/promos/${id}`, { method: 'PUT', body: data }),

  // Investments
  getInvestments: () => request('/investments'),
  createInvestment: (data) => request('/investments', { method: 'POST', body: data }),
};

export default api;
