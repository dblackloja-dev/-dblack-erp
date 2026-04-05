# D'Black Sistema Multilojas — ERP/PDV

Sistema completo de gestão para lojas D'Black com backend Node.js e frontend React.

## Estrutura do Projeto

```
dblack-erp/
├── backend/
│   ├── server.js          # Express server + API routes
│   ├── database.js        # SQLite setup + migrations
│   ├── package.json       # Dependencies backend
│   └── .env               # Configurações
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Aplicação React completa
│   │   ├── api.js         # API client (fetch wrapper)
│   │   └── index.js       # Entry point
│   ├── public/
│   │   └── index.html     # HTML template
│   ├── package.json       # Dependencies frontend
│   └── vite.config.js     # Vite config
├── uploads/               # Fotos dos produtos (auto-criado)
└── README.md
```

## Setup Rápido

### 1. Backend
```bash
cd backend
npm install
npm start
```
Roda em http://localhost:3001

### 2. Frontend
```bash
cd frontend
npm install
npm run dev
```
Roda em http://localhost:5173

## Tecnologias
- **Backend:** Node.js, Express, SQLite3, Multer (upload), CORS
- **Frontend:** React, Vite
- **Banco:** SQLite (arquivo local, zero config)
- **Upload:** Fotos salvas em /uploads, servidas como estáticos

## API Endpoints

### Produtos
- `GET    /api/products`          — Listar todos
- `POST   /api/products`          — Criar produto
- `PUT    /api/products/:id`      — Atualizar produto
- `DELETE /api/products/:id`      — Desativar produto
- `POST   /api/products/:id/photo` — Upload de foto

### Estoque
- `GET    /api/stock/:storeId`    — Estoque por loja
- `PUT    /api/stock/:storeId/:productId` — Ajustar estoque
- `POST   /api/stock/transfer`    — Transferência entre lojas

### Vendas
- `GET    /api/sales/:storeId`    — Vendas por loja
- `POST   /api/sales`             — Registrar venda

### Clientes
- `GET    /api/customers`         — Listar clientes
- `POST   /api/customers`         — Criar cliente
- `PUT    /api/customers/:id`     — Atualizar cliente

### Despesas
- `GET    /api/expenses/:storeId` — Despesas por loja
- `POST   /api/expenses`         — Registrar despesa

### Caixa
- `GET    /api/cash/:storeId`     — Estado do caixa
- `POST   /api/cash/:storeId`     — Abrir/fechar/sangria

### Colaboradores / Folha
- `GET    /api/employees`         — Listar colaboradores
- `POST   /api/employees`        — Cadastrar colaborador
- `PUT    /api/employees/:id`    — Atualizar colaborador
- `GET    /api/payrolls`          — Listar pagamentos
- `POST   /api/payrolls`         — Processar pagamento

### Usuários / Auth
- `POST   /api/auth/login`       — Login por PIN
- `GET    /api/users`             — Listar usuários
- `POST   /api/users`            — Criar usuário
