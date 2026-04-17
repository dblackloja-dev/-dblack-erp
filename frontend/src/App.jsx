import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import api from './api.js';

// ─── HELPERS ───
const fmt = (v) => (parseFloat(v)||0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (d) => { try { return new Date(d + "T12:00:00").toLocaleDateString("pt-BR"); } catch { return d; } };
const pct = (v) => (parseFloat(v)||0).toFixed(1)+"%";
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ─── IMPRESSÃO SILENCIOSA (QZ Tray) ───
// Armazena o nome da impressora configurada pelo usuário
let _qzPrinterName = localStorage.getItem('dblack_qz_printer') || '';
let _globalToast = null; // referência global para mostrar toasts de erro

function _buildPrintHTML(el) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    @page{margin:0;padding:0;size:80mm auto;}
    html,body{margin:0;padding:0;background:#fff;width:72mm;}
    body *{font-weight:700!important;color:#000!important;background:transparent!important;-webkit-print-color-adjust:exact!important;}
  </style></head><body>${el.outerHTML}</body></html>`;
}

// Retorna a lista de impressoras disponíveis no QZ Tray
async function qzGetPrinters() {
  const qz = window.qz;
  if (!qz) return [];
  if (!qz.websocket.isActive()) await qz.websocket.connect({ retries:2, delay:500 });
  return await qz.printers.find();
}

async function _qzSilentPrint(el) {
  const qz = window.qz;
  if (!qz) throw new Error('QZ Tray não disponível');
  // Só reconecta se necessário (normalmente já está conectado desde o início)
  if (!qz.websocket.isActive()) await qz.websocket.connect({ retries:2, delay:500 });

  let printer = _qzPrinterName;

  // Se não tem impressora salva, tenta encontrar automaticamente
  if (!printer) {
    const all = await qz.printers.find();
    // Procura por ELGIN ou termica no nome
    printer = all.find(p => /elgin/i.test(p)) || all.find(p => /termic|thermal|i8/i.test(p)) || all[0] || '';
    if (printer) { _qzPrinterName = printer; localStorage.setItem('dblack_qz_printer', printer); }
  }

  if (!printer) throw new Error('Nenhuma impressora encontrada. Configure nas configurações.');

  const config = qz.configs.create(printer, { scaleContent: false, margins: {top:0,right:0,bottom:0,left:0} });
  await qz.print(config, [{ type:'html', format:'plain', data: _buildPrintHTML(el) }]);
  if (_globalToast) _globalToast('✅ Impresso em: ' + printer);
}

let _printing = false; // Evita impressão dupla
async function triggerPrint(contentRef, callback) {
  if (_printing) return;
  _printing = true;
  setTimeout(() => { _printing = false; }, 3000);

  const el = contentRef?.current;
  const qz = window.qz;

  // Se QZ Tray JS carregou, tenta conectar e imprimir
  if (qz && el) {
    try {
      // Conecta ao QZ Tray se não estiver conectado (ws:// primeiro)
      if (!qz.websocket.isActive()) {
        try { await qz.websocket.connect({ usingSecure: false, host: 'localhost', retries: 2, delay: 500, keepAlive: 60 }); }
        catch { await qz.websocket.connect({ retries: 2, delay: 500, keepAlive: 60 }); }
      }
      // Conectou! Imprime pela térmica
      await _qzSilentPrint(el);
      callback && callback();
      return;
    } catch (err) {
      console.warn('[QZ] Falhou:', err.message || err);
      // Não mostra erro — cai silenciosamente pro Windows
    }
  }

  // Fallback: impressão pelo Windows (sem mensagem de erro)
  window.print();
  callback && callback();
}

// ─── LOCALSTORAGE HELPERS ───
const ls = (key, fallback) => {
  try { const v = localStorage.getItem('dblack_' + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const lsSave = (key, val) => {
  try { localStorage.setItem('dblack_' + key, JSON.stringify(val)); } catch {}
};

// ─── MIGRAÇÃO: garante que todos os usuários têm senha ───
(() => {
  try {
    const stored = localStorage.getItem('dblack_users');
    if (!stored) return;
    const users = JSON.parse(stored);
    const defaults = { u1:'admin123', u2:'ana123', u3:'carlos123', u4:'diego123', u5:'fer123', u6:'gabriel123' };
    let changed = false;
    users.forEach(u => {
      if (u.pin && !u.password) { u.password = u.pin; delete u.pin; changed = true; }
      if (!u.password && defaults[u.id]) { u.password = defaults[u.id]; changed = true; }
    });
    if (changed) localStorage.setItem('dblack_users', JSON.stringify(users));
  } catch {}
})();

// ─── TRANSFORMAÇÕES API ↔ FRONTEND ───
const prodFromApi = p => ({ ...p, minStock: parseInt(p.min_stock)||0, price: parseFloat(p.price)||0, cost: parseFloat(p.cost)||0, margin: parseFloat(p.margin)||0, variations: typeof p.variations === 'string' ? JSON.parse(p.variations||'[]') : (p.variations||[]) });
const prodToApi = p => ({ ...p, min_stock: p.minStock, variations: Array.isArray(p.variations) ? p.variations : [] });
const custFromApi = c => ({ ...c, totalSpent: parseFloat(c.total_spent||0), lastVisit: c.last_visit||'-', tags: typeof c.tags === 'string' ? JSON.parse(c.tags||'["Novo"]') : (c.tags||['Novo']) });
const custToApi = c => ({ ...c, total_spent: c.totalSpent||0, last_visit: c.lastVisit||'-' });
const salesFromApi = rows => { const r={loja1:[],loja2:[],loja3:[],loja4:[]}; rows.forEach(s=>{ const sid=s.store_id; if(r[sid]) r[sid].push({...s,storeId:s.store_id,customerId:s.customer_id,customerWhatsapp:s.customer_whatsapp,sellerId:s.seller_id,discountLabel:s.discount_label,canceledBy:s.canceled_by,canceledAt:s.canceled_at,subtotal:parseFloat(s.subtotal||0),discount:parseFloat(s.discount||0),total:parseFloat(s.total||0)}); }); return r; };
const expFromApi = rows => { const r={loja1:[],loja2:[],loja3:[],loja4:[]}; rows.forEach(e=>{ if(r[e.store_id]) r[e.store_id].push(e); }); return r; };
const exchFromApi = rows => { const r={loja1:[],loja2:[],loja3:[],loja4:[]}; rows.forEach(e=>{ if(r[e.store_id]) r[e.store_id].push(e); }); return r; };
const empFromApi = e => ({ ...e, storeId: e.store_id });
const sellerFromApi = s => ({ ...s, salesCount: s.sales_count||0, totalSold: parseFloat(s.total_sold||0), storeId: s.store_id });
const payrollFromApi = p => ({ ...p, empId:p.emp_id, empName:p.emp_name, empCpf:p.emp_cpf, empRole:p.emp_role, empPix:p.emp_pix, storeId:p.store_id, storeName:p.store_name, baseSalary:parseFloat(p.base_salary||0), metaBonus:parseFloat(p.meta_bonus||0), awards:parseFloat(p.awards||0), overtime:parseFloat(p.overtime||0), storeDiscount:parseFloat(p.store_discount||0), advances:parseFloat(p.advances||0), otherDeductions:parseFloat(p.other_deductions||0), totalEarnings:parseFloat(p.total_earnings||0), totalDeductions:parseFloat(p.total_deductions||0), netPay:parseFloat(p.net_pay||0), paidDate:p.paid_date });
const promoFromApi = p => ({ ...p, minPurchase: parseFloat(p.min_purchase||0), validUntil: p.valid_until, usageCount: p.usage_count||0 });
const promoToApi = p => ({ ...p, min_purchase: p.minPurchase||0, valid_until: p.validUntil||'', usage_count: p.usageCount||0 });

// ─── STORES ───
const STORES = [
  { id:"loja1", name:"D'Black Divino-MG", color:"#FFD740", stockId:"loja1" },
  { id:"loja2", name:"D'Black São João-MG", color:"#40C4FF", stockId:"loja2" },
  { id:"loja3", name:"D'Black Matriz", color:"#E040FB", stockId:"shared_matriz" },
  { id:"loja4", name:"D'Black E-commerce", color:"#00E676", stockId:"shared_matriz" },
];
// stockId: lojas com mesmo stockId compartilham o mesmo estoque físico
// loja3 (Matriz) e loja4 (E-commerce) → mesmo estoque "shared_matriz"
// Tudo mais (vendas, despesas, metas, caixa, faturamento) é SEPARADO

// ─── ROLES & PERMISSIONS ───
const ROLES = {
  admin:{ label:"Administrador", permissions:["all"] },
  gestor:{ label:"Gestor", permissions:["dashboard_geral","ver_todas_lojas","vendas","estoque","crm","financeiro","despesas","comissoes","trocas","etiquetas","fidelidade","promos","caixa","whatsapp","investimentos"] },
  gerente:{ label:"Gerente de Loja", permissions:["dashboard_loja","vendas","estoque","crm","caixa","trocas","comissoes","etiquetas","despesas","whatsapp","fidelidade"] },
  vendedor:{ label:"Vendedor", permissions:["vendas","caixa","trocas","etiquetas"] },
  caixa:{ label:"Operador de Caixa", permissions:["vendas","caixa","trocas","estoque","despesas","dashboard_loja"] },
};

// ─── USERS ───
const INIT_USERS = [
  { id:"u1", name:"Denilson", email:"denilson@dblack.com", password:"admin123", role:"admin", storeId:"all", active:true, avatar:"DN" },
  { id:"u2", name:"Ana Beatriz", email:"ana@dblack.com", password:"ana123", role:"gerente", storeId:"loja1", active:true, avatar:"AB" },
  { id:"u3", name:"Carlos Silva", email:"carlos@dblack.com", password:"carlos123", role:"vendedor", storeId:"loja1", active:true, avatar:"CS" },
  { id:"u4", name:"Diego Ramos", email:"diego@dblack.com", password:"diego123", role:"vendedor", storeId:"loja2", active:true, avatar:"DR" },
  { id:"u5", name:"Fernanda Lima", email:"fer@dblack.com", password:"fer123", role:"gerente", storeId:"loja2", active:true, avatar:"FL" },
  { id:"u6", name:"Gabriel Costa", email:"gab@dblack.com", password:"gabriel123", role:"gestor", storeId:"all", active:true, avatar:"GC" },
];

// ─── CATALOG (shared across stores) ───
const CATALOG = [
  { id:"p1", name:"Camiseta Oversized Premium", sku:"CAM-001", ean:"7891234560011", ref:"REF-001", category:"Camisetas", brand:"D'Black", supplier:"SP Têxtil", size:"M", color:"Preto", price:149.90, cost:45, margin:0, minStock:10, img:"👕", variations:["P","M","G","GG"], active:true },
  { id:"p2", name:"Calça Cargo Streetwear", sku:"CAL-002", ean:"7891234560022", ref:"REF-002", category:"Calças", brand:"D'Black", supplier:"SP Têxtil", size:"42", color:"Verde Militar", price:279.90, cost:95, margin:0, minStock:8, img:"👖", variations:["38","40","42","44","46"], active:true },
  { id:"p3", name:"Jaqueta Corta-Vento", sku:"JAQ-003", ean:"7891234560033", ref:"REF-003", category:"Jaquetas", brand:"D'Black", supplier:"SP Têxtil", size:"G", color:"Preto", price:389.90, cost:140, margin:0, minStock:5, img:"🧥", variations:["P","M","G","GG"], active:true },
  { id:"p4", name:"Boné Aba Reta D'Black", sku:"BON-004", ean:"7891234560044", ref:"REF-004", category:"Acessórios", brand:"D'Black", supplier:"Acessórios Premium", size:"Único", color:"Preto/Dourado", price:89.90, cost:22, margin:0, minStock:15, img:"🧢", variations:[], active:true },
  { id:"p5", name:"Corrente Aço Cirúrgico", sku:"ACE-005", ean:"7891234560055", ref:"REF-005", category:"Acessórios", brand:"D'Black", supplier:"Acessórios Premium", size:"60cm", color:"Prata", price:129.90, cost:35, margin:0, minStock:10, img:"⛓️", variations:["45cm","60cm"], active:true },
  { id:"p6", name:"Tênis Urban Runner", sku:"TEN-006", ean:"7891234560066", ref:"REF-006", category:"Calçados", brand:"D'Black", supplier:"CalçaBR", size:"42", color:"Preto/Branco", price:459.90, cost:180, margin:0, minStock:6, img:"👟", variations:["38","39","40","41","42","43","44"], active:true },
  { id:"p7", name:"Moletom Canguru D'Black", sku:"MOL-007", ean:"7891234560077", ref:"REF-007", category:"Moletons", brand:"D'Black", supplier:"SP Têxtil", size:"GG", color:"Cinza Escuro", price:249.90, cost:85, margin:0, minStock:8, img:"🧶", variations:["P","M","G","GG"], active:true },
  { id:"p8", name:"Bermuda Jogger", sku:"BER-008", ean:"7891234560088", ref:"REF-008", category:"Bermudas", brand:"D'Black", supplier:"SP Têxtil", size:"M", color:"Preto", price:159.90, cost:50, margin:0, minStock:10, img:"🩳", variations:["P","M","G","GG"], active:true },
  { id:"p9", name:"Óculos de Sol Polarizado", sku:"OCU-009", ean:"7891234560099", ref:"REF-009", category:"Acessórios", brand:"D'Black", supplier:"Acessórios Premium", size:"Único", color:"Preto Fosco", price:199.90, cost:60, margin:0, minStock:8, img:"🕶️", variations:[], active:true },
  { id:"p10", name:"Relógio Digital Sport", sku:"REL-010", ean:"7891234560100", ref:"REF-010", category:"Acessórios", brand:"D'Black", supplier:"Acessórios Premium", size:"Único", color:"Preto/Dourado", price:349.90, cost:120, margin:0, minStock:5, img:"⌚", variations:[], active:true },
];
// Auto-calc margins (markup sobre custo)
CATALOG.forEach(p=>{p.margin=p.cost>0?((p.price-p.cost)/p.cost*100):0;});

const CATEGORIES = ["Camisetas","Calças","Jaquetas","Acessórios","Calçados","Moletons","Bermudas","Vestidos","Conjuntos","Bolsas"];
const EMOJIS = ["👕","👖","🧥","🧢","⛓️","👟","🧶","🩳","🕶️","⌚","👗","👜","🧤","🧣","👔","🩱","🎒","💍"];

// ─── PER-STORE STOCK (uses stockId, not store id) ───
const INIT_STOCK = {
  loja1:{ p1:38, p2:22, p3:5, p4:45, p5:30, p6:12, p7:18, p8:25, p9:20, p10:8 },
  loja2:{ p1:25, p2:15, p3:8, p4:30, p5:20, p6:10, p7:12, p8:18, p9:15, p10:5 },
  shared_matriz:{ p1:70, p2:46, p3:13, p4:85, p5:60, p6:23, p7:35, p8:50, p9:34, p10:16 },
};
// Helper: get stockId for a store
const getStockId = (storeId) => (STORES.find(s=>s.id===storeId)||{}).stockId || storeId;

// ─── PER-STORE SALES ───
const INIT_SALES = { loja1:[], loja2:[], loja3:[], loja4:[] };

const INIT_EXPENSES = { loja1:[], loja2:[], loja3:[], loja4:[] };

const INIT_CASH = { loja1:{open:false,initial:0,history:[]}, loja2:{open:false,initial:0,history:[]}, loja3:{open:false,initial:0,history:[]}, loja4:{open:false,initial:0,history:[]} };

const INIT_CUSTOMERS = [];

const INIT_INVESTMENTS = [];

// ─── ICONS ───
const I = {
  dash:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  pdv:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  box:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  users:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  chart:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>,
  award:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>,
  store:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  search:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  plus:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  check:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  alert:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  money:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  lock:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  unlock:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>,
  menu:<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  x:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  key:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  logout:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  globe:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  minus:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  trash:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  cart:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>,
  printer:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
  star:<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
};

// ─── COLORS ───
const C = { bg:"#0A0A0C", s1:"#111114", s2:"#18181C", s3:"#1F1F24", brd:"rgba(255,215,64,0.08)", brdH:"rgba(255,215,64,0.2)", gold:"#FFD740", goldD:"#FF8F00", txt:"#EEEEF0", dim:"rgba(255,255,255,0.75)", grn:"#00E676", red:"#FF5252", blu:"#40C4FF", pur:"#E040FB", org:"#FF6D00" };

// ════════════════════════════════════════
// ═══  MAIN APP — LOGIN + MULTISTORE  ═══
// ════════════════════════════════════════
export default function App() {
  // Auth
  const [loggedUser, setLoggedUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [users, setUsers] = useState(() => ls('users', INIT_USERS));
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");

  // Store selection
  const [activeStore, setActiveStore] = useState("loja1");
  const [tab, setTab] = useState("dashboard");
  const [sideOpen, setSideOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [apiLoaded, setApiLoaded] = useState(false);

  // Global data — carregados do localStorage (persistem ao fechar o app)
  const [catalog, setCatalog] = useState(() => ls('catalog', CATALOG));
  const [stock, setStock] = useState(() => ls('stock', INIT_STOCK));
  const [sales, setSales] = useState(() => ls('sales', INIT_SALES));
  const [expenses, setExpenses] = useState(() => ls('expenses', INIT_EXPENSES));
  const [customers, setCustomers] = useState(() => ls('customers', INIT_CUSTOMERS));
  const [cashState, setCashState] = useState(() => ls('cashState', INIT_CASH));
  const [receiptSale, setReceiptSale] = useState(null);
  const [investments, setInvestments] = useState(() => ls('investments', INIT_INVESTMENTS));
  const [promos, setPromos] = useState(() => ls('promos', [
    {id:"pr1",name:"PRETA10",type:"percent",value:10,minPurchase:200,active:true,validUntil:"2026-04-30",usageCount:12},
    {id:"pr2",name:"FRETE0",type:"fixed",value:25,minPurchase:0,active:true,validUntil:"2026-05-15",usageCount:8},
  ]));
  const [exchanges, setExchanges] = useState(() => ls('exchanges', {loja1:[],loja2:[],loja3:[],loja4:[]}));
  const [sellers, setSellers] = useState(() => ls('sellers', [
    {id:"u2",name:"Ana Beatriz",commission:10,salesCount:15,totalSold:6500,avatar:"AB",storeId:"loja1"},
    {id:"u3",name:"Carlos Silva",commission:8,salesCount:12,totalSold:4800,avatar:"CS",storeId:"loja1"},
    {id:"u4",name:"Diego Ramos",commission:8,salesCount:10,totalSold:3800,avatar:"DR",storeId:"loja2"},
    {id:"u5",name:"Fernanda Lima",commission:10,salesCount:18,totalSold:7200,avatar:"FL",storeId:"loja2"},
  ]));
  const [employees, setEmployees] = useState(() => ls('employees', [
    {id:"emp1",name:"Ana Beatriz",cpf:"111.222.333-44",role:"Gerente",storeId:"loja1",salary:3200,pix:"ana@pix.com",admission:"2024-03-01",active:true},
    {id:"emp2",name:"Carlos Silva",cpf:"222.333.444-55",role:"Vendedor",storeId:"loja1",salary:1800,pix:"carlos@pix.com",admission:"2024-06-15",active:true},
    {id:"emp3",name:"Diego Ramos",cpf:"333.444.555-66",role:"Vendedor",storeId:"loja2",salary:1800,pix:"diego@pix.com",admission:"2025-01-10",active:true},
    {id:"emp4",name:"Fernanda Lima",cpf:"444.555.666-77",role:"Gerente",storeId:"loja2",salary:3200,pix:"fer@pix.com",admission:"2024-02-20",active:true},
    {id:"emp5",name:"Gustavo Reis",cpf:"555.666.777-88",role:"Vendedor",storeId:"loja3",salary:1800,pix:"gus@pix.com",admission:"2025-03-01",active:true},
    {id:"emp6",name:"Helena Souza",cpf:"666.777.888-99",role:"Caixa",storeId:"loja3",salary:1600,pix:"helena@pix.com",admission:"2025-06-01",active:true},
    {id:"emp7",name:"Igor Santos",cpf:"777.888.999-00",role:"Vendedor",storeId:"loja4",salary:1800,pix:"igor@pix.com",admission:"2025-04-01",active:true},
  ]));
  const [payrolls, setPayrolls] = useState(() => ls('payrolls', [
    {id:"pay1",month:"2026-03",empId:"emp1",empName:"Ana Beatriz",storeId:"loja1",baseSalary:3200,metaBonus:500,awards:200,overtime:0,storeDiscount:150,advances:0,otherDeductions:0,totalEarnings:3900,totalDeductions:150,netPay:3750,paid:true,paidDate:"2026-04-05",notes:"Bateu meta de março"},
    {id:"pay2",month:"2026-03",empId:"emp2",empName:"Carlos Silva",storeId:"loja1",baseSalary:1800,metaBonus:0,awards:0,overtime:180,storeDiscount:80,advances:200,otherDeductions:0,totalEarnings:1980,totalDeductions:280,netPay:1700,paid:true,paidDate:"2026-04-05",notes:""},
  ]));
  const [withdrawals, setWithdrawals] = useState(() => ls('withdrawals', []));
  const [advances, setAdvances] = useState(() => ls('advances', []));
  const [expenseCategories, setExpenseCategories] = useState(() => ls('expenseCategories', ["Aluguel","Energia","Água","Internet","Funcionários","Marketing","Manutenção","Material","Impostos","Transporte","Alimentação","Fornecedor","Outros"]));

  // ─── AUTO-SAVE no localStorage ───
  useEffect(() => { lsSave('users', users); }, [users]);
  useEffect(() => { lsSave('catalog', catalog); }, [catalog]);
  useEffect(() => { lsSave('stock', stock); }, [stock]);
  useEffect(() => { lsSave('sales', sales); }, [sales]);
  useEffect(() => { lsSave('expenses', expenses); }, [expenses]);
  useEffect(() => { lsSave('customers', customers); }, [customers]);
  useEffect(() => { lsSave('cashState', cashState); }, [cashState]);
  useEffect(() => { lsSave('investments', investments); }, [investments]);
  useEffect(() => { lsSave('promos', promos); }, [promos]);
  useEffect(() => { lsSave('exchanges', exchanges); }, [exchanges]);
  useEffect(() => { lsSave('sellers', sellers); }, [sellers]);
  useEffect(() => { lsSave('employees', employees); }, [employees]);
  useEffect(() => { lsSave('payrolls', payrolls); }, [payrolls]);
  useEffect(() => { lsSave('withdrawals', withdrawals); }, [withdrawals]);
  useEffect(() => { lsSave('advances', advances); }, [advances]);
  useEffect(() => { lsSave('expenseCategories', expenseCategories); }, [expenseCategories]);

  // ─── INICIALIZA QZ TRAY — colocado APÓS a definição de showToast ───

  // ─── RESTAURA SESSÃO AO ABRIR O APP ───
  useEffect(() => {
    api.me().then(user => {
      if (user?.id) {
        setLoggedUser({ ...user, storeId: user.store_id || 'all' });
        const sid = user.store_id;
        if (sid && sid !== 'all') setActiveStore(sid);
      }
    }).catch(() => {}).finally(() => setCheckingSession(false));
  }, []);

  // ─── CARREGA DADOS DA API APÓS LOGIN + AUTO-REFRESH 30s ───
  const loadAllData = useCallback((silent=false) => {
    // Não tenta carregar do servidor se estiver offline
    if (!navigator.onLine) { if(!silent) setApiLoaded(true); return Promise.resolve(); }
    if(!silent) setApiLoaded(false);
    return Promise.all([
      api.getProducts(),
      api.getStock(),
      api.getSales(),
      api.getCustomers(),
      api.getExpenses(),
      api.getEmployees(),
      api.getPayrolls(),
      api.getSellers(),
      api.getExchanges(),
      api.getPromos(),
      api.getInvestments(),
      api.getUsers(),
      api.getWithdrawals(),
      api.getAdvances(),
      api.getExpenseCategories(),
    ]).then(([prods,stk,sls,custs,exps,emps,pays,sels,exchs,proms,invs,usrs,wdrs,advs,expCats]) => {
      if(prods?.length) setCatalog(prods.map(prodFromApi));
      if(stk&&Object.keys(stk).length) setStock(stk);
      if(sls?.length){
        // Sincroniza vendas locais que não existem no servidor (ex: feitas offline)
        const apiSales=salesFromApi(sls);
        const localSales=ls('sales',{loja1:[],loja2:[],loja3:[],loja4:[]});
        const apiIds=new Set(sls.map(s=>s.id));
        let synced=0;
        Object.keys(localSales).forEach(store=>{
          (localSales[store]||[]).forEach(sale=>{
            if(sale.id&&!apiIds.has(sale.id)&&sale.status!=="Cancelada"){
              api.createSale({...sale,store_id:sale.storeId||store,customer_id:sale.customerId||'',customer_whatsapp:sale.customerWhatsapp||'',seller_id:sale.sellerId||'',discount_label:sale.discountLabel||'',stock_id:''}).catch(console.error);
              if(!apiSales[store])apiSales[store]=[];
              apiSales[store].unshift(sale);
              synced++;
            }
          });
        });
        if(synced>0) console.log('[SYNC] '+synced+' vendas locais enviadas ao servidor');
        setSales(apiSales);
      }
      if(custs?.length) setCustomers(custs.map(custFromApi));
      setExpenses(exps?.length ? expFromApi(exps) : {loja1:[],loja2:[],loja3:[],loja4:[]});
      if(emps?.length) setEmployees(emps.map(empFromApi));
      if(pays?.length) setPayrolls(pays.map(payrollFromApi));
      if(sels?.length) setSellers(sels.map(sellerFromApi));
      if(exchs?.length){
        const apiExchs=exchFromApi(exchs);
        const localExchs=ls('exchanges',{loja1:[],loja2:[],loja3:[],loja4:[]});
        const apiExchIds=new Set(exchs.map(e=>e.id));
        Object.keys(localExchs).forEach(store=>{
          (localExchs[store]||[]).forEach(ex=>{
            if(ex.id&&!apiExchIds.has(ex.id)&&ex.status!=="Cancelada"){
              api.createExchange({...ex,store_id:store,cupom_original:ex.cupomOriginal||ex.cupom_original||'',new_items:ex.newItems||[]}).catch(console.error);
              if(!apiExchs[store])apiExchs[store]=[];
              apiExchs[store].unshift(ex);
            }
          });
        });
        setExchanges(apiExchs);
      }
      if(proms?.length) setPromos(proms.map(promoFromApi));
      if(invs?.length) setInvestments(invs);
      if(usrs?.length) setUsers(usrs);
      setWithdrawals(wdrs?.length ? wdrs.map(w=>({...w,storeId:w.store_id,createdAt:w.created_at})) : []);
      setAdvances(advs?.length ? advs.map(a=>({...a,storeId:a.store_id,empId:a.emp_id,empName:a.emp_name,authorizedBy:a.authorized_by,createdAt:a.created_at})) : []);
      if(expCats?.length) setExpenseCategories(expCats.map(c=>c.name));
    }).catch(e => console.error('Erro ao carregar do servidor:', e))
      .finally(() => { if(!silent) setApiLoaded(true); });
  }, []);

  useEffect(() => {
    if (!loggedUser) return;
    loadAllData(false);
    // Tenta sincronizar fila offline ao logar (caso tenha itens presos)
    if (navigator.onLine && api.getQueueCount() > 0) {
      setTimeout(() => api.syncNow(), 2000);
    }
    // Auto-refresh a cada 30 segundos (silencioso, sem loading)
    const interval = setInterval(() => loadAllData(true), 30000);
    return () => clearInterval(interval);
  }, [loggedUser?.id]);

  const showToast = useCallback((msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast(null),3000); },[]);

  // ─── MODO OFFLINE ───
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [offlineQueue, setOfflineQueue] = useState(api.getQueueCount());

  useEffect(() => {
    const goOnline = () => { setIsOnline(true); showToast("Internet voltou! Sincronizando..."); };
    const goOffline = () => { setIsOnline(false); showToast("Sem internet — modo offline ativado","error"); };
    const queueChange = (e) => setOfflineQueue(e.detail.count);
    const syncDone = (e) => {
      if (e.detail.sent > 0) showToast(e.detail.sent + " ações sincronizadas com o servidor!");
      setOfflineQueue(e.detail.remaining);
      if (e.detail.remaining === 0 && loggedUser) loadAllData(true);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    window.addEventListener('offlineQueueChange', queueChange);
    window.addEventListener('offlineSyncDone', syncDone);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('offlineQueueChange', queueChange);
      window.removeEventListener('offlineSyncDone', syncDone);
    };
  }, [loggedUser]);

  // ─── INICIALIZA QZ TRAY (depois de showToast estar definido) ───
  useEffect(() => {
    _globalToast = showToast;

    // Certificado público (para QZ Tray identificar o site)
    const QZ_CERT = `-----BEGIN CERTIFICATE-----\nMIIDCzCCAfOgAwIBAgIURKOCoVnkTVwNuY4WqIeiQ00FYvQwDQYJKoZIhvcNAQEL\nBQAwFTETMBEGA1UEAwwKREJsYWNrIEVSUDAeFw0yNjA0MDYxNjU3MDBaFw0zNjA0\nMDMxNjU3MDBaMBUxEzARBgNVBAMMCkRCbGFjayBFUlAwggEiMA0GCSqGSIb3DQEB\nAQUAA4IBDwAwggEKAoIBAQCiEB7ITZpq59ecJyjBkfapVTsClOdBp69qid4DwoKK\nFK3LRI85W6CfuVQBFnFb/8LvnFxsSqKnlJ+KqokxCcFxVvd6wwhRQc/6uOsRC7sh\n8qbpI8UDK7voaVt4ztqZjp27APt2PbbiiKTTuuBMlgCaTUGhQNhxpHJMm1KO2qKA\nh+Ljys0I8d3gGLfgxAat13R51I4+qUa5WD+YQzZ41Opu+pS63M9QTRD7MCUevew7\n4DmVPPrjVw0ftlkvBfI9ReiTKnViOiUzTJxAqo2y+B0Gesp319ZwIynvcJAZ5wGB\nFBkHcFpVnTRnl5CMRojSP+ab5k306+WQMzJuxKtQuIt/AgMBAAGjUzBRMB0GA1Ud\nDgQWBBScfVt6JXhp1mG1iOdXu6ExuGSo7TAfBgNVHSMEGDAWgBScfVt6JXhp1mG1\niOdXu6ExuGSo7TAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAH\nNmkJCztq/9/GBBFNiLOZPuOn3nDtWOpuFSeB3OhyY7rOe+GKjPvSTzmY3Il1FnxR\n+1HeO+RaWeVhmRpkckglwXFaD3kNDEO+djLZrGEuQ8JqT8tO0hrHMh4tm0E96/pe\nhYGYd20IW2Z4PcOL9UdFDpRQ1HF2Ht5T9ZZ4dPBll6jjS29Xf6hKO/RcR1tt7TLu\nLSEttkHgQEuEK604NwJ9/uDpnGA2a5vzj6wXKfbC2gqFBkEyWxHAEShVI27ku2UY\ng1+BFOIlRWTVWrmby0c7Qrv7rq9LZWgRtgobVn/X7s7sYvELudHu/TOSjsvNk1ep\ncR8LceoswU8spRqTq2ev\n-----END CERTIFICATE-----`;

    // Assina via backend (mais seguro — chave privada não fica exposta no browser)
    async function qzSign(toSign) {
      try {
        const r = await fetch('/api/qz-sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ data: toSign })
        });
        if (!r.ok) {
          if (_globalToast) _globalToast('QZ Sign erro HTTP: ' + r.status, 'error');
          return '';
        }
        const j = await r.json();
        if (!j.signature) {
          if (_globalToast) _globalToast('QZ Sign: resposta sem signature', 'error');
        }
        return j.signature || '';
      } catch(e) {
        if (_globalToast) _globalToast('QZ Sign falhou: ' + (e.message||'erro'), 'error');
        return '';
      }
    }

    async function initQz() {
      if (!window.qz) { console.log('[QZ] qz-tray.js não carregou'); return; }
      try {
        window.qz.security.setCertificatePromise(resolve => resolve(QZ_CERT));
        window.qz.security.setSignaturePromise(toSign => resolve => qzSign(toSign).then(resolve));
        if (!window.qz.websocket.isActive()) {
          // Tenta ws:// PRIMEIRO (Chrome permite ws://localhost de HTTPS)
          // Evita o problema do wss:// que trava o QZ internamente
          try {
            await window.qz.websocket.connect({ usingSecure: false, host: 'localhost', retries: 3, delay: 1000, keepAlive: 60 });
            if (_globalToast) _globalToast('✅ QZ Tray conectado!');
            console.log('[QZ] Conectado via ws://localhost');
          } catch(e1) {
            console.warn('[QZ] ws:// falhou:', e1.message||e1);
            // Fallback: tenta wss:// (para PCs com certificado instalado)
            try {
              await window.qz.websocket.connect({ retries: 2, delay: 1000, keepAlive: 60 });
              if (_globalToast) _globalToast('✅ QZ Tray conectado (wss)!');
              console.log('[QZ] Conectado via wss://');
            } catch(e2) {
              console.warn('[QZ] wss:// também falhou:', e2.message||e2);
            }
          }
        } else {
          console.log('[QZ] Já conectado');
        }
      } catch(e) { console.warn('[QZ] Erro geral:', e); }
    }

    if (window.qz) { initQz(); return; }

    const s = document.createElement('script');
    s.src = '/qz-tray.js';
    s.async = true;
    s.onload = initQz;
    s.onerror = () => {};
    document.head.appendChild(s);
  }, []); // showToast é estável (useCallback com deps [])

  // Login
  const doLogin = async () => {
    setLoginError("");
    try {
      const user = await api.login(loginUser.trim(), loginPass);
      setLoggedUser({ ...user, storeId: user.store_id || user.storeId || 'all' });
      const sid = user.store_id || user.storeId;
      if (sid && sid !== 'all') setActiveStore(sid);
      setLoginUser(""); setLoginPass("");
    } catch(e) {
      // Fallback para login local (offline)
      const id = loginUser.trim().toLowerCase();
      const u = users.find(u => (u.name.toLowerCase()===id||u.email?.toLowerCase()===id) && (u.password||u.pin)===loginPass && u.active);
      if (!u) { setLoginError(e.message||"Usuário ou senha inválidos"); return; }
      setLoggedUser(u);
      if (u.storeId !== "all") setActiveStore(u.storeId);
      setLoginUser(""); setLoginPass(""); setLoginError("");
    }
  };

  const doLogout = () => { api.logout(); setLoggedUser(null); setTab("dashboard"); };

  // Permissions
  const hasPermission = (perm) => {
    if (!loggedUser) return false;
    const role = ROLES[loggedUser.role];
    if (!role) return false;
    if (role.permissions.includes("all")) return true;
    return role.permissions.includes(perm);
  };

  const canSeeAllStores = () => {
    if (!loggedUser) return false;
    return loggedUser.storeId === "all" || hasPermission("ver_todas_lojas");
  };

  const currentStore = STORES.find(s => s.id === activeStore) || STORES[0];

  // ─── VERIFICANDO SESSÃO ───
  if (checkingSession) {
    return (
      <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Outfit',sans-serif",color:C.txt}}>
        <div style={{textAlign:"center",color:C.dim,fontSize:14}}>Carregando...</div>
      </div>
    );
  }

  // ─── LOGIN SCREEN ───
  if (!loggedUser) {
    return (
      <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Outfit',sans-serif",color:C.txt}}>
        <style>{CSS}</style>
        <div style={{width:380,maxWidth:"90%",textAlign:"center"}}>
          <img src="/logo.jpg" alt="D'Black Store" style={{width:200,height:"auto",display:"block",margin:"0 auto 8px",borderRadius:12}} />
          <div style={{fontSize:11,letterSpacing:4,color:C.dim,marginBottom:40}}>SISTEMA MULTILOJAS</div>

          <div style={{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:20,padding:32}}>
            <div style={{marginBottom:24}}>{I.lock}</div>
            <div style={{fontSize:16,fontWeight:700,marginBottom:20}}>Acesso ao Sistema</div>

            <div style={{marginBottom:12,textAlign:"left"}}>
              <label style={{fontSize:11,color:C.dim,display:"block",marginBottom:6}}>USUÁRIO</label>
              <input
                type="text"
                placeholder="Seu nome ou e-mail"
                value={loginUser}
                onChange={e => { setLoginUser(e.target.value); setLoginError(""); }}
                onKeyDown={e => e.key === "Enter" && doLogin()}
                style={{width:"100%",padding:"12px 16px",borderRadius:12,border:`1px solid ${C.brd}`,background:C.s2,color:C.txt,fontSize:15,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}
                autoFocus
              />
            </div>

            <div style={{marginBottom:16,textAlign:"left"}}>
              <label style={{fontSize:11,color:C.dim,display:"block",marginBottom:6}}>SENHA</label>
              <input
                type="password"
                placeholder="Sua senha"
                value={loginPass}
                onChange={e => { setLoginPass(e.target.value); setLoginError(""); }}
                onKeyDown={e => e.key === "Enter" && doLogin()}
                style={{width:"100%",padding:"12px 16px",borderRadius:12,border:`1px solid ${C.brd}`,background:C.s2,color:C.txt,fontSize:15,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}
              />
            </div>

            {loginError && <div style={{color:C.red,fontSize:13,marginBottom:12}}>{loginError}</div>}

            <button onClick={doLogin} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,color:C.bg,fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit",letterSpacing:2}}>
              ENTRAR
            </button>

            <div style={{marginTop:20,fontSize:11,color:C.dim,lineHeight:1.8}}>
              D'Black Store ERP — v1.0
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── TABS based on permissions ───
  const allTabs = [
    { id:"dashboard", label:"Dashboard", icon:I.dash, perm:"dashboard_loja" },
    { id:"gestor", label:"Painel Gestor", icon:I.globe, perm:"dashboard_geral" },
    { id:"pdv", label:"PDV", icon:I.pdv, perm:"vendas" },
    { id:"vendas", label:"Vendas", icon:I.chart, perm:"vendas" },
    { id:"produtos", label:"Produtos", icon:I.box, perm:"estoque" },
    { id:"estoque", label:"Estoque", icon:I.box, perm:"estoque" },
    { id:"crm", label:"CRM", icon:I.users, perm:"crm" },
    { id:"financeiro", label:"Financeiro", icon:I.chart, perm:"financeiro" },
    { id:"despesas", label:"Despesas", icon:I.money, perm:"despesas" },
    { id:"comissoes", label:"Comissões", icon:I.award, perm:"comissoes" },
    { id:"caixa", label:"Caixa", icon:I.store, perm:"caixa" },
    { id:"trocas", label:"Trocas", icon:I.cart, perm:"trocas" },
    { id:"etiquetas", label:"Etiquetas", icon:I.printer, perm:"etiquetas" },
    { id:"fidelidade", label:"Fidelidade", icon:I.star, perm:"fidelidade" },
    { id:"promos", label:"Promoções", icon:I.award, perm:"promos" },
    { id:"whatsapp", label:"WhatsApp", icon:I.users, perm:"whatsapp" },
    { id:"investimentos", label:"Investimento", icon:I.money, perm:"investimentos" },
    { id:"rh", label:"RH / Folha", icon:I.users, perm:"all" },
    { id:"usuarios", label:"Usuários", icon:I.key, perm:"all" },
  ];

  const visibleTabs = allTabs.filter(t => hasPermission(t.perm));

  // Store-specific data
  const storeSales = sales[activeStore] || [];
  const activeStockId = getStockId(activeStore);
  const storeStock = stock[activeStockId] || {};
  const storeExpenses = expenses[activeStore] || [];
  const cashKey = activeStore + "_" + (loggedUser?.id || "main");
  const storeCash = cashState[cashKey] || { open:false, initial:0, history:[] };
  const sharedStockStores = STORES.filter(s=>s.stockId===activeStockId);
  const isSharedStock = sharedStockStores.length > 1;

  const storeProducts = catalog.map(p => ({...p, stock: storeStock[p.id] || 0}));
  const _todayStr = new Date().toISOString().split("T")[0];
  const todaySales = storeSales.filter(s => s.date === _todayStr && s.status !== "Cancelada");
  const todayRev = todaySales.reduce((s,v) => s + v.total, 0);
  const totalRev = storeSales.filter(s => s.status !== "Cancelada").reduce((s,v) => s + v.total, 0);
  const lowStock = storeProducts.filter(p => p.stock <= p.minStock);
  const storeExchanges = exchanges[activeStore] || [];
  const storeSellers = sellers.filter(s => s.storeId === activeStore);

  // All stores aggregated (for gestor)
  const allSales = Object.values(sales).flat();
  const allExpenses = Object.values(expenses).flat();

  return (
    <div style={S.app}>
      <style>{CSS}</style>

      {/* BANNER OFFLINE */}
      {(!isOnline || offlineQueue > 0) && <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9999,padding:"6px 16px",background:isOnline?"linear-gradient(90deg,#1565C0,#0D47A1)":"linear-gradient(90deg,#B71C1C,#880E4F)",color:"#fff",fontSize:12,fontWeight:700,fontFamily:"Outfit,sans-serif",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {!isOnline && <><span style={{fontSize:16}}>📡</span> MODO OFFLINE — suas ações estão sendo salvas localmente</>}
        {isOnline && offlineQueue > 0 && <><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>🔄</span> Sincronizando {offlineQueue} ação(ões) pendente(s)...</>}
        {offlineQueue > 0 && <span style={{background:"rgba(255,255,255,.2)",borderRadius:10,padding:"2px 8px",fontSize:11}}>{offlineQueue} na fila</span>}
        {isOnline && offlineQueue > 0 && <button onClick={()=>{api.syncNow();showToast("Forçando sincronização...");}} style={{background:"rgba(255,255,255,.25)",border:"none",color:"#fff",borderRadius:8,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Sincronizar agora</button>}
      </div>}

      {/* SIDEBAR */}
      <aside style={{...S.side,...(sideOpen?S.sideOn:{})}}>
        <div style={S.logoBox}>
          <img src="/logo.jpg" alt="D'Black Store" style={{width:140,height:"auto",display:"block",margin:"0 auto 2px",borderRadius:8}} />
          <div style={S.logoSub}>SISTEMA MULTILOJAS</div>
          <button style={S.closeBtn} onClick={() => setSideOpen(false)}>{I.x}</button>
        </div>

        {/* Store Selector */}
        {canSeeAllStores() ? (
          <div style={{padding:"10px 10px 6px"}}>
            <select style={{...S.sel,width:"100%",fontSize:12,padding:"8px 10px",borderColor:currentStore.color+"44",color:currentStore.color}} value={activeStore} onChange={e => setActiveStore(e.target.value)}>
              {STORES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ) : (
          <div style={{padding:"10px 14px",fontSize:12,color:currentStore.color,fontWeight:700,borderBottom:`1px solid ${C.brd}`}}>
            {I.store} <span style={{marginLeft:6}}>{currentStore.name}</span>
          </div>
        )}

        <nav style={S.nav}>
          {visibleTabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setSideOpen(false); }} style={{...S.navBtn,...(tab===t.id?S.navAct:{})}}>
              <span style={S.navIc}>{t.icon}</span><span>{t.label}</span>
            </button>
          ))}
        </nav>

        {/* User info + Logout */}
        <div style={{padding:"12px 14px",borderTop:`1px solid ${C.brd}`,display:"flex",alignItems:"center",gap:10}}>
          <div style={S.avatar}>{loggedUser.avatar}</div>
          <div style={{flex:1,overflow:"hidden"}}>
            <div style={{fontSize:12,fontWeight:700}}>{loggedUser.name}</div>
            <div style={{fontSize:10,color:C.dim}}>{ROLES[loggedUser.role]?.label}</div>
          </div>
          <button onClick={doLogout} style={{background:"none",border:"none",color:C.red,cursor:"pointer",display:"flex",padding:4}}>{I.logout}</button>
        </div>
      </aside>

      {sideOpen && <div style={S.overlay} onClick={() => setSideOpen(false)} />}

      {/* MAIN */}
      <main style={S.main}>
        <header style={S.topbar}>
          <button style={S.menuBtn} onClick={() => setSideOpen(true)}>{I.menu}</button>
          <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
            <h1 style={S.pageTitle}>{visibleTabs.find(t => t.id === tab)?.label || "Dashboard"}</h1>
            <span style={{fontSize:11,padding:"3px 10px",borderRadius:8,background:currentStore.color+"18",color:currentStore.color,fontWeight:700,border:`1px solid ${currentStore.color}33`}}>{currentStore.name}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:11,color:C.dim,display:"flex",alignItems:"center",gap:4}}>{I.store} <span>{loggedUser.name}</span></div>
          </div>
        </header>

        <div style={S.content}>
          {/* DASHBOARD DA LOJA */}
          {tab==="dashboard" && <StoreDashboard {...{storeProducts,storeSales,todaySales,todayRev,totalRev,lowStock,storeExpenses,currentStore,storeCash,customers,isSharedStock,sharedStockStores}} />}

          {/* PAINEL GESTOR (todas as lojas) */}
          {tab==="gestor" && <GestorPanel {...{sales,expenses,stock,catalog,customers,investments,cashState}} />}

          {/* PDV */}
          {tab==="pdv" && <PDVModule {...{storeProducts,storeSales,activeStore,stock,setStock,sales,setSales,customers,setCustomers,users,storeCash,cashState,setCashState,catalog,loggedUser,showToast,activeStockId,receiptSale,setReceiptSale}} />}

          {/* PRODUTOS (Cadastro) */}
          {tab==="produtos" && <ProdutosModule {...{catalog,setCatalog,stock,setStock,showToast}} />}

          {/* ESTOQUE */}
          {tab==="estoque" && <EstoqueModule {...{storeProducts,activeStore,stock,setStock,currentStore,catalog,showToast,activeStockId,isSharedStock,sharedStockStores}} />}

          {/* DESPESAS */}
          {tab==="despesas" && <DespesasModule {...{storeExpenses,activeStore,expenses,setExpenses,currentStore,showToast,expenseCategories,setExpenseCategories,cashState,setCashState,loggedUser}} />}

          {/* VENDAS */}
          {tab==="vendas" && <VendasModule {...{storeSales,sales,setSales,activeStore,exchanges,setExchanges,users,loggedUser,showToast,stock,setStock,getStockId,cashState,setCashState}} />}

          {/* CAIXA */}
          {tab==="caixa" && <CaixaModule {...{storeCash,activeStore,cashState,setCashState,storeSales,showToast,loggedUser,withdrawals,setWithdrawals,advances,setAdvances,employees}} />}

          {/* RH / FOLHA */}
          {tab==="rh" && <RHModule {...{employees,setEmployees,payrolls,setPayrolls,advances,showToast}} />}

          {/* USUÁRIOS */}
          {tab==="usuarios" && <UsersModule {...{users,setUsers,showToast,loggedUser}} />}

          {/* CRM */}
          {tab==="crm" && <CRMModule {...{customers,setCustomers,storeSales,showToast}} />}

          {/* FINANCEIRO */}
          {tab==="financeiro" && <FinanceiroModule {...{storeSales,storeProducts,storeExpenses,storeSellers,totalRev,currentStore}} />}

          {/* COMISSÕES */}
          {tab==="comissoes" && <ComissoesModule {...{storeSellers,sellers,setSellers,storeSales,showToast}} />}

          {/* TROCAS */}
          {tab==="trocas" && <TrocasModule {...{storeExchanges,exchanges,setExchanges,storeSales,storeProducts,activeStore,stock,setStock,showToast,activeStockId,cashState,setCashState,loggedUser}} />}

          {/* ETIQUETAS */}
          {tab==="etiquetas" && <EtiquetasModule {...{storeProducts,showToast}} />}

          {/* FIDELIDADE */}
          {tab==="fidelidade" && <FidelidadeModule {...{customers,setCustomers,showToast}} />}

          {/* PROMOÇÕES */}
          {tab==="promos" && <PromosModule {...{promos,setPromos,showToast}} />}

          {/* WHATSAPP */}
          {tab==="whatsapp" && <WhatsAppModule {...{customers}} />}

          {/* INVESTIMENTOS */}
          {tab==="investimentos" && <InvestimentosModule {...{investments,setInvestments,showToast}} />}
        </div>
      </main>

      {toast && <div style={{...S.toast,...(toast.type==="error"?S.toastErr:{})}}>{toast.type==="error"?I.alert:I.check}<span>{toast.msg}</span></div>}

      {/* BLACK IA — Chat de Suporte */}
      {loggedUser && <ChatWidget loggedUser={loggedUser} activeStore={activeStore} showToast={showToast} />}
    </div>
  );
}

// ═══════════════════════════════════
// ═══  BLACK IA — CHAT WIDGET     ═══
// ═══════════════════════════════════
function ChatWidget({loggedUser,activeStore,showToast}){
  const [open,setOpen]=useState(false);
  const [messages,setMessages]=useState([]); // {role:'user'|'assistant', content:string}
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [convId,setConvId]=useState(null);
  const endRef=useRef(null);

  // Auto-scroll para a última mensagem
  useEffect(()=>{
    if(endRef.current) endRef.current.scrollIntoView({behavior:"smooth"});
  },[messages,loading]);

  const enviar=async(texto)=>{
    const msg=texto||input.trim();
    if(!msg||loading) return;
    setInput("");
    setMessages(prev=>[...prev,{role:"user",content:msg}]);
    setLoading(true);
    try{
      const res=await api.agentChat({message:msg,conversationId:convId});
      if(res.conversationId) setConvId(res.conversationId);
      setMessages(prev=>[...prev,{role:"assistant",content:res.message||"Desculpe, não consegui processar sua mensagem."}]);
    }catch(e){
      setMessages(prev=>[...prev,{role:"assistant",content:"Erro de conexão. Tente novamente."}]);
    }finally{
      setLoading(false);
    }
  };

  const novaConversa=()=>{setMessages([]);setConvId(null);};

  const sugestoes=["Como abrir o caixa?","Verificar estoque de um produto","Consultar vendas de hoje","Preciso cancelar uma venda"];

  // Estilos do chat
  const chatBtn={position:"fixed",bottom:24,right:24,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,border:"none",cursor:"pointer",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 4px 20px rgba(255,215,64,.3)`,transition:"transform .15s"};
  const panel={position:"fixed",top:0,right:0,bottom:0,width:380,maxWidth:"100vw",background:C.s1,borderLeft:`1px solid ${C.brd}`,zIndex:998,display:"flex",flexDirection:"column",transform:open?"translateX(0)":"translateX(100%)",transition:"transform .25s ease",boxShadow:open?"-8px 0 30px rgba(0,0,0,.4)":"none"};
  const header={padding:"14px 18px",background:C.s2,borderBottom:`1px solid ${C.brd}`,display:"flex",alignItems:"center",gap:12};
  const msgArea={flex:1,overflowY:"auto",padding:"16px 14px",display:"flex",flexDirection:"column",gap:10};
  const userBubble={alignSelf:"flex-end",background:`rgba(255,215,64,.15)`,border:`1px solid rgba(255,215,64,.2)`,color:C.txt,borderRadius:"14px 14px 4px 14px",padding:"10px 14px",maxWidth:"85%",fontSize:13,lineHeight:1.5,wordBreak:"break-word"};
  const aiBubble={alignSelf:"flex-start",background:C.s2,border:`1px solid ${C.brd}`,color:C.txt,borderRadius:"14px 14px 14px 4px",padding:"10px 14px",maxWidth:"85%",fontSize:13,lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-word"};
  const inputArea={padding:"12px 14px",borderTop:`1px solid ${C.brd}`,background:C.s2,display:"flex",gap:8};

  return <>
    {/* Botão flutuante */}
    {!open&&<button style={chatBtn} onClick={()=>setOpen(true)} title="Black IA — Suporte"
      onMouseDown={e=>e.currentTarget.style.transform="scale(.92)"}
      onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
      onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>}

    {/* Painel do chat */}
    <div style={panel}>
      {/* Header */}
      <div style={header}>
        <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:14,color:C.gold}}>Black IA</div>
          <div style={{fontSize:11,color:C.dim}}>Suporte inteligente</div>
        </div>
        <button onClick={novaConversa} style={{background:"none",border:`1px solid ${C.brd}`,color:C.dim,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:10,fontFamily:"inherit"}} title="Nova conversa">Nova</button>
        <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:18,padding:"4px"}}>✕</button>
      </div>

      {/* Mensagens */}
      <div style={msgArea}>
        {messages.length===0&&!loading&&<>
          <div style={{textAlign:"center",padding:"30px 10px",color:C.dim}}>
            <div style={{fontSize:40,marginBottom:10}}>🤖</div>
            <div style={{fontSize:15,fontWeight:600,color:C.gold,marginBottom:6}}>Olá, {loggedUser.name.split(" ")[0]}!</div>
            <div style={{fontSize:12,marginBottom:20}}>Sou a Black IA, sua assistente de suporte. Como posso te ajudar?</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {sugestoes.map(s=><button key={s} onClick={()=>enviar(s)} style={{background:C.s2,border:`1px solid ${C.brd}`,borderRadius:10,color:C.txt,padding:"10px 14px",fontSize:12,cursor:"pointer",fontFamily:"inherit",textAlign:"left",transition:"border-color .15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=C.gold}
                onMouseLeave={e=>e.currentTarget.style.borderColor=C.brd}>
                {s}
              </button>)}
            </div>
          </div>
        </>}

        {messages.map((m,i)=><div key={i} style={m.role==="user"?userBubble:aiBubble}>{m.content}</div>)}

        {loading&&<div style={{...aiBubble,color:C.dim}}>
          <span style={{animation:"pulse 1.2s infinite"}}>Analisando...</span>
        </div>}

        <div ref={endRef}/>
      </div>

      {/* Input */}
      <div style={inputArea}>
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();enviar();}}}
          placeholder="Digite sua dúvida..."
          style={{...S.inp,flex:1,fontSize:13,borderRadius:10}}
          disabled={loading}/>
        <button onClick={()=>enviar()} disabled={loading||!input.trim()}
          style={{background:input.trim()&&!loading?C.gold:"rgba(255,215,64,.2)",border:"none",borderRadius:10,width:42,cursor:input.trim()&&!loading?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",transition:"background .15s"}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={input.trim()&&!loading?"#000":C.dim} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>

    {/* Overlay quando chat aberto em mobile */}
    {open&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",zIndex:997}} onClick={()=>setOpen(false)}/>}
  </>;
}

// ─── KPI CARD ───
function KPI({icon,label,value,sub,color}){
  return <div style={S.kpi}><div style={{...S.kpiIc,background:color+"22",color}}>{icon}</div><div style={S.kpiInfo}><div style={S.kpiLabel}>{label}</div><div style={S.kpiVal}>{value}</div><div style={S.kpiSub}>{sub}</div></div></div>;
}

// ═══════════════════════════════════
// ═══  STORE DASHBOARD            ═══
// ═══════════════════════════════════
function StoreDashboard({storeProducts,storeSales,todaySales,todayRev,totalRev,lowStock,storeExpenses,currentStore,storeCash,customers,isSharedStock,sharedStockStores}){
  const avgTicket = storeSales.length > 0 ? totalRev / storeSales.length : 0;
  const totalExp = storeExpenses.reduce((s,e) => s + e.value, 0);
  const stockValue = storeProducts.reduce((s,p) => s + p.cost * p.stock, 0);
  const cashBal = storeCash.open ? storeCash.initial + storeCash.history.filter(h=>h.type==="entrada").reduce((s,h)=>s+h.value,0) - storeCash.history.filter(h=>h.type==="saida").reduce((s,h)=>s+h.value,0) : 0;

  return (
    <div style={{animation:"fadeIn .4s ease"}}>
      {isSharedStock&&<div style={{padding:"10px 16px",background:"rgba(224,64,251,.06)",border:"1px solid rgba(224,64,251,.2)",borderRadius:12,marginBottom:14,display:"flex",alignItems:"center",gap:8,fontSize:12,color:C.pur}}>
        <span style={{fontSize:16}}>🔗</span>
        <span><strong>Estoque compartilhado</strong> com {sharedStockStores.filter(s=>s.id!==currentStore.id).map(s=>s.name).join(", ")}. Vendas e despesas são separadas.</span>
      </div>}
      <div style={S.kpiRow}>
        <KPI icon={I.money} label="Vendas Hoje" value={fmt(todayRev)} sub={todaySales.length+" vendas"} color={C.grn}/>
        <KPI icon={I.cart} label="Receita Total" value={fmt(totalRev)} sub={storeSales.length+" vendas"} color={C.gold}/>
        <KPI icon={I.box} label="Estoque (Custo)" value={fmt(stockValue)} sub={storeProducts.reduce((s,p)=>s+p.stock,0)+" peças"} color={C.blu}/>
        <KPI icon={I.chart} label="Ticket Médio" value={fmt(avgTicket)} sub={customers.length+" clientes"} color={C.pur}/>
      </div>
      {storeCash.open&&<div style={S.kpiRow}><KPI icon={I.store} label="Caixa Aberto" value={fmt(cashBal)} sub="Saldo atual" color={C.grn}/><KPI icon={I.money} label="Despesas" value={fmt(totalExp)} sub={storeExpenses.length+" lançamentos"} color={C.red}/></div>}
{/* alertas de estoque baixo desativados para testes */}
      <div style={S.card}><h3 style={S.cardTitle}>Últimas Vendas — {currentStore.name}</h3><div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Data</th><th style={S.th}>Cliente</th><th style={S.th}>Total</th><th style={S.th}>Pgto</th><th style={S.th}>Cupom</th></tr></thead><tbody>{storeSales.slice(0,5).map(s=><tr key={s.id} style={S.tr}><td style={S.td}>{fmtDate(s.date)}</td><td style={S.td}>{s.customer}</td><td style={{...S.td,...S.tdM}}>{fmt(s.total)}</td><td style={S.td}><span style={S.payBadge}>{s.payment}</span></td><td style={{...S.td,fontSize:11}}>{s.cupom}</td></tr>)}</tbody></table></div></div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  GESTOR PANEL (ALL STORES)  ═══
// ═══════════════════════════════════
function GestorPanel({sales,expenses,stock,catalog,customers,investments,cashState}){
  const storeData = STORES.map(store => {
    const ss = sales[store.id] || [];
    const exps = expenses[store.id] || [];
    const st = stock[store.stockId] || {};
    const _today = new Date().toISOString().split("T")[0];
    const rev = ss.filter(s=>s.status!=="Cancelada").reduce((s,v) => s + v.total, 0);
    const expCaixa = exps.filter(e=>(e.expense_type||e.expenseType)==="caixa").reduce((s,e) => s + (+e.value||0), 0);
    const expOp = exps.filter(e=>(e.expense_type||e.expenseType)!=="caixa").reduce((s,e) => s + (+e.value||0), 0);
    const exp = exps.reduce((s,e) => s + (+e.value||0), 0);
    const todayRev = ss.filter(s=>s.date===_today&&s.status!=="Cancelada").reduce((s,v)=>s+v.total,0);
    const pieces = catalog.reduce((s,p) => s + (st[p.id]||0), 0);
    const stockVal = catalog.reduce((s,p) => s + p.cost * (st[p.id]||0), 0);
    const cash = Object.entries(cashState).filter(([k])=>k.startsWith(store.id+"_")).find(([,v])=>v.open)?.[1] || cashState[store.id];
    const isShared = STORES.filter(s=>s.stockId===store.stockId).length > 1;
    return { ...store, rev, exp, expCaixa, expOp, todayRev, salesCount:ss.length, pieces, stockVal, cashOpen:cash?.open, isShared };
  });

  const totalRev = storeData.reduce((s,d) => s + d.rev, 0);
  const totalExp = storeData.reduce((s,d) => s + d.exp, 0);
  const totalExpOp = storeData.reduce((s,d) => s + d.expOp, 0);
  const totalExpCaixa = storeData.reduce((s,d) => s + d.expCaixa, 0);
  const totalInv = investments.reduce((s,i) => s + i.value, 0);
  const totalToday = storeData.reduce((s,d) => s + d.todayRev, 0);
  const allSalesCount = storeData.reduce((s,d) => s + d.salesCount, 0);
  const resultado = totalRev - totalExpOp;

  return (
    <div style={{animation:"fadeIn .4s ease"}}>
      <div style={{padding:"16px 20px",background:`linear-gradient(135deg,rgba(255,215,64,.06),rgba(255,215,64,.02))`,borderRadius:16,border:`1px solid ${C.brdH}`,marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
        {I.globe}
        <div><div style={{fontSize:18,fontWeight:800,letterSpacing:1}}>Painel do Gestor</div><div style={{fontSize:12,color:C.dim}}>Visão consolidada de todas as lojas</div></div>
      </div>

      {/* Global KPIs */}
      <div style={S.kpiRow}>
        <KPI icon={I.money} label="Vendas Hoje (Geral)" value={fmt(totalToday)} sub="Todas as lojas" color={C.grn}/>
        <KPI icon={I.cart} label="Receita Total" value={fmt(totalRev)} sub={allSalesCount+" vendas"} color={C.gold}/>
        <KPI icon="🏢" label="Desp. Operacionais" value={fmt(totalExpOp)} sub="Subtraem da receita" color={C.red}/>
        <KPI icon={I.chart} label="Resultado" value={fmt(resultado)} sub={resultado>=0?"Positivo":"Negativo"} color={resultado>=0?C.grn:C.red}/>
      </div>

      {/* Per-store cards */}
      <h3 style={{fontSize:15,fontWeight:700,marginBottom:14,letterSpacing:.5}}>Desempenho por Loja</h3>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:14,marginBottom:16}}>
        {storeData.map(d => (
          <div key={d.id} style={{...S.card,borderColor:d.color+"33",borderLeft:`4px solid ${d.color}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:16,fontWeight:800,color:d.color}}>{d.name}</span>
                {d.isShared&&<span style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(224,64,251,.12)",color:C.pur,fontWeight:700}}>🔗 Estoque Compartilhado</span>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <span style={{width:8,height:8,borderRadius:4,background:d.cashOpen?C.grn:C.red}}/>
                <span style={{fontSize:10,color:d.cashOpen?C.grn:C.red}}>{d.cashOpen?"Aberto":"Fechado"}</span>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div><div style={{fontSize:10,color:C.dim}}>Vendas Hoje</div><div style={{fontSize:18,fontWeight:800,color:C.grn}}>{fmt(d.todayRev)}</div></div>
              <div><div style={{fontSize:10,color:C.dim}}>Receita Total</div><div style={{fontSize:18,fontWeight:800,color:C.gold}}>{fmt(d.rev)}</div></div>
              <div><div style={{fontSize:10,color:C.dim}}>Desp. Operacional</div><div style={{fontSize:14,fontWeight:700,color:C.red}}>{fmt(d.expOp)}</div></div>
              <div><div style={{fontSize:10,color:C.dim}}>Resultado</div><div style={{fontSize:14,fontWeight:700,color:d.rev-d.expOp>=0?C.grn:C.red}}>{fmt(d.rev-d.expOp)}</div></div>
              <div><div style={{fontSize:10,color:C.dim}}>Estoque</div><div style={{fontSize:14,fontWeight:600}}>{d.pieces} pç</div></div>
              <div><div style={{fontSize:10,color:C.dim}}>Valor Estoque</div><div style={{fontSize:14,fontWeight:600}}>{fmt(d.stockVal)}</div></div>
            </div>
            {/* Revenue bar */}
            <div style={{marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.dim,marginBottom:3}}><span>Participação na receita</span><span>{totalRev>0?pct(d.rev/totalRev*100):"0%"}</span></div>
              <div style={{height:6,background:C.s2,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:d.color,width:totalRev>0?(d.rev/totalRev*100)+"%":"0%",transition:"width .6s"}}/></div>
            </div>
          </div>
        ))}
      </div>

      {/* Comparative bar chart */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Comparativo de Receita</h3>
        {storeData.sort((a,b)=>b.rev-a.rev).map(d => (
          <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <span style={{width:110,fontSize:12,fontWeight:600,color:d.color,flexShrink:0}}>{d.name.replace("D'Black ","")}</span>
            <div style={{flex:1,height:24,background:C.s2,borderRadius:12,overflow:"hidden"}}><div style={{height:"100%",borderRadius:12,background:`linear-gradient(90deg,${d.color},${d.color}88)`,width:totalRev>0?(d.rev/totalRev*100)+"%":"0%",transition:"width .6s",minWidth:3}}/></div>
            <span style={{fontSize:12,fontWeight:700,color:d.color,minWidth:90,textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>{fmt(d.rev)}</span>
          </div>
        ))}
      </div>

      {/* Investments */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Investimento em Mercadoria (Geral)</h3>
        <div style={{fontSize:24,fontWeight:900,color:C.blu,marginBottom:12}}>{fmt(totalInv)}</div>
        <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Semana</th><th style={S.th}>Fornecedor</th><th style={S.th}>Valor</th></tr></thead><tbody>{investments.map(inv=><tr key={inv.id} style={S.tr}><td style={S.td}>{inv.week}</td><td style={{...S.td,fontWeight:600}}>{inv.supplier}</td><td style={{...S.td,fontWeight:700,color:C.blu}}>{fmt(inv.value)}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  PDV MODULE                 ═══
// ═══════════════════════════════════
function PDVModule({storeProducts,activeStore,stock,setStock,sales,setSales,customers,setCustomers,users,storeCash,cashState,setCashState,catalog,loggedUser,showToast,activeStockId,receiptSale,setReceiptSale}){
  // ── MULTI-TAB SALES ──
  const emptyTab=()=>({id:genId(),label:"Venda 1",cart:[],customer:"",discount:0,discountType:"fixed",discountScope:"sale",discountItemIds:[],itemDiscounts:{},payments:[],showPayPanel:false,currentMethod:"PIX",currentValue:"",cashReceived:""});
  const [saleTabs,setSaleTabs]=useState([emptyTab()]);
  const [activeTabIdx,setActiveTabIdx]=useState(0);
  const [search,setSearch]=useState("");
  const [showDiscountPanel,setShowDiscountPanel]=useState(false);
  const [showShortcuts,setShowShortcuts]=useState(false);
  const [lastReceipt,setLastReceipt]=useState(null);
  const [autoFlow,setAutoFlow]=useState(false);

  // Current tab data
  const tab=saleTabs[activeTabIdx]||emptyTab();
  const cart=tab.cart;
  const cartCustomer=tab.customer;
  const cartDiscount=tab.discount;
  const discountType=tab.discountType;
  const discountScope=tab.discountScope;
  const discountItemIds=tab.discountItemIds||[];
  const payments=tab.payments;
  const showPayPanel=tab.showPayPanel;
  const currentMethod=tab.currentMethod;
  const currentValue=tab.currentValue;
  const cashReceived=tab.cashReceived;

  // Update current tab helper
  const upTab=(changes)=>{setSaleTabs(prev=>prev.map((t,i)=>i===activeTabIdx?{...t,...changes}:t));};
  // Setter wrappers (so all existing code works)
  const setCart=(fn)=>{if(typeof fn==="function"){setSaleTabs(prev=>prev.map((t,i)=>i===activeTabIdx?{...t,cart:fn(t.cart)}:t));}else{upTab({cart:fn});}};
  const setCartCustomer=(v)=>upTab({customer:v});
  const setCartDiscount=(v)=>upTab({discount:v});
  const setDiscountType=(v)=>upTab({discountType:v});
  const setDiscountScope=(v)=>upTab({discountScope:v});
  const toggleDiscountItemId=(id)=>upTab({discountItemIds:discountItemIds.includes(id)?discountItemIds.filter(x=>x!==id):[...discountItemIds,id]});
  const itemDiscounts=tab.itemDiscounts||{};
  const setItemDiscount=(id,val)=>upTab({itemDiscounts:{...itemDiscounts,[id]:+val}});
  const setPayments=(fn)=>{if(typeof fn==="function"){setSaleTabs(prev=>prev.map((t,i)=>i===activeTabIdx?{...t,payments:fn(t.payments)}:t));}else{upTab({payments:fn});}};
  const setShowPayPanel=(v)=>upTab({showPayPanel:typeof v==="function"?v(tab.showPayPanel):v});
  const setCurrentMethod=(v)=>upTab({currentMethod:v});
  const setCurrentValue=(v)=>upTab({currentValue:v});
  const setCashReceived=(v)=>upTab({cashReceived:v});

  // Add new sale tab
  const addSaleTab=()=>{
    const num=saleTabs.length+1;
    const newTab={...emptyTab(),label:"Venda "+num};
    setSaleTabs(prev=>[...prev,newTab]);
    setActiveTabIdx(saleTabs.length);
    showToast("Nova venda aberta!");
  };
  // Close sale tab
  const closeSaleTab=(idx)=>{
    if(saleTabs.length<=1){showToast("Precisa ter pelo menos 1 venda","error");return;}
    setSaleTabs(prev=>prev.filter((_,i)=>i!==idx));
    if(activeTabIdx>=idx&&activeTabIdx>0)setActiveTabIdx(activeTabIdx-1);
  };

  const searchRef=useRef(null);

  // ── KEYBOARD SHORTCUTS ──
  // F1=Buscar  F2=Desconto  F3=PIX  F4=Dinheiro  F5=Crédito  F6=Débito
  // F7=Finalizar  F8=Limpar carrinho  F9=Cancelar venda  F10=Reimprimir  F12=Atalhos
  // Enter=avançar  Esc=voltar  Ctrl+T=nova aba  Ctrl+W=fechar aba
  useEffect(()=>{
    const handler=(e)=>{
      // Ctrl+T = new sale tab
      if(e.ctrlKey && e.key==="t"){e.preventDefault();addSaleTab();return;}
      // Ctrl+W = close current tab
      if(e.ctrlKey && e.key==="w"){e.preventDefault();closeSaleTab(activeTabIdx);return;}
      // Ctrl+1-9 = switch to tab N
      if(e.ctrlKey && e.key>="1" && e.key<="9"){
        var idx=parseInt(e.key)-1;
        if(idx<saleTabs.length){e.preventDefault();setActiveTabIdx(idx);}
        return;
      }
      // Enter smart navigation
      if(e.key==="Enter"){
        // Se o campo de busca está focado e tem texto, adiciona produto (leitor de código de barras)
        const searchVal=(searchRef.current?.value||search).trim();
        if(document.activeElement===searchRef.current && searchVal){
          const q=searchVal.toLowerCase();
          // Busca por EAN exato primeiro, depois SKU exato, depois por nome/sku parcial
          const match=storeProducts.find(p=>p.ean===searchVal||p.sku.toLowerCase()===q)
            ||storeProducts.find(p=>p.name.toLowerCase().includes(q)||p.sku.toLowerCase().includes(q)||(p.ean||"").includes(q));
          if(match){addToCart(match);setSearch("");if(searchRef.current)searchRef.current.value="";showToast(match.img+" "+match.name+" adicionado!");}
          else showToast("Produto não encontrado","error");
          e.preventDefault();return;
        }
        // If in discount panel number input, close panel
        if(showDiscountPanel && document.activeElement?.type==="number" && cartDiscount>0){
          setShowDiscountPanel(false);e.preventDefault();return;
        }
        // If cash received input is focused and has value, confirm cash payment
        if(showPayPanel && cashReceived && +cashReceived>0 && currentMethod==="Dinheiro"){
          // handled by onKeyDown on the input itself
          return;
        }
        // If payment value input is focused, confirm payment
        if(showPayPanel && currentValue && +currentValue>0){
          addPayment();e.preventDefault();return;
        }
        // If fully paid, finalize
        if(isFullyPaid && cart.length>0){
          finalizeSale();e.preventDefault();return;
        }
        // If cart has items but no payment panel, open payment with PIX
        if(cart.length>0 && !showPayPanel && !isFullyPaid){
          setShowPayPanel(true);
          setPayments([{method:"PIX",value:cartTotal}]);
          e.preventDefault();return;
        }
        // If cart empty and search empty, focus search
        if(cart.length===0 && !search){
          if(searchRef.current){searchRef.current.focus();}
          e.preventDefault();return;
        }
        return;
      }
      // Escape = retroceder (inverso do Enter)
      if(e.key==="Escape"){
        e.preventDefault();
        // If receipt modal is open, close it
        if(receiptSale){setReceiptSale(null);return;}
        // If shortcuts panel is open, close it
        if(showShortcuts){setShowShortcuts(false);return;}
        // If discount panel is open, close it
        if(showDiscountPanel){setShowDiscountPanel(false);return;}
        // If payment is fully paid, remove last payment (go back to adding)
        if(isFullyPaid && payments.length>0){setPayments(prev=>prev.slice(0,-1));return;}
        // If in multi-payment panel with payments added, remove last one
        if(showPayPanel && payments.length>0){setPayments(prev=>prev.slice(0,-1));return;}
        // If payment panel is open but empty, close it
        if(showPayPanel && payments.length===0){setShowPayPanel(false);setCashReceived("");setCurrentValue("");return;}
        // If cart has items, remove last item
        if(cart.length>0){
          var lastItem=cart[cart.length-1];
          if(lastItem.qty>1){setCart(prev=>prev.map(function(i,idx){return idx===prev.length-1?{...i,qty:i.qty-1}:i;}));}
          else{setCart(prev=>prev.slice(0,-1));}
          return;
        }
        // If search has text, clear it
        if(search){setSearch("");return;}
        // Nothing to go back to
        return;
      }
      // Qualquer tecla digitada sem input focado → foca busca (essencial para o scanner de código de barras)
      const activeTag=document.activeElement?.tagName;
      if(!e.ctrlKey&&!e.altKey&&e.key.length===1&&activeTag!=="INPUT"&&activeTag!=="TEXTAREA"&&activeTag!=="SELECT"){
        if(searchRef.current){searchRef.current.focus();}
        return;
      }
      // F-keys
      if(!e.key.startsWith("F"))return;
      e.preventDefault();
      switch(e.key){
        case "F1": if(searchRef.current){searchRef.current.focus();searchRef.current.select();} break;
        case "F2": setShowDiscountPanel(p=>!p); break;
        case "F3": quickPay("PIX"); break;
        case "F4": quickPay("Dinheiro"); break;
        case "F5": quickPay("Crédito"); break;
        case "F6": quickPay("Débito"); break;
        case "F7": finalizeSale(); break;
        case "F8": setCart([]);setPayments([]);setShowPayPanel(false);showToast("Carrinho limpo!"); break;
        case "F9": upTab({cart:[],customer:"",discount:0,discountType:"fixed",discountScope:"sale",discountItemIds:[],itemDiscounts:{},payments:[],showPayPanel:false,currentMethod:"PIX",currentValue:"",cashReceived:""});setShowDiscountPanel(false);showToast("Venda cancelada!"); break;
        case "F10": if(lastReceipt)setReceiptSale(lastReceipt); else showToast("Nenhum cupom anterior","error"); break;
        case "F12": setShowShortcuts(p=>!p); break;
        default: break;
      }
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  });

  const filtered=storeProducts.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase()));
  const cartSub=cart.reduce((s,i)=>s+i.price*i.qty,0);

  // Discount calculation
  var discountValue=0;
  var discountLabel="";
  var hasItemDiscounts=Object.values(itemDiscounts).some(function(v){return +v>0;});
  if((cartDiscount>0||hasItemDiscounts)&&cart.length>0){
    if(discountScope==="sale"){
      if(discountType==="percent"){
        discountValue=cartSub*cartDiscount/100;
        discountLabel=cartDiscount+"% na venda toda";
      } else {
        discountValue=cartDiscount;
        discountLabel=fmt(cartDiscount)+" na venda toda";
      }
    } else if(discountScope==="item"){
      var activeItems=cart.filter(function(i){return (itemDiscounts[i.id]||0)>0;});
      if(activeItems.length>0){
        activeItems.forEach(function(i){
          var val=itemDiscounts[i.id]||0;
          if(discountType==="percent"){
            discountValue+=Math.round(i.price*i.qty*val/100*100)/100;
          } else {
            discountValue+=Math.min(val,i.price*i.qty);
          }
        });
        var selNames=activeItems.length===1?activeItems[0].name:(activeItems.length+" produtos");
        discountLabel="desconto em "+selNames;
      }
    }
  }
  discountValue=Math.min(discountValue,cartSub); // não pode ser maior que o subtotal
  const cartTotal=Math.round(Math.max(0,cartSub-discountValue)*100)/100;

  // Payment calculations
  const totalPaid=payments.reduce((s,p)=>s+p.value,0);
  const remaining=Math.max(0,cartTotal-totalPaid);
  const isFullyPaid=totalPaid>=cartTotal;
  const overpaid=Math.max(0,totalPaid-cartTotal);

  // Cash change for current method
  const cashChange=currentMethod==="Dinheiro"&&cashReceived?(+cashReceived)-remaining:0;

  const addToCart=(p)=>{
    setCart(prev=>{const ex=prev.find(i=>i.id===p.id);if(ex){return prev.map(i=>i.id===p.id?{...i,qty:i.qty+1}:i);}return[...prev,{...p,qty:1}];});
  };

  // Add payment method
  const addPayment=()=>{
    if(isFullyPaid)return showToast("Valor total já coberto!","error");
    var val=+currentValue;
    if(currentMethod==="Dinheiro"&&cashReceived){
      // Em dinheiro: o valor do pagamento é o remaining (não o que recebeu)
      val=Math.min(+cashReceived,remaining);
      if(+cashReceived<remaining&&payments.length===0){
        // Se é o único pagamento e não cobre, pega o que recebeu
        val=+cashReceived;
      } else {
        val=remaining; // cobre o restante
      }
    }
    if(!val||val<=0){
      // Se não digitou valor, assume o restante
      val=remaining;
    }
    if(val>remaining) val=remaining;
    var newPay={method:currentMethod,value:val};
    if(currentMethod==="Dinheiro"&&cashReceived){
      newPay.received=+cashReceived;
      newPay.change=Math.max(0,Math.round(((+cashReceived)-val)*100)/100);
    }
    setPayments(prev=>[...prev,newPay]);
    setCurrentValue("");setCashReceived("");
    // Se cobriu tudo, mostra confirmação
    if(val>=remaining){
      showToast("Pagamento completo! Confirme a venda.");
    }
  };

  const removePayment=(idx)=>{setPayments(prev=>prev.filter((_,i)=>i!==idx));};

  // Quick single payment (covers total)
  const quickPay=(method)=>{
    if(cart.length===0)return;
    if(method==="Dinheiro"){
      setCurrentMethod("Dinheiro");
      setCurrentValue(String(cartTotal));
      setShowPayPanel(true);
      return;
    }
    setPayments([{method,value:cartTotal}]);
    setShowPayPanel(true);
  };

  const finalizeSale=()=>{
    if(cart.length===0)return showToast("Carrinho vazio!","error");
    if(!storeCash.open)return showToast("Abra o caixa!","error");
    if(!isFullyPaid)return showToast("Pagamento incompleto! Faltam "+fmt(remaining),"error");
    const cupomNum="CNF-"+String(Date.now()).slice(-6);
    const paymentDesc=payments.map(p=>p.method+": "+fmt(p.value)).join(" + ");
    const custObj=customers.find(c=>c.name===cartCustomer);
    const newSale={id:genId(),date:new Date().toISOString().split("T")[0],customer:cartCustomer||"Avulso",customerId:custObj?.id||"",customerWhatsapp:custObj?.whatsapp||"",storeId:activeStore,seller:loggedUser.name,sellerId:loggedUser.id,items:cart.map(i=>({name:i.name,qty:i.qty,price:i.price,id:i.id})),subtotal:cartSub,discount:discountValue,discountLabel:discountLabel,total:cartTotal,payment:paymentDesc,payments:payments,status:"Concluída",cupom:cupomNum};
    setSales(prev=>{const n={...prev};n[activeStore]=[newSale,...(n[activeStore]||[])];return n;});
    api.createSale({ ...newSale, store_id: newSale.storeId, customer_id: newSale.customerId||'', customer_whatsapp: newSale.customerWhatsapp||'', seller_id: newSale.sellerId||'', discount_label: newSale.discountLabel||'', stock_id: activeStockId }).catch(console.error);
    setStock(prev=>{const n={...prev};const st={...(n[activeStockId]||{})};cart.forEach(c=>{st[c.id]=Math.max(0,(st[c.id]||0)-c.qty);});n[activeStockId]=st;return n;});
    setAutoFlow(true);
    setReceiptSale(newSale);
    setLastReceipt(newSale);
    // If multiple tabs, close this one. If only tab, reset it.
    if(saleTabs.length>1){
      closeSaleTab(activeTabIdx);
    } else {
      upTab({cart:[],customer:"",discount:0,discountType:"fixed",discountScope:"sale",discountItemIds:[],itemDiscounts:{},payments:[],showPayPanel:false,currentMethod:"PIX",currentValue:"",cashReceived:""});
    }
    setShowDiscountPanel(false);
    showToast("Venda "+fmt(cartTotal)+" finalizada!");
  };

  const payMethods=["PIX","Dinheiro","Crédito","Débito"];

  return(
    <div>
      {/* ── SALE TABS BAR ── */}
      <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:12,overflowX:"auto",paddingBottom:4}}>
        {saleTabs.map((st,idx)=>{
          var itemCount=st.cart.length;
          var tabTotal=st.cart.reduce((s,i)=>s+i.price*i.qty,0);
          return <button key={st.id} onClick={()=>setActiveTabIdx(idx)} style={{
            display:"flex",alignItems:"center",gap:6,padding:"8px 14px",borderRadius:10,
            border:"2px solid "+(activeTabIdx===idx?C.gold:C.brd),
            background:activeTabIdx===idx?"rgba(255,215,64,.1)":C.s1,
            color:activeTabIdx===idx?C.gold:C.dim,cursor:"pointer",fontSize:12,fontWeight:600,
            fontFamily:"inherit",whiteSpace:"nowrap",transition:"all .2s",position:"relative"
          }}>
            <span>{I.cart}</span>
            <span>{st.customer||st.label}</span>
            {itemCount>0&&<span style={{background:activeTabIdx===idx?C.gold:C.dim,color:C.bg,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:8}}>{itemCount}</span>}
            {tabTotal>0&&<span style={{fontSize:10,opacity:.7}}>{fmt(tabTotal)}</span>}
            {saleTabs.length>1&&<span onClick={(e)=>{e.stopPropagation();closeSaleTab(idx);}} style={{marginLeft:2,fontSize:10,color:C.red,cursor:"pointer",padding:"0 2px",fontWeight:800}}>✕</span>}
          </button>;
        })}
        <button onClick={addSaleTab} style={{padding:"8px 12px",borderRadius:10,border:"1px dashed "+C.brd,background:"transparent",color:C.dim,cursor:"pointer",fontSize:18,fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}} title="Nova venda (Ctrl+T)">+</button>
      </div>

      <div style={{display:"flex",gap:16,flexWrap:"wrap",animation:"fadeIn .2s ease"}}>
      <div style={{flex:1,minWidth:280}}>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
          <div style={{...S.searchBar,flex:1}}>{I.search}<input ref={searchRef} style={S.searchIn} placeholder="Buscar produto... (F1)" value={search} onChange={e=>setSearch(e.target.value)}/></div>
          <button onClick={()=>setShowShortcuts(s=>!s)} style={{padding:"8px 10px",borderRadius:8,border:`1px solid ${C.brd}`,background:showShortcuts?"rgba(255,215,64,.08)":C.s1,color:showShortcuts?C.gold:C.dim,cursor:"pointer",fontSize:10,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}} title="Atalhos (F12)">⌨️ F12</button>
        </div>
        {/* Shortcuts help bar */}
        {showShortcuts&&<div style={{background:C.s1,border:`1px solid ${C.brdH}`,borderRadius:10,padding:12,marginBottom:10,animation:"fadeIn .2s ease"}}>
          <div style={{fontSize:12,fontWeight:700,color:C.gold,marginBottom:8}}>⌨️ Atalhos do PDV</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:4}}>
            {[["Enter","Avançar / próximo passo"],["Esc","Voltar / desfazer passo"],["Ctrl+T","Nova aba de venda"],["Ctrl+W","Fechar aba atual"],["Ctrl+1-9","Alternar entre abas"],["F1","Buscar produto"],["F2","Abrir/fechar desconto"],["F3","Pagar com PIX"],["F4","Pagar em Dinheiro"],["F5","Pagar no Crédito"],["F6","Pagar no Débito"],["F7","Finalizar venda"],["F8","Limpar carrinho"],["F9","Cancelar venda"],["F10","Reimprimir cupom"],["F12","Mostrar/ocultar atalhos"]].map(function(s){
              return <div key={s[0]} style={{display:"flex",alignItems:"center",gap:6,fontSize:11}}>
                <span style={{background:C.s2,border:`1px solid ${C.brd}`,borderRadius:4,padding:"2px 6px",fontFamily:"monospace",fontWeight:800,fontSize:10,color:C.gold,minWidth:28,textAlign:"center"}}>{s[0]}</span>
                <span style={{color:C.dim}}>{s[1]}</span>
              </div>;
            })}
          </div>
        </div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",gap:8,marginTop:8}}>
          {filtered.map(p=><button key={p.id} style={{...S.pdvCard,...(p.stock<=0?{opacity:.35}:{})}} onClick={()=>addToCart(p)}>
            {p.photo
              ? <img src={p.photo} alt={p.name} style={{width:80,height:80,objectFit:"cover",borderRadius:10,marginBottom:4}}/>
              : <div style={{fontSize:42,lineHeight:1}}>{p.img}</div>
            }
            <div style={{fontSize:11,fontWeight:600,lineHeight:1.2}}>{p.name}</div>
            <div style={{fontSize:9,color:C.dim}}>{p.size} • {p.color}</div>
            <div style={{fontSize:14,fontWeight:800,color:C.gold}}>{fmt(p.price)}</div>
            <div style={{fontSize:10,color:p.stock<=p.minStock?C.red:C.grn}}>{p.stock} un.</div>
          </button>)}
        </div>
      </div>
      <div style={S.cartPanel}>
        <div style={S.cartHead}>{I.cart}<span style={{fontSize:14,fontWeight:700,letterSpacing:1}}>Carrinho</span><span style={S.cartBadge}>{cart.length}</span></div>
        {!storeCash.open&&<div style={{padding:"10px 14px",background:"rgba(255,82,82,.08)",color:C.red,fontSize:12,display:"flex",alignItems:"center",gap:6}}>{I.lock} Abra o caixa primeiro</div>}
        <div style={{padding:"6px 10px",borderBottom:`1px solid ${C.brd}`}}>
          <CustomerSelector customers={customers} setCustomers={setCustomers} cartCustomer={cartCustomer} setCartCustomer={setCartCustomer} showToast={showToast}/>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:8}}>
          {cart.length===0?<div style={{textAlign:"center",padding:"40px 0",color:C.dim,fontSize:12}}>🛒 Carrinho vazio</div>:
          cart.map(item=>{const itemDisc=discountScope==="item"&&(itemDiscounts[item.id]||0)>0?(discountType==="percent"?Math.round(item.price*item.qty*(itemDiscounts[item.id]||0)/100*100)/100:Math.min(itemDiscounts[item.id]||0,item.price*item.qty)):0;return <div key={item.id} style={{background:C.s2,borderRadius:8,padding:8,marginBottom:5,...(itemDisc>0?{border:"1px solid rgba(255,82,82,.3)",background:"rgba(255,82,82,.04)"}:{})}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>{item.photo?<img src={item.photo} alt={item.name} style={{width:44,height:44,objectFit:"cover",borderRadius:8,flexShrink:0}}/>:<span style={{fontSize:28,lineHeight:1}}>{item.img}</span>}<div style={{flex:1}}><div style={{fontSize:11,fontWeight:600}}>{item.name}</div>{itemDisc>0&&<div style={{fontSize:9,color:C.red}}>🏷️ -{fmt(itemDisc)}</div>}</div></div>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <button style={S.qBtn} onClick={()=>setCart(prev=>prev.map(i=>i.id===item.id?(i.qty>1?{...i,qty:i.qty-1}:null):i).filter(Boolean))}>{I.minus}</button>
              <span style={{fontSize:14,fontWeight:700,minWidth:24,textAlign:"center"}}>{item.qty}</span>
              <button style={S.qBtn} onClick={()=>setCart(prev=>prev.map(i=>i.id===item.id?{...i,qty:i.qty+1}:i))}>{I.plus}</button>
              <span style={{marginLeft:"auto",fontWeight:700,color:C.gold,fontSize:13}}>{fmt(item.price*item.qty)}</span>
            </div>
          </div>;})}
        </div>

        {/* FOOTER - Payment Area */}
        <div style={{padding:10,borderTop:`1px solid ${C.brd}`}}>
          {/* Discount toggle button */}
          <div style={{marginBottom:8}}>
            {!showDiscountPanel?
              <button style={{width:"100%",padding:"6px",borderRadius:7,border:`1px dashed ${discountValue>0?"rgba(255,82,82,.4)":C.brd}`,background:discountValue>0?"rgba(255,82,82,.06)":"transparent",color:discountValue>0?C.red:C.dim,cursor:"pointer",fontSize:11,fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:4}} onClick={()=>setShowDiscountPanel(true)}>
                {discountValue>0?("🏷️ Desconto: -"+fmt(discountValue)+" ("+discountLabel+") ✎"):("🏷️ Adicionar desconto")}
              </button>
            :
              <div style={{background:C.s2,borderRadius:10,padding:10,border:`1px solid ${C.brd}`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:C.red}}>🏷️ Desconto</span>
                  <button style={{background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:10}} onClick={()=>{setShowDiscountPanel(false);}}>✕</button>
                </div>

                {/* Type: % or R$ */}
                <div style={{display:"flex",gap:3,marginBottom:6}}>
                  <button onClick={()=>setDiscountType("percent")} style={{flex:1,padding:"5px",borderRadius:6,border:"1px solid "+(discountType==="percent"?C.gold:C.brd),background:discountType==="percent"?"rgba(255,215,64,.1)":C.s1,color:discountType==="percent"?C.gold:C.dim,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>% Porcentagem</button>
                  <button onClick={()=>setDiscountType("fixed")} style={{flex:1,padding:"5px",borderRadius:6,border:"1px solid "+(discountType==="fixed"?C.gold:C.brd),background:discountType==="fixed"?"rgba(255,215,64,.1)":C.s1,color:discountType==="fixed"?C.gold:C.dim,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>R$ Valor Fixo</button>
                </div>

                {/* Scope: whole sale or specific item */}
                <div style={{display:"flex",gap:3,marginBottom:6}}>
                  <button onClick={()=>{setDiscountScope("sale");upTab({discountItemIds:[]});}} style={{flex:1,padding:"5px",borderRadius:6,border:"1px solid "+(discountScope==="sale"?C.gold:C.brd),background:discountScope==="sale"?"rgba(255,215,64,.1)":C.s1,color:discountScope==="sale"?C.gold:C.dim,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Venda toda</button>
                  <button onClick={()=>setDiscountScope("item")} style={{flex:1,padding:"5px",borderRadius:6,border:"1px solid "+(discountScope==="item"?C.gold:C.brd),background:discountScope==="item"?"rgba(255,215,64,.1)":C.s1,color:discountScope==="item"?C.gold:C.dim,cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Por produto</button>
                </div>

                {/* Por produto: input individual por item */}
                {discountScope==="item"&&cart.length>0&&<div style={{marginBottom:6,background:C.s2,borderRadius:8,padding:"6px 8px"}}>
                  <div style={{fontSize:10,color:C.dim,marginBottom:6,fontWeight:600}}>Desconto por produto ({discountType==="percent"?"%":"R$"}):</div>
                  {cart.map(i=>{
                    const val=itemDiscounts[i.id]||"";
                    const disc=+val>0?(discountType==="percent"?Math.round(i.price*i.qty*+val/100*100)/100:Math.min(+val,i.price*i.qty)):0;
                    return <div key={i.id} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 0",borderBottom:`1px solid ${C.brd}`}}>
                      <span style={{flex:1,fontSize:11}}>{i.name}</span>
                      <span style={{fontSize:10,color:C.dim,fontFamily:"monospace"}}>{fmt(i.price*i.qty)}</span>
                      <input type="number" placeholder="0" value={val} onChange={e=>setItemDiscount(i.id,e.target.value)}
                        style={{...S.inp,width:64,padding:"3px 6px",fontSize:12,textAlign:"center"}} min={0}/>
                      <span style={{fontSize:10,color:C.dim,minWidth:14}}>{discountType==="percent"?"%":"R$"}</span>
                      {disc>0&&<span style={{fontSize:10,color:C.red,fontFamily:"monospace",minWidth:48}}>-{fmt(disc)}</span>}
                    </div>;
                  })}
                </div>}

                {/* Venda toda: input único */}
                {discountScope==="sale"&&<div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:13,fontWeight:700,color:C.red}}>{discountType==="percent"?"%":"R$"}</span>
                  <input style={{...S.inp,flex:1,textAlign:"center",fontSize:16,fontWeight:700}} type="number" placeholder={discountType==="percent"?"10":"50"} value={cartDiscount||""} onChange={e=>setCartDiscount(+e.target.value)} min={0} max={discountType==="percent"?100:cartSub}/>
                </div>}

                {/* Preview */}
                {discountValue>0&&<div style={{marginTop:6,padding:"6px 8px",background:"rgba(255,82,82,.08)",borderRadius:6,display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span style={{color:C.dim}}>{discountLabel}</span>
                  <span style={{fontWeight:700,color:C.red}}>-{fmt(discountValue)}</span>
                </div>}

                {/* Confirmar */}
                {discountValue>0&&<button style={{width:"100%",marginTop:6,padding:"10px",borderRadius:8,border:"none",background:C.gold,color:"#000",cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}} onClick={()=>setShowDiscountPanel(false)}>✓ Aplicar Desconto (-{fmt(discountValue)})</button>}

                {/* Clear */}
                {(cartDiscount>0||Object.values(itemDiscounts).some(v=>v>0))&&<button style={{width:"100%",marginTop:4,padding:"4px",borderRadius:5,border:"none",background:"transparent",color:C.dim,cursor:"pointer",fontSize:10,fontFamily:"inherit"}} onClick={()=>{setCartDiscount(0);upTab({discountItemIds:[],itemDiscounts:{}});}}>Remover desconto</button>}
              </div>
            }
          </div>

          {discountValue>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.dim,marginBottom:2}}>
            <span>Subtotal: {fmt(cartSub)}</span>
            <span style={{color:C.red}}>Desc: -{fmt(discountValue)}</span>
          </div>}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:12,color:C.dim,letterSpacing:2}}>TOTAL</span>
            <span style={{fontSize:24,fontWeight:900,color:C.gold}}>{fmt(cartTotal)}</span>
          </div>

          {/* Quick pay buttons (single payment) */}
          {!showPayPanel&&<div>
            <div style={{fontSize:11,color:C.txt,fontWeight:600,marginBottom:6}}>💳 Forma de pagamento:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:6}}>
              {payMethods.map(function(m,mi){var fKey="F"+(mi+3);return <button key={m} style={{...S.payBtn,display:"flex",alignItems:"center",justifyContent:"center",gap:4}} onClick={()=>quickPay(m)}><span style={{fontSize:9,opacity:.5,fontFamily:"monospace"}}>{fKey}</span>{m}</button>;})}
            </div>
            <button style={{width:"100%",padding:"8px",borderRadius:8,border:`1px dashed rgba(255,255,255,0.2)`,background:"rgba(255,255,255,0.04)",color:C.txt,cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:500,marginBottom:8}} onClick={()=>setShowPayPanel(true)}>
              ➕ Dividir em duas formas
            </button>
          </div>}

          {/* Multi-payment panel */}
          {showPayPanel&&<div style={{background:C.s2,borderRadius:10,padding:10,marginBottom:8}}>
            {/* Already added payments */}
            {payments.length>0&&<div style={{marginBottom:8}}>
              {payments.map((p,idx)=><div key={idx} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 8px",background:C.s1,borderRadius:6,marginBottom:4,fontSize:12}}>
                <span style={{fontWeight:600}}>{p.method}</span>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontWeight:700,color:C.grn}}>{fmt(p.value)}</span>
                  {p.change>0&&<span style={{fontSize:10,color:C.org}}>Troco: {fmt(p.change)}</span>}
                  <button style={{background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:10,padding:2}} onClick={()=>removePayment(idx)}>✕</button>
                </div>
              </div>)}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"4px 8px",color:C.dim}}>
                <span>Pago: {fmt(totalPaid)}</span>
                <span style={{color:remaining>0?C.org:C.grn,fontWeight:700}}>{remaining>0?"Falta: "+fmt(remaining):"✓ Completo"}</span>
              </div>
            </div>}

            {/* Add more payment */}
            {!isFullyPaid&&<div>
              <div style={{fontSize:11,color:C.txt,fontWeight:600,marginBottom:6}}>{payments.length===0?"💳 Forma de pagamento:":"➕ Segunda forma:"} <span style={{color:C.gold}}>falta {fmt(remaining)}</span></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3,marginBottom:6}}>
                {payMethods.map(m=><button key={m} style={{...S.payBtn,...(currentMethod===m?S.payAct:{})}} onClick={()=>{setCurrentMethod(m);setCashReceived("");}}>{m}</button>)}
              </div>

              {currentMethod==="Dinheiro"?(<div>
                <div style={{fontSize:10,color:C.dim,marginBottom:3}}>Valor recebido do cliente:</div>
                <input
                  style={{...S.inp,width:"100%",fontSize:18,textAlign:"center",fontWeight:700,padding:"10px",marginBottom:6}}
                  type="number" placeholder="0,00" value={cashReceived}
                  onChange={e=>setCashReceived(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&cashReceived&&addPayment()}
                  autoFocus
                />
                {cashReceived&&+cashReceived>0&&<div style={{background:+cashReceived>=remaining?"rgba(0,230,118,.08)":"rgba(255,82,82,.08)",borderRadius:8,padding:10,textAlign:"center",marginBottom:6}}>
                  {+cashReceived>=remaining?(<>
                    <div style={{fontSize:11,color:C.grn,fontWeight:600}}>TROCO</div>
                    <div style={{fontSize:28,fontWeight:900,color:C.grn}}>{fmt(Math.max(0,(+cashReceived)-remaining))}</div>
                    <div style={{fontSize:10,color:C.dim}}>Recebido: {fmt(+cashReceived)} • Valor: {fmt(remaining)}</div>
                  </>):(<>
                    <div style={{fontSize:11,color:C.red,fontWeight:600}}>VALOR INSUFICIENTE</div>
                    <div style={{fontSize:14,fontWeight:700,color:C.red}}>Faltam {fmt(remaining-(+cashReceived))}</div>
                  </>)}
                </div>}
                <button style={{...S.primBtn,width:"100%",justifyContent:"center",padding:"8px",background:cashReceived&&+cashReceived>=remaining?`linear-gradient(135deg,${C.grn},#00C853)`:`linear-gradient(135deg,${C.gold},${C.goldD})`}} onClick={addPayment} disabled={!cashReceived||+cashReceived<=0}>
                  {I.check} Confirmar Dinheiro
                </button>
              </div>):(<div>
                <div style={{fontSize:10,color:C.dim,marginBottom:3}}>Valor em {currentMethod}:</div>
                <div style={{display:"flex",gap:6}}>
                  <input style={{...S.inp,flex:1,fontSize:14,textAlign:"center",fontWeight:700}} type="number" placeholder={fmt(remaining)} value={currentValue} onChange={e=>setCurrentValue(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addPayment()}/>
                  <button style={S.primBtn} onClick={addPayment}>{I.check}</button>
                </div>
                <button style={{width:"100%",marginTop:4,padding:"5px",borderRadius:6,border:`1px solid ${C.brd}`,background:"transparent",color:C.dim,cursor:"pointer",fontSize:10,fontFamily:"inherit"}} onClick={()=>{setCurrentValue(String(remaining));setTimeout(addPayment,50);}}>
                  Usar valor total restante ({fmt(remaining)})
                </button>
              </div>)}
            </div>}

            {/* Cancel multi-pay */}
            <button style={{width:"100%",marginTop:6,padding:"5px",borderRadius:6,border:"none",background:"transparent",color:C.dim,cursor:"pointer",fontSize:10,fontFamily:"inherit"}} onClick={()=>{setShowPayPanel(false);setPayments([]);setCurrentValue("");setCashReceived("");}}>
              Cancelar pagamento
            </button>
          </div>}

          {/* Finalize button */}
          {isFullyPaid&&<div>
            <div style={{background:"rgba(0,230,118,.06)",borderRadius:8,padding:8,marginBottom:6,textAlign:"center"}}>
              <div style={{fontSize:11,color:C.grn,fontWeight:700}}>✓ PAGAMENTO COMPLETO</div>
              <div style={{fontSize:10,color:C.dim,marginTop:2}}>{payments.map(p=>p.method+": "+fmt(p.value)).join(" + ")}</div>
              {payments.find(p=>p.change>0)&&<div style={{fontSize:12,color:C.org,fontWeight:700,marginTop:4}}>Troco: {fmt(payments.reduce((s,p)=>s+(p.change||0),0))}</div>}
            </div>
            <button style={S.finBtn} onClick={finalizeSale}>{I.check} FINALIZAR VENDA</button>
          </div>}
        </div>
      </div>

      {/* ═══ CUPOM MODAL (Não Fiscal + Troca Presente) ═══ */}
      {receiptSale&&<ReceiptCupom sale={receiptSale} autoFlow={autoFlow} onClose={()=>{setReceiptSale(null);setAutoFlow(false);}} />}
    </div>
  </div>
  );
}

// ─── Customer Selector (search + quick register) ───
function CustomerSelector({customers,setCustomers,cartCustomer,setCartCustomer,showToast}){
  const [custSearch,setCustSearch]=useState("");
  const [showResults,setShowResults]=useState(false);
  const [showQuickAdd,setShowQuickAdd]=useState(false);
  const [qc,setQc]=useState({name:"",phone:"",city:""});
  const inputRef=useRef(null);

  const filtered=custSearch.trim()?customers.filter(c=>
    c.name.toLowerCase().includes(custSearch.toLowerCase())||
    (c.cpf||"").includes(custSearch)||
    (c.phone||"").includes(custSearch)
  ):customers;

  const selectCustomer=(c)=>{setCartCustomer(c.name);setCustSearch("");setShowResults(false);};
  const clearCustomer=()=>{setCartCustomer("");setCustSearch("");};

  const quickAdd=()=>{
    if(!qc.name||!qc.phone)return showToast("Preencha nome e telefone!","error");
    const newCust={id:genId(),name:qc.name,phone:qc.phone,email:"",cpf:"",birthdate:"",totalSpent:0,visits:0,lastVisit:"-",tags:["Novo"],notes:"Cidade: "+qc.city,points:0,whatsapp:qc.phone.replace(/\D/g,"")};
    setCustomers(prev=>[...prev,newCust]);
    setCartCustomer(qc.name);
    setQc({name:"",phone:"",city:""});
    setShowQuickAdd(false);setCustSearch("");setShowResults(false);
    showToast("Cliente "+qc.name+" cadastrado e selecionado!");
  };

  return(
    <div style={{position:"relative"}}>
      {cartCustomer?
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",background:"rgba(255,215,64,.06)",borderRadius:8,border:`1px solid ${C.brdH}`}}>
          <div style={{...S.avatar,width:24,height:24,fontSize:10}}>{cartCustomer.charAt(0)}</div>
          <span style={{flex:1,fontSize:12,fontWeight:700,color:C.gold}}>{cartCustomer}</span>
          <button onClick={clearCustomer} style={{background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:10,padding:2}}>✕</button>
        </div>
      :
        <div>
          <div style={{display:"flex",gap:4}}>
            <div style={{flex:1,display:"flex",alignItems:"center",gap:6,background:C.s2,borderRadius:8,border:`1px solid ${C.brd}`,padding:"5px 10px"}}>
              {I.search}
              <input
                ref={inputRef}
                style={{background:"none",border:"none",color:C.txt,fontSize:12,fontFamily:"inherit",outline:"none",flex:1}}
                placeholder="Nome ou CPF do cliente..."
                value={custSearch}
                onChange={e=>{setCustSearch(e.target.value);setShowResults(true);}}
                onFocus={()=>setShowResults(true)}
              />
            </div>
            <button onClick={()=>setShowQuickAdd(!showQuickAdd)} style={{padding:"5px 8px",borderRadius:8,border:`1px solid ${C.brd}`,background:showQuickAdd?"rgba(0,230,118,.08)":C.s2,color:showQuickAdd?C.grn:C.dim,cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}} title="Cadastro rápido">
              {I.plus}
            </button>
          </div>

          {/* Search results dropdown */}
          {showResults&&custSearch.trim()&&<div style={{position:"absolute",top:"100%",left:0,right:0,background:C.s1,border:`1px solid ${C.brdH}`,borderRadius:10,marginTop:4,maxHeight:180,overflowY:"auto",zIndex:20,boxShadow:"0 8px 24px rgba(0,0,0,.4)"}}>
            {filtered.length===0?
              <div style={{padding:"12px",textAlign:"center",color:C.dim,fontSize:11}}>
                Nenhum cliente encontrado
                <button onClick={()=>{setShowQuickAdd(true);setQc(q=>({...q,name:custSearch}));setShowResults(false);}} style={{display:"block",margin:"6px auto 0",padding:"5px 12px",borderRadius:6,border:`1px solid ${C.grn}`,background:"transparent",color:C.grn,cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600}}>
                  + Cadastrar "{custSearch}"
                </button>
              </div>
            :
              filtered.slice(0,6).map(c=>
                <button key={c.id} onClick={()=>selectCustomer(c)} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"transparent",border:"none",borderBottom:`1px solid ${C.brd}`,color:C.txt,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                  <div style={{...S.avatar,width:28,height:28,fontSize:10}}>{c.name.charAt(0)}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:700}}>{c.name}</div>
                    <div style={{fontSize:10,color:C.dim}}>{c.phone}{c.cpf?" • "+c.cpf:""}</div>
                  </div>
                  <div style={{fontSize:10,color:C.gold}}>{c.points}pts</div>
                </button>
              )
            }
          </div>}

          {/* Quick add form */}
          {showQuickAdd&&<div style={{marginTop:6,background:C.s2,borderRadius:10,padding:10,border:`1px solid rgba(0,230,118,.2)`,animation:"fadeIn .2s ease"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <span style={{fontSize:11,fontWeight:700,color:C.grn}}>⚡ Cadastro Rápido</span>
              <button onClick={()=>setShowQuickAdd(false)} style={{background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:10}}>✕</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              <input style={{...S.inp,fontSize:12,padding:"6px 10px"}} placeholder="Nome *" value={qc.name} onChange={e=>setQc(q=>({...q,name:e.target.value}))} autoFocus/>
              <input style={{...S.inp,fontSize:12,padding:"6px 10px"}} placeholder="Telefone *" value={qc.phone} onChange={e=>setQc(q=>({...q,phone:e.target.value}))}/>
              <input style={{...S.inp,fontSize:12,padding:"6px 10px"}} placeholder="Cidade" value={qc.city} onChange={e=>setQc(q=>({...q,city:e.target.value}))}/>
            </div>
            <button onClick={quickAdd} style={{...S.primBtn,width:"100%",justifyContent:"center",marginTop:6,padding:"7px",fontSize:11,background:`linear-gradient(135deg,${C.grn},#00C853)`}}>
              {I.check} Cadastrar e Selecionar
            </button>
          </div>}

          {/* Quick select: no search, show "Cliente Avulso" link */}
          {!custSearch&&!showQuickAdd&&<button onClick={()=>setShowResults(false)} style={{width:"100%",marginTop:3,padding:"3px",background:"transparent",border:"none",color:C.dim,cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
            Continuar como Cliente Avulso
          </button>}
        </div>
      }
    </div>
  );
}

// ─── Receipt / Cupom Modal Component ───
function ReceiptCupom({sale,onClose,autoFlow=false}){
  // phase: "cupom" | "troca_prompt" | "troca"
  const [phase,setPhase]=useState("cupom");
  const contentRef=useRef(null);
  const [waPhone,setWaPhone]=useState(sale.customerWhatsapp||"");
  const isEcommerce=sale.storeId==="loja4";
  const showWaBtn=!!(waPhone||isEcommerce);

  // Gera mensagem de texto do cupom para WhatsApp
  const buildWaMsg=()=>{
    const lines=[
      `🛍️ *D'Black Store — Comprovante de Venda*`,
      ``,
      `Olá ${sale.customer}! 😊`,
      `Sua compra foi confirmada! ✅`,
      ``,
      `🔖 *Pedido:* ${sale.cupom}`,
      `📅 *Data:* ${fmtDate(sale.date)}`,
      ``,
      `*Itens:*`,
      ...(sale.items||[]).map(it=>`  • ${it.qty}x ${it.name} — ${fmt(it.price*it.qty)}`),
      ``,
      sale.discount>0?`🏷️ *Desconto:* -${fmt(sale.discount)}`:"",
      `💰 *Total:* ${fmt(sale.total)}`,
      `💳 *Pagamento:* ${sale.payment}`,
      ``,
      `Obrigado pela preferência! 🖤`,
      `*D'Black Store*`,
    ].filter(l=>l!==undefined);
    return lines.join("\n");
  };

  const generateReceiptImage=()=>{
    return new Promise((resolve)=>{
      const W=380,PAD=20,LH=18,LHS=15;
      const storeName=STORES.find(s=>s.id===sale.storeId)?.name||"D'Black Store";
      const items=sale.items||[];
      const payments=sale.payments&&sale.payments.length>0?sale.payments:[{method:sale.payment||"",value:sale.total}];
      // Calcula altura necessária
      const h=PAD+30+LH+LH+10+LH*3+10+LH+items.length*(LH*2)+10+(sale.discount>0?LH*2:0)+10+LH+10+LH+payments.length*LH+10+LH*4+PAD+40;
      const canvas=document.createElement("canvas");
      canvas.width=W;canvas.height=h;
      const ctx=canvas.getContext("2d");
      // Fundo branco
      ctx.fillStyle="#fff";ctx.fillRect(0,0,W,h);
      ctx.fillStyle="#000";
      let y=PAD;
      const center=(text,size,bold)=>{ctx.font=(bold?"bold ":"")+size+"px Arial";ctx.textAlign="center";ctx.fillText(text,W/2,y);y+=size+4;};
      const row=(l,r,bold)=>{ctx.font=(bold?"bold ":"")+"12px Arial";ctx.textAlign="left";ctx.fillText(l,PAD,y);ctx.textAlign="right";ctx.fillText(r,W-PAD,y);y+=LH;};
      const line=()=>{ctx.strokeStyle="#000";ctx.lineWidth=0.5;ctx.setLineDash([2,2]);ctx.beginPath();ctx.moveTo(PAD,y);ctx.lineTo(W-PAD,y);ctx.stroke();ctx.setLineDash([]);y+=8;};
      const lineS=()=>{ctx.strokeStyle="#000";ctx.lineWidth=1.5;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(PAD,y);ctx.lineTo(W-PAD,y);ctx.stroke();y+=8;};

      // Header
      center("D'BLACK STORE",18,true);
      center("COMPROVANTE DE VENDA",11,false);
      center(storeName,10,false);
      line();
      // Info
      const saleTime=sale.created_at?new Date(sale.created_at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}):"";
      row(sale.cupom||"",fmtDate(sale.date)+(saleTime?" "+saleTime:""),true);
      row("Vendedor: "+(sale.seller||"-"),"");
      row("Cliente: "+(sale.customer||"Avulso"),"");
      line();
      // Itens
      ctx.font="bold 11px Arial";ctx.textAlign="left";ctx.fillText("ITENS",PAD,y);y+=LH;
      items.forEach(it=>{
        ctx.font="11px Arial";ctx.textAlign="left";ctx.fillText(it.qty+"x "+it.name,PAD,y);y+=LHS;
        row("  "+it.qty+" x "+fmt(it.price),fmt(it.price*it.qty));
      });
      line();
      // Desconto
      if(sale.discount>0){
        row("Subtotal",fmt(_itemsTotal));
        ctx.fillStyle="#C62828";row("Desconto"+(sale.discountLabel?" ("+sale.discountLabel+")":""),"-"+fmt(sale.discount),true);ctx.fillStyle="#000";
      }
      lineS();
      ctx.font="bold 14px Arial";ctx.textAlign="left";ctx.fillText("TOTAL",PAD,y);ctx.textAlign="right";ctx.fillText(fmt(sale.total),W-PAD,y);y+=LH+4;
      line();
      // Pagamento
      ctx.font="bold 11px Arial";ctx.textAlign="left";ctx.fillText("PAGAMENTO",PAD,y);y+=LH;
      payments.forEach(p=>{row(p.method,fmt(p.received||p.value)+(p.change>0?" troco:"+fmt(p.change):""));});
      line();
      // Footer
      y+=4;
      center("Obrigado pela preferencia!",11,false);
      center("Volte sempre - D'Black Store",11,false);
      center("@d_blackloja",11,true);
      y+=4;
      ctx.fillStyle="#888";center(new Date().toLocaleString("pt-BR"),9,false);

      canvas.toBlob(blob=>resolve(blob),"image/png");
    });
  };

  const openWhatsApp=async()=>{
    const phone=(waPhone||"").replace(/\D/g,"");
    if(!phone){return;}
    try{
      const blob=await generateReceiptImage();
      const file=new File([blob],"comprovante-dblack-"+sale.cupom+".png",{type:"image/png"});
      // Tenta Web Share API (funciona no celular)
      if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){
        await navigator.share({files:[file],title:"Comprovante D'Black",text:"Comprovante de venda "+sale.cupom});
      } else {
        // Fallback: baixa a imagem e abre WhatsApp com texto
        const url=URL.createObjectURL(blob);
        const a=document.createElement("a");a.href=url;a.download=file.name;a.click();URL.revokeObjectURL(url);
        const msg=encodeURIComponent(buildWaMsg());
        window.open(`https://wa.me/${phone}?text=${msg}`,"_blank");
      }
    }catch(e){
      // Fallback final: envia como texto
      const msg=encodeURIComponent(buildWaMsg());
      window.open(`https://wa.me/${phone}?text=${msg}`,"_blank");
    }
  };

  // ─── Code 39 barcode (padrão real, lido por qualquer scanner) ───
  var _C39={'0':'000110100','1':'100100001','2':'001100001','3':'101100000','4':'000110001','5':'100110000','6':'001110000','7':'000100101','8':'100100100','9':'001100100','A':'100001001','B':'001001001','C':'101001000','D':'000011001','E':'100011000','F':'001011000','G':'000001101','H':'100001100','I':'001001100','J':'000011100','K':'100000011','L':'001000011','M':'101000010','N':'000010011','O':'100010010','P':'001010010','Q':'000000111','R':'100000110','S':'001000110','T':'000010110','U':'110000001','V':'011000001','W':'111000000','X':'010010001','Y':'110010000','Z':'011010000','-':'010000101','*':'010010100'};
  var _N=2,_W=5;
  function _c39Bars(text){var chars=['*'].concat(text.toUpperCase().replace(/[^0-9A-Z\-]/g,'').split('')).concat(['*']);var res=[];chars.forEach(function(ch,ci){var pat=_C39[ch];if(!pat)return;pat.split('').forEach(function(b,i){res.push({w:b==='1'?_W:_N,dark:i%2===0});});if(ci<chars.length-1)res.push({w:_N,dark:false});});return res;}
  function C39SVG({text,h=32}){var brs=_c39Bars(text);var xs=[];var x=4;brs.forEach(function(b){xs.push({x:x,w:b.w,dark:b.dark});x+=b.w;});var tw=x+4;return <svg width={tw} height={h+10} viewBox={'0 0 '+tw+' '+(h+10)} style={{display:'block',margin:'0 auto',maxWidth:'100%'}}>{xs.filter(b=>b.dark).map((b,i)=><rect key={i} x={b.x} y={0} width={b.w} height={h} fill="#000"/>)}<text x={tw/2} y={h+9} textAnchor="middle" fill="#000" fontSize="8" fontFamily="Courier New">{text}</text></svg>;}
  var barcode=sale.cupom||"CNF-000000";
  // Calcula subtotal direto dos itens (mais confiável que sale.subtotal)
  var _itemsTotal=(sale.items||[]).reduce(function(s,i){return s+(i.price||0)*(i.qty||1);},0);

  // Auto-print cupom de venda ao abrir (somente no fluxo de venda nova)
  useEffect(()=>{
    if(!autoFlow)return;
    const t=setTimeout(()=>{
      triggerPrint(contentRef,()=>setPhase("troca_prompt"));
    },120);
    return()=>clearTimeout(t);
  },[autoFlow]);

  // Teclado: Enter = imprimir troca, Esc = fechar
  useEffect(()=>{
    if(phase!=="troca_prompt")return;
    const handler=(e)=>{
      if(e.key==="Enter"){e.preventDefault();setPhase("troca");setTimeout(()=>{triggerPrint(contentRef,onClose);},120);}
      if(e.key==="Escape"){e.preventDefault();onClose();}
    };
    window.addEventListener("keydown",handler);
    return()=>window.removeEventListener("keydown",handler);
  },[phase,onClose]);

  // estilos térmico 80mm
  const W={fontFamily:"'Courier New',Courier,monospace",color:"#000",background:"#fff",width:"100%",boxSizing:"border-box",wordBreak:"break-word",fontWeight:700};
  const HR=()=><div style={{borderTop:"1px dashed #000",margin:"5px 0"}}/>;
  const HR2=()=><div style={{borderTop:"2px solid #000",margin:"5px 0"}}/>;
  const Row=({l,r})=><div style={{display:"flex",justifyContent:"space-between",gap:4,padding:"1px 0",fontWeight:700}}><span style={{flex:1,wordBreak:"break-word"}}>{l}</span><span style={{whiteSpace:"nowrap",fontWeight:700}}>{r}</span></div>;

  // Cupom de venda
  const CupomVenda=()=>(
    <div ref={contentRef} id="receipt-print" style={{...W,padding:"6px 4px",fontSize:11,lineHeight:1.6}}>
      <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
      <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>CUPOM NAO FISCAL</div>
      <div style={{textAlign:"center",fontSize:10}}>{STORES.find(s=>s.id===sale.storeId)?.name||""}</div>
      <HR/>
      <Row l={sale.cupom} r={fmtDate(sale.date)+(sale.created_at?" "+new Date(sale.created_at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}):"")} bold/>
      <Row l={"Vendedor: "+sale.seller} r=""/>
      <Row l={"Cliente: "+sale.customer} r=""/>
      <HR/>
      <div style={{fontWeight:700,fontSize:10}}>ITENS</div>
      {sale.items.map(function(it,i){return <div key={i} style={{padding:"1px 0"}}>
        <div style={{fontSize:10}}>{it.qty}x {it.name}</div>
        <Row l={"  "+it.qty+" x "+fmt(it.price)} r={fmt(it.price*it.qty)}/>
      </div>;})}
      <HR/>
      {sale.discount>0&&<><Row l="Subtotal" r={fmt(_itemsTotal)}/><Row l={"Desconto"+(sale.discountLabel?" ("+sale.discountLabel+")":"")} r={"-"+fmt(sale.discount)} bold/></>}
      <HR2/>
      <Row l="TOTAL" r={fmt(sale.total)} bold/>
      <HR/>
      <div style={{fontWeight:700,fontSize:10}}>PAGAMENTO</div>
      {sale.payments&&sale.payments.length>0
        ?sale.payments.map(function(p,i){return <Row key={i} l={p.method} r={fmt(p.received||p.value)+(p.change>0?" troco:"+fmt(p.change):"")}/>;})
        :<Row l={sale.payment} r={fmt(sale.total)}/>}
      <HR/>
      <div style={{textAlign:"center",margin:"4px 0"}}><C39SVG text={barcode} h={32}/></div>
      <HR/>
      <div style={{textAlign:"center",fontSize:11,lineHeight:1.7}}>Obrigado pela preferencia!<br/>Volte sempre - D'Black Store<br/>@d_blackloja</div>
      <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
    </div>
  );

  // Cupom de troca
  const CupomTroca=()=>(
    <div ref={contentRef} id="receipt-print" style={{...W,padding:"6px 4px",fontSize:11,lineHeight:1.6}}>
      <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
      <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>*** CUPOM DE TROCA ***</div>
      <div style={{textAlign:"center",fontSize:10}}>{STORES.find(s=>s.id===sale.storeId)?.name||""}</div>
      <HR/>
      <Row l={sale.cupom} r={fmtDate(sale.date)} bold/>
      <Row l={"Cliente: "+(sale.customer||"Avulso")} r=""/>
      <HR/>
      <div style={{fontWeight:700,fontSize:10}}>ITENS PARA TROCA</div>
      {sale.items.map(function(it,i){return <Row key={i} l={it.qty+"x "+it.name} r=""/>;}) }
      <HR/>
      <div style={{textAlign:"center",margin:"4px 0"}}><C39SVG text={barcode} h={32}/></div>
      <HR/>
      <div style={{textAlign:"center",fontSize:11,lineHeight:1.7}}>Apresente este cupom para realizar<br/>a troca em qualquer loja D'Black.<br/>Sujeito a disponibilidade de estoque.</div>
      <HR/>
      <div style={{textAlign:"center",fontSize:11,fontWeight:700,lineHeight:1.7}}>PRAZO PARA TROCAS E DE 7 DIAS.<br/>TROCAS SOMENTE COM A ETIQUETA<br/>FIXADA NA PECA E MEDIANTE<br/>APRESENTACAO DESTE CUPOM!</div>
      <HR/>
      <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
    </div>
  );

  // ── PHASE: TROCA PROMPT ──
  if(phase==="troca_prompt"){
    return(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.92)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
        <div style={{background:C.s1,border:"1px solid "+C.brdH,borderRadius:20,maxWidth:400,width:"92%",padding:32,textAlign:"center",animation:"fadeIn .25s ease"}}>
          <div style={{fontSize:36,marginBottom:12}}>✅</div>
          <div style={{fontSize:16,fontWeight:800,color:C.grn,marginBottom:6}}>Cupom de venda impresso!</div>
          <div style={{fontSize:13,color:C.dim,marginBottom:28}}>
            {sale.cupom} • {sale.customer} • <strong style={{color:C.gold}}>{fmt(sale.total)}</strong>
          </div>

          <div style={{fontSize:12,color:C.dim,marginBottom:12,fontWeight:600}}>Próximas ações:</div>

          {/* WhatsApp — input de telefone se não tiver cadastrado */}
          {(isEcommerce||showWaBtn)&&<div style={{marginBottom:12,background:"rgba(37,211,102,.08)",border:"1px solid rgba(37,211,102,.25)",borderRadius:12,padding:12}}>
            <div style={{fontSize:11,fontWeight:700,color:"#25D366",marginBottom:8}}>📱 Enviar comprovante por WhatsApp</div>
            <div style={{display:"flex",gap:6}}>
              <input
                type="tel"
                placeholder="Ex: 55319XXXXXXXX"
                value={waPhone}
                onChange={e=>setWaPhone(e.target.value)}
                style={{...S.inp,flex:1,fontSize:12,padding:"7px 10px"}}
              />
              <button
                style={{padding:"7px 14px",borderRadius:8,border:"none",background:"#25D366",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}
                onClick={openWhatsApp}
                disabled={!waPhone.replace(/\D/g,"")}>
                📤 Enviar
              </button>
            </div>
            {!sale.customerWhatsapp&&<div style={{fontSize:10,color:"rgba(37,211,102,.7)",marginTop:5}}>
              ⚠️ Cliente sem WhatsApp cadastrado. Digite o número acima para enviar.
            </div>}
          </div>}

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button autoFocus
              style={{width:"100%",padding:"13px",borderRadius:12,border:"none",background:`linear-gradient(135deg,${C.pur},#AD1457)`,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
              onClick={()=>{setPhase("troca");setTimeout(()=>{triggerPrint(contentRef,onClose);},120);}}>
              🎁 Imprimir Cupom de Troca <span style={{fontSize:11,opacity:.7,marginLeft:4}}>[Enter]</span>
            </button>
            <button
              style={{width:"100%",padding:"11px",borderRadius:12,border:"1px solid "+C.brd,background:"transparent",color:C.txt,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}
              onClick={onClose}>
              ✕ Pular — Nova Venda <span style={{fontSize:11,opacity:.7,marginLeft:4}}>[Esc]</span>
            </button>
          </div>

          <div style={{marginTop:16,fontSize:10,color:C.dim,opacity:.5}}>
            Enter = imprimir troca &nbsp;•&nbsp; Esc = nova venda
          </div>
        </div>
      </div>
    );
  }

  // ── PHASE: CUPOM ou TROCA (manual / reimpressão) ──
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div style={{background:C.s1,border:"1px solid "+C.brdH,borderRadius:18,maxWidth:420,width:"92%",maxHeight:"92vh",overflowY:"auto",animation:"fadeIn .3s ease"}} onClick={function(e){e.stopPropagation();}}>

        {/* Mode tabs */}
        <div style={{display:"flex",borderBottom:"1px solid "+C.brd}}>
          <button onClick={function(){setPhase("cupom");}} style={{flex:1,padding:"12px",background:phase==="cupom"?"rgba(255,215,64,.08)":"transparent",border:"none",borderBottom:phase==="cupom"?"2px solid "+C.gold:"2px solid transparent",color:phase==="cupom"?C.gold:C.dim,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            🧾 Cupom Não Fiscal
          </button>
          <button onClick={function(){setPhase("troca");}} style={{flex:1,padding:"12px",background:phase==="troca"?"rgba(224,64,251,.08)":"transparent",border:"none",borderBottom:phase==="troca"?"2px solid "+C.pur:"2px solid transparent",color:phase==="troca"?C.pur:C.dim,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
            🎁 Cupom de Troca
          </button>
        </div>

        {phase==="cupom"?<CupomVenda/>:<CupomTroca/>}

        <div style={{display:"flex",gap:8,padding:"0 24px 12px"}}>
          <button style={{flex:1,padding:"10px",borderRadius:10,border:"1px solid "+C.brd,background:C.s2,color:C.dim,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}} onClick={onClose}>Fechar</button>
          <button style={{flex:2,padding:"10px",borderRadius:10,border:"none",background:"linear-gradient(135deg,"+C.gold+","+C.goldD+")",color:C.bg,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}} onClick={function(){triggerPrint(contentRef);}}>🖨️ Imprimir</button>
        </div>
        {/* WhatsApp na reimpressão */}
        {showWaBtn&&<div style={{margin:"0 24px 20px",background:"rgba(37,211,102,.08)",border:"1px solid rgba(37,211,102,.2)",borderRadius:10,padding:"10px 12px"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#25D366",marginBottom:6}}>📱 Reenviar por WhatsApp</div>
          <div style={{display:"flex",gap:6}}>
            <input type="tel" placeholder="55319XXXXXXXX" value={waPhone} onChange={e=>setWaPhone(e.target.value)} style={{...S.inp,flex:1,fontSize:12,padding:"6px 10px"}}/>
            <button style={{padding:"6px 12px",borderRadius:8,border:"none",background:"#25D366",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}} onClick={openWhatsApp}>Enviar</button>
          </div>
        </div>}
      </div>
    </div>
  );
}

// ─── Receipt / Comprovante Caixa, Sangria, Despesa ───
function ReceiptComprovante({data,onClose}){
  const contentRef=useRef(null);

  // Auto-print ao abrir (mesmo padrão do ReceiptCupom)
  useEffect(()=>{
    const t=setTimeout(()=>{triggerPrint(contentRef);},120);
    return()=>clearTimeout(t);
  },[]);

  // Estilos térmico 80mm (mesmo do CupomVenda)
  const W={fontFamily:"'Courier New',Courier,monospace",color:"#000",background:"#fff",width:"100%",boxSizing:"border-box",wordBreak:"break-word",fontWeight:700};
  const HR=()=><div style={{borderTop:"1px dashed #000",margin:"5px 0"}}/>;
  const HR2=()=><div style={{borderTop:"2px solid #000",margin:"5px 0"}}/>;
  const Row=({l,r})=><div style={{display:"flex",justifyContent:"space-between",gap:4,padding:"1px 0",fontWeight:700}}><span style={{flex:1,wordBreak:"break-word"}}>{l}</span><span style={{whiteSpace:"nowrap",fontWeight:700}}>{r}</span></div>;

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={onClose}>
      <div style={{background:C.s1,border:"1px solid "+C.brdH,borderRadius:18,maxWidth:420,width:"92%",maxHeight:"92vh",overflowY:"auto",animation:"fadeIn .3s ease"}} onClick={function(e){e.stopPropagation();}}>

        {/* Conteúdo do cupom */}
        <div ref={contentRef} id="receipt-print" style={{...W,padding:"6px 4px",fontSize:11,lineHeight:1.6}}>

          {/* ── SANGRIA / SUPRIMENTO ── */}
          {data.type==="sangria"&&<>
            <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
            <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>COMPROVANTE DE {data.movType==="saida"?"SANGRIA":"SUPRIMENTO"}</div>
            <div style={{textAlign:"center",fontSize:10}}>{data.store}</div>
            <HR/>
            <Row l={"Data: "+data.date} r={"Hora: "+data.time}/>
            <Row l={"Operador: "+data.operator} r=""/>
            <HR/>
            <Row l="Tipo" r={data.movType==="saida"?"Sangria (Retirada)":"Suprimento (Entrada)"}/>
            <Row l="Descricao" r={data.desc}/>
            <HR2/>
            <div style={{textAlign:"center",fontSize:22,fontWeight:900,margin:"8px 0"}}>{data.movType==="saida"?"- ":"+ "}{fmt(data.value)}</div>
            <HR2/>
            <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
          </>}

          {/* ── FECHAMENTO DE CAIXA ── */}
          {data.type==="fechamento"&&<>
            <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
            <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>FECHAMENTO DE CAIXA</div>
            <div style={{textAlign:"center",fontSize:10}}>{data.store}</div>
            <HR/>
            <Row l={"Data: "+data.date} r={data.report.closedBy}/>
            <Row l={"Operador: "+data.operator} r=""/>
            <HR2/>
            <div style={{fontWeight:700,fontSize:10,letterSpacing:1}}>RESUMO DE VENDAS</div>
            <Row l="Qtd. vendas" r={String(data.vendas)}/>
            <Row l="Total faturado" r={fmt(data.totalVendas)}/>
            <Row l="Total descontos" r={fmt(data.totalDesc)}/>
            <HR/>
            {data.history.filter(h=>h.type==="saida").length>0&&<>
              <div style={{fontWeight:700,fontSize:10,letterSpacing:1}}>SANGRIAS</div>
              {data.history.filter(h=>h.type==="saida").map((h,i)=><Row key={i} l={h.time+" - "+h.desc} r={"-"+fmt(h.value)}/>)}
              <Row l="Total sangrias" r={"-"+fmt(data.sangrias)}/>
              <HR/>
            </>}
            {data.history.filter(h=>h.type==="entrada"&&!h.desc?.startsWith("Venda ")).length>0&&<>
              <div style={{fontWeight:700,fontSize:10,letterSpacing:1}}>SUPRIMENTOS</div>
              {data.history.filter(h=>h.type==="entrada"&&!h.desc?.startsWith("Venda ")).map((h,i)=><Row key={i} l={h.time+" - "+h.desc} r={"+"+fmt(h.value)}/>)}
              <HR/>
            </>}
            <div style={{fontWeight:700,fontSize:10,letterSpacing:1}}>CONFERENCIA POR FORMA PGTO</div>
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:9,borderBottom:"1px solid #000",paddingBottom:2,marginBottom:2}}><span style={{flex:1}}>FORMA</span><span style={{width:50,textAlign:"right"}}>ESPER.</span><span style={{width:50,textAlign:"right"}}>CONT.</span><span style={{width:50,textAlign:"right"}}>DIF.</span></div>
            {data.groups.map(g=>{const esp=data.report.esperado[g.key];const cnt=data.report.counted[g.key];const d=cnt!==""?(+cnt)-esp:null;const lbl=({dinheiro:"Dinheiro",pix:"PIX",credito:"Credito",debito:"Debito",outros:"Outros"})[g.key];return(esp>0||cnt!=="")&&<div key={g.key} style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:10,padding:"1px 0"}}><span style={{flex:1}}>{lbl}</span><span style={{width:50,textAlign:"right"}}>{fmt(esp)}</span><span style={{width:50,textAlign:"right"}}>{cnt!==""?fmt(+cnt):"--"}</span><span style={{width:50,textAlign:"right"}}>{d!=null?(d>=0?"+":"")+fmt(d):"--"}</span></div>;})}
            <HR2/>
            <Row l="ESPERADO" r={fmt(Object.values(data.report.esperado).reduce((s,v)=>s+v,0))}/>
            <Row l="CONTADO" r={fmt(data.groups.reduce((s,g)=>s+(+data.report.counted[g.key]||0),0))}/>
            <HR/>
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:900,fontSize:14,margin:"4px 0"}}><span>DIFERENCA:</span><span>{data.report.diferenca>=0?"+":""}{fmt(data.report.diferenca)}</span></div>
            {data.report.diferenca!==0&&<div style={{textAlign:"center",fontWeight:900,fontSize:11}}>{data.report.diferenca>0?"*** SOBRA ***":"*** FALTA ***"}</div>}
            {data.report.obs&&<><HR/><Row l="Obs" r={data.report.obs}/></>}
            <HR/>
            <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
          </>}

          {/* ── DESPESA ── */}
          {data.type==="despesa"&&<>
            <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
            <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>COMPROVANTE DE DESPESA</div>
            <div style={{textAlign:"center",fontSize:10}}>{data.store}</div>
            <HR/>
            <Row l={"Data: "+fmtDate(data.date)} r=""/>
            <HR/>
            <Row l="Categoria" r={data.category}/>
            <Row l="Descricao" r={data.description}/>
            <Row l="Tipo" r={data.recurring?"Despesa Fixa":"Despesa Variavel"}/>
            <HR2/>
            <div style={{textAlign:"center",fontSize:22,fontWeight:900,margin:"8px 0"}}>{fmt(data.value)}</div>
            <HR2/>
            <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
          </>}

          {/* ── TRANSFERÊNCIA ── */}
          {/* ── RETIRADA GRANDE ── */}
          {data.type==="retirada"&&<>
            <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
            <div style={{textAlign:"center",fontSize:12,letterSpacing:1,fontWeight:900}}>COMPROVANTE DE RETIRADA</div>
            <div style={{textAlign:"center",fontSize:10}}>{data.store}</div>
            <HR2/>
            <Row l={"Data: "+data.date} r={"Hora: "+data.time}/>
            <Row l={"Operador: "+data.operator} r=""/>
            <HR/>
            <Row l="Responsavel:" r={data.responsible}/>
            {data.destination&&<Row l="Destino:" r={data.destination}/>}
            <Row l="Motivo:" r={data.description||"-"}/>
            <HR2/>
            <div style={{textAlign:"center",fontSize:24,fontWeight:900,margin:"8px 0",color:"#000"}}>- {fmt(data.value)}</div>
            <HR2/>
            <div style={{marginTop:16,fontSize:10}}>
              <div style={{borderBottom:"1px solid #000",paddingBottom:14,marginBottom:6}}>Assinatura: ________________________</div>
            </div>
            <div style={{textAlign:"center",fontSize:9,marginTop:6,color:"#666"}}>Documento gerado em {new Date().toLocaleString("pt-BR")}</div>
          </>}

          {data.type==="transferencia"&&<>
            <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
            <div style={{textAlign:"center",fontSize:12,letterSpacing:1,fontWeight:900}}>TRANSFERÊNCIA DE MERCADORIA</div>
            <HR2/>
            <Row l={"Data: "+data.date} r={"Hora: "+data.time}/>
            <Row l={"ID: "+data.id.slice(-8).toUpperCase()} r=""/>
            <HR/>
            <Row l="ORIGEM:" r={data.from}/>
            <Row l="DESTINO:" r={data.to}/>
            <HR/>
            {data.description&&<Row l="Motivo:" r={data.description}/>}
            {data.clientName&&<Row l="Cliente:" r={data.clientName}/>}
            {data.clientPhone&&<Row l="Telefone:" r={data.clientPhone}/>}
            {data.requestedBy&&<Row l="Pedido por:" r={data.requestedBy}/>}
            {data.separatedBy&&<Row l="Separado por:" r={data.separatedBy}/>}
            <Row l="Pago:" r={data.paid?"SIM":"NAO"}/>
            <HR2/>
            <div style={{fontWeight:900,fontSize:10,letterSpacing:1,marginBottom:4}}>PRODUTOS</div>
            {data.items.map((item,i)=><div key={i} style={{padding:"3px 0",borderBottom:"1px dotted #999"}}>
              <div style={{fontWeight:700,fontSize:11}}>{item.productName}</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}>
                <span>SKU: {item.sku}</span>
                <span>{item.qty} un. x {fmt(item.cost)} = {fmt(item.cost*item.qty)}</span>
              </div>
            </div>)}
            <HR2/>
            <Row l={"TOTAL PECAS:"} r={data.totalPcs+" un."}/>
            <Row l={"VALOR CUSTO:"} r={fmt(data.totalVal)}/>
            <HR2/>
            <div style={{marginTop:16,fontSize:10}}>
              <div style={{borderBottom:"1px solid #000",marginBottom:4,paddingBottom:12}}>Assinatura (separou): ________________________</div>
              <div style={{borderBottom:"1px solid #000",marginBottom:4,paddingBottom:12}}>Assinatura (recebeu): ________________________</div>
            </div>
            <div style={{textAlign:"center",fontSize:9,marginTop:6,color:"#666"}}>Documento gerado em {new Date().toLocaleString("pt-BR")}</div>
          </>}
        </div>

        {/* Botões (mesmo padrão do ReceiptCupom) */}
        <div style={{display:"flex",gap:8,padding:"0 24px 12px"}}>
          <button style={{flex:1,padding:"10px",borderRadius:10,border:"1px solid "+C.brd,background:C.s2,color:C.dim,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}} onClick={onClose}>Fechar</button>
          <button style={{flex:2,padding:"10px",borderRadius:10,border:"none",background:"linear-gradient(135deg,"+C.gold+","+C.goldD+")",color:C.bg,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:6}} onClick={function(){triggerPrint(contentRef);}}>🖨️ Imprimir</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  PRODUTOS MODULE (Cadastro) ═══
// ═══════════════════════════════════
function ProdutosModule({catalog,setCatalog,stock,setStock,showToast}){
  const [search,setSearch]=useState("");
  const [filterCat,setFilterCat]=useState("");
  const [showForm,setShowForm]=useState(false);
  const [formTab,setFormTab]=useState("essencial"); // essencial, detalhes
  const [editId,setEditId]=useState(null);
  const [showImport,setShowImport]=useState(false);
  const [csvText,setCsvText]=useState("");
  const [categories,setCategories]=useState(CATEGORIES);
  const [newCat,setNewCat]=useState("");
  const [showCatManager,setShowCatManager]=useState(false);

  // Auto-generate next SKU and EAN
  const getNextSku=()=>{
    const skuNums=catalog.map(p=>{const m=(p.sku||"").match(/(\d+)$/);return m?parseInt(m[1]):0;});
    const next=Math.max(0,...skuNums)+1;
    return "DBK-"+String(next).padStart(4,"0");
  };
  const getNextEan=()=>{
    const eanNums=catalog.map(p=>{const n=parseInt((p.ean||"0").slice(-5));return isNaN(n)?0:n;});
    const next=Math.max(0,...eanNums)+1;
    return "789"+String(next).padStart(10,"0");
  };
  const getNextRef=()=>{
    const refNums=catalog.map(p=>{const m=(p.ref||"").match(/(\d+)$/);return m?parseInt(m[1]):0;});
    const next=Math.max(0,...refNums)+1;
    return "REF-"+String(next).padStart(3,"0");
  };

  const newEmpty=()=>({name:"",sku:getNextSku(),ean:getNextEan(),ref:getNextRef(),category:"Camisetas",brand:"D'Black",supplier:"",size:"",color:"",price:"",cost:"",minStock:"10",img:"👕",photo:"",variations:"",active:true});
  const [np,setNp]=useState(newEmpty());

  // Margin calc (markup sobre custo)
  const npPrice=+np.price||0;const npCost=+np.cost||0;
  const npMargin=npCost>0?((npPrice-npCost)/npCost*100):0;

  const filtered=catalog.filter(p=>{
    const matchSearch=p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase())||(p.ean||"").includes(search)||(p.ref||"").toLowerCase().includes(search.toLowerCase());
    const matchCat=filterCat?p.category===filterCat:true;
    return matchSearch&&matchCat;
  });

  // Save product (add or edit)
  const saveProduct=()=>{
    if(!np.name||!np.sku)return showToast("Preencha nome e SKU!","error");
    if(!np.price||!np.cost)return showToast("Preencha preço e custo!","error");
    const vars=np.variations?np.variations.split(",").map(v=>v.trim()).filter(Boolean):[];
    const margin=npCost>0?((npPrice-npCost)/npCost*100):0;
    if(editId){
      const updated = {...np,price:npPrice,cost:npCost,margin,minStock:+np.minStock||0,variations:vars};
      setCatalog(prev=>prev.map(p=>p.id===editId?{...p,...updated}:p));
      api.updateProduct(editId, prodToApi(updated)).catch(console.error);
      setEditId(null);showToast("Produto atualizado!");
    } else {
      const newProd={...np,id:genId(),price:npPrice,cost:npCost,margin,minStock:+np.minStock||0,variations:vars};
      setCatalog(prev=>[...prev,newProd]);
      setStock(prev=>{const n={...prev};Object.keys(n).forEach(sid=>{n[sid]={...n[sid],[newProd.id]:0};});return n;});
      api.createProduct(prodToApi(newProd)).catch(console.error);
      showToast("Produto cadastrado!");
    }
    setNp(newEmpty());setShowForm(false);
  };

  // Edit
  const startEdit=(p)=>{
    setNp({...p,price:String(p.price),cost:String(p.cost),minStock:String(p.minStock),variations:(p.variations||[]).join(", ")});
    setEditId(p.id);setShowForm(true);setFormTab("essencial");
  };

  // Toggle active
  const toggleProduct=(id)=>{
    setCatalog(prev=>prev.map(p=>{
      if(p.id!==id) return p;
      const updated={...p,active:!p.active};
      api.updateProduct(id, prodToApi(updated)).catch(console.error);
      return updated;
    }));
  };

  // CSV Import
  const importCSV=()=>{
    if(!csvText.trim())return showToast("Cole os dados CSV!","error");
    const lines=csvText.trim().split("\n");
    var count=0;
    lines.forEach((line,idx)=>{
      if(idx===0)return; // skip header
      const cols=line.split(";").map(c=>c.trim());
      if(cols.length<6)return;
      const [name,sku,category,size,color,price,cost]=cols;
      if(!name||!sku)return;
      const p=+price||0;const c=+cost||0;
      const newProd={id:genId(),name,sku,ean:"",ref:"",category:category||"Camisetas",brand:"D'Black",supplier:"",size:size||"",color:color||"",price:p,cost:c,margin:c>0?((p-c)/c*100):0,minStock:10,img:"👕",variations:[],active:true};
      setCatalog(prev=>[...prev,newProd]);
      setStock(prev=>{const n={...prev};Object.keys(n).forEach(sid=>{n[sid]={...n[sid],[newProd.id]:0};});return n;});
      count++;
    });
    setCsvText("");setShowImport(false);
    showToast(count+" produtos importados!");
  };

  // Add custom category
  const addCategory=()=>{
    if(!newCat.trim())return;
    if(categories.includes(newCat.trim()))return showToast("Categoria já existe","error");
    setCategories(prev=>[...prev,newCat.trim()]);
    setNewCat("");showToast("Categoria adicionada!");
  };

  // Stats
  const totalProducts=catalog.length;
  const activeProducts=catalog.filter(p=>p.active).length;
  const avgMargin=catalog.length>0?(catalog.reduce((s,p)=>s+(p.margin||0),0)/catalog.length):0;
  const catCount={};catalog.forEach(p=>{catCount[p.category]=(catCount[p.category]||0)+1;});

  return(
    <div>
      <div style={S.kpiRow}>
        <KPI icon={I.box} label="Produtos" value={totalProducts+""} sub={activeProducts+" ativos"} color={C.blu}/>
        <KPI icon={I.chart} label="Margem Média" value={pct(avgMargin)} sub="Preço vs Custo" color={C.grn}/>
        <KPI icon={I.money} label="Categorias" value={Object.keys(catCount).length+""} sub="No catálogo" color={C.gold}/>
      </div>

      <div style={S.toolbar}>
        <div style={{...S.searchBar,flex:1}}>{I.search}<input style={S.searchIn} placeholder="Buscar por nome, SKU, EAN, referência..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <select style={{...S.sel,minWidth:120}} value={filterCat} onChange={e=>setFilterCat(e.target.value)}>
          <option value="">Todas categorias</option>
          {categories.map(c=><option key={c}>{c}</option>)}
        </select>
        <button style={S.secBtn} onClick={()=>setShowCatManager(!showCatManager)}>📁 Categorias</button>
        <button style={S.secBtn} onClick={()=>setShowImport(!showImport)}>📥 Importar CSV</button>
        <button style={S.primBtn} onClick={()=>{setNp(newEmpty());setEditId(null);setShowForm(!showForm);}}>{I.plus} Novo Produto</button>
      </div>

      {/* Category Manager */}
      {showCatManager&&<div style={S.formCard}>
        <h3 style={S.formTitle}>Gerenciar Categorias</h3>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
          {categories.map(c=><span key={c} style={{padding:"4px 10px",borderRadius:6,background:C.s2,border:`1px solid ${C.brd}`,fontSize:12,fontWeight:600,color:C.txt,display:"flex",alignItems:"center",gap:4}}>
            {c}
            <button onClick={()=>setCategories(prev=>prev.filter(x=>x!==c))} style={{background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:10,padding:0}}>✕</button>
          </span>)}
        </div>
        <div style={{display:"flex",gap:6}}>
          <input style={{...S.inp,flex:1}} placeholder="Nova categoria..." value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCategory()}/>
          <button style={S.primBtn} onClick={addCategory}>{I.plus} Adicionar</button>
        </div>
      </div>}

      {/* CSV Import */}
      {showImport&&<div style={S.formCard}>
        <h3 style={S.formTitle}>📥 Importar Produtos via CSV</h3>
        <p style={{fontSize:12,color:C.dim,marginBottom:8}}>Cole o conteúdo do CSV abaixo. Formato: <strong>Nome;SKU;Categoria;Tamanho;Cor;Preço;Custo</strong> (primeira linha = cabeçalho, será ignorada)</p>
        <textarea style={{...S.inp,width:"100%",minHeight:100,resize:"vertical",fontFamily:"monospace",fontSize:11}} value={csvText} onChange={e=>setCsvText(e.target.value)} placeholder={"Nome;SKU;Categoria;Tamanho;Cor;Preço;Custo\nCamiseta Preta;CAM-100;Camisetas;M;Preto;99.90;35\nCalça Jeans;CAL-200;Calças;42;Azul;189.90;70"}/>
        <div style={S.formAct}>
          <button style={S.secBtn} onClick={()=>setShowImport(false)}>Cancelar</button>
          <button style={S.primBtn} onClick={importCSV}>{I.check} Importar</button>
        </div>
      </div>}

      {/* Product Form */}
      {showForm&&<div style={S.formCard}>
        <h3 style={S.formTitle}>{editId?"✏️ Editar Produto":"➕ Novo Produto"}</h3>

        {/* Form Tabs */}
        <div style={{display:"flex",gap:4,marginBottom:14}}>
          <button onClick={()=>setFormTab("essencial")} style={{flex:1,padding:"8px",borderRadius:8,border:"1px solid "+(formTab==="essencial"?C.gold:C.brd),background:formTab==="essencial"?"rgba(255,215,64,.08)":C.s2,color:formTab==="essencial"?C.gold:C.dim,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>📋 Essencial</button>
          <button onClick={()=>setFormTab("detalhes")} style={{flex:1,padding:"8px",borderRadius:8,border:"1px solid "+(formTab==="detalhes"?C.blu:C.brd),background:formTab==="detalhes"?"rgba(64,196,255,.08)":C.s2,color:formTab==="detalhes"?C.blu:C.dim,cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>📝 Detalhes Adicionais</button>
        </div>

        {/* TAB 1: ESSENCIAL */}
        {formTab==="essencial"&&<div>
          <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
            {/* Left: Photo */}
            <div style={{width:120,display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
              <label style={{cursor:"pointer",display:"block"}}>
                <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                  const file=e.target.files?.[0];
                  if(!file)return;
                  const reader=new FileReader();
                  reader.onload=ev=>setNp(p=>({...p,photo:ev.target.result}));
                  reader.readAsDataURL(file);
                }}/>
                <div style={{width:100,height:100,borderRadius:14,background:C.s2,border:`2px dashed ${np.photo?C.gold:C.brd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:np.photo?0:40,overflow:"hidden",position:"relative"}}>
                  {np.photo
                    ? <img src={np.photo} alt="foto" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:12}}/>
                    : <span>{np.img}</span>
                  }
                  <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,.55)",fontSize:9,color:"#fff",textAlign:"center",padding:"3px 0",borderRadius:"0 0 12px 12px"}}>
                    {np.photo?"trocar foto":"📷 clique"}
                  </div>
                </div>
              </label>
              {np.photo&&<button style={{...S.secBtn,padding:"4px 8px",fontSize:10}} onClick={()=>setNp(p=>({...p,photo:""}))}>✕ remover</button>}
              {!np.photo&&<select style={{...S.sel,width:"100%",fontSize:11,textAlign:"center"}} value={np.img} onChange={e=>setNp(p=>({...p,img:e.target.value}))}>
                {EMOJIS.map(e=><option key={e} value={e}>{e}</option>)}
              </select>}
              <div style={{fontSize:9,color:C.dim,textAlign:"center"}}>{np.photo?"foto carregada":"ícone ou foto"}</div>
            </div>

            {/* Right: Essential fields */}
            <div style={{flex:1,minWidth:240,display:"flex",flexDirection:"column",gap:8}}>
              <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Nome do produto *</label><input style={{...S.inp,width:"100%",fontSize:15,fontWeight:600}} value={np.name} onChange={e=>setNp(p=>({...p,name:e.target.value}))} placeholder="Ex: Camiseta Oversized Premium" autoFocus/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>SKU *</label><input style={{...S.inp,width:"100%"}} value={np.sku} onChange={e=>setNp(p=>({...p,sku:e.target.value}))} placeholder="CAM-001"/></div>
                <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Código EAN (código de barras)</label><input style={{...S.inp,width:"100%"}} value={np.ean} onChange={e=>setNp(p=>({...p,ean:e.target.value}))} placeholder="7891234560011"/></div>
              </div>
              <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Categoria</label><select style={{...S.sel,width:"100%"}} value={np.category} onChange={e=>setNp(p=>({...p,category:e.target.value}))}>{categories.map(c=><option key={c}>{c}</option>)}</select></div>
            </div>
          </div>

          {/* Price block */}
          <div style={{marginTop:14,padding:14,background:C.s2,borderRadius:12,border:`1px solid ${C.brd}`}}>
            <div style={{fontSize:11,fontWeight:700,color:C.dim,letterSpacing:1,marginBottom:10}}>💰 PREÇOS</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,alignItems:"end"}}>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Preço de Custo R$ *</label>
                <input style={{...S.inp,width:"100%",fontSize:16,fontWeight:700}} type="number" value={np.cost} onChange={e=>setNp(p=>({...p,cost:e.target.value}))} placeholder="45.00"/>
              </div>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Preço de Venda R$ *</label>
                <input style={{...S.inp,width:"100%",fontSize:16,fontWeight:700,borderColor:C.gold+"44"}} type="number" value={np.price} onChange={e=>setNp(p=>({...p,price:e.target.value}))} placeholder="149.90"/>
              </div>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Margem (automática)</label>
                <div style={{padding:"10px 12px",borderRadius:8,background:npMargin>=100?"rgba(0,230,118,.1)":npMargin>=50?"rgba(255,215,64,.1)":"rgba(255,82,82,.1)",border:`1px solid ${npMargin>=100?C.grn:npMargin>=50?C.gold:C.red}44`,fontSize:18,fontWeight:900,color:npMargin>=100?C.grn:npMargin>=50?C.gold:C.red,textAlign:"center"}}>{npCost>0?pct(npMargin):"—"}</div>
              </div>
            </div>
            {npCost>0&&npPrice>0&&<div style={{marginTop:8,fontSize:11,color:C.dim,textAlign:"center"}}>
              Lucro por peça: <strong style={{color:C.grn}}>{fmt(npPrice-npCost)}</strong>
            </div>}
          </div>
        </div>}

        {/* TAB 2: DETALHES ADICIONAIS */}
        {formTab==="detalhes"&&<div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:8}}>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Referência</label><input style={{...S.inp,width:"100%"}} value={np.ref} onChange={e=>setNp(p=>({...p,ref:e.target.value}))} placeholder="REF-001"/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Marca</label><input style={{...S.inp,width:"100%"}} value={np.brand} onChange={e=>setNp(p=>({...p,brand:e.target.value}))}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Fornecedor</label><input style={{...S.inp,width:"100%"}} value={np.supplier} onChange={e=>setNp(p=>({...p,supplier:e.target.value}))}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Tamanho</label><input style={{...S.inp,width:"100%"}} value={np.size} onChange={e=>setNp(p=>({...p,size:e.target.value}))} placeholder="M, 42, Único"/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Cor</label><input style={{...S.inp,width:"100%"}} value={np.color} onChange={e=>setNp(p=>({...p,color:e.target.value}))}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Estoque Mínimo</label><input style={{...S.inp,width:"100%"}} type="number" value={np.minStock} onChange={e=>setNp(p=>({...p,minStock:e.target.value}))}/></div>
          </div>
          <div style={{marginTop:10}}>
            <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Variações (separar por vírgula)</label>
            <input style={{...S.inp,width:"100%"}} value={np.variations} onChange={e=>setNp(p=>({...p,variations:e.target.value}))} placeholder="P, M, G, GG  ou  38, 40, 42, 44, 46"/>
            {np.variations&&<div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap"}}>{np.variations.split(",").map((v,i)=>v.trim()?<span key={i} style={{padding:"3px 10px",borderRadius:6,background:C.s1,border:`1px solid ${C.brd}`,fontSize:11,fontWeight:600}}>{v.trim()}</span>:null)}</div>}
          </div>
        </div>}

        {/* Preview (always visible) */}
        {np.name&&<div style={{marginTop:14,padding:12,background:C.s2,borderRadius:10,display:"flex",alignItems:"center",gap:12,border:`1px solid ${C.brd}`}}>
          {np.photo
            ? <img src={np.photo} alt={np.name} style={{width:48,height:48,objectFit:"cover",borderRadius:10,flexShrink:0}}/>
            : <span style={{fontSize:32}}>{np.img}</span>
          }
          <div style={{flex:1}}>
            <div style={{fontWeight:700}}>{np.name}</div>
            <div style={{fontSize:11,color:C.dim}}>{np.sku}{np.ean?" • EAN: "+np.ean:""}{np.ref?" • "+np.ref:""}</div>
            <div style={{fontSize:11,color:C.dim}}>{np.category}{np.brand?" • "+np.brand:""}{np.supplier?" • "+np.supplier:""}</div>
            {np.variations&&<div style={{display:"flex",gap:3,marginTop:4,flexWrap:"wrap"}}>{np.variations.split(",").map((v,i)=>v.trim()?<span key={i} style={{padding:"2px 6px",borderRadius:4,background:C.s1,border:`1px solid ${C.brd}`,fontSize:9,fontWeight:600}}>{v.trim()}</span>:null)}</div>}
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:18,fontWeight:800,color:C.gold}}>{fmt(npPrice)}</div>
            <div style={{fontSize:11,color:C.dim}}>Custo: {fmt(npCost)}</div>
            {npCost>0&&<div style={{fontSize:12,fontWeight:700,color:npMargin>=100?C.grn:npMargin>=50?C.gold:C.red}}>Margem: {pct(npMargin)}</div>}
          </div>
        </div>}

        <div style={{...S.formAct,marginTop:12}}>
          <button style={S.secBtn} onClick={()=>{setShowForm(false);setEditId(null);setNp(newEmpty());setFormTab("essencial");}}>Cancelar</button>
          <button style={S.primBtn} onClick={saveProduct}>{I.check} {editId?"Salvar Alterações":"Cadastrar Produto"}</button>
        </div>
      </div>}

      {/* Product Table */}
      <div style={S.tWrap}><table style={S.table}><thead><tr>
        <th style={S.th}></th><th style={S.th}>Produto</th><th style={S.th}>SKU / EAN</th><th style={S.th}>Cat.</th><th style={S.th}>Marca</th><th style={S.th}>Tam.</th><th style={S.th}>Cor</th><th style={S.th}>Preço</th><th style={S.th}>Custo</th><th style={S.th}>Margem</th><th style={S.th}>Variações</th><th style={S.th}>Ações</th>
      </tr></thead>
      <tbody>{filtered.map(p=><tr key={p.id} style={{...S.tr,...(!p.active?{opacity:.35}:{})}}>
        <td style={S.td}>{p.photo
          ? <img src={p.photo} alt={p.name} style={{width:40,height:40,objectFit:"cover",borderRadius:8,display:"block"}}/>
          : <span style={{fontSize:20}}>{p.img}</span>
        }</td>
        <td style={S.td}><div style={{fontWeight:700,fontSize:13}}>{p.name}</div>{p.ref&&<div style={{fontSize:9,color:C.dim}}>{p.ref}</div>}{p.supplier&&<div style={{fontSize:9,color:C.dim}}>Forn: {p.supplier}</div>}</td>
        <td style={S.td}><div style={{fontFamily:"monospace",fontSize:11}}>{p.sku}</div>{p.ean&&<div style={{fontFamily:"monospace",fontSize:9,color:C.dim}}>{p.ean}</div>}</td>
        <td style={S.td}><span style={S.payBadge}>{p.category}</span></td>
        <td style={{...S.td,fontSize:11}}>{p.brand||"-"}</td>
        <td style={S.td}>{p.size}</td>
        <td style={{...S.td,fontSize:11}}>{p.color}</td>
        <td style={{...S.td,...S.tdM}}>{fmt(p.price)}</td>
        <td style={{...S.td,opacity:.6,fontSize:11}}>{fmt(p.cost)}</td>
        <td style={{...S.td,fontWeight:700,color:(p.margin||0)>=100?C.grn:(p.margin||0)>=50?C.gold:C.red}}>{pct(p.margin||0)}</td>
        <td style={S.td}><div style={{display:"flex",gap:2,flexWrap:"wrap"}}>{(p.variations||[]).length>0?(p.variations||[]).map((v,i)=><span key={i} style={{padding:"1px 5px",borderRadius:3,background:C.s2,fontSize:9,border:`1px solid ${C.brd}`}}>{v}</span>):<span style={{fontSize:10,color:C.dim}}>-</span>}</div></td>
        <td style={S.td}><div style={{display:"flex",gap:3}}>
          <button style={S.smBtn} onClick={()=>startEdit(p)}>✏️</button>
          <button style={{...S.smBtn,color:p.active?C.red:C.grn}} onClick={()=>toggleProduct(p.id)}>{p.active?"Desativar":"Ativar"}</button>
          <button style={{...S.smBtn,color:C.red}} onClick={()=>{if(!confirm("Tem certeza que deseja EXCLUIR este produto? Esta ação não pode ser desfeita."))return;setCatalog(prev=>prev.filter(x=>x.id!==p.id));api.deleteProduct(p.id).catch(console.error);showToast("Produto excluído!");}}>🗑️</button>
        </div></td>
      </tr>)}</tbody></table></div>

      {/* Category breakdown */}
      <div style={{...S.card,marginTop:12}}>
        <h3 style={S.cardTitle}>Produtos por Categoria</h3>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {Object.entries(catCount).sort((a,b)=>b[1]-a[1]).map(([cat,count])=>
            <div key={cat} style={{background:C.s2,borderRadius:8,padding:"8px 14px",border:`1px solid ${C.brd}`,textAlign:"center",cursor:"pointer"}} onClick={()=>setFilterCat(filterCat===cat?"":cat)}>
              <div style={{fontSize:18,fontWeight:800,color:filterCat===cat?C.gold:C.txt}}>{count}</div>
              <div style={{fontSize:10,color:C.dim}}>{cat}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  ESTOQUE MODULE             ═══
// ═══════════════════════════════════
function EstoqueModule({storeProducts,activeStore,stock,setStock,currentStore,catalog,showToast,activeStockId,isSharedStock,sharedStockStores}){
  const [search,setSearch]=useState("");
  const [activeTab,setActiveTab]=useState("lista"); // lista, entrada, saida, contagem, transferencia
  const [movHistory,setMovHistory]=useState([]); // {id,date,type,productId,productName,qty,reason,from,to}

  // Entry/Exit form
  const [movType,setMovType]=useState("entrada");
  const [movProduct,setMovProduct]=useState("");
  const [movQty,setMovQty]=useState("");
  const [movReason,setMovReason]=useState("");
  const [movSearch,setMovSearch]=useState("");
  const movSearchRef=useRef(null);

  // Transfer form — múltiplos produtos
  const [transItems,setTransItems]=useState([]); // [{productId,productName,img,qty,stock}]
  const [transSearch,setTransSearch]=useState("");
  const [transTo,setTransTo]=useState("");
  const [transDesc,setTransDesc]=useState("");
  const [transRequestedBy,setTransRequestedBy]=useState("");
  const [transSeparatedBy,setTransSeparatedBy]=useState("");
  const [transPaid,setTransPaid]=useState(false);
  const [transClientName,setTransClientName]=useState("");
  const [transClientPhone,setTransClientPhone]=useState("");
  const [printTransfer,setPrintTransfer]=useState(null);
  const transSearchRef=useRef(null);

  // Count form
  const [countData,setCountData]=useState(null); // [{productId, systemQty, countedQty}]
  const [countDone,setCountDone]=useState(false);
  const [scanInput,setScanInput]=useState("");
  const [scanHighlight,setScanHighlight]=useState(null); // productId highlighted
  const scanRef=useRef(null);
  const countInputRefs=useRef({});

  const filtered=storeProducts.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase())||p.category.toLowerCase().includes(search.toLowerCase()));
  const lowStock=storeProducts.filter(p=>p.stock<=p.minStock);
  const totalPieces=storeProducts.reduce((s,p)=>s+p.stock,0);
  const totalValue=storeProducts.reduce((s,p)=>s+p.cost*p.stock,0);
  const otherStores=STORES.filter(s=>s.stockId!==activeStockId); // only stores with different stock

  // Adjust stock helper — uses stockId, not storeId
  const adjustStock=(pid,delta,targetStockId,opts={})=>{
    targetStockId=targetStockId||activeStockId;
    setStock(prev=>{const n={...prev};const st={...(n[targetStockId]||{})};st[pid]=Math.max(0,(st[pid]||0)+delta);n[targetStockId]=st;return n;});
    // Persiste no backend (opts.skipApi permite pular quando já chamado de outro lugar)
    if(!opts.skipApi){
      api.adjustStock(targetStockId,pid,{delta,type:opts.type||"",reason:opts.reason||""}).catch(console.error);
    }
  };

  // Busca produto por EAN, SKU ou nome
  const searchProducts=(query)=>{
    if(!query) return [];
    const q=query.toLowerCase().trim();
    return storeProducts.filter(p=>
      (p.ean&&p.ean===q) || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    ).slice(0,10);
  };

  // Seleciona produto na busca (entrada/saída)
  const selectMovProduct=(p)=>{
    setMovProduct(p.id);
    setMovSearch(p.name);
    // Se bipou EAN, foca na quantidade automaticamente
    if(p.ean&&movSearch.trim()===p.ean) setTimeout(()=>document.querySelector('[data-mov-qty]')?.focus(),50);
  };

  // Seleciona produto na busca (transferência) — adiciona à lista
  const addTransItem=(p)=>{
    const existing=transItems.find(i=>i.productId===p.id);
    if(existing){
      setTransItems(prev=>prev.map(i=>i.productId===p.id?{...i,qty:i.qty+1}:i));
    } else {
      setTransItems(prev=>[...prev,{productId:p.id,productName:p.name,img:p.img,sku:p.sku,qty:1,stock:p.stock,price:p.price,cost:p.cost}]);
    }
    setTransSearch("");
    transSearchRef.current?.focus();
  };

  // Entry/Exit — usa activeTab diretamente para evitar race condition com setState
  const doMovement=()=>{
    if(!movProduct||!movQty||+movQty<=0)return showToast("Selecione produto e quantidade!","error");
    const qty=+movQty;
    const type=activeTab==="saida"?"saida":"entrada";
    const prod=catalog.find(p=>p.id===movProduct);
    adjustStock(movProduct, type==="entrada"?qty:-qty, activeStockId, {type,reason:movReason||"-"});
    const mov={id:genId(),date:new Date().toISOString().split("T")[0],time:new Date().toLocaleTimeString("pt-BR"),type,productId:movProduct,productName:prod?.name||"",qty,reason:movReason||"-",store:currentStore.name};
    setMovHistory(prev=>[mov,...prev]);
    showToast((type==="entrada"?"Entrada":"Saída")+" de "+qty+" un. registrada!");
    setMovProduct("");setMovQty("");setMovReason("");
  };

  // Transfer — múltiplos produtos
  const doTransfer=()=>{
    if(transItems.length===0)return showToast("Adicione pelo menos um produto!","error");
    if(!transTo)return showToast("Selecione a loja destino!","error");
    if(!transRequestedBy)return showToast("Informe quem pediu!","error");
    if(!transSeparatedBy)return showToast("Informe quem separou!","error");
    if(!transClientName)return showToast("Informe o nome do cliente!","error");
    if(!transClientPhone)return showToast("Informe o telefone do cliente!","error");
    const destStore=STORES.find(s=>s.id===transTo);
    const today=new Date().toISOString().split("T")[0];
    const time=new Date().toLocaleTimeString("pt-BR");

    transItems.forEach(item=>{
      adjustStock(item.productId,-item.qty,activeStockId,{skipApi:true});
      adjustStock(item.productId,item.qty,getStockId(transTo),{skipApi:true});
      api.transferStock({fromStockId:activeStockId,toStockId:getStockId(transTo),productId:item.productId,quantity:item.qty}).catch(console.error);
      setMovHistory(prev=>[{id:genId(),date:today,time,type:"transferencia",productId:item.productId,productName:item.productName,qty:item.qty,reason:(transDesc||"Transferência")+" → "+destStore?.name,store:currentStore.name,from:currentStore.name,to:destStore?.name},...prev]);
    });

    const totalPcs=transItems.reduce((s,i)=>s+i.qty,0);
    const totalVal=transItems.reduce((s,i)=>s+i.cost*i.qty,0);

    // Dados para o cupom
    setPrintTransfer({
      id:genId(),date:today,time,
      from:currentStore.name,to:destStore?.name,
      items:transItems,totalPcs,totalVal,
      description:transDesc,requestedBy:transRequestedBy,separatedBy:transSeparatedBy,paid:transPaid,
      clientName:transClientName,clientPhone:transClientPhone
    });

    showToast(totalPcs+" peças transferidas para "+destStore?.name+"!");
    setTransItems([]);setTransTo("");setTransDesc("");setTransRequestedBy("");setTransSeparatedBy("");setTransPaid(false);setTransClientName("");setTransClientPhone("");
  };

  // Start count
  const startCount=()=>{
    const data=storeProducts.map(p=>({productId:p.id,productName:p.name,img:p.img,sku:p.sku,systemQty:p.stock,countedQty:p.stock}));
    setCountData(data);setCountDone(false);
  };
  const updateCount=(pid,val)=>{setCountData(prev=>prev.map(c=>c.productId===pid?{...c,countedQty:+val}:c));};
  const applyCount=()=>{
    const diffs=countData.filter(c=>c.countedQty!==c.systemQty);
    if(diffs.length===0){showToast("Estoque confere! Sem divergências.");setCountData(null);setCountDone(true);return;}
    setStock(prev=>{const n={...prev};const st={...(n[activeStockId]||{})};diffs.forEach(d=>{st[d.productId]=d.countedQty;});n[activeStockId]=st;return n;});
    const today=new Date().toISOString().split("T")[0];
    diffs.forEach(d=>{
      const diff=d.countedQty-d.systemQty;
      const adjustType=diff>0?"ajuste_entrada":"ajuste_saida";
      const reason="Contagem de estoque (sistema: "+d.systemQty+", contado: "+d.countedQty+")";
      api.adjustStock(activeStockId,d.productId,{quantity:d.countedQty,type:adjustType,reason}).catch(console.error);
      setMovHistory(prev=>[{id:genId(),date:today,time:new Date().toLocaleTimeString("pt-BR"),type:adjustType,productId:d.productId,productName:d.productName,qty:Math.abs(diff),reason,store:currentStore.name},...prev]);
    });
    showToast(diffs.length+" produto(s) ajustados pela contagem!");
    setCountData(null);setCountDone(true);
  };

  const subTabs=[
    {id:"lista",label:"Estoque",icon:"📦"},
    {id:"entrada",label:"Entrada",icon:"📥"},
    {id:"saida",label:"Saída",icon:"📤"},
    {id:"transferencia",label:"Transferência",icon:"🔄"},
    {id:"contagem",label:"Contagem",icon:"📋"},
    {id:"historico",label:"Histórico",icon:"📜"},
  ];

  return(
    <div>
      {/* Sub-tabs */}
      <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
        {subTabs.map(st=><button key={st.id} onClick={()=>setActiveTab(st.id)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid "+(activeTab===st.id?C.gold:C.brd),background:activeTab===st.id?"rgba(255,215,64,.08)":C.s1,color:activeTab===st.id?C.gold:C.dim,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><span>{st.icon}</span>{st.label}</button>)}
      </div>

      {/* Shared stock banner */}
      {isSharedStock&&<div style={{padding:"10px 16px",background:"rgba(224,64,251,.06)",border:"1px solid rgba(224,64,251,.2)",borderRadius:12,marginBottom:14,display:"flex",alignItems:"center",gap:8,fontSize:12,color:C.pur}}>
        <span style={{fontSize:16}}>🔗</span>
        <span><strong>Estoque compartilhado</strong> — {sharedStockStores.map(s=>s.name).join(" e ")} usam o mesmo estoque físico. Qualquer alteração aqui reflete nas duas lojas.</span>
      </div>}

      {/* KPIs */}
      <div style={S.kpiRow}>
        <KPI icon={I.box} label="Total Peças" value={totalPieces+""} sub={currentStore.name} color={C.blu}/>
        <KPI icon={I.money} label="Valor (Custo)" value={fmt(totalValue)} sub="Em estoque" color={C.gold}/>
        <KPI icon={I.alert} label="Estoque Baixo" value={lowStock.length+""} sub="Produtos críticos" color={lowStock.length>0?C.red:C.grn}/>
        <KPI icon={I.chart} label="Movimentações" value={movHistory.length+""} sub="Hoje" color={C.pur}/>
      </div>

      {/* ── LISTA ── */}
      {activeTab==="lista"&&<div>
        <div style={S.toolbar}><div style={S.searchBar}>{I.search}<input style={S.searchIn} placeholder="Buscar produto..." value={search} onChange={e=>setSearch(e.target.value)}/></div></div>
{/* alertas de estoque baixo desativados para testes */}
        <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}></th><th style={S.th}>Produto</th><th style={S.th}>SKU</th><th style={S.th}>Cat.</th><th style={S.th}>Preço</th><th style={S.th}>Custo</th><th style={S.th}>Estoque</th><th style={S.th}>Valor</th><th style={S.th}>Ajuste</th></tr></thead>
        <tbody>{filtered.map(p=><tr key={p.id} style={{...S.tr,...(p.stock<=p.minStock?{background:"rgba(255,82,82,0.06)"}:{})}}>
          <td style={S.td}><span style={{fontSize:18}}>{p.img}</span></td>
          <td style={{...S.td,fontWeight:600}}>{p.name}</td>
          <td style={{...S.td,fontFamily:"monospace",fontSize:10}}>{p.sku}</td>
          <td style={S.td}>{p.category}</td>
          <td style={{...S.td,...S.tdM}}>{fmt(p.price)}</td>
          <td style={{...S.td,opacity:.6,fontSize:11}}>{fmt(p.cost)}</td>
          <td style={S.td}><span style={{...S.stBadge,...(p.stock<=p.minStock?S.stLow:S.stOk)}}>{p.stock}</span></td>
          <td style={{...S.td,fontSize:11,color:C.dim}}>{fmt(p.cost*p.stock)}</td>
          <td style={S.td}><div style={{display:"flex",gap:3}}><button style={S.smBtn} onClick={()=>{adjustStock(p.id,-1,activeStockId,{type:"saida",reason:"Ajuste rápido"});setMovHistory(prev=>[{id:genId(),date:new Date().toISOString().split("T")[0],time:new Date().toLocaleTimeString("pt-BR"),type:"saida",productId:p.id,productName:p.name,qty:1,reason:"Ajuste rápido",store:currentStore.name},...prev]);}}>−</button><button style={S.smBtn} onClick={()=>{adjustStock(p.id,1,activeStockId,{type:"entrada",reason:"Ajuste rápido"});setMovHistory(prev=>[{id:genId(),date:new Date().toISOString().split("T")[0],time:new Date().toLocaleTimeString("pt-BR"),type:"entrada",productId:p.id,productName:p.name,qty:1,reason:"Ajuste rápido",store:currentStore.name},...prev]);}}>+</button></div></td>
        </tr>)}</tbody></table></div>
      </div>}

      {/* ── ENTRADA / SAÍDA ── */}
      {(activeTab==="entrada"||activeTab==="saida")&&<div>
        <div style={{...S.card,borderColor:activeTab==="entrada"?"rgba(0,230,118,.2)":"rgba(255,82,82,.2)",borderLeft:"4px solid "+(activeTab==="entrada"?C.grn:C.red)}}>
          <h3 style={{fontSize:16,fontWeight:800,marginBottom:16,color:activeTab==="entrada"?C.grn:C.red}}>
            {activeTab==="entrada"?"📥 Registrar Entrada de Mercadoria":"📤 Registrar Saída de Mercadoria"}
          </h3>
          {/* Busca por EAN/SKU/Nome */}
          <div style={{position:"relative",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:C.s2,borderRadius:10,border:`1px solid ${movProduct?activeTab==="entrada"?C.grn:C.red:C.brd}`}}>
              <span style={{fontSize:16}}>🔍</span>
              <input ref={movSearchRef} style={{...S.inp,flex:1,border:"none",background:"transparent",padding:0,fontSize:14}} placeholder="Bipe o código de barras, SKU ou digite o nome..." value={movSearch} onChange={e=>{setMovSearch(e.target.value);setMovProduct("");}} onKeyDown={e=>{
                if(e.key==="Enter"&&movSearch){
                  const results=searchProducts(movSearch);
                  if(results.length===1) selectMovProduct(results[0]);
                  // Se bipou EAN exato, seleciona direto
                  const eanMatch=storeProducts.find(p=>p.ean&&p.ean===movSearch.trim());
                  if(eanMatch) selectMovProduct(eanMatch);
                }
              }} autoFocus/>
              {movProduct&&<span style={{color:C.grn,fontSize:14}}>✓</span>}
              {movSearch&&!movProduct&&<button onClick={()=>{setMovSearch("");setMovProduct("");}} style={{background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:14}}>✕</button>}
            </div>
            {/* Resultados da busca */}
            {movSearch&&!movProduct&&searchProducts(movSearch).length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:C.s1,border:`1px solid ${C.brd}`,borderRadius:10,marginTop:4,maxHeight:250,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,.4)"}}>
              {searchProducts(movSearch).map(p=><div key={p.id} onClick={()=>selectMovProduct(p)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",cursor:"pointer",borderBottom:`1px solid ${C.brd}`}} onMouseEnter={e=>e.currentTarget.style.background="rgba(255,215,64,.06)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span style={{fontSize:20}}>{p.img}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13}}>{p.name}</div>
                  <div style={{fontSize:10,color:C.dim}}>SKU: {p.sku}{p.ean?" • EAN: "+p.ean:""}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:700,color:C.gold}}>{p.stock} un.</div>
                  <div style={{fontSize:10,color:C.dim}}>{fmt(p.price)}</div>
                </div>
              </div>)}
            </div>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <input data-mov-qty="" style={S.inp} type="number" placeholder="Quantidade" value={movQty} onChange={e=>setMovQty(e.target.value)} min={1}/>
            <input style={S.inp} placeholder={activeTab==="entrada"?"Motivo (NF, reposição, devolução...)":"Motivo (avaria, perda, uso interno...)"} value={movReason} onChange={e=>setMovReason(e.target.value)}/>
          </div>
          {movProduct&&<div style={{marginTop:12,padding:12,background:C.s2,borderRadius:10,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:24}}>{catalog.find(p=>p.id===movProduct)?.img}</span>
            <div style={{flex:1}}><div style={{fontWeight:700}}>{catalog.find(p=>p.id===movProduct)?.name}</div><div style={{fontSize:12,color:C.dim}}>Estoque atual: <strong style={{color:C.gold}}>{(stock[activeStockId]||{})[movProduct]||0} un.</strong></div></div>
            {movQty&&<div style={{textAlign:"right"}}><div style={{fontSize:11,color:C.dim}}>{activeTab==="entrada"?"Após entrada:":"Após saída:"}</div><div style={{fontSize:18,fontWeight:800,color:activeTab==="entrada"?C.grn:C.red}}>{activeTab==="entrada"?((stock[activeStockId]||{})[movProduct]||0)+(+movQty):Math.max(0,((stock[activeStockId]||{})[movProduct]||0)-(+movQty))} un.</div></div>}
          </div>}
          <div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}>
            <button style={{...S.primBtn,padding:"10px 24px",background:activeTab==="entrada"?`linear-gradient(135deg,${C.grn},#00C853)`:`linear-gradient(135deg,${C.red},#B71C1C)`}} onClick={doMovement}>
              {I.check} {activeTab==="entrada"?"REGISTRAR ENTRADA":"REGISTRAR SAÍDA"}
            </button>
          </div>
        </div>
      </div>}

      {/* ── TRANSFERÊNCIA ENTRE LOJAS ── */}
      {activeTab==="transferencia"&&<div>
        <div style={{...S.card,borderColor:"rgba(224,64,251,.2)",borderLeft:"4px solid "+C.pur}}>
          <h3 style={{fontSize:16,fontWeight:800,marginBottom:4,color:C.pur}}>🔄 Transferência entre Lojas</h3>
          <p style={{fontSize:12,color:C.dim,marginBottom:16}}>Enviar mercadoria de <strong style={{color:currentStore.color}}>{currentStore.name}</strong> para outra loja</p>

          {/* Busca por EAN/SKU/Nome */}
          <div style={{position:"relative",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:C.s2,borderRadius:10,border:`1px solid ${C.pur}44`}}>
              <span style={{fontSize:16}}>🔍</span>
              <input ref={transSearchRef} style={{...S.inp,flex:1,border:"none",background:"transparent",padding:0,fontSize:14}} placeholder="Bipe ou busque produtos para adicionar..." value={transSearch} onChange={e=>setTransSearch(e.target.value)} onKeyDown={e=>{
                if(e.key==="Enter"&&transSearch){
                  const eanMatch=storeProducts.find(p=>p.ean&&p.ean===transSearch.trim());
                  if(eanMatch){addTransItem(eanMatch);return;}
                  const results=searchProducts(transSearch);
                  if(results.length===1) addTransItem(results[0]);
                }
              }}/>
            </div>
            {transSearch&&searchProducts(transSearch).length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:C.s1,border:`1px solid ${C.brd}`,borderRadius:10,marginTop:4,maxHeight:250,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,.4)"}}>
              {searchProducts(transSearch).map(p=><div key={p.id} onClick={()=>addTransItem(p)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",cursor:"pointer",borderBottom:`1px solid ${C.brd}`}} onMouseEnter={e=>e.currentTarget.style.background="rgba(224,64,251,.06)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span style={{fontSize:20}}>{p.img}</span>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13}}>{p.name}</div>
                  <div style={{fontSize:10,color:C.dim}}>SKU: {p.sku}{p.ean?" • EAN: "+p.ean:""}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:700,color:C.gold}}>{p.stock} un.</div>
                  <div style={{fontSize:10,color:C.dim}}>{fmt(p.price)}</div>
                </div>
              </div>)}
            </div>}
          </div>

          {/* Lista de produtos adicionados */}
          {transItems.length>0&&<div style={{marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:C.dim,letterSpacing:1,marginBottom:6}}>PRODUTOS NA TRANSFERÊNCIA ({transItems.length})</div>
            <div style={S.tWrap}><table style={S.table}><thead><tr>
              <th style={S.th}></th><th style={S.th}>Produto</th><th style={S.th}>SKU</th><th style={S.th}>Estoque</th><th style={S.th}>Qtd</th><th style={S.th}>Custo</th><th style={S.th}></th>
            </tr></thead><tbody>
              {transItems.map((item,idx)=><tr key={item.productId} style={S.tr}>
                <td style={S.td}><span style={{fontSize:16}}>{item.img}</span></td>
                <td style={{...S.td,fontWeight:600,fontSize:12}}>{item.productName}</td>
                <td style={{...S.td,fontFamily:"monospace",fontSize:10}}>{item.sku}</td>
                <td style={S.td}><span style={{...S.stBadge,...S.stOk}}>{item.stock}</span></td>
                <td style={S.td}><input type="number" min={1} max={item.stock} value={item.qty} onChange={e=>setTransItems(prev=>prev.map((it,i)=>i===idx?{...it,qty:Math.max(1,+e.target.value||1)}:it))} style={{...S.inp,width:60,textAlign:"center",padding:"4px 6px"}}/></td>
                <td style={{...S.td,fontSize:11,color:C.dim}}>{fmt(item.cost*item.qty)}</td>
                <td style={S.td}><button onClick={()=>setTransItems(prev=>prev.filter((_,i)=>i!==idx))} style={{...S.smBtn,color:C.red}}>✕</button></td>
              </tr>)}
              <tr style={{background:C.s2}}><td colSpan={4} style={{...S.td,fontWeight:700,textAlign:"right"}}>Total:</td><td style={{...S.td,fontWeight:800,color:C.pur}}>{transItems.reduce((s,i)=>s+i.qty,0)} pç</td><td style={{...S.td,fontWeight:700,color:C.gold}}>{fmt(transItems.reduce((s,i)=>s+i.cost*i.qty,0))}</td><td style={S.td}></td></tr>
            </tbody></table></div>
          </div>}

          {/* Campos extras */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            <select style={{...S.sel,borderColor:!transTo?C.red+"44":C.brd}} value={transTo} onChange={e=>setTransTo(e.target.value)}>
              <option value="">Loja destino *</option>
              {otherStores.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input style={S.inp} placeholder="Descrição/Motivo" value={transDesc} onChange={e=>setTransDesc(e.target.value)}/>
            <input style={{...S.inp,borderColor:!transClientName?C.red+"44":C.brd}} placeholder="Nome do cliente *" value={transClientName} onChange={e=>setTransClientName(e.target.value)}/>
            <input style={{...S.inp,borderColor:!transClientPhone?C.red+"44":C.brd}} placeholder="Telefone do cliente *" value={transClientPhone} onChange={e=>setTransClientPhone(e.target.value)}/>
            <input style={{...S.inp,borderColor:!transRequestedBy?C.red+"44":C.brd}} placeholder="Quem pediu *" value={transRequestedBy} onChange={e=>setTransRequestedBy(e.target.value)}/>
            <input style={{...S.inp,borderColor:!transSeparatedBy?C.red+"44":C.brd}} placeholder="Quem separou *" value={transSeparatedBy} onChange={e=>setTransSeparatedBy(e.target.value)}/>
          </div>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:C.dim,cursor:"pointer",marginBottom:14}}>
            <input type="checkbox" checked={transPaid} onChange={e=>setTransPaid(e.target.checked)} style={{accentColor:C.grn,width:18,height:18}}/>
            <span>{transPaid?"✅ Cliente PAGOU na loja destino":"❌ NÃO pago"}</span>
          </label>

          <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
            {transItems.length>0&&<button style={S.secBtn} onClick={()=>{setTransItems([]);setTransDesc("");setTransRequestedBy("");setTransSeparatedBy("");setTransPaid(false);setTransClientName("");setTransClientPhone("");}}>Limpar</button>}
            <button style={{...S.primBtn,padding:"10px 24px",background:`linear-gradient(135deg,${C.pur},#9C27B0)`,opacity:transItems.length===0?.5:1}} onClick={doTransfer} disabled={transItems.length===0}>
              {I.check} CONFIRMAR TRANSFERÊNCIA ({transItems.reduce((s,i)=>s+i.qty,0)} pç)
            </button>
          </div>
        </div>

        {/* Cupom de transferência */}
        {printTransfer&&<ReceiptComprovante data={{type:"transferencia",...printTransfer,store:currentStore.name}} onClose={()=>setPrintTransfer(null)}/>}

        {/* Quick view: stock across all stores */}
        <div style={S.card}>
          <h3 style={S.cardTitle}>Estoque em Todas as Lojas</h3>
          <div style={{fontSize:11,color:C.dim,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>🔗 <strong style={{color:C.pur}}>Matriz</strong> e <strong style={{color:C.grn}}>E-commerce</strong> compartilham o mesmo estoque físico</div>
          <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Produto</th>{STORES.map(s=><th key={s.id} style={{...S.th,color:s.color}}>{s.name.replace("D'Black ","")}{s.stockId==="shared_matriz"?" 🔗":""}</th>)}<th style={S.th}>Total Geral</th></tr></thead>
          <tbody>{catalog.map(p=>{
            const uniqueStockIds=[...new Set(STORES.map(s=>s.stockId))];
            const total=uniqueStockIds.reduce((s,sid)=>s+((stock[sid]||{})[p.id]||0),0);
            return <tr key={p.id} style={S.tr}>
              <td style={{...S.td,fontWeight:600}}><span style={{marginRight:6}}>{p.img}</span>{p.name}</td>
              {STORES.map(s=>{const qty=(stock[s.stockId]||{})[p.id]||0;return <td key={s.id} style={{...S.td,fontWeight:700,color:qty<=p.minStock?C.red:C.txt}}>{qty}{s.stockId==="shared_matriz"?<span style={{fontSize:8,color:C.pur,marginLeft:3}}>🔗</span>:""}</td>;})}
              <td style={{...S.td,fontWeight:800,color:C.gold}}>{total}</td>
            </tr>;
          })}</tbody></table></div>
        </div>
      </div>}

      {/* ── CONTAGEM DE ESTOQUE (com scanner) ── */}
      {activeTab==="contagem"&&<div>
        {!countData?<div style={{...S.card,textAlign:"center",padding:28}}>
          <div style={{fontSize:48,marginBottom:12}}>📋</div>
          <h3 style={{fontSize:18,fontWeight:800,marginBottom:8}}>Contagem de Estoque</h3>
          <p style={{fontSize:13,color:C.dim,marginBottom:20}}>Inicie uma contagem para comparar o estoque físico com o sistema.<br/>Use o leitor de código de barras para localizar os produtos rapidamente.</p>
          <button style={{...S.primBtn,padding:"12px 28px",fontSize:14,margin:"0 auto"}} onClick={startCount}>
            {I.check} INICIAR CONTAGEM
          </button>
          {countDone&&<div style={{marginTop:16,color:C.grn,fontSize:13,fontWeight:600}}>✓ Última contagem aplicada com sucesso!</div>}
        </div>:
        <div>
          <div style={{...S.card,borderColor:C.brdH}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <h3 style={{margin:0,fontSize:15,fontWeight:700}}>📋 Contagem — {currentStore.name}</h3>
              <div style={{display:"flex",gap:6}}>
                <button style={S.secBtn} onClick={()=>{setCountData(null);setScanHighlight(null);setScanInput("");}}>Cancelar</button>
                <button style={{...S.primBtn,background:`linear-gradient(135deg,${C.grn},#00C853)`}} onClick={applyCount}>{I.check} APLICAR</button>
              </div>
            </div>

            {/* Scanner bar */}
            <div style={{background:`linear-gradient(135deg,rgba(64,196,255,.08),rgba(224,64,251,.08))`,border:`2px solid ${C.blu}44`,borderRadius:12,padding:14,marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:14}}>
                <span style={{fontSize:22}}>📷</span>
                <span style={{fontWeight:700,color:C.blu}}>Scanner</span>
              </div>
              <div style={{flex:1,minWidth:200,position:"relative"}}>
                <input
                  ref={scanRef}
                  type="text"
                  placeholder="Bipe o código de barras ou digite o SKU..."
                  value={scanInput}
                  onChange={e=>setScanInput(e.target.value)}
                  onKeyDown={e=>{
                    if(e.key==="Enter"){
                      const q=scanInput.trim().toUpperCase();
                      if(!q)return;
                      const found=countData.find(c=>c.sku.toUpperCase()===q||c.sku.toUpperCase().includes(q)||c.productName.toUpperCase().includes(q));
                      if(found){
                        setScanHighlight(found.productId);
                        setScanInput("");
                        // Scroll to and focus the count input
                        setTimeout(()=>{
                          const el=document.getElementById("count-"+found.productId);
                          if(el){el.scrollIntoView({behavior:"smooth",block:"center"});el.focus();el.select();}
                        },100);
                        showToast("✓ "+found.productName+" encontrado!");
                      } else {
                        showToast("Produto não encontrado: "+q,"error");
                        setScanHighlight(null);
                      }
                    }
                  }}
                  autoFocus
                  style={{width:"100%",padding:"10px 16px",borderRadius:10,border:`2px solid ${C.blu}55`,background:C.s2,color:C.txt,fontSize:16,fontFamily:"'JetBrains Mono',monospace",letterSpacing:2,outline:"none",textTransform:"uppercase"}}
                />
              </div>
              <div style={{fontSize:11,color:C.dim,lineHeight:1.5}}>
                Bipe o código → produto é destacado e<br/>o cursor vai pro campo de quantidade
              </div>
            </div>

            {/* Count table */}
            <div style={{fontSize:12,color:C.dim,marginBottom:10,display:"flex",justifyContent:"space-between"}}>
              <span>Contados: <strong style={{color:C.gold}}>{countData.filter(c=>c.countedQty!==c.systemQty).length}</strong> divergência(s)</span>
              <span>Total: <strong>{countData.length}</strong> produtos</span>
            </div>
            <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}></th><th style={S.th}>Produto</th><th style={S.th}>SKU</th><th style={S.th}>Sistema</th><th style={S.th}>Contado</th><th style={S.th}>Dif.</th></tr></thead>
            <tbody>{countData.map(c=>{
              const diff=c.countedQty-c.systemQty;
              const hasDiff=diff!==0;
              const isHighlighted=scanHighlight===c.productId;
              return <tr key={c.productId} style={{...S.tr,
                ...(isHighlighted?{background:"rgba(64,196,255,.15)",boxShadow:"inset 0 0 0 2px "+C.blu}:
                hasDiff?{background:diff>0?"rgba(0,230,118,.06)":"rgba(255,82,82,.06)"}:{}),
                transition:"all .3s ease"
              }}>
                <td style={S.td}><span style={{fontSize:isHighlighted?22:16,transition:"font-size .3s"}}>{c.img}</span></td>
                <td style={{...S.td,fontWeight:isHighlighted?800:600,color:isHighlighted?C.blu:C.txt,transition:"all .3s"}}>{c.productName}</td>
                <td style={{...S.td,fontFamily:"monospace",fontSize:isHighlighted?12:10,color:isHighlighted?C.blu:C.dim}}>{c.sku}</td>
                <td style={{...S.td,fontWeight:700}}>{c.systemQty}</td>
                <td style={S.td}>
                  <input
                    id={"count-"+c.productId}
                    type="number"
                    value={c.countedQty}
                    onChange={e=>updateCount(c.productId,e.target.value)}
                    onFocus={()=>setScanHighlight(c.productId)}
                    onKeyDown={e=>{
                      if(e.key==="Enter"){
                        // After entering count, refocus scanner for next product
                        e.preventDefault();
                        setScanHighlight(null);
                        if(scanRef.current){scanRef.current.focus();}
                      }
                    }}
                    min={0}
                    style={{...S.inp,width:70,textAlign:"center",fontWeight:700,fontSize:isHighlighted?16:14,
                      borderColor:isHighlighted?C.blu:(hasDiff?(diff>0?"rgba(0,230,118,.4)":"rgba(255,82,82,.4)"):C.brd),
                      background:isHighlighted?"rgba(64,196,255,.08)":C.s2,
                      transition:"all .3s"
                    }}
                  />
                </td>
                <td style={{...S.td,fontWeight:800,fontSize:14,color:hasDiff?(diff>0?C.grn:C.red):C.dim}}>{diff>0?"+"+diff:diff===0?"—":diff}</td>
              </tr>;
            })}</tbody></table></div>
            <div style={{marginTop:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:12,color:C.dim}}>{countData.filter(c=>c.countedQty!==c.systemQty).length} divergência(s)</div>
              <button style={{...S.primBtn,background:`linear-gradient(135deg,${C.grn},#00C853)`,padding:"10px 24px"}} onClick={applyCount}>{I.check} APLICAR CONTAGEM</button>
            </div>
          </div>
        </div>}
      </div>}

      {/* ── HISTÓRICO DE MOVIMENTAÇÕES ── */}
      {activeTab==="historico"&&<div>
        <div style={S.card}>
          <h3 style={S.cardTitle}>Histórico de Movimentações — {currentStore.name}</h3>
          {movHistory.length===0?<div style={{textAlign:"center",padding:30,color:C.dim}}><div style={{fontSize:36,marginBottom:8}}>📜</div><div>Nenhuma movimentação registrada</div></div>:
          <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Data</th><th style={S.th}>Hora</th><th style={S.th}>Tipo</th><th style={S.th}>Produto</th><th style={S.th}>Qtd</th><th style={S.th}>Motivo</th></tr></thead>
          <tbody>{movHistory.map(m=>{
            const typeLabel={entrada:"Entrada",saida:"Saída",transferencia:"Transferência",ajuste_entrada:"Ajuste (+)",ajuste_saida:"Ajuste (-)"}[m.type]||m.type;
            const typeColor={entrada:C.grn,saida:C.red,transferencia:C.pur,ajuste_entrada:C.blu,ajuste_saida:C.org}[m.type]||C.dim;
            return <tr key={m.id} style={S.tr}>
              <td style={S.td}>{fmtDate(m.date)}</td>
              <td style={{...S.td,fontSize:11}}>{m.time}</td>
              <td style={S.td}><span style={{...S.stBadge,background:typeColor+"18",color:typeColor}}>{typeLabel}</span></td>
              <td style={{...S.td,fontWeight:600}}>{m.productName}</td>
              <td style={{...S.td,fontWeight:700,color:typeColor}}>{m.type.includes("entrada")||m.type==="ajuste_entrada"?"+":m.type==="transferencia"?"↗":"-"}{m.qty}</td>
              <td style={{...S.td,fontSize:11,color:C.dim}}>{m.reason}</td>
            </tr>;
          })}</tbody></table></div>}
        </div>
      </div>}
    </div>
  );
}

// ═══════════════════════════════════
// ═══  DESPESAS MODULE            ═══
// ═══════════════════════════════════
function DespesasModule({storeExpenses,activeStore,expenses,setExpenses,currentStore,showToast,expenseCategories,setExpenseCategories,cashState,setCashState,loggedUser}){
  const [activeTab,setActiveTab]=useState("caixa"); // caixa, operacional
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [showCatManager,setShowCatManager]=useState(false);
  const [newCat,setNewCat]=useState("");
  const todayStr=new Date().toISOString().split("T")[0];
  const [nd,setNd]=useState({date:todayStr,category:expenseCategories[0]||"Outros",description:"",value:"",recurring:false,expense_type:"caixa"});
  const [printExpense,setPrintExpense]=useState(null);

  // Separar despesas por tipo
  const caixaExpenses=storeExpenses.filter(e=>(e.expense_type||e.expenseType)==="caixa");
  const operacionalExpenses=storeExpenses.filter(e=>(e.expense_type||e.expenseType)!=="caixa");
  const currentExpenses=activeTab==="caixa"?caixaExpenses:operacionalExpenses;
  const totalCaixa=caixaExpenses.reduce((s,e)=>s+(+e.value||0),0);
  const totalOp=operacionalExpenses.reduce((s,e)=>s+(+e.value||0),0);
  const totalGeral=storeExpenses.reduce((s,e)=>s+(+e.value||0),0);

  const resetForm=()=>{setNd({date:todayStr,category:expenseCategories[0]||"Outros",description:"",value:"",recurring:false,expense_type:activeTab});setEditId(null);setShowForm(false);};

  const addOrEditExp=()=>{
    if(!nd.description||!nd.value)return showToast("Preencha descrição e valor!","error");
    const expType=activeTab;
    if(editId){
      const updated={...nd,value:+nd.value,expense_type:expType,expenseType:expType};
      setExpenses(prev=>{const n={...prev};n[activeStore]=(n[activeStore]||[]).map(e=>e.id===editId?{...e,...updated}:e);return n;});
      api.updateExpense(editId,{date:nd.date,category:nd.category,description:nd.description,value:+nd.value,recurring:nd.recurring,expense_type:expType}).catch(console.error);
      showToast("Despesa atualizada!");
    } else {
      const newExp={...nd,id:genId(),value:+nd.value,expense_type:expType,expenseType:expType,store_id:activeStore};
      setExpenses(prev=>{const n={...prev};n[activeStore]=[newExp,...(n[activeStore]||[])];return n;});
      api.createExpense({store_id:activeStore,date:nd.date,category:nd.category,description:nd.description,value:+nd.value,recurring:nd.recurring,expense_type:expType}).catch(console.error);
      // Se for despesa de caixa, registra como sangria automática
      if(expType==="caixa"){
        const cashKey=activeStore+"_"+(loggedUser?.id||"main");
        setCashState(prev=>{
          const n={...prev};
          const cs=n[cashKey]||{open:false,initial:0,history:[]};
          if(cs.open){
            n[cashKey]={...cs,history:[...cs.history,{type:"saida",value:+nd.value,desc:"Despesa: "+nd.description,time:new Date().toLocaleTimeString("pt-BR")}]};
          }
          return n;
        });
      }
      setPrintExpense({type:"despesa",...newExp,store:currentStore.name,date:nd.date});
      showToast("Despesa lançada!"+(expType==="caixa"?" (descontada do caixa)":""));
    }
    resetForm();
  };

  const startEdit=(e)=>{
    setNd({date:e.date,category:e.category,description:e.description,value:String(e.value),recurring:e.recurring||false,expense_type:e.expense_type||e.expenseType||activeTab});
    setEditId(e.id);setShowForm(true);
  };

  const deleteExp=(id)=>{
    if(!confirm("Excluir esta despesa?"))return;
    setExpenses(prev=>{const n={...prev};n[activeStore]=(n[activeStore]||[]).filter(e=>e.id!==id);return n;});
    api.deleteExpense(id).catch(console.error);
    showToast("Despesa excluída!");
  };

  const reprintExpense=(e)=>{setPrintExpense({type:"despesa",...e,store:currentStore.name});};

  // Categorias
  const addCategory=()=>{
    if(!newCat.trim())return;
    if(expenseCategories.includes(newCat.trim()))return showToast("Categoria já existe","error");
    setExpenseCategories(prev=>[...prev,newCat.trim()]);
    api.createExpenseCategory(newCat.trim()).catch(console.error);
    setNewCat("");showToast("Categoria adicionada!");
  };
  const removeCategory=(cat)=>{
    setExpenseCategories(prev=>prev.filter(c=>c!==cat));
    api.deleteExpenseCategory(cat).catch(console.error);
  };

  const subTabs=[
    {id:"caixa",label:"Despesas do Caixa",icon:"💰",color:C.gold},
    {id:"operacional",label:"Despesas Operacionais",icon:"🏢",color:C.blu},
  ];

  return(
    <div>
      {/* Sub-abas */}
      <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
        {subTabs.map(st=><button key={st.id} onClick={()=>{setActiveTab(st.id);resetForm();}} style={{padding:"8px 14px",borderRadius:8,border:"1px solid "+(activeTab===st.id?st.color:C.brd),background:activeTab===st.id?st.color+"14":C.s1,color:activeTab===st.id?st.color:C.dim,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><span>{st.icon}</span>{st.label}</button>)}
      </div>

      {/* KPIs */}
      <div style={S.kpiRow}>
        <KPI icon="💰" label="Despesas Caixa" value={fmt(totalCaixa)} sub={caixaExpenses.length+" lançamentos"} color={C.gold}/>
        <KPI icon="🏢" label="Despesas Operacionais" value={fmt(totalOp)} sub={operacionalExpenses.length+" lançamentos"} color={C.blu}/>
        <KPI icon={I.alert} label="Total Geral" value={fmt(totalGeral)} sub={currentStore.name} color={C.red}/>
      </div>

      {/* Info do tipo */}
      <div style={{padding:"10px 14px",background:activeTab==="caixa"?"rgba(255,215,64,.06)":"rgba(64,196,255,.06)",border:`1px solid ${activeTab==="caixa"?C.gold+"33":C.blu+"33"}`,borderRadius:10,marginBottom:14,fontSize:12,color:C.dim}}>
        {activeTab==="caixa"
          ?"💰 Despesas pagas diretamente no caixa da loja. Ao registrar, o valor é descontado automaticamente do caixa aberto."
          :"🏢 Despesas operacionais pagas pelo financeiro (transferência, boleto, etc). Subtraem da receita geral, não do caixa."
        }
      </div>

      {/* Toolbar */}
      <div style={S.toolbar}>
        <button style={S.secBtn} onClick={()=>setShowCatManager(!showCatManager)}>📁 Categorias</button>
        <div style={{flex:1}}/>
        <button style={S.primBtn} onClick={()=>{resetForm();setShowForm(!showForm);}}>{I.plus} Nova Despesa</button>
      </div>

      {/* Gerenciador de Categorias */}
      {showCatManager&&<div style={S.formCard}>
        <h3 style={S.formTitle}>Gerenciar Categorias de Despesas</h3>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
          {expenseCategories.map(c=><span key={c} style={{padding:"4px 10px",borderRadius:6,background:C.s2,border:`1px solid ${C.brd}`,fontSize:12,fontWeight:600,color:C.txt,display:"flex",alignItems:"center",gap:4}}>
            {c}
            <button onClick={()=>removeCategory(c)} style={{background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:10,padding:0}}>✕</button>
          </span>)}
        </div>
        <div style={{display:"flex",gap:6}}>
          <input style={{...S.inp,flex:1}} placeholder="Nova categoria..." value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCategory()}/>
          <button style={S.primBtn} onClick={addCategory}>{I.plus} Adicionar</button>
        </div>
      </div>}

      {/* Formulário */}
      {showForm&&<div style={S.formCard}>
        <h3 style={S.formTitle}>{editId?"✏️ Editar Despesa":"➕ Nova Despesa"} — {activeTab==="caixa"?"Caixa":"Operacional"}</h3>
        <div style={S.formGrid}>
          <input style={S.inp} type="date" value={nd.date} onChange={e=>setNd(d=>({...d,date:e.target.value}))}/>
          <select style={S.sel} value={nd.category} onChange={e=>setNd(d=>({...d,category:e.target.value}))}>
            {expenseCategories.map(c=><option key={c}>{c}</option>)}
          </select>
          <input style={S.inp} placeholder="Descrição" value={nd.description} onChange={e=>setNd(d=>({...d,description:e.target.value}))}/>
          <input style={S.inp} type="number" placeholder="Valor R$" value={nd.value} onChange={e=>setNd(d=>({...d,value:e.target.value}))}/>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:C.dim,cursor:"pointer"}}><input type="checkbox" checked={nd.recurring} onChange={e=>setNd(d=>({...d,recurring:e.target.checked}))} style={{accentColor:C.gold}}/>Fixa/Recorrente</label>
        </div>
        <div style={S.formAct}>
          <button style={S.secBtn} onClick={resetForm}>Cancelar</button>
          <button style={S.primBtn} onClick={addOrEditExp}>{editId?"Salvar Alterações":"Lançar Despesa"}</button>
        </div>
      </div>}

      {/* Tabela */}
      <div style={S.tWrap}><table style={S.table}><thead><tr>
        <th style={S.th}>Data</th><th style={S.th}>Categoria</th><th style={S.th}>Descrição</th><th style={S.th}>Valor</th><th style={S.th}>Tipo</th><th style={S.th}>Ações</th>
      </tr></thead>
      <tbody>{currentExpenses.length===0
        ?<tr><td colSpan={6} style={{...S.td,textAlign:"center",opacity:.4,padding:20}}>Nenhuma despesa {activeTab==="caixa"?"de caixa":"operacional"} registrada</td></tr>
        :currentExpenses.map(e=><tr key={e.id} style={S.tr}>
          <td style={S.td}>{fmtDate(e.date)}</td>
          <td style={S.td}><span style={S.payBadge}>{e.category}</span></td>
          <td style={S.td}>{e.description}</td>
          <td style={{...S.td,fontWeight:700,color:C.red}}>{fmt(+e.value)}</td>
          <td style={S.td}>{e.recurring?<span style={{...S.stBadge,...S.stLow}}>Fixa</span>:<span style={{...S.stBadge,...S.stOk}}>Variável</span>}</td>
          <td style={S.td}><div style={{display:"flex",gap:3}}>
            <button style={S.smBtn} onClick={()=>startEdit(e)}>✏️</button>
            <button style={{...S.smBtn,color:C.red}} onClick={()=>deleteExp(e.id)}>🗑️</button>
            <button style={S.smBtn} onClick={()=>reprintExpense(e)} title="Imprimir comprovante">{I.printer}</button>
          </div></td>
        </tr>)
      }</tbody></table></div>

      {/* Comprovante */}
      {printExpense&&<ReceiptComprovante data={printExpense} onClose={()=>setPrintExpense(null)}/>}
    </div>
  );
}

// ═══════════════════════════════════
// ═══  CAIXA MODULE               ═══
// ═══════════════════════════════════
function CaixaModule({storeCash,activeStore,cashState,setCashState,storeSales,showToast,loggedUser,withdrawals,setWithdrawals,advances,setAdvances,employees}){
  const cashKey = activeStore + "_" + (loggedUser?.id || "main");
  const [caixaTab,setCaixaTab]=useState("operacao"); // operacao, retiradas
  const [openVal,setOpenVal]=useState(()=>storeCash.initial!=null?storeCash.initial:0);
  // Sincroniza openVal quando o caixa fecha ou o saldo muda
  useEffect(()=>{ if(!storeCash.open) setOpenVal(storeCash.initial!=null?storeCash.initial:0); },[storeCash.open,storeCash.initial]);
  const [sangria,setSangria]=useState("");
  const [sangriaDesc,setSangriaDesc]=useState("");
  const [sangriaType,setSangriaType]=useState("saida");
  const [showCloseModal,setShowCloseModal]=useState(false);
  const [closeObs,setCloseObs]=useState("");
  const [printData,setPrintData]=useState(null);

  // Grupos de formas de pagamento para o fechamento
  const PAY_GROUPS=[
    {key:"dinheiro", label:"💵 Dinheiro",      color:C.grn,  match:m=>m==="Dinheiro"},
    {key:"pix",      label:"📱 PIX",            color:C.blu,  match:m=>m.toLowerCase().startsWith("pix")},
    {key:"credito",  label:"💳 Crédito",        color:C.pur,  match:m=>m.toLowerCase().startsWith("créd")||m.toLowerCase().startsWith("cred")},
    {key:"debito",   label:"💳 Débito",         color:C.gold, match:m=>m==="Débito"||m==="Debito"},
    {key:"outros",   label:"🏷️ Outros",         color:C.dim,  match:()=>false}, // catch-all
  ];

  // Valor inicial de contagem por grupo (preenchido pelo operador)
  const initCounted=()=>Object.fromEntries(PAY_GROUPS.map(g=>[g.key,""]));
  const [counted,setCounted]=useState(initCounted);

  const todayStr=new Date().toISOString().split("T")[0];

  // Calcula o esperado por grupo — somente vendas deste operador hoje
  const vendas=(storeSales||[]).filter(s=>s.date===todayStr&&s.status!=="Cancelada"&&(loggedUser?.id?s.sellerId===loggedUser.id:true));
  const esperado=Object.fromEntries(PAY_GROUPS.map(g=>{
    let total=0;
    vendas.forEach(v=>{
      const pays=v.payments&&v.payments.length>0?v.payments:[{method:v.payment||"",value:v.total}];
      pays.forEach(p=>{
        const matched=PAY_GROUPS.find(x=>x.match(p.method));
        const groupKey=matched?matched.key:"outros";
        if(groupKey===g.key)total+=+p.value||0;
      });
    });
    // Para dinheiro: soma fundo inicial e suprimentos, desconta sangrias
    if(g.key==="dinheiro"){
      total+=storeCash.initial||0;
      const suprimentos=storeCash.history.filter(h=>h.type==="entrada"&&!h.desc?.startsWith("Venda ")).reduce((s,h)=>s+h.value,0);
      const sangrias=storeCash.history.filter(h=>h.type==="saida").reduce((s,h)=>s+h.value,0);
      total+=suprimentos;
      total-=sangrias;
    }
    return [g.key,total];
  }));

  const totalEsperado=Object.values(esperado).reduce((s,v)=>s+v,0);
  const totalContado=PAY_GROUPS.reduce((s,g)=>s+(+counted[g.key]||0),0);
  const diferenca=totalContado-totalEsperado;

  const saidas=storeCash.history.filter(h=>h.type==="saida").reduce((s,h)=>s+h.value,0);
  // saldoSistema = dinheiro esperado no caixa físico (inicial + vendas dinheiro + suprimentos - sangrias)
  const saldoSistema=storeCash.open?esperado["dinheiro"]:0;

  const updateCash=(fn)=>{setCashState(prev=>{const n={...prev};n[cashKey]=fn({...(n[cashKey]||{open:false,initial:0,history:[]})});return n;});};
  const openCash=()=>{updateCash(cs=>({...cs,open:true,initial:openVal,history:[]}));showToast("Caixa aberto com fundo de "+fmt(openVal)+"!");};
  const doSangria=()=>{
    if(!sangria||+sangria<=0)return showToast("Valor inválido","error");
    const label=sangriaType==="saida"?"Sangria":"Suprimento";
    const mov={type:sangriaType,value:+sangria,desc:sangriaDesc||label,time:new Date().toLocaleTimeString("pt-BR")};
    updateCash(cs=>({...cs,history:[...cs.history,mov]}));
    setPrintData({type:"sangria",label,movType:sangriaType,value:+sangria,desc:sangriaDesc||label,time:mov.time,date:new Date().toLocaleDateString("pt-BR"),store:STORES.find(s=>s.id===activeStore)?.name||"",operator:loggedUser?.name||"—"});
    setSangria("");setSangriaDesc("");showToast(label+" registrado!");
  };

  const confirmarFechamento=()=>{
    const faltando=PAY_GROUPS.filter(g=>esperado[g.key]>0&&counted[g.key]==="");
    if(faltando.length>0)return showToast("Preencha: "+faltando.map(g=>g.label).join(", "),"error");
    const totalVendas=vendas.reduce((s,v)=>s+v.total,0);
    const totalDesc=vendas.reduce((s,v)=>s+(v.discount||0),0);
    const reportData={counted:{...counted},esperado:{...esperado},diferenca,obs:closeObs,closedBy:new Date().toLocaleTimeString("pt-BR")};
    // Salva o valor contado em dinheiro como fundo para a próxima abertura
    const dinheiroContado=+(counted["dinheiro"]||0);
    updateCash(cs=>({
      ...cs,
      open:false,
      initial:dinheiroContado,
      closedAt:new Date().toISOString(),
      closeReport:reportData
    }));
    setPrintData({type:"fechamento",report:reportData,date:new Date().toLocaleDateString("pt-BR"),store:STORES.find(s=>s.id===activeStore)?.name||"",operator:loggedUser?.name||"—",vendas:vendas.length,totalVendas,totalDesc,groups:PAY_GROUPS,sangrias:saidas,history:storeCash.history});
    setShowCloseModal(false);
    setCounted(initCounted());
    setCloseObs("");
    showToast(`Caixa fechado! ${diferenca>=0?"Sobra":"Falta"}: ${fmt(Math.abs(diferenca))}`);
  };

  // Último relatório de fechamento
  const lastReport=storeCash.closeReport;

  // ─── Retiradas grandes ───
  const [wdVal,setWdVal]=useState("");
  const [wdDesc,setWdDesc]=useState("");
  const [wdResp,setWdResp]=useState(loggedUser?.name||"");
  const [wdDest,setWdDest]=useState("");
  const [wdFilterDate,setWdFilterDate]=useState("");
  const [printWithdrawal,setPrintWithdrawal]=useState(null);

  const storeWithdrawals=(withdrawals||[]).filter(w=>(w.storeId||w.store_id)===activeStore);
  const filteredWithdrawals=wdFilterDate?storeWithdrawals.filter(w=>{const d=new Date(w.createdAt||w.created_at).toISOString().split("T")[0];return d===wdFilterDate;}):storeWithdrawals;
  const totalRetiradas=storeWithdrawals.reduce((s,w)=>s+(+w.value||0),0);

  const registerWithdrawal=()=>{
    if(!wdVal||+wdVal<=0)return showToast("Informe o valor da retirada!","error");
    if(!wdDesc)return showToast("Informe o motivo da retirada!","error");
    const newW={id:genId(),storeId:activeStore,store_id:activeStore,value:+wdVal,description:wdDesc,responsible:wdResp||loggedUser?.name||"",destination:wdDest,createdAt:new Date().toISOString(),created_at:new Date().toISOString()};
    setWithdrawals(prev=>[newW,...prev]);
    api.createWithdrawal({store_id:activeStore,value:+wdVal,description:wdDesc,responsible:wdResp,destination:wdDest}).catch(console.error);
    // Registra saída no caixa para subtrair do saldo (usa cashKey do componente)
    setCashState(prev=>{
      const n={...prev};
      const cs=n[cashKey]||{open:false,initial:0,history:[]};
      const newMov={type:"saida",value:+wdVal,desc:"Retirada: "+(wdDesc||"Sem descrição"),time:new Date().toLocaleTimeString("pt-BR")};
      n[cashKey]={...cs,history:[...(cs.history||[]),newMov]};
      return n;
    });
    // Gera comprovante
    setPrintWithdrawal({type:"retirada",value:+wdVal,description:wdDesc,responsible:wdResp||loggedUser?.name||"",destination:wdDest,store:STORES.find(s=>s.id===activeStore)?.name||"",date:new Date().toLocaleDateString("pt-BR"),time:new Date().toLocaleTimeString("pt-BR"),operator:loggedUser?.name||"—"});
    setWdVal("");setWdDesc("");setWdDest("");
    showToast("Retirada de "+fmt(+wdVal)+" registrada!");
  };

  const deleteWithdrawal=(id)=>{
    if(!confirm("Excluir esta retirada?"))return;
    setWithdrawals(prev=>prev.filter(w=>w.id!==id));
    api.deleteWithdrawal(id).catch(console.error);
    showToast("Retirada excluída!");
  };

  const printWithdrawalReport=()=>{
    const data=filteredWithdrawals;
    const storeName=STORES.find(s=>s.id===activeStore)?.name||"";
    const total=data.reduce((s,w)=>s+(+w.value||0),0);
    const w=window.open("","_blank","width=400,height=600");
    w.document.write(`<html><head><title>Relatório de Retiradas</title><style>body{font-family:Arial,sans-serif;padding:20px;color:#000}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px;text-align:left}th{background:#f5f5f5;font-weight:700}.total{font-size:16px;font-weight:700;margin-top:12px;text-align:right}h2{margin:0 0 4px}p{margin:2px 0;color:#666;font-size:12px}</style></head><body>`);
    w.document.write(`<h2>D'BLACK - RELATÓRIO DE RETIRADAS</h2>`);
    w.document.write(`<p>${storeName}</p>`);
    w.document.write(`<p>Gerado em: ${new Date().toLocaleString("pt-BR")}</p>`);
    if(wdFilterDate)w.document.write(`<p>Filtro: ${new Date(wdFilterDate+"T12:00:00").toLocaleDateString("pt-BR")}</p>`);
    w.document.write(`<table><thead><tr><th>Data/Hora</th><th>Valor</th><th>Motivo</th><th>Responsável</th><th>Destino</th></tr></thead><tbody>`);
    data.forEach(wd=>{
      const dt=new Date(wd.createdAt||wd.created_at).toLocaleString("pt-BR");
      w.document.write(`<tr><td>${dt}</td><td style="font-weight:700;color:#B71C1C">R$ ${(+wd.value).toFixed(2).replace(".",",")}</td><td>${wd.description||"-"}</td><td>${wd.responsible||"-"}</td><td>${wd.destination||"-"}</td></tr>`);
    });
    w.document.write(`</tbody></table>`);
    w.document.write(`<div class="total">Total: R$ ${total.toFixed(2).replace(".",",")}</div>`);
    w.document.write(`<p style="margin-top:30px;border-top:1px solid #000;padding-top:10px">_________________________<br/>Assinatura do responsável</p>`);
    w.document.write(`</body></html>`);
    w.document.close();
    w.print();
  };

  const caixaTabs=[
    {id:"operacao",label:"Operação",icon:"💰"},
    {id:"retiradas",label:"Retiradas Grandes",icon:"💸"},
    {id:"vales",label:"Vales Colaboradores",icon:"🧾"},
  ];

  return(
    <div>
      {/* Sub-abas do Caixa */}
      <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
        {caixaTabs.map(st=><button key={st.id} onClick={()=>setCaixaTab(st.id)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid "+(caixaTab===st.id?C.gold:C.brd),background:caixaTab===st.id?"rgba(255,215,64,.08)":C.s1,color:caixaTab===st.id?C.gold:C.dim,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><span>{st.icon}</span>{st.label}{st.id==="retiradas"&&storeWithdrawals.length>0?<span style={{background:C.red,color:"#fff",borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:700,marginLeft:4}}>{storeWithdrawals.length}</span>:null}</button>)}
      </div>

      {/* ═══ ABA OPERAÇÃO (conteúdo existente) ═══ */}
      {caixaTab==="operacao"&&<div>
      {/* KPIs */}
      <div style={S.kpiRow}>
        <KPI icon={storeCash.open?I.unlock:I.lock} label="Status" value={storeCash.open?"ABERTO":"FECHADO"} sub="" color={storeCash.open?C.grn:C.red}/>
        <KPI icon={I.money} label="Saldo Sistema" value={fmt(saldoSistema)} sub={"Fundo: "+fmt(storeCash.initial)} color={C.gold}/>
        <KPI icon={I.check} label="Vendas Hoje" value={vendas.length+""} sub={fmt(vendas.reduce((s,v)=>s+v.total,0))} color={C.grn}/>
        <KPI icon={I.alert} label="Sangrias" value={fmt(saidas)} sub={storeCash.history.filter(h=>h.type==="saida").length+" movim."} color={C.red}/>
      </div>

      {/* CAIXA FECHADO */}
      {!storeCash.open&&<div style={S.card}>
        <h3 style={S.cardTitle}>🔓 Abrir Caixa</h3>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontSize:12,color:C.dim}}>Fundo de troco:</span>
          {lastReport?<>
            <span style={{...S.inp,width:120,textAlign:"center",fontSize:18,fontWeight:700,background:"rgba(255,215,64,.08)",display:"inline-flex",alignItems:"center",justifyContent:"center"}}>{fmt(openVal)}</span>
            <span style={{fontSize:10,color:C.dim}}>Valor do último fechamento</span>
          </>:
            <input style={{...S.inp,width:120,textAlign:"center",fontSize:18,fontWeight:700}} type="number" value={openVal} onChange={e=>setOpenVal(+e.target.value)}/>
          }
          <button style={S.primBtn} onClick={openCash}>{I.unlock} Abrir Caixa</button>
        </div>
        {lastReport&&<div style={{marginTop:16,padding:14,background:C.s2,borderRadius:10,border:`1px solid ${C.brd}`}}>
          <div style={{fontSize:11,fontWeight:700,color:C.dim,letterSpacing:1,marginBottom:8}}>📋 ÚLTIMO FECHAMENTO — {storeCash.closedAt?new Date(storeCash.closedAt).toLocaleString("pt-BR"):""}</div>
          {PAY_GROUPS.map(g=>lastReport.counted[g.key]!==""&&<div key={g.key} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",borderBottom:`1px solid ${C.brd}`}}>
            <span style={{color:g.color}}>{g.label}</span>
            <span>Contado: <strong>{fmt(+lastReport.counted[g.key])}</strong> | Esperado: <strong>{fmt(lastReport.esperado[g.key])}</strong></span>
          </div>)}
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontWeight:700,fontSize:13}}>
            <span>Diferença total:</span>
            <span style={{color:lastReport.diferenca>=0?C.grn:C.red}}>{lastReport.diferenca>0?"+":""}{fmt(lastReport.diferenca)}</span>
          </div>
          {lastReport.obs&&<div style={{marginTop:6,fontSize:11,color:C.dim}}>Obs: {lastReport.obs}</div>}
        </div>}
      </div>}

      {/* CAIXA ABERTO */}
      {storeCash.open&&<>
        <div style={S.grid2}>
          {/* Sangria / Suprimento */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>💸 Sangria / Suprimento</h3>
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <button onClick={()=>setSangriaType("saida")}
                style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${sangriaType==="saida"?C.red:C.brd}`,background:sangriaType==="saida"?"rgba(255,82,82,.12)":"transparent",color:sangriaType==="saida"?C.red:C.dim,fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>
                ↓ Sangria (retirada)
              </button>
              <button onClick={()=>setSangriaType("entrada")}
                style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${sangriaType==="entrada"?C.grn:C.brd}`,background:sangriaType==="entrada"?"rgba(0,230,118,.12)":"transparent",color:sangriaType==="entrada"?C.grn:C.dim,fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>
                ↑ Suprimento (entrada)
              </button>
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              <input style={{...S.inp,width:100}} type="number" placeholder="Valor R$" value={sangria} onChange={e=>setSangria(e.target.value)}/>
              <input style={{...S.inp,flex:1}} placeholder={sangriaType==="saida"?"Motivo (ex: pagamento fornecedor)":"Motivo (ex: reforço de troco)"} value={sangriaDesc} onChange={e=>setSangriaDesc(e.target.value)}/>
              <button style={{...S.primBtn,background:sangriaType==="saida"?`linear-gradient(135deg,${C.red},#B71C1C)`:`linear-gradient(135deg,${C.grn},#00C853)`}} onClick={doSangria}>Registrar</button>
            </div>
          </div>
          {/* Fechar */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>🔒 Fechar Caixa</h3>
            <p style={{fontSize:12,color:C.dim,marginBottom:12}}>Saldo sistema: <strong style={{color:C.gold,fontSize:15}}>{fmt(saldoSistema)}</strong></p>
            <button style={{...S.primBtn,background:`linear-gradient(135deg,${C.red},#B71C1C)`,width:"100%",justifyContent:"center"}}
              onClick={()=>{setCounted(initCounted());setShowCloseModal(true);}}>
              {I.lock} Iniciar Fechamento de Caixa
            </button>
          </div>
        </div>

        {/* Movimentações */}
        <div style={S.card}>
          <h3 style={S.cardTitle}>📋 Movimentações do Dia</h3>
          {storeCash.history.length===0
            ?<div style={{opacity:.4,fontSize:12,textAlign:"center",padding:16}}>Nenhuma movimentação registrada</div>
            :<div style={S.tWrap}><table style={S.table}>
              <thead><tr><th style={S.th}>Hora</th><th style={S.th}>Tipo</th><th style={S.th}>Descrição</th><th style={S.th}>Valor</th></tr></thead>
              <tbody>{storeCash.history.map((h,i)=><tr key={i} style={S.tr}>
                <td style={{...S.td,fontFamily:"monospace",fontSize:11}}>{h.time}</td>
                <td style={S.td}><span style={{...S.stBadge,...(h.type==="entrada"?S.stOk:S.stLow)}}>{h.type==="entrada"?"↑ Entrada":"↓ Saída"}</span></td>
                <td style={S.td}>{h.desc}</td>
                <td style={{...S.td,fontWeight:700,color:h.type==="entrada"?C.grn:C.red}}>{h.type==="entrada"?"+":"-"}{fmt(h.value)}</td>
              </tr>)}</tbody>
            </table></div>
          }
        </div>
      </>}

      {/* ── MODAL FECHAMENTO ── */}
      {showCloseModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",overflowY:"auto",padding:16}}>
        <div style={{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:20,width:520,maxWidth:"100%",padding:28}} onClick={e=>e.stopPropagation()}>
          <h3 style={{margin:"0 0 4px",fontSize:18}}>🔒 Fechamento de Caixa</h3>
          <p style={{fontSize:12,color:C.dim,marginBottom:12}}>Informe o valor contado fisicamente para cada forma de pagamento.</p>

          {/* Resumo de vendas do operador */}
          {(()=>{const totalVendas=vendas.reduce((s,v)=>s+v.total,0);const totalDesc=vendas.reduce((s,v)=>s+(v.discount||0),0);return(
          <div style={{background:"rgba(0,230,118,.06)",border:"1px solid rgba(0,230,118,.2)",borderRadius:10,padding:"10px 14px",marginBottom:16,display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,textAlign:"center"}}>
            <div><div style={{fontSize:18,fontWeight:800,color:C.grn}}>{vendas.length}</div><div style={{fontSize:10,color:C.dim}}>vendas no dia</div></div>
            <div><div style={{fontSize:18,fontWeight:800,color:C.gold}}>{fmt(totalVendas)}</div><div style={{fontSize:10,color:C.dim}}>total faturado</div></div>
            <div><div style={{fontSize:18,fontWeight:800,color:C.red}}>{fmt(totalDesc)}</div><div style={{fontSize:10,color:C.dim}}>em descontos</div></div>
          </div>);})()}

          {/* Cabeçalho da tabela */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 110px 110px 90px",gap:8,padding:"6px 8px",background:C.s2,borderRadius:8,fontSize:10,fontWeight:700,color:C.dim,letterSpacing:1,marginBottom:8}}>
            <span>FORMA</span><span style={{textAlign:"right"}}>ESPERADO</span><span style={{textAlign:"right"}}>CONTADO</span><span style={{textAlign:"right"}}>DIFERENÇA</span>
          </div>

          {PAY_GROUPS.map(g=>{
            const esp=esperado[g.key];
            const cnt=counted[g.key]===""?null:+counted[g.key];
            const diff=cnt!=null?cnt-esp:null;
            const diffColor=diff==null?C.dim:diff>0?C.grn:diff<0?C.red:C.grn;
            return <div key={g.key} style={{display:"grid",gridTemplateColumns:"1fr 110px 110px 90px",gap:8,alignItems:"center",padding:"8px",borderRadius:10,marginBottom:6,background:"rgba(255,255,255,.03)",border:`1px solid ${esp>0?g.color+"33":C.brd}`}}>
              <span style={{fontWeight:600,fontSize:13,color:esp>0?g.color:C.dim}}>{g.label}</span>
              <span style={{textAlign:"right",fontFamily:"monospace",fontSize:12,color:C.dim}}>{fmt(esp)}</span>
              <input
                type="number"
                placeholder={esp>0?"obrigatório":"—"}
                value={counted[g.key]}
                onChange={e=>setCounted(prev=>({...prev,[g.key]:e.target.value}))}
                style={{...S.inp,padding:"6px 8px",fontSize:13,textAlign:"right",borderColor:esp>0&&counted[g.key]===""?C.red+"66":diff!=null&&diff!==0?diffColor+"66":C.brd}}
              />
              <span style={{textAlign:"right",fontWeight:700,fontSize:12,color:diffColor}}>
                {diff==null?"—":diff===0?"✓":(diff>0?"+":"")+fmt(diff)}
              </span>
            </div>;
          })}

          {/* Totais */}
          <div style={{borderTop:`1px solid ${C.brd}`,marginTop:10,paddingTop:12}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 110px 110px 90px",gap:8,fontWeight:800,fontSize:14}}>
              <span>TOTAL</span>
              <span style={{textAlign:"right",color:C.dim,fontFamily:"monospace"}}>{fmt(totalEsperado)}</span>
              <span style={{textAlign:"right",fontFamily:"monospace",color:C.gold}}>{fmt(totalContado)}</span>
              <span style={{textAlign:"right",color:diferenca>=0?C.grn:C.red}}>{diferenca>=0?"+":""}{fmt(diferenca)}</span>
            </div>
            {diferenca!==0&&<div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:diferenca>0?"rgba(0,230,118,.08)":"rgba(255,82,82,.08)",fontSize:12,color:diferenca>0?C.grn:C.red,fontWeight:600}}>
              {diferenca>0?`✅ Sobra de ${fmt(diferenca)} — verifique o troco`:`⚠️ Falta de ${fmt(Math.abs(diferenca))} — verifique as movimentações`}
            </div>}
          </div>

          {/* Observação */}
          <div style={{marginTop:12}}>
            <label style={{fontSize:11,color:C.dim,display:"block",marginBottom:4}}>Observação (opcional)</label>
            <input style={{...S.inp,width:"100%",boxSizing:"border-box"}} placeholder="Ex: cliente pagou com nota de R$100, troco dado..." value={closeObs} onChange={e=>setCloseObs(e.target.value)}/>
          </div>

          <div style={{display:"flex",gap:8,marginTop:18}}>
            <button style={{...S.secBtn,flex:1}} onClick={()=>setShowCloseModal(false)}>Cancelar</button>
            <button style={{flex:2,padding:"12px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${C.red},#B71C1C)`,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
              onClick={confirmarFechamento}>
              {I.lock} Confirmar Fechamento
            </button>
          </div>
        </div>
      </div>}

      {/* ── COMPROVANTE CAIXA/SANGRIA ── */}
      {printData&&<ReceiptComprovante data={printData} onClose={()=>setPrintData(null)}/>}
      </div>}

      {/* ═══ ABA RETIRADAS GRANDES ═══ */}
      {caixaTab==="retiradas"&&<div>
        <div style={S.kpiRow}>
          <KPI icon="💸" label="Total Retiradas" value={fmt(totalRetiradas)} sub={storeWithdrawals.length+" registros"} color={C.red}/>
          <KPI icon="📋" label="Última Retirada" value={storeWithdrawals.length>0?fmt(+storeWithdrawals[0].value):"-"} sub={storeWithdrawals.length>0?new Date(storeWithdrawals[0].createdAt||storeWithdrawals[0].created_at).toLocaleDateString("pt-BR"):"-"} color={C.gold}/>
        </div>

        {/* Formulário de nova retirada */}
        <div style={S.card}>
          <h3 style={S.cardTitle}>💸 Registrar Retirada Grande</h3>
          <p style={{fontSize:12,color:C.dim,marginBottom:12}}>Registre retiradas grandes de dinheiro do caixa para controle e verificação.</p>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Valor R$ *</label><input style={{...S.inp,width:"100%",fontSize:16,fontWeight:700}} type="number" placeholder="0,00" value={wdVal} onChange={e=>setWdVal(e.target.value)}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Responsável</label><input style={{...S.inp,width:"100%"}} placeholder="Quem retirou" value={wdResp} onChange={e=>setWdResp(e.target.value)}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Motivo da retirada *</label><input style={{...S.inp,width:"100%"}} placeholder="Ex: Pagamento fornecedor, depósito bancário..." value={wdDesc} onChange={e=>setWdDesc(e.target.value)}/></div>
            <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Destino do dinheiro</label><input style={{...S.inp,width:"100%"}} placeholder="Ex: Banco, cofre, fornecedor X..." value={wdDest} onChange={e=>setWdDest(e.target.value)}/></div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button style={{...S.primBtn,background:`linear-gradient(135deg,${C.red},#B71C1C)`}} onClick={registerWithdrawal}>💸 Registrar Retirada</button>
          </div>
        </div>

        {/* Filtro e relatório */}
        <div style={S.card}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:12}}>
            <h3 style={{...S.cardTitle,margin:0}}>📋 Histórico de Retiradas</h3>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input style={{...S.inp,width:160}} type="date" value={wdFilterDate} onChange={e=>setWdFilterDate(e.target.value)}/>
              {wdFilterDate&&<button style={S.secBtn} onClick={()=>setWdFilterDate("")}>Limpar filtro</button>}
              <button style={S.primBtn} onClick={printWithdrawalReport}>🖨️ Imprimir Relatório</button>
            </div>
          </div>

          {filteredWithdrawals.length===0
            ?<div style={{opacity:.4,fontSize:12,textAlign:"center",padding:16}}>Nenhuma retirada registrada{wdFilterDate?" nesta data":""}</div>
            :<div style={S.tWrap}><table style={S.table}>
              <thead><tr>
                <th style={S.th}>Data/Hora</th>
                <th style={S.th}>Valor</th>
                <th style={S.th}>Motivo</th>
                <th style={S.th}>Responsável</th>
                <th style={S.th}>Destino</th>
                <th style={S.th}>Ação</th>
              </tr></thead>
              <tbody>{filteredWithdrawals.map(w=><tr key={w.id} style={S.tr}>
                <td style={{...S.td,fontFamily:"monospace",fontSize:11}}>{new Date(w.createdAt||w.created_at).toLocaleString("pt-BR")}</td>
                <td style={{...S.td,fontWeight:800,color:C.red,fontSize:14}}>{fmt(+w.value)}</td>
                <td style={S.td}>{w.description||"-"}</td>
                <td style={S.td}>{w.responsible||"-"}</td>
                <td style={S.td}>{w.destination||"-"}</td>
                <td style={S.td}><button style={{...S.smBtn,color:C.red}} onClick={()=>deleteWithdrawal(w.id)}>🗑️</button></td>
              </tr>)}</tbody>
            </table></div>
          }

          {/* Totalizador */}
          {filteredWithdrawals.length>0&&<div style={{marginTop:12,padding:"12px 16px",background:"rgba(255,82,82,.06)",border:`1px solid rgba(255,82,82,.2)`,borderRadius:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:13,fontWeight:600,color:C.dim}}>{filteredWithdrawals.length} retirada(s){wdFilterDate?" no dia":""}</span>
            <span style={{fontSize:18,fontWeight:900,color:C.red}}>{fmt(filteredWithdrawals.reduce((s,w)=>s+(+w.value||0),0))}</span>
          </div>}
        </div>
        {/* Comprovante de retirada */}
        {printWithdrawal&&<ReceiptComprovante data={printWithdrawal} onClose={()=>setPrintWithdrawal(null)}/>}
      </div>}

      {/* ═══ ABA VALES COLABORADORES ═══ */}
      {caixaTab==="vales"&&(()=>{
        const storeAdvances=(advances||[]).filter(a=>(a.storeId||a.store_id)===activeStore);
        const storeEmps=(employees||[]).filter(e=>e.storeId===activeStore||e.store_id===activeStore||e.storeId==="all");
        const totalVales=storeAdvances.reduce((s,a)=>s+(+a.value||0),0);
        const currentMonth=new Date().toISOString().slice(0,7);
        const monthAdvances=storeAdvances.filter(a=>(a.month||"")===currentMonth);
        const totalMes=monthAdvances.reduce((s,a)=>s+(+a.value||0),0);

        return <div>
          <div style={S.kpiRow}>
            <KPI icon="🧾" label="Total Vales" value={fmt(totalVales)} sub={storeAdvances.length+" registros"} color={C.gold}/>
            <KPI icon="📅" label="Vales do Mês" value={fmt(totalMes)} sub={monthAdvances.length+" neste mês"} color={C.blu}/>
          </div>

          {/* Formulário */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>🧾 Registrar Vale (Adiantamento)</h3>
            <p style={{fontSize:12,color:C.dim,marginBottom:12}}>Valor retirado do caixa como adiantamento para colaborador. Será descontado automaticamente na folha de pagamento.</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Colaborador *</label>
                <select id="adv-emp" style={{...S.sel,width:"100%"}} defaultValue="">
                  <option value="">Selecione o colaborador</option>
                  {storeEmps.filter(e=>e.active!==false).map(e=><option key={e.id} value={e.id}>{e.name} — {e.role||"Colaborador"}</option>)}
                </select>
              </div>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Valor R$ *</label>
                <input id="adv-val" style={{...S.inp,width:"100%",fontSize:16,fontWeight:700}} type="number" placeholder="0,00"/>
              </div>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Motivo</label>
                <input id="adv-desc" style={{...S.inp,width:"100%"}} placeholder="Ex: Adiantamento salarial, emergência..."/>
              </div>
              <div>
                <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Autorizado por</label>
                <input id="adv-auth" style={{...S.inp,width:"100%"}} placeholder={loggedUser?.name||""} defaultValue={loggedUser?.name||""}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button style={{...S.primBtn,background:`linear-gradient(135deg,${C.gold},${C.goldD||"#FFA000"})`}} onClick={()=>{
                const empEl=document.getElementById("adv-emp");
                const valEl=document.getElementById("adv-val");
                const descEl=document.getElementById("adv-desc");
                const authEl=document.getElementById("adv-auth");
                const empId=empEl?.value;
                const val=+valEl?.value;
                if(!empId)return showToast("Selecione o colaborador!","error");
                if(!val||val<=0)return showToast("Informe o valor!","error");
                const emp=storeEmps.find(e=>e.id===empId);
                const newAdv={id:genId(),storeId:activeStore,store_id:activeStore,empId,emp_id:empId,empName:emp?.name||"",emp_name:emp?.name||"",value:val,description:descEl?.value||"",authorizedBy:authEl?.value||loggedUser?.name||"",authorized_by:authEl?.value||loggedUser?.name||"",month:currentMonth,createdAt:new Date().toISOString(),created_at:new Date().toISOString()};
                setAdvances(prev=>[newAdv,...prev]);
                api.createAdvance({store_id:activeStore,emp_id:empId,emp_name:emp?.name||"",value:val,description:descEl?.value||"",authorized_by:authEl?.value||loggedUser?.name||""}).catch(console.error);
                // Desconta do caixa
                setCashState(prev=>{
                  const n={...prev};
                  const cs=n[cashKey]||{open:false,initial:0,history:[]};
                  n[cashKey]={...cs,history:[...(cs.history||[]),{type:"saida",value:val,desc:"Vale: "+(emp?.name||"")+" - "+(descEl?.value||"Adiantamento"),time:new Date().toLocaleTimeString("pt-BR")}]};
                  return n;
                });
                // Limpa
                if(valEl)valEl.value="";
                if(descEl)descEl.value="";
                if(empEl)empEl.value="";
                showToast("Vale de "+fmt(val)+" para "+(emp?.name||"")+" registrado!");
              }}>🧾 Registrar Vale</button>
            </div>
          </div>

          {/* Histórico */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>📋 Histórico de Vales</h3>
            <div style={S.tWrap}><table style={S.table}><thead><tr>
              <th style={S.th}>Data</th><th style={S.th}>Colaborador</th><th style={S.th}>Valor</th><th style={S.th}>Motivo</th><th style={S.th}>Autorizado</th><th style={S.th}>Mês Ref.</th><th style={S.th}></th>
            </tr></thead><tbody>
              {storeAdvances.length===0
                ?<tr><td colSpan={7} style={{...S.td,textAlign:"center",opacity:.4,padding:20}}>Nenhum vale registrado</td></tr>
                :storeAdvances.map(a=><tr key={a.id} style={S.tr}>
                  <td style={{...S.td,fontSize:11}}>{new Date(a.createdAt||a.created_at).toLocaleDateString("pt-BR")}</td>
                  <td style={{...S.td,fontWeight:700}}>{a.empName||a.emp_name}</td>
                  <td style={{...S.td,fontWeight:700,color:C.red}}>{fmt(+a.value)}</td>
                  <td style={{...S.td,fontSize:11}}>{a.description||"-"}</td>
                  <td style={{...S.td,fontSize:11}}>{a.authorizedBy||a.authorized_by||"-"}</td>
                  <td style={S.td}><span style={S.payBadge}>{a.month}</span></td>
                  <td style={S.td}><button style={{...S.smBtn,color:C.red}} onClick={()=>{if(!confirm("Excluir este vale?"))return;setAdvances(prev=>prev.filter(x=>x.id!==a.id));api.deleteAdvance(a.id).catch(console.error);showToast("Vale excluído!");}}>🗑️</button></td>
                </tr>)
              }
            </tbody></table></div>
          </div>

          {/* Resumo por colaborador */}
          {monthAdvances.length>0&&<div style={S.card}>
            <h3 style={S.cardTitle}>👥 Resumo do Mês ({currentMonth})</h3>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {Object.entries(monthAdvances.reduce((acc,a)=>{const n=a.empName||a.emp_name;acc[n]=(acc[n]||0)+(+a.value||0);return acc;},{})).map(([name,total])=>
                <div key={name} style={{background:C.s2,borderRadius:10,padding:"10px 16px",border:`1px solid ${C.brd}`,textAlign:"center"}}>
                  <div style={{fontSize:16,fontWeight:800,color:C.red}}>{fmt(total)}</div>
                  <div style={{fontSize:11,color:C.dim}}>{name}</div>
                </div>
              )}
            </div>
          </div>}
        </div>;
      })()}
    </div>
  );
}

// ═══════════════════════════════════
// ═══  RH / FOLHA DE PAGAMENTO   ═══
// ═══════════════════════════════════
function RHModule({employees,setEmployees,payrolls,setPayrolls,advances,showToast}){
  const [activeTab,setActiveTab]=useState("colaboradores"); // colaboradores, folha, historico
  const [showEmpForm,setShowEmpForm]=useState(false);
  const [showPayForm,setShowPayForm]=useState(false);
  const [selectedEmp,setSelectedEmp]=useState(null);
  const [filterStore,setFilterStore]=useState("");
  const [receiptData,setReceiptData]=useState(null); // payroll receipt to print

  // New employee form
  const [ne,setNe]=useState({name:"",cpf:"",role:"Vendedor",storeId:"loja1",salary:"",pix:"",admission:new Date().toISOString().split("T")[0]});

  // Payroll form
  const [pay,setPay]=useState({month:new Date().toISOString().slice(0,7),empId:"",baseSalary:0,metaBonus:"",awards:"",overtime:"",storeDiscount:"",advances:"",otherDeductions:"",notes:""});

  const [editEmpId,setEditEmpId]=useState(null);

  const addEmployee=()=>{
    if(!ne.name||!ne.salary)return showToast("Preencha nome e salário!","error");
    if(editEmpId){
      const updated={...ne,salary:+ne.salary};
      setEmployees(prev=>prev.map(e=>e.id===editEmpId?{...e,...updated}:e));
      api.updateEmployee(editEmpId,{name:ne.name,cpf:ne.cpf,role:ne.role,store_id:ne.storeId,salary:+ne.salary,pix:ne.pix,admission:ne.admission,active:true}).catch(console.error);
      setEditEmpId(null);setShowEmpForm(false);showToast("Colaborador atualizado!");
    } else {
      const newEmp={...ne,id:genId(),salary:+ne.salary,active:true};
      setEmployees(prev=>[...prev,newEmp]);
      api.createEmployee({name:ne.name,cpf:ne.cpf,role:ne.role,store_id:ne.storeId,salary:+ne.salary,pix:ne.pix,admission:ne.admission}).catch(console.error);
      setShowEmpForm(false);showToast("Colaborador cadastrado!");
    }
    setNe({name:"",cpf:"",role:"Vendedor",storeId:"loja1",salary:"",pix:"",admission:new Date().toISOString().split("T")[0]});
  };

  const startEditEmp=(emp)=>{
    setNe({name:emp.name,cpf:emp.cpf||"",role:emp.role,storeId:emp.storeId,salary:String(emp.salary),pix:emp.pix||"",admission:emp.admission||""});
    setEditEmpId(emp.id);setShowEmpForm(true);
  };

  const deleteEmployee=(id)=>{
    if(!confirm("Tem certeza que deseja EXCLUIR este colaborador? Esta ação não pode ser desfeita."))return;
    setEmployees(prev=>prev.filter(e=>e.id!==id));
    api.deleteEmployee(id).catch(console.error);
    showToast("Colaborador excluído!");
  };

  const toggleEmployee=(id)=>{
    setEmployees(prev=>prev.map(e=>{
      if(e.id!==id)return e;
      const updated={...e,active:!e.active};
      api.updateEmployee(id,{name:e.name,cpf:e.cpf,role:e.role,store_id:e.storeId,salary:e.salary,pix:e.pix,admission:e.admission,active:!e.active}).catch(console.error);
      return updated;
    }));
  };

  const deletePayroll=(id)=>{
    if(!confirm("Tem certeza que deseja EXCLUIR este pagamento? Esta ação não pode ser desfeita."))return;
    setPayrolls(prev=>prev.filter(p=>p.id!==id));
    api.deletePayroll(id).catch(console.error);
    showToast("Pagamento excluído!");
  };

  // Select employee for payroll — calcula vales automaticamente
  const selectEmpForPay=(emp)=>{
    const empAdvances=(advances||[]).filter(a=>(a.empId||a.emp_id)===emp.id&&(a.month||"")===pay.month);
    const totalAdvances=empAdvances.reduce((s,a)=>s+(+a.value||0),0);
    setPay(p=>({...p,empId:emp.id,baseSalary:emp.salary,advances:totalAdvances||""}));
    setSelectedEmp(emp);
  };

  // Calculate payroll
  const payEarnings=(+pay.baseSalary||0)+(+pay.metaBonus||0)+(+pay.awards||0)+(+pay.overtime||0);
  const payDeductions=(+pay.storeDiscount||0)+(+pay.advances||0)+(+pay.otherDeductions||0);
  const payNet=payEarnings-payDeductions;

  const processPayroll=()=>{
    if(!pay.empId)return showToast("Selecione um colaborador!","error");
    const emp=employees.find(e=>e.id===pay.empId);
    const store=STORES.find(s=>s.id===emp?.storeId);
    const newPay={
      id:genId(),month:pay.month,empId:pay.empId,empName:emp?.name||"",empCpf:emp?.cpf||"",empRole:emp?.role||"",empPix:emp?.pix||"",
      storeId:emp?.storeId||"",storeName:store?.name||"",
      baseSalary:+pay.baseSalary,metaBonus:+pay.metaBonus||0,awards:+pay.awards||0,overtime:+pay.overtime||0,
      storeDiscount:+pay.storeDiscount||0,advances:+pay.advances||0,otherDeductions:+pay.otherDeductions||0,
      totalEarnings:payEarnings,totalDeductions:payDeductions,netPay:payNet,
      paid:true,paidDate:new Date().toISOString().split("T")[0],notes:pay.notes
    };
    setPayrolls(prev=>[newPay,...prev]);
    setReceiptData(newPay); // Open receipt
    setPay({month:pay.month,empId:"",baseSalary:0,metaBonus:"",awards:"",overtime:"",storeDiscount:"",advances:"",otherDeductions:"",notes:""});
    setSelectedEmp(null);setShowPayForm(false);
    showToast("Pagamento de "+fmt(payNet)+" processado para "+emp?.name+"!");
  };

  const activeEmps=employees.filter(e=>e.active);
  const filteredEmps=filterStore?employees.filter(e=>e.storeId===filterStore):employees;
  const totalPayroll=payrolls.reduce((s,p)=>s+p.netPay,0);
  const monthPayrolls=payrolls.filter(p=>p.month===pay.month);
  const monthTotal=monthPayrolls.reduce((s,p)=>s+p.netPay,0);

  // By store
  const payByStore={};payrolls.forEach(p=>{payByStore[p.storeId]=(payByStore[p.storeId]||0)+p.netPay;});

  const subTabs=[
    {id:"colaboradores",label:"Colaboradores",icon:"👥"},
    {id:"folha",label:"Gerar Pagamento",icon:"💰"},
    {id:"historico",label:"Histórico",icon:"📜"},
  ];

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
        {subTabs.map(st=><button key={st.id} onClick={()=>setActiveTab(st.id)} style={{padding:"8px 14px",borderRadius:8,border:"1px solid "+(activeTab===st.id?C.gold:C.brd),background:activeTab===st.id?"rgba(255,215,64,.08)":C.s1,color:activeTab===st.id?C.gold:C.dim,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><span>{st.icon}</span>{st.label}</button>)}
      </div>

      <div style={S.kpiRow}>
        <KPI icon={I.users} label="Colaboradores" value={activeEmps.length+""} sub={employees.length+" total"} color={C.blu}/>
        <KPI icon={I.money} label="Folha Total" value={fmt(totalPayroll)} sub={payrolls.length+" pagamentos"} color={C.gold}/>
        <KPI icon={I.chart} label={"Folha "+pay.month} value={fmt(monthTotal)} sub={monthPayrolls.length+" processados"} color={C.pur}/>
      </div>

      {/* ═══ COLABORADORES ═══ */}
      {activeTab==="colaboradores"&&<div>
        <div style={S.toolbar}>
          <select style={{...S.sel,minWidth:140}} value={filterStore} onChange={e=>setFilterStore(e.target.value)}>
            <option value="">Todas as lojas</option>
            {STORES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div style={{flex:1}}/>
          <button style={S.primBtn} onClick={()=>{setEditEmpId(null);setNe({name:"",cpf:"",role:"Vendedor",storeId:"loja1",salary:"",pix:"",admission:new Date().toISOString().split("T")[0]});setShowEmpForm(!showEmpForm);}}>{I.plus} Novo Colaborador</button>
        </div>

        {showEmpForm&&<div style={S.formCard}><h3 style={S.formTitle}>{editEmpId?"✏️ Editar Colaborador":"Cadastrar Colaborador"}</h3><div style={S.formGrid}>
          <input style={S.inp} placeholder="Nome completo" value={ne.name} onChange={e=>setNe(n=>({...n,name:e.target.value}))}/>
          <input style={S.inp} placeholder="CPF" value={ne.cpf} onChange={e=>setNe(n=>({...n,cpf:e.target.value}))}/>
          <select style={S.sel} value={ne.role} onChange={e=>setNe(n=>({...n,role:e.target.value}))}>
            <option>Gerente</option><option>Vendedor</option><option>Caixa</option><option>Estoquista</option><option>Auxiliar</option>
          </select>
          <select style={S.sel} value={ne.storeId} onChange={e=>setNe(n=>({...n,storeId:e.target.value}))}>
            {STORES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input style={S.inp} type="number" placeholder="Salário base R$" value={ne.salary} onChange={e=>setNe(n=>({...n,salary:e.target.value}))}/>
          <input style={S.inp} placeholder="Chave PIX" value={ne.pix} onChange={e=>setNe(n=>({...n,pix:e.target.value}))}/>
          <input style={S.inp} type="date" value={ne.admission} onChange={e=>setNe(n=>({...n,admission:e.target.value}))}/>
        </div><div style={S.formAct}><button style={S.secBtn} onClick={()=>{setShowEmpForm(false);setEditEmpId(null);}}>Cancelar</button><button style={S.primBtn} onClick={addEmployee}>{editEmpId?"Salvar Alterações":"Cadastrar"}</button></div></div>}

        <div style={S.tWrap}><table style={S.table}><thead><tr>
          <th style={S.th}>Nome</th><th style={S.th}>CPF</th><th style={S.th}>Cargo</th><th style={S.th}>Loja</th><th style={S.th}>Salário</th><th style={S.th}>PIX</th><th style={S.th}>Admissão</th><th style={S.th}>Status</th><th style={S.th}>Ação</th>
        </tr></thead><tbody>{filteredEmps.map(e=>{
          const store=STORES.find(s=>s.id===e.storeId);
          return <tr key={e.id} style={{...S.tr,...(!e.active?{opacity:.4}:{})}}>
            <td style={{...S.td,fontWeight:700}}>{e.name}</td>
            <td style={{...S.td,fontFamily:"monospace",fontSize:11}}>{e.cpf}</td>
            <td style={S.td}><span style={S.payBadge}>{e.role}</span></td>
            <td style={{...S.td,color:store?.color}}>{store?.name?.replace("D'Black ","")}</td>
            <td style={{...S.td,...S.tdM}}>{fmt(e.salary)}</td>
            <td style={{...S.td,fontSize:11,color:C.dim}}>{e.pix||"-"}</td>
            <td style={S.td}>{fmtDate(e.admission)}</td>
            <td style={S.td}><span style={{...S.stBadge,...(e.active?S.stOk:S.stLow)}}>{e.active?"Ativo":"Inativo"}</span></td>
            <td style={S.td}><div style={{display:"flex",gap:3}}>
              <button style={S.smBtn} onClick={()=>startEditEmp(e)}>✏️</button>
              <button style={S.smBtn} onClick={()=>toggleEmployee(e.id)}>{e.active?"Desativar":"Ativar"}</button>
              <button style={{...S.smBtn,color:C.red}} onClick={()=>deleteEmployee(e.id)}>🗑️</button>
            </div></td>
          </tr>;
        })}</tbody></table></div>
      </div>}

      {/* ═══ GERAR PAGAMENTO ═══ */}
      {activeTab==="folha"&&<div>
        <div style={S.card}>
          <h3 style={S.cardTitle}>Gerar Pagamento</h3>
          <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.dim}}>Mês referência:</span>
            <input style={{...S.inp,width:140}} type="month" value={pay.month} onChange={e=>setPay(p=>({...p,month:e.target.value}))}/>
          </div>

          {/* Employee selector */}
          <div style={{fontSize:13,fontWeight:700,marginBottom:10}}>Selecione o colaborador:</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8,marginBottom:16}}>
            {activeEmps.map(emp=>{
              const store=STORES.find(s=>s.id===emp.storeId);
              const alreadyPaid=monthPayrolls.find(p=>p.empId===emp.id);
              return <button key={emp.id} onClick={()=>!alreadyPaid&&selectEmpForPay(emp)} style={{
                display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,
                border:"2px solid "+(selectedEmp?.id===emp.id?C.gold:alreadyPaid?"rgba(0,230,118,.3)":C.brd),
                background:selectedEmp?.id===emp.id?"rgba(255,215,64,.08)":alreadyPaid?"rgba(0,230,118,.04)":C.s2,
                cursor:alreadyPaid?"default":"pointer",fontFamily:"inherit",color:C.txt,textAlign:"left",
                opacity:alreadyPaid?.5:1
              }}>
                <div style={{...S.avatar,width:34,height:34,fontSize:12}}>{emp.name.split(" ").map(w=>w[0]).join("").slice(0,2)}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700}}>{emp.name}</div>
                  <div style={{fontSize:10,color:store?.color}}>{store?.name?.replace("D'Black ","")} • {emp.role}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.gold}}>{fmt(emp.salary)}</div>
                  {alreadyPaid&&<div style={{fontSize:9,color:C.grn}}>✓ Pago</div>}
                </div>
              </button>;
            })}
          </div>

          {/* Payroll form */}
          {selectedEmp&&<div style={{background:C.s2,borderRadius:14,padding:20,border:`1px solid ${C.brdH}`}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,paddingBottom:14,borderBottom:`1px solid ${C.brd}`}}>
              <div style={{...S.avatar,width:44,height:44,fontSize:16}}>{selectedEmp.name.split(" ").map(w=>w[0]).join("").slice(0,2)}</div>
              <div>
                <div style={{fontSize:16,fontWeight:800}}>{selectedEmp.name}</div>
                <div style={{fontSize:12,color:C.dim}}>{selectedEmp.role} • {STORES.find(s=>s.id===selectedEmp.storeId)?.name} • PIX: {selectedEmp.pix||"N/A"}</div>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
              {/* PROVENTOS */}
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.grn,marginBottom:12,letterSpacing:1}}>📈 PROVENTOS</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Salário Base</label><input style={{...S.inp,width:"100%",fontSize:15,fontWeight:700}} type="number" value={pay.baseSalary} onChange={e=>setPay(p=>({...p,baseSalary:e.target.value}))}/></div>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Bônus por Meta</label><input style={{...S.inp,width:"100%"}} type="number" placeholder="0,00" value={pay.metaBonus} onChange={e=>setPay(p=>({...p,metaBonus:e.target.value}))}/></div>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Premiações</label><input style={{...S.inp,width:"100%"}} type="number" placeholder="0,00" value={pay.awards} onChange={e=>setPay(p=>({...p,awards:e.target.value}))}/></div>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Horas Extras (R$)</label><input style={{...S.inp,width:"100%"}} type="number" placeholder="0,00" value={pay.overtime} onChange={e=>setPay(p=>({...p,overtime:e.target.value}))}/></div>
                </div>
                <div style={{marginTop:12,padding:"8px 12px",background:"rgba(0,230,118,.06)",borderRadius:8,display:"flex",justifyContent:"space-between",fontSize:13}}>
                  <span style={{color:C.dim}}>Total Proventos</span>
                  <span style={{fontWeight:800,color:C.grn}}>{fmt(payEarnings)}</span>
                </div>
              </div>

              {/* DESCONTOS */}
              <div>
                <div style={{fontSize:13,fontWeight:800,color:C.red,marginBottom:12,letterSpacing:1}}>📉 DESCONTOS</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Desconto em Loja (compras)</label><input style={{...S.inp,width:"100%"}} type="number" placeholder="0,00" value={pay.storeDiscount} onChange={e=>setPay(p=>({...p,storeDiscount:e.target.value}))}/></div>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Vale / Adiantamento {+pay.advances>0?"(do caixa)":""}</label><input style={{...S.inp,width:"100%",borderColor:+pay.advances>0?C.gold+"66":C.brd}} type="number" placeholder="0,00" value={pay.advances} onChange={e=>setPay(p=>({...p,advances:e.target.value}))}/>{+pay.advances>0&&<div style={{fontSize:9,color:C.gold,marginTop:2}}>🧾 Preenchido automaticamente com vales registrados no caixa</div>}</div>
                  <div><label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Outros Descontos</label><input style={{...S.inp,width:"100%"}} type="number" placeholder="0,00" value={pay.otherDeductions} onChange={e=>setPay(p=>({...p,otherDeductions:e.target.value}))}/></div>
                </div>
                <div style={{marginTop:12,padding:"8px 12px",background:"rgba(255,82,82,.06)",borderRadius:8,display:"flex",justifyContent:"space-between",fontSize:13}}>
                  <span style={{color:C.dim}}>Total Descontos</span>
                  <span style={{fontWeight:800,color:C.red}}>{fmt(payDeductions)}</span>
                </div>
              </div>
            </div>

            {/* Observações */}
            <div style={{marginTop:16}}>
              <label style={{fontSize:10,color:C.dim,display:"block",marginBottom:2}}>Observações</label>
              <input style={{...S.inp,width:"100%"}} placeholder="Ex: Bateu meta, faltou 2 dias, etc..." value={pay.notes} onChange={e=>setPay(p=>({...p,notes:e.target.value}))}/>
            </div>

            {/* TOTAL LÍQUIDO */}
            <div style={{marginTop:20,padding:16,background:C.s1,borderRadius:12,border:`2px solid ${payNet>=0?C.gold:C.red}`,textAlign:"center"}}>
              <div style={{fontSize:12,color:C.dim,letterSpacing:2,marginBottom:4}}>VALOR LÍQUIDO A PAGAR</div>
              <div style={{fontSize:36,fontWeight:900,color:payNet>=0?C.gold:C.red}}>{fmt(payNet)}</div>
              <div style={{fontSize:11,color:C.dim,marginTop:4}}>Proventos {fmt(payEarnings)} − Descontos {fmt(payDeductions)}</div>
            </div>

            <div style={{display:"flex",gap:10,marginTop:16}}>
              <button style={{...S.secBtn,flex:1}} onClick={()=>{setSelectedEmp(null);setPay(p=>({...p,empId:"",baseSalary:0,metaBonus:"",awards:"",overtime:"",storeDiscount:"",advances:"",otherDeductions:"",notes:""}));}}>Cancelar</button>
              <button style={{...S.finBtn,flex:2}} onClick={processPayroll}>{I.check} PROCESSAR PAGAMENTO</button>
            </div>
          </div>}
        </div>
      </div>}

      {/* ═══ HISTÓRICO ═══ */}
      {activeTab==="historico"&&<div>
        <div style={S.grid2}>
          <div style={S.card}>
            <h3 style={S.cardTitle}>Folha por Loja</h3>
            {Object.entries(payByStore).sort((a,b)=>b[1]-a[1]).map(([sid,val])=>{
              const store=STORES.find(s=>s.id===sid);
              return <div key={sid} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <span style={{width:100,fontSize:12,fontWeight:600,color:store?.color,flexShrink:0}}>{store?.name?.replace("D'Black ","")}</span>
                <div style={{flex:1,height:20,background:C.s2,borderRadius:10,overflow:"hidden"}}><div style={{height:"100%",borderRadius:10,background:store?.color||C.gold,width:(totalPayroll>0?val/totalPayroll*100:0)+"%",minWidth:3}}/></div>
                <span style={{fontSize:12,fontWeight:700,color:store?.color,minWidth:85,textAlign:"right",fontFamily:"monospace"}}>{fmt(val)}</span>
              </div>;
            })}
          </div>
          <div style={S.card}>
            <h3 style={S.cardTitle}>Resumo por Mês</h3>
            {[...new Set(payrolls.map(p=>p.month))].sort().reverse().map(month=>{
              const mPays=payrolls.filter(p=>p.month===month);
              const mTotal=mPays.reduce((s,p)=>s+p.netPay,0);
              return <div key={month} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.brd}`,fontSize:13}}>
                <span style={{fontWeight:600}}>{month}</span>
                <span style={{color:C.dim}}>{mPays.length} pagamentos</span>
                <span style={{fontWeight:700,color:C.gold}}>{fmt(mTotal)}</span>
              </div>;
            })}
          </div>
        </div>

        <div style={S.card}>
          <h3 style={S.cardTitle}>Todos os Pagamentos</h3>
          <div style={S.tWrap}><table style={S.table}><thead><tr>
            <th style={S.th}>Mês</th><th style={S.th}>Colaborador</th><th style={S.th}>Loja</th><th style={S.th}>Salário</th><th style={S.th}>Meta</th><th style={S.th}>Prêmios</th><th style={S.th}>H.Extra</th><th style={S.th}>Desc.Loja</th><th style={S.th}>Vales</th><th style={S.th}>Outros</th><th style={S.th}>Líquido</th><th style={S.th}>Obs.</th><th style={S.th}>Ação</th>
          </tr></thead><tbody>{payrolls.map(p=>{
            const store=STORES.find(s=>s.id===p.storeId);
            return <tr key={p.id} style={S.tr}>
              <td style={{...S.td,fontWeight:600}}>{p.month}</td>
              <td style={{...S.td,fontWeight:700}}>{p.empName}</td>
              <td style={{...S.td,color:store?.color,fontSize:11}}>{store?.name?.replace("D'Black ","")}</td>
              <td style={S.td}>{fmt(p.baseSalary)}</td>
              <td style={{...S.td,color:p.metaBonus>0?C.grn:C.dim}}>{p.metaBonus>0?"+"+fmt(p.metaBonus):"-"}</td>
              <td style={{...S.td,color:p.awards>0?C.grn:C.dim}}>{p.awards>0?"+"+fmt(p.awards):"-"}</td>
              <td style={{...S.td,color:p.overtime>0?C.grn:C.dim}}>{p.overtime>0?"+"+fmt(p.overtime):"-"}</td>
              <td style={{...S.td,color:p.storeDiscount>0?C.red:C.dim}}>{p.storeDiscount>0?"-"+fmt(p.storeDiscount):"-"}</td>
              <td style={{...S.td,color:p.advances>0?C.red:C.dim}}>{p.advances>0?"-"+fmt(p.advances):"-"}</td>
              <td style={{...S.td,color:p.otherDeductions>0?C.red:C.dim}}>{p.otherDeductions>0?"-"+fmt(p.otherDeductions):"-"}</td>
              <td style={{...S.td,fontWeight:800,color:C.gold,fontSize:14}}>{fmt(p.netPay)}</td>
              <td style={{...S.td,fontSize:10,color:C.dim,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis"}}>{p.notes||"-"}</td>
              <td style={S.td}><button style={{...S.smBtn,color:C.red}} onClick={()=>deletePayroll(p.id)}>🗑️</button></td>
            </tr>;
          })}</tbody></table></div>
        </div>
      </div>}

      {/* ═══ RECIBO DE PAGAMENTO (PDF A4 - 2 vias) ═══ */}
      {receiptData&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={()=>setReceiptData(null)}>
        <div style={{background:"#fff",color:"#000",width:700,maxWidth:"95%",maxHeight:"95vh",overflowY:"auto",borderRadius:8,fontFamily:"'Outfit',sans-serif"}} onClick={e=>e.stopPropagation()}>

          {/* Action buttons (topo) */}
          <div style={{display:"flex",gap:8,padding:"16px 28px",borderBottom:"1px solid #eee",background:"#f5f5f5",borderRadius:"8px 8px 0 0"}}>
            <button onClick={()=>setReceiptData(null)} style={{flex:1,padding:"10px",borderRadius:8,border:"1px solid #ddd",background:"#fff",color:"#666",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Fechar</button>
            <button onClick={()=>{
              const printW=window.open("","_blank","width=800,height=1100");
              const content=document.getElementById("receipt-pdf-content").innerHTML;
              printW.document.write(`<html><head><title>Recibo de Pagamento - ${receiptData.empName}</title><style>
                @page{size:A4;margin:10mm 15mm}
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:Arial,Helvetica,sans-serif;color:#000;font-size:11px}
                .via{padding:16px 20px;border:1px solid #000;margin-bottom:12px;page-break-inside:avoid}
                .via-label{font-size:9px;font-weight:700;letter-spacing:2px;color:#666;text-align:right;margin-bottom:8px}
                .header{text-align:center;margin-bottom:12px;padding-bottom:10px;border-bottom:2px solid #000}
                .header h1{font-size:22px;font-weight:900;letter-spacing:4px;margin:0}
                .header p{font-size:9px;letter-spacing:3px;color:#666;margin-top:2px}
                .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;font-size:10px}
                .info-grid .item span{display:block;font-size:8px;color:#888;text-transform:uppercase;letter-spacing:1px}
                .info-grid .item strong{font-size:11px}
                .section-title{font-size:9px;font-weight:800;letter-spacing:2px;padding:6px 0;border-top:1.5px solid #000;border-bottom:1px solid #ddd;margin-top:10px;margin-bottom:4px}
                .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #eee;font-size:11px}
                .row-total{display:flex;justify-content:space-between;padding:6px 8px;font-weight:800;font-size:12px;background:#f5f5f5;border-radius:3px;margin-top:4px}
                .row-total.red{background:#fff5f5}
                .net-box{margin-top:14px;padding:12px;border:2.5px solid #000;border-radius:6px;text-align:center}
                .net-box .label{font-size:9px;font-weight:800;letter-spacing:3px;color:#888;margin-bottom:2px}
                .net-box .value{font-size:28px;font-weight:900}
                .pix{margin-top:8px;font-size:10px;color:#666;text-align:center}
                .pix strong{color:#000}
                .obs{margin-top:8px;padding:6px 8px;background:#f9f9f9;border-radius:4px;font-size:10px}
                .obs span{font-size:8px;color:#888}
                .signatures{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:30px}
                .signatures div{text-align:center;border-top:1px solid #000;padding-top:4px;font-size:9px;color:#666}
                .footer{text-align:center;margin-top:10px;font-size:8px;color:#aaa}
                .cut-line{border-top:1.5px dashed #999;margin:8px 0;position:relative}
                .cut-line::after{content:"✂ recorte aqui";position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:#fff;padding:0 8px;font-size:8px;color:#999}
              </style></head><body>${content}</body></html>`);
              printW.document.close();
              printW.focus();
              setTimeout(()=>printW.print(),300);
            }} style={{flex:2,padding:"10px",borderRadius:8,border:"none",background:"#000",color:"#FFD740",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"inherit",letterSpacing:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>🖨️ GERAR PDF / IMPRIMIR</button>
          </div>

          {/* Conteúdo do recibo (2 vias) */}
          <div id="receipt-pdf-content" style={{padding:"20px 28px"}}>
            {[{via:"1ª VIA — EMPRESA",idx:0},{via:"2ª VIA — COLABORADOR",idx:1}].map(({via,idx})=><div key={idx} style={{border:"1px solid #000",padding:"16px 20px",marginBottom:idx===0?0:0,...(idx===0?{marginBottom:12}:{})}}>
              {/* Linha de corte entre as vias */}
              {idx===1&&<div style={{borderTop:"1.5px dashed #999",margin:"-16px -20px 12px",position:"relative"}}><span style={{position:"absolute",top:-8,left:"50%",transform:"translateX(-50%)",background:"#fff",padding:"0 8px",fontSize:8,color:"#999"}}>✂ recorte aqui</span></div>}

              <div style={{fontSize:9,fontWeight:700,letterSpacing:2,color:"#666",textAlign:"right",marginBottom:8}}>{via}</div>

              {/* Header */}
              <div style={{textAlign:"center",marginBottom:12,paddingBottom:10,borderBottom:"2px solid #000"}}>
                <div style={{fontSize:22,fontWeight:900,letterSpacing:4}}>D'BLACK</div>
                <div style={{fontSize:9,letterSpacing:3,color:"#666",marginTop:2}}>RECIBO DE PAGAMENTO</div>
              </div>

              {/* Info grid */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12,fontSize:10}}>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>COLABORADOR</span><strong style={{fontSize:11}}>{receiptData.empName}</strong></div>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>CPF</span><strong style={{fontSize:11}}>{receiptData.empCpf||"—"}</strong></div>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>CARGO</span><strong style={{fontSize:11}}>{receiptData.empRole}</strong></div>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>LOJA</span><strong style={{fontSize:11}}>{receiptData.storeName}</strong></div>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>MÊS REFERÊNCIA</span><strong style={{fontSize:11}}>{receiptData.month}</strong></div>
                <div><span style={{fontSize:8,color:"#888",display:"block",letterSpacing:1}}>DATA PAGAMENTO</span><strong style={{fontSize:11}}>{fmtDate(receiptData.paidDate)}</strong></div>
              </div>

              {/* Proventos */}
              <div style={{fontSize:9,fontWeight:800,letterSpacing:2,padding:"6px 0",borderTop:"1.5px solid #000",borderBottom:"1px solid #ddd",marginBottom:4}}>PROVENTOS</div>
              <div style={{fontSize:11}}>
                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Salário Base</span><span style={{fontWeight:700}}>{fmt(receiptData.baseSalary)}</span></div>
                {receiptData.metaBonus>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Bônus por Meta</span><span style={{fontWeight:700,color:"#2E7D32"}}>{fmt(receiptData.metaBonus)}</span></div>}
                {receiptData.awards>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Premiações</span><span style={{fontWeight:700,color:"#2E7D32"}}>{fmt(receiptData.awards)}</span></div>}
                {receiptData.overtime>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Horas Extras</span><span style={{fontWeight:700,color:"#2E7D32"}}>{fmt(receiptData.overtime)}</span></div>}
                <div style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",fontWeight:800,fontSize:12,background:"#f5f5f5",borderRadius:3,marginTop:4}}><span>Total Proventos</span><span style={{color:"#2E7D32"}}>{fmt(receiptData.totalEarnings)}</span></div>
              </div>

              {/* Descontos */}
              {receiptData.totalDeductions>0&&<>
                <div style={{fontSize:9,fontWeight:800,letterSpacing:2,padding:"6px 0",borderTop:"1.5px solid #000",borderBottom:"1px solid #ddd",marginTop:10,marginBottom:4}}>DESCONTOS</div>
                <div style={{fontSize:11}}>
                  {receiptData.storeDiscount>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Desconto em Loja</span><span style={{fontWeight:700,color:"#C62828"}}>-{fmt(receiptData.storeDiscount)}</span></div>}
                  {receiptData.advances>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Vale / Adiantamento</span><span style={{fontWeight:700,color:"#C62828"}}>-{fmt(receiptData.advances)}</span></div>}
                  {receiptData.otherDeductions>0&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #eee"}}><span>Outros Descontos</span><span style={{fontWeight:700,color:"#C62828"}}>-{fmt(receiptData.otherDeductions)}</span></div>}
                  <div style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",fontWeight:800,fontSize:12,background:"#fff5f5",borderRadius:3,marginTop:4}}><span>Total Descontos</span><span style={{color:"#C62828"}}>-{fmt(receiptData.totalDeductions)}</span></div>
                </div>
              </>}

              {/* Valor líquido */}
              <div style={{marginTop:14,padding:12,border:"2.5px solid #000",borderRadius:6,textAlign:"center"}}>
                <div style={{fontSize:9,fontWeight:800,letterSpacing:3,color:"#888",marginBottom:2}}>VALOR LÍQUIDO</div>
                <div style={{fontSize:28,fontWeight:900}}>{fmt(receiptData.netPay)}</div>
              </div>

              {receiptData.empPix&&<div style={{marginTop:8,fontSize:10,color:"#666",textAlign:"center"}}>Chave PIX: <strong style={{color:"#000"}}>{receiptData.empPix}</strong></div>}
              {receiptData.notes&&<div style={{marginTop:8,padding:"6px 8px",background:"#f9f9f9",borderRadius:4,fontSize:10}}><span style={{fontSize:8,color:"#888"}}>Observações:</span><div style={{marginTop:2}}>{receiptData.notes}</div></div>}

              {/* Assinaturas */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:30,marginTop:30}}>
                <div style={{textAlign:"center",borderTop:"1px solid #000",paddingTop:4,fontSize:9,color:"#666"}}>Empregador</div>
                <div style={{textAlign:"center",borderTop:"1px solid #000",paddingTop:4,fontSize:9,color:"#666"}}>Colaborador</div>
              </div>

              <div style={{textAlign:"center",marginTop:10,fontSize:8,color:"#aaa"}}>D'Black — Recibo gerado em {fmtDate(receiptData.paidDate)} — ID: {receiptData.id}</div>
            </div>)}
          </div>
        </div>
      </div>}
    </div>
  );
}
function UsersModule({users,setUsers,showToast,loggedUser}){
  const EMPTY={name:"",email:"",password:"",role:"vendedor",store_id:"loja1"};
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [form,setForm]=useState(EMPTY);
  const [confirmDel,setConfirmDel]=useState(null);

  const openNew=()=>{setEditId(null);setForm(EMPTY);setShowForm(true);};
  const openEdit=(u)=>{setEditId(u.id);setForm({name:u.name,email:u.email||"",password:"",role:u.role,store_id:u.store_id||u.storeId||"loja1"});setShowForm(true);};
  const closeForm=()=>{setShowForm(false);setEditId(null);setForm(EMPTY);};

  const saveUser=async()=>{
    if(!form.name)return showToast("Preencha o nome!","error");
    if(!editId&&!form.password)return showToast("Defina uma senha!","error");
    const avatar=form.name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
    try{
      if(editId){
        const payload={name:form.name,email:form.email,role:form.role,store_id:form.store_id,avatar,active:true};
        if(form.password)payload.password=form.password;
        await api.updateUser(editId,payload);
        setUsers(prev=>prev.map(u=>u.id===editId?{...u,...payload,storeId:form.store_id}:u));
        showToast("Usuário atualizado!");
      }else{
        const data=await api.createUser({name:form.name,email:form.email,password:form.password,role:form.role,store_id:form.store_id,avatar});
        setUsers(prev=>[...prev,{...data,storeId:form.store_id}]);
        showToast("Usuário criado!");
      }
      closeForm();
    }catch(e){showToast(e.message||"Erro ao salvar","error");}
  };

  const toggleUser=async(u)=>{
    try{
      await api.updateUser(u.id,{name:u.name,email:u.email||"",role:u.role,store_id:u.store_id||u.storeId,avatar:u.avatar,active:!u.active});
      setUsers(prev=>prev.map(x=>x.id===u.id?{...x,active:!x.active}:x));
    }catch(e){showToast(e.message||"Erro","error");}
  };

  const deleteUser=async(id)=>{
    try{
      await api.deleteUser(id);
      setUsers(prev=>prev.filter(u=>u.id!==id));
      setConfirmDel(null);
      showToast("Usuário excluído!");
    }catch(e){showToast(e.message||"Erro ao excluir","error");}
  };

  return(
    <div>
      <div style={S.toolbar}><h3 style={{margin:0,fontSize:16}}>Gestão de Usuários</h3><div style={{flex:1}}/><button style={S.primBtn} onClick={openNew}>{I.plus} Novo Usuário</button></div>

      {showForm&&<div style={S.formCard}><h3 style={S.formTitle}>{editId?"Editar Usuário":"Novo Usuário"}</h3><div style={S.formGrid}>
        <input style={S.inp} placeholder="Nome completo" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
        <input style={S.inp} placeholder="E-mail" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/>
        <input style={S.inp} type="password" placeholder={editId?"Nova senha (deixe em branco para não alterar)":"Senha"} value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/>
        <select style={S.sel} value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))}>
          {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        <select style={S.sel} value={form.store_id} onChange={e=>setForm(f=>({...f,store_id:e.target.value}))}>
          <option value="all">Todas as lojas</option>
          {STORES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div><div style={S.formAct}><button style={S.secBtn} onClick={closeForm}>Cancelar</button><button style={S.primBtn} onClick={saveUser}>{editId?"Salvar":"Criar"}</button></div></div>}

      {confirmDel&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999}}>
        <div style={{background:C.card,borderRadius:12,padding:28,width:320,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
          <div style={{fontWeight:700,fontSize:16,marginBottom:8}}>Excluir usuário?</div>
          <div style={{color:C.dim,fontSize:13,marginBottom:20}}>"{confirmDel.name}" será removido permanentemente.</div>
          <div style={{display:"flex",gap:8}}>
            <button style={{...S.secBtn,flex:1}} onClick={()=>setConfirmDel(null)}>Cancelar</button>
            <button style={{...S.primBtn,flex:1,background:C.red,borderColor:C.red}} onClick={()=>deleteUser(confirmDel.id)}>Excluir</button>
          </div>
        </div>
      </div>}

      <div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}></th><th style={S.th}>Nome</th><th style={S.th}>E-mail</th><th style={S.th}>Cargo</th><th style={S.th}>Loja</th><th style={S.th}>Status</th><th style={S.th}>Ações</th></tr></thead>
      <tbody>{users.map(u=><tr key={u.id} style={{...S.tr,...(!u.active?{opacity:.4}:{})}}>
        <td style={S.td}><div style={S.avatar}>{u.avatar}</div></td>
        <td style={{...S.td,fontWeight:600}}>{u.name}</td>
        <td style={{...S.td,fontSize:12}}>{u.email}</td>
        <td style={S.td}><span style={S.payBadge}>{ROLES[u.role]?.label||u.role}</span></td>
        <td style={S.td}>{(u.store_id||u.storeId)==="all"?"Todas":STORES.find(s=>s.id===(u.store_id||u.storeId))?.name||(u.store_id||u.storeId)}</td>
        <td style={S.td}><span style={{...S.stBadge,...(u.active?S.stOk:S.stLow)}}>{u.active?"Ativo":"Inativo"}</span></td>
        <td style={S.td}><div style={{display:"flex",gap:4}}>
          <button style={S.smBtn} onClick={()=>openEdit(u)}>✏️ Editar</button>
          <button style={S.smBtn} onClick={()=>toggleUser(u)}>{u.active?"Desativar":"Ativar"}</button>
          {u.id!==loggedUser?.id&&<button style={{...S.smBtn,color:C.red,borderColor:C.red}} onClick={()=>setConfirmDel(u)}>🗑️</button>}
        </div></td>
      </tr>)}</tbody></table></div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  CRM MODULE                 ═══
// ═══════════════════════════════════
function CRMModule({customers,setCustomers,storeSales,showToast}){
  const [search,setSearch]=useState("");const [sel,setSel]=useState(null);const [showForm,setShowForm]=useState(false);
  const [nc,setNc]=useState({name:"",phone:"",email:"",cpf:"",birthdate:"",notes:"",whatsapp:""});
  const filtered=customers.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())||c.phone.includes(search));
  const addC=()=>{
    if(!nc.name||!nc.phone)return showToast("Preencha nome e telefone!","error");
    const newC={...nc,id:genId(),totalSpent:0,visits:0,lastVisit:"-",tags:["Novo"],points:0};
    setCustomers(prev=>[...prev,newC]);
    api.createCustomer(custToApi(newC)).catch(console.error);
    setNc({name:"",phone:"",email:"",cpf:"",birthdate:"",notes:"",whatsapp:""});
    setShowForm(false);
    showToast("Cliente cadastrado!");
  };
  const custSales=sel?storeSales.filter(s=>s.customerId===sel.id):[];
  return(
    <div>
      <div style={S.toolbar}><div style={S.searchBar}>{I.search}<input style={S.searchIn} placeholder="Buscar cliente..." value={search} onChange={e=>setSearch(e.target.value)}/></div><button style={S.primBtn} onClick={()=>setShowForm(!showForm)}>{I.plus} Novo</button></div>
      {showForm&&<div style={S.formCard}><h3 style={S.formTitle}>Novo Cliente</h3><div style={S.formGrid}><input style={S.inp} placeholder="Nome" value={nc.name} onChange={e=>setNc(c=>({...c,name:e.target.value}))}/><input style={S.inp} placeholder="Telefone" value={nc.phone} onChange={e=>setNc(c=>({...c,phone:e.target.value}))}/><input style={S.inp} placeholder="WhatsApp" value={nc.whatsapp} onChange={e=>setNc(c=>({...c,whatsapp:e.target.value}))}/><input style={S.inp} placeholder="E-mail" value={nc.email} onChange={e=>setNc(c=>({...c,email:e.target.value}))}/><input style={S.inp} placeholder="CPF" value={nc.cpf} onChange={e=>setNc(c=>({...c,cpf:e.target.value}))}/><input style={S.inp} type="date" value={nc.birthdate} onChange={e=>setNc(c=>({...c,birthdate:e.target.value}))}/></div><div style={S.formAct}><button style={S.secBtn} onClick={()=>setShowForm(false)}>Cancelar</button><button style={S.primBtn} onClick={addC}>Salvar</button></div></div>}
      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
        <div style={{width:300,maxWidth:"100%",display:"flex",flexDirection:"column",gap:6}}>{filtered.map(c=><button key={c.id} style={{...S.crmCard,...(sel?.id===c.id?{borderColor:C.gold,background:"rgba(255,215,64,.04)"}:{})}} onClick={()=>setSel(c)}><div style={S.avatar}>{c.name.charAt(0)}</div><div style={{flex:1,overflow:"hidden"}}><div style={{fontWeight:700,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:C.dim}}>{c.phone}</div><div style={{display:"flex",gap:3,marginTop:3,flexWrap:"wrap"}}>{c.tags.map(t=><span key={t} style={S.tag}>{t}</span>)}</div></div><div style={{textAlign:"right"}}><div style={{fontWeight:700,color:C.grn,fontSize:12}}>{fmt(c.totalSpent)}</div><div style={{fontSize:10,color:C.gold}}>{c.points}pts</div></div></button>)}</div>
        {sel?<div style={{flex:1,minWidth:280,...S.card,animation:"fadeIn .3s ease"}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,paddingBottom:14,borderBottom:`1px solid ${C.brd}`}}><div style={{...S.avatar,width:50,height:50,fontSize:20}}>{sel.name.charAt(0)}</div><div><h3 style={{margin:0,fontSize:18,fontWeight:800}}>{sel.name}</h3><div style={{display:"flex",gap:4,marginTop:4}}>{sel.tags.map(t=><span key={t} style={S.tag}>{t}</span>)}</div></div></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:14}}><div><span style={{fontSize:10,color:C.dim}}>Telefone</span><div>{sel.phone}</div></div><div><span style={{fontSize:10,color:C.dim}}>E-mail</span><div>{sel.email||"-"}</div></div><div><span style={{fontSize:10,color:C.dim}}>CPF</span><div>{sel.cpf||"-"}</div></div><div><span style={{fontSize:10,color:C.dim}}>Total Gasto</span><div style={{color:C.grn,fontWeight:700}}>{fmt(sel.totalSpent)}</div></div><div><span style={{fontSize:10,color:C.dim}}>Pontos</span><div style={{color:C.gold,fontWeight:700}}>{sel.points}</div></div><div><span style={{fontSize:10,color:C.dim}}>Visitas</span><div>{sel.visits}</div></div></div>
          {sel.whatsapp&&<a href={"https://wa.me/"+sel.whatsapp} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px",borderRadius:8,background:"#25D366",color:"#fff",fontSize:12,fontWeight:700,marginBottom:10,textDecoration:"none"}}>WhatsApp</a>}
          <h4 style={{fontSize:13,color:C.dim,marginBottom:8}}>Compras nesta loja</h4>
          {custSales.length===0?<div style={{fontSize:12,color:C.dim}}>Nenhuma</div>:<div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Data</th><th style={S.th}>Itens</th><th style={S.th}>Total</th></tr></thead><tbody>{custSales.map(s=><tr key={s.id} style={S.tr}><td style={S.td}>{fmtDate(s.date)}</td><td style={{...S.td,fontSize:11}}>{s.items.map(i=>i.qty+"x "+i.name).join(", ")}</td><td style={{...S.td,...S.tdM}}>{fmt(s.total)}</td></tr>)}</tbody></table></div>}
        </div>:<div style={{flex:1,minWidth:280,...S.card,display:"flex",alignItems:"center",justifyContent:"center",minHeight:250,color:C.dim}}>👤 Selecione um cliente</div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  FINANCEIRO MODULE          ═══
// ═══════════════════════════════════
function FinanceiroModule({storeSales,storeProducts,storeExpenses,storeSellers,totalRev,currentStore}){
  const totalCost=storeSales.reduce((s,sale)=>s+sale.items.reduce((si,it)=>{const p=storeProducts.find(pr=>pr.id===it.id)||storeProducts.find(pr=>pr.name===it.name);return si+(p?p.cost*it.qty:0);},0),0);
  const profit=totalRev-totalCost;const margin=totalRev>0?profit/totalRev*100:0;
  const totalComm=storeSellers.reduce((s,sl)=>s+sl.totalSold*sl.commission/100,0);
  const totalExp=storeExpenses.reduce((s,e)=>s+e.value,0);
  const totalDisc=storeSales.reduce((s,v)=>s+v.discount,0);
  const net=profit-totalComm-totalExp;
  const payBreak={};storeSales.forEach(s=>{payBreak[s.payment]=(payBreak[s.payment]||0)+s.total;});
  return(
    <div>
      <div style={S.kpiRow}><KPI icon={I.money} label="Receita Bruta" value={fmt(totalRev)} sub={currentStore.name} color={C.gold}/><KPI icon={I.chart} label="CMV" value={fmt(totalCost)} sub="Custo" color={C.red}/><KPI icon={I.check} label="Lucro Bruto" value={fmt(profit)} sub={"Margem: "+pct(margin)} color={C.grn}/><KPI icon={I.award} label="Comissões" value={fmt(totalComm)} sub="Vendedores" color={C.pur}/></div>
      <div style={S.kpiRow}><KPI icon={I.money} label="Despesas" value={fmt(totalExp)} sub="Loja" color={C.red}/><KPI icon={I.alert} label="Descontos" value={fmt(totalDisc)} sub="Concedidos" color={C.org}/><KPI icon={I.chart} label="Resultado Líquido" value={fmt(net)} sub="Final" color={net>=0?C.grn:C.red}/></div>
      <div style={S.card}><h3 style={S.cardTitle}>Receita por Pagamento</h3>{Object.entries(payBreak).sort((a,b)=>b[1]-a[1]).map(([p,v])=><div key={p} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><span style={{width:90,fontSize:12,fontWeight:500}}>{p}</span><div style={{flex:1,height:20,background:C.s2,borderRadius:10,overflow:"hidden"}}><div style={{height:"100%",borderRadius:10,background:`linear-gradient(90deg,${C.gold},${C.grn})`,width:(totalRev>0?v/totalRev*100:0)+"%",minWidth:3}}/></div><span style={{fontSize:12,fontWeight:700,color:C.grn,minWidth:85,textAlign:"right",fontFamily:"monospace"}}>{fmt(v)}</span></div>)}</div>
      <div style={S.card}><h3 style={S.cardTitle}>Vendas</h3><div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Data</th><th style={S.th}>Cliente</th><th style={S.th}>Vendedor</th><th style={S.th}>Total</th><th style={S.th}>Pgto</th></tr></thead><tbody>{storeSales.map(s=><tr key={s.id} style={S.tr}><td style={S.td}>{fmtDate(s.date)}</td><td style={{...S.td,fontWeight:600}}>{s.customer}</td><td style={S.td}>{s.seller}</td><td style={{...S.td,...S.tdM}}>{fmt(s.total)}</td><td style={S.td}><span style={S.payBadge}>{s.payment}</span></td></tr>)}</tbody></table></div></div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  COMISSÕES MODULE           ═══
// ═══════════════════════════════════
function ComissoesModule({storeSellers,sellers,setSellers,storeSales,showToast}){
  const [editId,setEditId]=useState(null);const [editVal,setEditVal]=useState("");
  const saveComm=(id)=>{
    setSellers(prev=>prev.map(s=>s.id===id?{...s,commission:+editVal}:s));
    api.updateSeller(id,{commission:+editVal}).catch(console.error);
    setEditId(null);
    showToast("Comissão atualizada!");
  };
  return(
    <div>
      <div style={S.kpiRow}>{storeSellers.map(s=><KPI key={s.id} icon={I.award} label={s.name} value={fmt(s.totalSold*s.commission/100)} sub={pct(s.commission)+" de "+fmt(s.totalSold)} color={C.gold}/>)}</div>
      <div style={S.card}><h3 style={S.cardTitle}>Vendedores desta Loja</h3><div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Vendedor</th><th style={S.th}>Vendas</th><th style={S.th}>Total Vendido</th><th style={S.th}>Comissão %</th><th style={S.th}>Valor</th><th style={S.th}>Ação</th></tr></thead>
      <tbody>{storeSellers.map(s=><tr key={s.id} style={S.tr}><td style={{...S.td,fontWeight:600}}><div style={{display:"flex",alignItems:"center",gap:8}}><div style={{...S.avatar,width:30,height:30,fontSize:11}}>{s.avatar}</div>{s.name}</div></td><td style={S.td}>{s.salesCount}</td><td style={{...S.td,...S.tdM}}>{fmt(s.totalSold)}</td><td style={S.td}>{editId===s.id?<input style={{...S.inp,width:55,textAlign:"center"}} type="number" value={editVal} onChange={e=>setEditVal(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&saveComm(s.id)}/>:<span style={{color:C.gold,fontWeight:700}}>{pct(s.commission)}</span>}</td><td style={{...S.td,fontWeight:700,color:C.grn}}>{fmt(s.totalSold*s.commission/100)}</td><td style={S.td}>{editId===s.id?<button style={S.smBtn} onClick={()=>saveComm(s.id)}>Salvar</button>:<button style={S.smBtn} onClick={()=>{setEditId(s.id);setEditVal(s.commission);}}>Editar</button>}</td></tr>)}</tbody></table></div></div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  TROCAS MODULE (fluxo cupom)═══
// ═══════════════════════════════════
function TrocasModule({storeExchanges,exchanges,setExchanges,storeSales,storeProducts,activeStore,stock,setStock,showToast,activeStockId,cashState,setCashState,loggedUser}){
  const [step,setStep]=useState(0);
  const [cupomInput,setCupomInput]=useState("");
  const [foundSale,setFoundSale]=useState(null);
  // returnItems = [{id, name, price, qty, maxQty}]
  const [returnItems,setReturnItems]=useState([]);
  // newItems = [{id, name, price, img, qty}]
  const [newItems,setNewItems]=useState([]);
  const [reason,setReason]=useState("");
  const [newSearch,setNewSearch]=useState("");
  const [payMethod,setPayMethod]=useState("PIX");
  const [cashRecTroca,setCashRecTroca]=useState("");
  // Split de pagamento (2 formas)
  const [splitMode,setSplitMode]=useState(false);
  const [pay1,setPay1]=useState({method:"PIX",value:""});
  const [pay2,setPay2]=useState({method:"Dinheiro",value:""});
  const [cashRecSplit,setCashRecSplit]=useState("");
  // Cupom de troca
  const [receiptExchange,setReceiptExchange]=useState(null);
  // Filtro relatório de trocas
  const todayStr=new Date().toISOString().split("T")[0];
  const [exchFilterFrom,setExchFilterFrom]=useState(todayStr);
  const [exchFilterTo,setExchFilterTo]=useState(todayStr);

  const searchCupom=()=>{
    const q=cupomInput.trim().toUpperCase();
    if(!q)return showToast("Digite o cupom!","error");
    const sale=storeSales.find(s=>(s.cupom||"").toUpperCase().includes(q));
    if(!sale)return showToast("Cupom não encontrado!","error");
    setFoundSale(sale);
    setReturnItems([]);
    setNewItems([]);
    setStep(1);
  };

  // Toggle item de devolução (adiciona/remove da lista)
  const toggleReturnItem=(item)=>{
    setReturnItems(prev=>{
      const exists=prev.find(r=>r.id===item.id);
      if(exists) return prev.filter(r=>r.id!==item.id);
      return [...prev,{...item,qty:1,maxQty:item.qty}];
    });
  };
  const setReturnQty=(id,qty)=>{
    setReturnItems(prev=>prev.map(r=>r.id===id?{...r,qty:Math.max(1,Math.min(qty,r.maxQty))}:r));
  };

  // Adicionar/remover produto novo
  const addNewItem=(prod)=>{
    setNewItems(prev=>{
      const exists=prev.find(n=>n.id===prod.id);
      if(exists) return prev.map(n=>n.id===prod.id?{...n,qty:n.qty+1}:n);
      return [...prev,{...prod,qty:1}];
    });
  };
  const removeNewItem=(id)=>setNewItems(prev=>prev.filter(n=>n.id!==id));
  const setNewQty=(id,qty)=>{
    setNewItems(prev=>prev.map(n=>n.id===id?{...n,qty:Math.max(1,qty)}:n));
  };

  const returnValue=returnItems.reduce((s,r)=>s+r.price*r.qty,0);
  const newValue=newItems.reduce((s,n)=>s+n.price*n.qty,0);
  const diff=newValue-returnValue;

  const resetFlow=()=>{setStep(0);setCupomInput("");setFoundSale(null);setReturnItems([]);setNewItems([]);setReason("");setNewSearch("");setPayMethod("PIX");setCashRecTroca("");setSplitMode(false);setPay1({method:"PIX",value:""});setPay2({method:"Dinheiro",value:""});setCashRecSplit("");};

  const finalize=()=>{
    if(returnItems.length===0)return showToast("Selecione ao menos uma peça para devolver","error");
    const hasNew=newItems.length>0;
    if(diff>0&&!splitMode&&!payMethod)return showToast("Selecione a forma de pagamento!","error");
    if(diff>0&&splitMode){
      const v1=+pay1.value||0;const v2=+pay2.value||0;
      if(!pay1.method||!pay2.method)return showToast("Selecione as duas formas de pagamento!","error");
      const soma=Math.round((v1+v2)*100);const diffCent=Math.round(diff*100);
      if(soma<diffCent)return showToast("A soma dos valores ("+fmt(v1+v2)+") é menor que a diferença ("+fmt(diff)+")","error");
    }
    let trocoTroca=0;let paymentField=null;let paymentsArr=null;
    if(diff>0){
      if(splitMode){
        const v1=+pay1.value||0;const v2=+pay2.value||0;
        const hasCash=pay1.method==="Dinheiro"||pay2.method==="Dinheiro";
        trocoTroca=hasCash&&cashRecSplit?Math.max(0,+cashRecSplit-(pay1.method==="Dinheiro"?v1:v2)):0;
        if(Math.round((v1+v2)*100)>Math.round(diff*100)&&!hasCash){
          // Se não tem dinheiro mas a soma excede, ajusta o segundo valor
          const adjusted=Math.round(diff*100-Math.round(v1*100))/100;
          paymentsArr=[{method:pay1.method,value:v1},{method:pay2.method,value:Math.max(0,adjusted)}];
        } else {
          paymentsArr=[{method:pay1.method,value:v1,change:pay1.method==="Dinheiro"?trocoTroca:0},{method:pay2.method,value:v2,change:pay2.method==="Dinheiro"?trocoTroca:0}];
        }
        paymentField=pay1.method+"/"+pay2.method;
      } else {
        trocoTroca=payMethod==="Dinheiro"&&cashRecTroca?Math.max(0,+cashRecTroca-diff):0;
        paymentField=payMethod;
      }
    }
    const ex={
      id:genId(),date:todayStr,customer:foundSale.customer,
      type:hasNew?"Troca":"Devolução",reason:reason||"-",
      items:returnItems.map(r=>({name:r.name,qty:r.qty,price:r.price,id:r.id})),
      newItems:newItems.map(n=>({name:n.name,qty:n.qty,price:n.price,id:n.id})),
      difference:diff,payment:paymentField,payments:paymentsArr,change:trocoTroca||null,
      cupomOriginal:foundSale.cupom,status:"Concluída"
    };
    setExchanges(prev=>{const n={...prev};n[activeStore]=[ex,...(n[activeStore]||[])];return n;});
    // Salva a troca no banco de dados via API
    api.createExchange({ ...ex, store_id: activeStore, cupom_original: ex.cupomOriginal, new_items: ex.newItems }).catch(console.error);
    // Registra a diferença paga no caixa (backend + local)
    if(diff>0){
      const cashKey=activeStore+"_"+(loggedUser?.id||"main");
      if(splitMode&&paymentsArr){
        paymentsArr.forEach(p=>{
          if(p.value>0){
            api.cashAction(activeStore,{action:"movement",type:"entrada",value:p.value,description:"Diferença troca ("+p.method+") - "+foundSale.cupom}).catch(console.error);
            setCashState(prev=>{const n={...prev};const cs=n[cashKey]||{open:false,initial:0,history:[]};if(cs.open){n[cashKey]={...cs,history:[...cs.history,{type:"entrada",value:p.value,desc:"Troca ("+p.method+") "+foundSale.cupom,time:new Date().toLocaleTimeString("pt-BR")}]};}return n;});
          }
        });
      } else {
        api.cashAction(activeStore,{action:"movement",type:"entrada",value:diff,description:"Diferença troca ("+paymentField+") - "+foundSale.cupom}).catch(console.error);
        setCashState(prev=>{const n={...prev};const cs=n[cashKey]||{open:false,initial:0,history:[]};if(cs.open){n[cashKey]={...cs,history:[...cs.history,{type:"entrada",value:diff,desc:"Troca ("+paymentField+") "+foundSale.cupom,time:new Date().toLocaleTimeString("pt-BR")}]};}return n;});
      }
    }
    setStock(prev=>{
      const n={...prev};const st={...(n[activeStockId]||{})};
      returnItems.forEach(r=>{st[r.id]=(st[r.id]||0)+r.qty;});
      newItems.forEach(ni=>{st[ni.id]=Math.max(0,(st[ni.id]||0)-ni.qty);});
      n[activeStockId]=st;return n;
    });
    setReceiptExchange({...ex,storeId:activeStore});
    resetFlow();
  };

  const [cancelingExchId,setCancelingExchId]=useState(null);
  const cancelExchange=(ex)=>{
    if(cancelingExchId)return; // Evita cliques múltiplos
    if(ex.status==="Cancelada")return;
    if(!confirm("Cancelar esta troca?\n\nIsso vai reverter o estoque e estornar o valor do caixa."))return;
    setCancelingExchId(ex.id);
    // Reverte estoque: peças devolvidas saem, peças levadas voltam
    setStock(prev=>{
      const n={...prev};const st={...(n[activeStockId]||{})};
      ex.items.forEach(r=>{st[r.id]=Math.max(0,(st[r.id]||0)-r.qty);});
      (ex.newItems||[]).forEach(ni=>{st[ni.id]=(st[ni.id]||0)+ni.qty;});
      n[activeStockId]=st;return n;
    });
    // Estorna o valor da diferença no caixa (backend + local)
    if(ex.difference>0){
      const cupomRef=ex.cupomOriginal||ex.cupom_original||"";
      api.cashAction(activeStore,{action:"movement",type:"saida",value:ex.difference,description:"Estorno troca cancelada - "+cupomRef}).catch(console.error);
      const cashKey=activeStore+"_"+(loggedUser?.id||"main");
      setCashState(prev=>{const n={...prev};const cs=n[cashKey]||{open:false,initial:0,history:[]};if(cs.open){n[cashKey]={...cs,history:[...cs.history,{type:"saida",value:ex.difference,desc:"Estorno troca "+cupomRef,time:new Date().toLocaleTimeString("pt-BR")}]};}return n;});
    }
    // Atualiza status para Cancelada
    setExchanges(prev=>{
      const n={...prev};
      n[activeStore]=(n[activeStore]||[]).map(e=>e.id===ex.id?{...e,status:"Cancelada"}:e);
      return n;
    });
    api.cancelExchange(ex.id).catch(console.error);
    setCancelingExchId(null);
    showToast("Troca cancelada e estoque revertido!");
  };

  const filteredNew=storeProducts.filter(p=>
    !newSearch
      ? p.stock>0
      : p.name.toLowerCase().includes(newSearch.toLowerCase())||
        (p.sku||"").toLowerCase().includes(newSearch.toLowerCase())||
        (p.ean||"").includes(newSearch)
  );
  const steps=["Bipar Cupom","Devolver","Novo Item","Finalizar"];

  return(
    <div>
      {step>0&&<div style={{display:"flex",alignItems:"center",gap:4,marginBottom:16,padding:"12px 16px",background:C.s1,borderRadius:12,border:`1px solid ${C.brd}`}}>
        {steps.map((s,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:4,flex:i<3?1:"none"}}>
          <div style={{width:28,height:28,borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800,background:i<step?C.gold+"22":i===step?C.gold:C.s2,color:i===step?C.bg:i<step?C.gold:C.dim,border:`2px solid ${i<=step?C.gold:C.brd}`}}>{i<step?"✓":i+1}</div>
          <span style={{fontSize:11,fontWeight:i===step?700:400,color:i<=step?C.txt:C.dim}}>{s}</span>
          {i<3&&<div style={{flex:1,height:2,background:i<step?C.gold:C.brd,margin:"0 6px"}}/>}
        </div>)}
        <button style={{...S.smBtn,color:C.red}} onClick={resetFlow}>Cancelar</button>
      </div>}

      {/* ── STEP 0: Buscar cupom ── */}
      {step===0&&<div>
        <div style={{...S.card,textAlign:"center",padding:28}}>
          <div style={{fontSize:40,marginBottom:8}}>🔍</div>
          <h3 style={{fontSize:18,fontWeight:800,marginBottom:16}}>Troca ou Devolução</h3>
          <div style={{display:"flex",gap:8,maxWidth:400,margin:"0 auto"}}>
            <input style={{...S.inp,flex:1,fontSize:16,textAlign:"center",letterSpacing:2,fontFamily:"monospace",textTransform:"uppercase"}} placeholder="CNF-000124" value={cupomInput} onChange={e=>setCupomInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&searchCupom()} autoFocus/>
            <button style={S.primBtn} onClick={searchCupom}>{I.search} Buscar</button>
          </div>
        </div>
        {/* ── RELATÓRIO DE TROCAS ── */}
        {(()=>{
          const [exchDateFrom,setExchDateFrom]=[exchFilterFrom,setExchFilterFrom];
          const [exchDateTo,setExchDateTo]=[exchFilterTo,setExchFilterTo];
          const filteredExch=storeExchanges.filter(e=>e.date>=exchDateFrom&&e.date<=exchDateTo);
          const ativasExch=filteredExch.filter(e=>e.status!=="Cancelada");
          const canceladasExch=filteredExch.filter(e=>e.status==="Cancelada");
          const totalTrocas=ativasExch.filter(e=>e.type==="Troca").length;
          const totalDev=ativasExch.filter(e=>e.type!=="Troca").length;
          const totalDiff=ativasExch.reduce((s,e)=>s+(e.difference||0),0);
          const isMulti=exchDateFrom!==exchDateTo;

          return <div style={S.card}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:14}}>
              <h3 style={{...S.cardTitle,margin:0}}>📋 Relatório de Trocas/Devoluções</h3>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <input type="date" value={exchDateFrom} onChange={e=>{setExchDateFrom(e.target.value);if(e.target.value>exchDateTo)setExchDateTo(e.target.value);}} style={{...S.inp,padding:"6px 10px",fontSize:12,width:"auto"}}/>
                <span style={{color:C.dim,fontSize:11}}>até</span>
                <input type="date" value={exchDateTo} onChange={e=>setExchDateTo(e.target.value)} min={exchDateFrom} style={{...S.inp,padding:"6px 10px",fontSize:12,width:"auto"}}/>
                <button style={{...S.secBtn,fontSize:10,padding:"5px 10px"}} onClick={()=>{setExchDateFrom(todayStr);setExchDateTo(todayStr);}}>Hoje</button>
              </div>
            </div>

            {/* KPIs */}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:14}}>
              <div style={{background:"rgba(0,230,118,.06)",border:"1px solid rgba(0,230,118,.2)",borderRadius:10,padding:"10px 16px",textAlign:"center",minWidth:100}}>
                <div style={{fontSize:20,fontWeight:800,color:C.grn}}>{totalTrocas}</div>
                <div style={{fontSize:10,color:C.dim}}>Trocas</div>
              </div>
              <div style={{background:"rgba(255,82,82,.06)",border:"1px solid rgba(255,82,82,.2)",borderRadius:10,padding:"10px 16px",textAlign:"center",minWidth:100}}>
                <div style={{fontSize:20,fontWeight:800,color:C.red}}>{totalDev}</div>
                <div style={{fontSize:10,color:C.dim}}>Devoluções</div>
              </div>
              <div style={{background:"rgba(255,152,0,.06)",border:"1px solid rgba(255,152,0,.2)",borderRadius:10,padding:"10px 16px",textAlign:"center",minWidth:100}}>
                <div style={{fontSize:20,fontWeight:800,color:totalDiff>0?C.org:totalDiff<0?C.grn:C.dim}}>{totalDiff>0?"+"+fmt(totalDiff):totalDiff<0?"-"+fmt(Math.abs(totalDiff)):"R$ 0"}</div>
                <div style={{fontSize:10,color:C.dim}}>Diferença</div>
              </div>
              <div style={{background:"rgba(255,215,64,.06)",border:"1px solid rgba(255,215,64,.2)",borderRadius:10,padding:"10px 16px",textAlign:"center",minWidth:100}}>
                <div style={{fontSize:20,fontWeight:800,color:C.gold}}>{filteredExch.length}</div>
                <div style={{fontSize:10,color:C.dim}}>Total {isMulti?"período":"dia"}</div>
              </div>
              {canceladasExch.length>0&&<div style={{background:"rgba(255,82,82,.06)",border:"1px solid rgba(255,82,82,.2)",borderRadius:10,padding:"10px 16px",textAlign:"center",minWidth:100}}>
                <div style={{fontSize:20,fontWeight:800,color:C.red}}>{canceladasExch.length}</div>
                <div style={{fontSize:10,color:C.dim}}>Canceladas</div>
              </div>}
            </div>

            {/* Tabela */}
            {filteredExch.length===0
              ?<div style={{textAlign:"center",padding:20,color:C.dim,opacity:.5}}>Nenhuma troca/devolução {isMulti?"no período":"nesta data"}</div>
              :<div style={S.tWrap}><table style={S.table}><thead><tr>
                <th style={S.th}>Data</th><th style={S.th}>Cliente</th><th style={S.th}>Tipo</th><th style={S.th}>Devolveu</th><th style={S.th}>Levou</th><th style={S.th}>Dif.</th><th style={S.th}>Cupom Orig.</th><th style={S.th}>Status</th><th style={S.th}>Ação</th>
              </tr></thead><tbody>{filteredExch.map(e=><tr key={e.id} style={{...S.tr,opacity:e.status==="Cancelada"?.5:1}}>
                <td style={S.td}>{fmtDate(e.date)}</td>
                <td style={{...S.td,fontWeight:600}}>{e.customer}</td>
                <td style={S.td}><span style={{...S.stBadge,...(e.type==="Troca"?S.stOk:S.stLow)}}>{e.type}</span></td>
                <td style={{...S.td,fontSize:11}}>{(e.items||[]).map(i=>i.qty+"x "+i.name).join(", ")}</td>
                <td style={{...S.td,fontSize:11}}>{e.newItems?.length>0?e.newItems.map(i=>i.qty+"x "+i.name).join(", "):"-"}</td>
                <td style={{...S.td,fontWeight:700,color:e.difference>0?C.org:e.difference<0?C.grn:C.dim}}>{e.difference>0?"+"+fmt(e.difference):e.difference<0?fmt(Math.abs(e.difference)):"R$ 0"}</td>
                <td style={{...S.td,fontFamily:"monospace",fontSize:10,color:C.gold}}>{e.cupomOriginal||e.cupom_original||"-"}</td>
                <td style={S.td}><span style={{...S.stBadge,...(e.status==="Cancelada"?{background:"rgba(255,82,82,.15)",color:"#ff5252"}:S.stOk)}}>{e.status||"Concluída"}</span></td>
                <td style={S.td}>{e.status!=="Cancelada"&&<button onClick={()=>cancelExchange(e)} style={{padding:"4px 10px",borderRadius:6,border:"1px solid rgba(255,82,82,.4)",background:"rgba(255,82,82,.1)",color:"#ff5252",fontWeight:700,cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>Cancelar</button>}</td>
              </tr>)}</tbody></table></div>
            }
          </div>;
        })()}
      </div>}

      {/* ── STEP 1: Selecionar peças a devolver (múltiplas) ── */}
      {step===1&&foundSale&&<div>
        <div style={S.card}>
          <div style={{marginBottom:12,fontSize:13,color:C.dim}}>Cupom: <strong style={{color:C.gold}}>{foundSale.cupom}</strong> • {foundSale.customer}</div>
          <h3 style={{fontSize:15,fontWeight:700,marginBottom:4}}>Selecione as peças a devolver</h3>
          <div style={{fontSize:11,color:C.dim,marginBottom:12}}>Pode selecionar mais de uma peça</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
            {foundSale.items.map((item,idx)=>{
              const sel=returnItems.find(r=>r.id===item.id);
              const prod=storeProducts.find(p=>p.id===item.id||p.name===item.name);
              return <div key={idx} onClick={()=>toggleReturnItem(item)} style={{background:sel?"rgba(255,82,82,.08)":C.s2,border:`2px solid ${sel?"rgba(255,82,82,.5)":C.brd}`,borderRadius:12,padding:16,cursor:"pointer",color:C.txt,display:"flex",alignItems:"center",gap:12,transition:"all .15s"}}>
                <div style={{fontSize:30}}>{prod?.img||"📦"}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700}}>{item.name}</div>
                  <div style={{fontSize:12,color:C.dim}}>{item.qty}x • {fmt(item.price)} cada</div>
                  {sel&&<div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}} onClick={e=>e.stopPropagation()}>
                    <button style={S.qBtn} onClick={()=>setReturnQty(item.id,sel.qty-1)}>{I.minus}</button>
                    <span style={{fontWeight:800,minWidth:20,textAlign:"center"}}>{sel.qty}</span>
                    <button style={S.qBtn} onClick={()=>setReturnQty(item.id,sel.qty+1)}>{I.plus}</button>
                    <span style={{fontSize:10,color:C.dim}}>de {item.qty}</span>
                  </div>}
                </div>
                <div style={{fontSize:20}}>{sel?"✅":""}</div>
              </div>;
            })}
          </div>
        </div>
        {returnItems.length>0&&<div style={{...S.card,background:"rgba(255,82,82,.04)",borderColor:"rgba(255,82,82,.2)"}}>
          <div style={{fontWeight:700,fontSize:13,color:C.red,marginBottom:8}}>Crédito de devolução: {fmt(returnValue)}</div>
          <input style={{...S.inp,width:"100%",marginBottom:10}} placeholder="Motivo da troca (opcional)..." value={reason} onChange={e=>setReason(e.target.value)}/>
          <div style={{display:"flex",gap:8}}>
            <button style={{...S.secBtn,flex:1}} onClick={()=>{setNewItems([]);finalize();}}>💰 Só Devolver ({fmt(returnValue)})</button>
            <button style={{...S.primBtn,flex:2}} onClick={()=>setStep(2)}>Escolher novo item →</button>
          </div>
        </div>}
      </div>}

      {/* ── STEP 2: Selecionar novos produtos (múltiplos) ── */}
      {step===2&&<div>
        <div style={{...S.card,background:"rgba(255,82,82,.03)",borderColor:"rgba(255,82,82,.2)",marginBottom:10}}>
          <div style={{fontSize:11,color:C.red,fontWeight:700,letterSpacing:2,marginBottom:4}}>DEVOLVENDO</div>
          {returnItems.map((r,i)=><div key={i} style={{fontSize:13,padding:"2px 0"}}>{r.qty}x {r.name} <span style={{color:C.red,fontWeight:700}}>-{fmt(r.price*r.qty)}</span></div>)}
        </div>
        <div style={S.card}>
          <h3 style={{fontSize:14,fontWeight:700,marginBottom:4}}>Selecione os novos itens</h3>
          <div style={{fontSize:11,color:C.dim,marginBottom:10}}>Pode adicionar mais de um produto</div>
          {newItems.length>0&&<div style={{marginBottom:10}}>
            {newItems.map((n,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:`1px solid ${C.brd}`}}>
              <span style={{fontSize:18}}>{n.img||"📦"}</span>
              <span style={{flex:1,fontSize:12,fontWeight:600}}>{n.name}</span>
              <button style={S.qBtn} onClick={()=>setNewQty(n.id,n.qty-1)}>{I.minus}</button>
              <span style={{fontWeight:800,minWidth:20,textAlign:"center"}}>{n.qty}</span>
              <button style={S.qBtn} onClick={()=>setNewQty(n.id,n.qty+1)}>{I.plus}</button>
              <span style={{fontSize:12,fontWeight:700,color:C.gold,minWidth:60,textAlign:"right"}}>{fmt(n.price*n.qty)}</span>
              <button style={{...S.qBtn,color:C.red}} onClick={()=>removeNewItem(n.id)}>✕</button>
            </div>)}
          </div>}
          <div style={S.searchBar}>{I.search}<input style={S.searchIn} placeholder="Buscar por nome, SKU ou bipe o código de barras..." value={newSearch} onChange={e=>setNewSearch(e.target.value)} autoFocus
            onKeyDown={e=>{
              if(e.key!=="Enter")return;
              const q=newSearch.trim();
              if(!q)return;
              // Tenta match exato por EAN ou SKU primeiro (scanner de código de barras)
              const exact=storeProducts.find(p=>(p.ean||"")=== q||(p.sku||"").toLowerCase()===q.toLowerCase());
              const target=exact||(filteredNew.length===1?filteredNew[0]:null);
              if(target){
                if(target.stock>0) addNewItem(target);
                else showToast("Produto sem estoque!","error");
                setNewSearch("");
              }
            }}/></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:8,marginTop:10,maxHeight:260,overflowY:"auto"}}>
            {filteredNew.map(p=>{const inCart=newItems.find(n=>n.id===p.id);const noStock=p.stock<=0;return <button key={p.id} onClick={()=>!noStock&&addNewItem(p)} style={{background:inCart?"rgba(255,215,64,.08)":noStock?"rgba(255,82,82,.04)":C.s2,border:`1px solid ${inCart?C.gold:noStock?"rgba(255,82,82,.3)":C.brd}`,borderRadius:10,padding:10,cursor:noStock?"not-allowed":"pointer",fontFamily:"inherit",color:noStock?C.dim:C.txt,textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:3,opacity:noStock?.5:1}}>
              <div style={{fontSize:26}}>{p.img}</div>
              <div style={{fontSize:10,fontWeight:600}}>{p.name}</div>
              <div style={{fontSize:13,fontWeight:800,color:noStock?C.red:C.gold}}>{fmt(p.price)}</div>
              {noStock?<div style={{fontSize:9,color:C.red,fontWeight:700}}>Sem estoque</div>:inCart?<div style={{fontSize:9,color:C.gold,fontWeight:700}}>+{inCart.qty} add.</div>:<div style={{fontSize:9,color:C.dim}}>{p.stock} em estoque</div>}
            </button>;})}
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <button style={{...S.secBtn,flex:1}} onClick={()=>setStep(1)}>← Voltar</button>
          <button style={{...S.primBtn,flex:2}} onClick={()=>setStep(3)}>Revisar →</button>
        </div>
      </div>}

      {/* ── STEP 3: Confirmar ── */}
      {step===3&&<div style={{...S.card,padding:24}}>
        <h3 style={{fontSize:18,fontWeight:800,textAlign:"center",marginBottom:20}}>{newItems.length>0?"Finalizar Troca":"Finalizar Devolução"}</h3>
        <div style={{display:"grid",gridTemplateColumns:newItems.length>0?"1fr auto 1fr":"1fr",gap:14,alignItems:"flex-start",marginBottom:20}}>
          <div style={{background:"rgba(255,82,82,.06)",borderRadius:12,padding:16}}>
            <div style={{fontSize:10,color:C.red,fontWeight:700,letterSpacing:2,marginBottom:8}}>DEVOLVENDO</div>
            {returnItems.map((r,i)=><div key={i} style={{fontSize:12,padding:"3px 0",borderBottom:`1px solid rgba(255,82,82,.1)`}}>{r.qty}x {r.name}<span style={{float:"right",color:C.red,fontWeight:700}}>{fmt(r.price*r.qty)}</span></div>)}
            <div style={{fontWeight:800,color:C.red,marginTop:8,fontSize:14}}>Total: {fmt(returnValue)}</div>
          </div>
          {newItems.length>0&&<>
            <div style={{fontSize:24,color:C.dim,alignSelf:"center"}}>→</div>
            <div style={{background:"rgba(0,230,118,.06)",borderRadius:12,padding:16}}>
              <div style={{fontSize:10,color:C.grn,fontWeight:700,letterSpacing:2,marginBottom:8}}>LEVANDO</div>
              {newItems.map((n,i)=><div key={i} style={{fontSize:12,padding:"3px 0",borderBottom:`1px solid rgba(0,230,118,.1)`}}>{n.qty}x {n.name}<span style={{float:"right",color:C.grn,fontWeight:700}}>{fmt(n.price*n.qty)}</span></div>)}
              <div style={{fontWeight:800,color:C.grn,marginTop:8,fontSize:14}}>Total: {fmt(newValue)}</div>
            </div>
          </>}
        </div>
        <div style={{background:C.s2,borderRadius:12,padding:16,textAlign:"center",marginBottom:16,border:`2px solid ${diff>0?C.org:diff<0?"rgba(0,230,118,.3)":C.brd}`}}>
          {newItems.length>0?(<>{diff>0&&<><div style={{fontSize:12,color:C.org,fontWeight:600}}>CLIENTE PAGA</div><div style={{fontSize:32,fontWeight:900,color:C.org}}>{fmt(diff)}</div></>}{diff<0&&<><div style={{fontSize:12,color:C.grn,fontWeight:600}}>TROCO</div><div style={{fontSize:32,fontWeight:900,color:C.grn}}>{fmt(Math.abs(diff))}</div></>}{diff===0&&<div style={{fontSize:28,fontWeight:900,color:C.blu}}>Sem diferença ✓</div>}</>):(<><div style={{fontSize:12,color:C.red,fontWeight:600}}>DEVOLVER AO CLIENTE</div><div style={{fontSize:32,fontWeight:900,color:C.red}}>{fmt(returnValue)}</div></>)}
        </div>

        {diff>0&&<div style={{background:"rgba(255,152,0,.06)",border:"1px solid rgba(255,152,0,.25)",borderRadius:12,padding:16,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,color:C.org,letterSpacing:1}}>FORMA DE PAGAMENTO DA DIFERENÇA</div>
            <button onClick={()=>{setSplitMode(!splitMode);if(!splitMode){setPay1({method:"PIX",value:""});setPay2({method:"Dinheiro",value:""});setCashRecSplit("");}}}
              style={{padding:"5px 10px",borderRadius:8,border:`1px solid ${splitMode?C.org:C.brd}`,background:splitMode?"rgba(255,152,0,.15)":"transparent",color:splitMode?C.org:C.dim,fontWeight:700,cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>
              {splitMode?"1 forma":"2 formas"}
            </button>
          </div>

          {!splitMode&&<>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:6,marginBottom:10}}>
              {["PIX","Dinheiro","Crédito","Débito"].map(m=><button key={m} onClick={()=>setPayMethod(m)}
                style={{padding:"8px 4px",borderRadius:8,border:`2px solid ${payMethod===m?C.org:C.brd}`,background:payMethod===m?"rgba(255,152,0,.15)":"transparent",color:payMethod===m?C.org:C.dim,fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>
                {m==="PIX"?"📱":m==="Dinheiro"?"💵":m==="Crédito"?"💳":"💳"} {m}
              </button>)}
            </div>
            {payMethod==="Dinheiro"&&<div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
              <span style={{fontSize:12,color:C.dim}}>Recebido:</span>
              <input type="number" placeholder={fmt(diff)} value={cashRecTroca} onChange={e=>setCashRecTroca(e.target.value)}
                style={{...S.inp,width:110,textAlign:"center",fontSize:14,fontWeight:700}}/>
              {+cashRecTroca>diff&&<span style={{fontSize:13,fontWeight:700,color:C.grn}}>Troco: {fmt(+cashRecTroca-diff)}</span>}
            </div>}
          </>}

          {splitMode&&<>
            {/* Pagamento 1 */}
            <div style={{background:"rgba(255,255,255,.03)",border:`1px solid ${C.brd}`,borderRadius:10,padding:12,marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:C.dim,marginBottom:6}}>PAGAMENTO 1</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4,marginBottom:8}}>
                {["PIX","Dinheiro","Crédito","Débito"].map(m=><button key={m} onClick={()=>setPay1(p=>({...p,method:m}))}
                  style={{padding:"6px 2px",borderRadius:6,border:`2px solid ${pay1.method===m?C.org:C.brd}`,background:pay1.method===m?"rgba(255,152,0,.15)":"transparent",color:pay1.method===m?C.org:C.dim,fontWeight:700,cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
                  {m}
                </button>)}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:11,color:C.dim}}>Valor:</span>
                <input type="number" placeholder="R$ 0,00" value={pay1.value}
                  onChange={e=>{const v=e.target.value;setPay1(p=>({...p,value:v}));if(+v>0&&+v<=diff)setPay2(p=>({...p,value:String(Math.round((diff-+v)*100)/100)}));}}
                  style={{...S.inp,flex:1,textAlign:"center",fontSize:13,fontWeight:700}}/>
              </div>
            </div>
            {/* Pagamento 2 */}
            <div style={{background:"rgba(255,255,255,.03)",border:`1px solid ${C.brd}`,borderRadius:10,padding:12,marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:C.dim,marginBottom:6}}>PAGAMENTO 2</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4,marginBottom:8}}>
                {["PIX","Dinheiro","Crédito","Débito"].map(m=><button key={m} onClick={()=>setPay2(p=>({...p,method:m}))}
                  style={{padding:"6px 2px",borderRadius:6,border:`2px solid ${pay2.method===m?C.org:C.brd}`,background:pay2.method===m?"rgba(255,152,0,.15)":"transparent",color:pay2.method===m?C.org:C.dim,fontWeight:700,cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
                  {m}
                </button>)}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:11,color:C.dim}}>Valor:</span>
                <input type="number" placeholder="R$ 0,00" value={pay2.value}
                  onChange={e=>setPay2(p=>({...p,value:e.target.value}))}
                  style={{...S.inp,flex:1,textAlign:"center",fontSize:13,fontWeight:700}}/>
              </div>
            </div>
            {/* Troco se um dos métodos for Dinheiro */}
            {(pay1.method==="Dinheiro"||pay2.method==="Dinheiro")&&<div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
              <span style={{fontSize:12,color:C.dim}}>Dinheiro recebido:</span>
              <input type="number" placeholder={fmt(pay1.method==="Dinheiro"?+pay1.value:+pay2.value)} value={cashRecSplit} onChange={e=>setCashRecSplit(e.target.value)}
                style={{...S.inp,width:110,textAlign:"center",fontSize:14,fontWeight:700}}/>
              {+cashRecSplit>(pay1.method==="Dinheiro"?+pay1.value:+pay2.value)&&<span style={{fontSize:13,fontWeight:700,color:C.grn}}>Troco: {fmt(+cashRecSplit-(pay1.method==="Dinheiro"?+pay1.value:+pay2.value))}</span>}
            </div>}
            {/* Resumo do split */}
            {(+pay1.value>0||+pay2.value>0)&&<div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:"rgba(255,152,0,.08)",fontSize:12,fontWeight:600}}>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>{pay1.method}:</span><span style={{color:C.org}}>{fmt(+pay1.value||0)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>{pay2.method}:</span><span style={{color:C.org}}>{fmt(+pay2.value||0)}</span></div>
              <div style={{borderTop:`1px solid ${C.brd}`,marginTop:4,paddingTop:4,display:"flex",justifyContent:"space-between",fontWeight:800}}>
                <span>Total:</span>
                <span style={{color:Math.round(((+pay1.value||0)+(+pay2.value||0))*100)>=Math.round(diff*100)?C.grn:C.red}}>{fmt((+pay1.value||0)+(+pay2.value||0))}</span>
              </div>
            </div>}
          </>}
        </div>}
        <div style={{display:"flex",gap:10}}>
          <button style={{...S.secBtn,flex:1,padding:12}} onClick={()=>setStep(newItems.length>0?2:1)}>← Voltar</button>
          <button style={{...S.finBtn,flex:2}} onClick={finalize}>{I.check} CONFIRMAR</button>
        </div>
      </div>}

      {/* ═══ CUPOM COMPROVANTE DE TROCA ═══ */}
      {receiptExchange&&<ExchangeReceiptModal ex={receiptExchange} onClose={()=>{setReceiptExchange(null);showToast(receiptExchange.type==="Troca"?"Troca finalizada!":"Devolução finalizada!");}} />}
    </div>
  );
}

function ExchangeReceiptModal({ex,onClose}){
  const contentRef=useRef(null);
  const storeName=STORES.find(s=>s.id===ex.storeId)?.name||"D'Black Store";
  const returnTotal=(ex.items||[]).reduce((s,i)=>s+i.price*i.qty,0);
  const newTotal=(ex.newItems||[]).reduce((s,i)=>s+i.price*i.qty,0);

  useEffect(()=>{
    const t=setTimeout(()=>{triggerPrint(contentRef,null);},150);
    return()=>clearTimeout(t);
  },[]);

  useEffect(()=>{
    const handler=(e)=>{if(e.key==="Escape")onClose();if(e.key==="Enter"){triggerPrint(contentRef,null);}};
    window.addEventListener("keydown",handler);
    return()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  const W={fontFamily:"'Courier New',Courier,monospace",color:"#000",background:"#fff",width:"100%",boxSizing:"border-box",wordBreak:"break-word",fontWeight:700};
  const HR=()=><div style={{borderTop:"1px dashed #000",margin:"5px 0"}}/>;
  const HR2=()=><div style={{borderTop:"2px solid #000",margin:"5px 0"}}/>;
  const Row=({l,r})=><div style={{display:"flex",justifyContent:"space-between",gap:4,padding:"1px 0",fontWeight:700}}><span style={{flex:1,wordBreak:"break-word"}}>{l}</span><span style={{whiteSpace:"nowrap",fontWeight:700}}>{r}</span></div>;

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.92)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:12,maxWidth:380,width:"92%",maxHeight:"90vh",overflowY:"auto",padding:0}} onClick={e=>e.stopPropagation()}>
        <div ref={contentRef} id="receipt-print" style={{...W,padding:"6px 4px",fontSize:11,lineHeight:1.6}}>
          <div style={{textAlign:"center",fontWeight:900,fontSize:16,letterSpacing:3}}>D'BLACK STORE</div>
          <div style={{textAlign:"center",fontSize:11,letterSpacing:1}}>COMPROVANTE DE {ex.type==="Troca"?"TROCA":"DEVOLUCAO"}</div>
          <div style={{textAlign:"center",fontSize:10}}>{storeName}</div>
          <HR/>
          <Row l={"Data: "+fmtDate(ex.date)} r=""/>
          <Row l={"Cliente: "+(ex.customer||"Avulso")} r=""/>
          <Row l={"Cupom orig: "+(ex.cupomOriginal||"-")} r=""/>
          {ex.reason&&ex.reason!=="-"&&<Row l={"Motivo: "+ex.reason} r=""/>}
          <HR/>
          <div style={{fontWeight:700,fontSize:10}}>ITENS DEVOLVIDOS</div>
          {(ex.items||[]).map((it,i)=><div key={i} style={{padding:"1px 0"}}>
            <div style={{fontSize:10}}>{it.qty}x {it.name}</div>
            <Row l={"  "+it.qty+" x "+fmt(it.price)} r={fmt(it.price*it.qty)}/>
          </div>)}
          <Row l="Subtotal devolvido" r={fmt(returnTotal)}/>
          {ex.newItems&&ex.newItems.length>0&&<>
            <HR/>
            <div style={{fontWeight:700,fontSize:10}}>NOVOS ITENS</div>
            {ex.newItems.map((it,i)=><div key={i} style={{padding:"1px 0"}}>
              <div style={{fontSize:10}}>{it.qty}x {it.name}</div>
              <Row l={"  "+it.qty+" x "+fmt(it.price)} r={fmt(it.price*it.qty)}/>
            </div>)}
            <Row l="Subtotal novos" r={fmt(newTotal)}/>
          </>}
          <HR2/>
          {ex.difference>0&&<Row l="DIFERENCA PAGA" r={fmt(ex.difference)}/>}
          {ex.difference<0&&<Row l="TROCO/CREDITO" r={fmt(Math.abs(ex.difference))}/>}
          {ex.difference===0&&<Row l="SEM DIFERENCA" r="R$ 0,00"/>}
          {ex.payment&&<Row l={"Pagamento: "+ex.payment} r=""/>}
          {ex.change>0&&<Row l="Troco" r={fmt(ex.change)}/>}
          <HR/>
          <div style={{textAlign:"center",fontSize:11,lineHeight:1.7}}>Obrigado pela preferencia!<br/>Volte sempre - D'Black Store<br/>@d_blackloja</div>
          <div style={{textAlign:"center",fontSize:10,marginTop:3}}>{new Date().toLocaleString("pt-BR")}</div>
        </div>
        <div style={{display:"flex",gap:8,padding:"12px 8px",borderTop:"1px solid #ddd"}} className="no-print">
          <button onClick={()=>triggerPrint(contentRef,null)} style={{flex:1,padding:"10px",borderRadius:8,border:"1px solid #ccc",background:"#f5f5f5",color:"#000",fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>🖨️ Reimprimir</button>
          <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:"#222",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>✓ Fechar</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  ETIQUETAS MODULE           ═══
// ═══════════════════════════════════
function EtiquetasModule({storeProducts,showToast}){
  const [search,setSearch]=useState("");const [queue,setQueue]=useState([]);const [showPreview,setShowPreview]=useState(false);
  const filtered=storeProducts.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())||p.sku.toLowerCase().includes(search.toLowerCase())||(p.ean||"").includes(search));
  const addQ=(p)=>setQueue(prev=>{const ex=prev.find(q=>q.pid===p.id);if(ex)return prev.map(q=>q.pid===p.id?{...q,qty:q.qty+1}:q);return[...prev,{pid:p.id,qty:1}];});
  const totalLabels=queue.reduce((s,q)=>s+q.qty,0);

  // Gerador de código de barras EAN-13 real
  const EAN_L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const EAN_G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const EAN_R=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const EAN_P=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

  const ean13Encode=(code)=>{
    if(!code)return null;
    let d=code.replace(/\D/g,'');
    if(d.length===12){let s=0;for(let i=0;i<12;i++)s+=parseInt(d[i])*(i%2===0?1:3);d+=((10-(s%10))%10).toString();}
    if(d.length!==13)return null;
    const par=EAN_P[parseInt(d[0])];
    let bits='101';
    for(let i=0;i<6;i++){const v=parseInt(d[i+1]);bits+=par[i]==='L'?EAN_L[v]:EAN_G[v];}
    bits+='01010';
    for(let i=0;i<6;i++)bits+=EAN_R[parseInt(d[i+7])];
    bits+='101';
    return{bits,digits:d};
  };

  const BarcodeEAN=({ean,width,height})=>{
    const data=ean13Encode(ean);
    if(!data)return <div style={{fontSize:8,color:'#999',textAlign:'center'}}>Sem EAN</div>;
    const bw=width/95;
    const barH=height-12;
    const rects=[];
    for(let i=0;i<data.bits.length;i++){
      if(data.bits[i]==='1')rects.push(<rect key={i} x={i*bw} y={0} width={bw} height={barH} fill="#000"/>);
    }
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{display:'block'}}>
      {rects}
      <text x={width/2} y={height-1} textAnchor="middle" fill="#000" fontSize={9} fontFamily="Arial,Helvetica,sans-serif" fontWeight="700">{data.digits}</text>
    </svg>;
  };

  // Formata preço para etiqueta (sem símbolo, separado)
  const fmtPrecoEtiqueta=(v)=>{const n=parseFloat(v)||0;const parts=n.toFixed(2).split('.');return{inteiro:parts[0],decimal:parts[1]};};

  // Renderiza uma etiqueta 40x40mm (151px ≈ 40mm a 96dpi)
  const renderLabel=(prod,idx)=>{
    const preco=fmtPrecoEtiqueta(prod.price);
    return <div key={prod.id+"-"+idx} className="etiqueta-40x40" style={{
      width:151,height:151,padding:'6px 8px',background:'#fff',color:'#000',
      fontFamily:"'Arial','Helvetica',sans-serif",display:'flex',flexDirection:'column',
      alignItems:'center',justifyContent:'space-between',boxSizing:'border-box',
      border:'1px solid #ccc',flexShrink:0,overflow:'hidden',lineHeight:1.2,
      WebkitFontSmoothing:'antialiased',textRendering:'geometricPrecision'
    }}>
      <div style={{fontSize:11,fontWeight:900,letterSpacing:1,textAlign:'center',marginTop:6}}>D'BLACK STORE</div>
      <div style={{fontSize:9,fontWeight:700,textAlign:'center',lineHeight:1.15,overflow:'hidden',maxHeight:22,width:'100%',wordBreak:'break-word'}}>
        {prod.sku} {prod.name.toUpperCase()}
      </div>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:22,fontWeight:900,lineHeight:1,fontFamily:"'Poppins',sans-serif"}}>R$ {preco.inteiro},{preco.decimal}</div>
        <div style={{fontSize:8,fontWeight:700,marginTop:1}}>Ate 12x sem juros</div>
      </div>
      <BarcodeEAN ean={prod.ean||''} width={120} height={32}/>
    </div>;
  };

  const sample=storeProducts[0]||{id:"x",name:"Produto Exemplo",sku:"00001",ean:"7891234560011",price:49.90,img:"👕"};

  // Função de imprimir que abre janela dedicada para impressora térmica
  const handlePrint=()=>{
    const labels=[];
    queue.forEach(q=>{const p=storeProducts.find(pr=>pr.id===q.pid);if(!p)return;for(let i=0;i<q.qty;i++)labels.push(p);});
    if(labels.length===0)return showToast("Fila vazia!","error");

    const printWin=window.open('','_blank','width=400,height=600');
    if(!printWin){showToast("Popup bloqueado! Permita popups.","error");return;}

    const labelsHtml=labels.map(p=>{
      const preco=fmtPrecoEtiqueta(p.price);
      const data=ean13Encode(p.ean||'');
      let barcodeSvg='<div style="font-size:8px;color:#999">Sem EAN</div>';
      if(data){
        let rects='';const bw=120/95;const barH=20;
        for(let i=0;i<data.bits.length;i++){
          if(data.bits[i]==='1')rects+=`<rect x="${i*bw}" y="0" width="${bw}" height="${barH}" fill="#000"/>`;
        }
        barcodeSvg=`<svg width="120" height="32" viewBox="0 0 120 32" style="display:block">${rects}<text x="60" y="31" text-anchor="middle" fill="#000" font-size="9" font-family="Arial,Helvetica,sans-serif" font-weight="700">${data.digits}</text></svg>`;
      }
      return `<div class="label">
        <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-align:center;margin-top:4px">D'BLACK STORE</div>
        <div style="font-size:9px;font-weight:700;text-align:center;line-height:1.15;overflow:hidden;max-height:22px;word-break:break-word">${p.sku} ${p.name.toUpperCase()}</div>
        <div style="text-align:center">
          <div style="font-size:22px;font-weight:900;line-height:1;font-family:'Poppins',sans-serif">R$ ${preco.inteiro},${preco.decimal}</div>
          <div style="font-size:8px;font-weight:700;margin-top:1px">Ate 12x sem juros</div>
        </div>
        <div style="display:flex;justify-content:center">${barcodeSvg}</div>
      </div>`;
    }).join('');

    printWin.document.write(`<!DOCTYPE html><html><head><title>Etiquetas D'Black</title>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;900&display=swap" rel="stylesheet">
      <style>
      @page{size:40mm 40mm;margin:0 !important;}
      html,body{width:40mm;height:40mm;margin:0 !important;padding:0 !important;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
      *{box-sizing:border-box;margin:0;padding:0;}
      .label{width:40mm;height:40mm;padding:2mm 3mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;overflow:hidden;page-break-after:always;page-break-inside:avoid;line-height:1.2;}
      .label:last-child{page-break-after:auto;}
      @media screen{html,body{width:auto;height:auto;padding:10px;display:flex;flex-wrap:wrap;gap:8px;}.label{border:1px solid #ccc;}}
    </style></head><body>${labelsHtml}</body></html>`);
    printWin.document.close();
    setTimeout(()=>{
      printWin.print();
    },500);
  };

  return(
    <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:280}}>
        <div style={{...S.card,marginBottom:10,padding:12,display:"flex",alignItems:"center",gap:10,background:"rgba(255,215,64,.04)",borderColor:C.brdH}}>
          <span style={{fontSize:28}}>🏷️</span>
          <div><div style={{fontSize:14,fontWeight:700}}>Etiquetas 40x40mm</div><div style={{fontSize:11,color:C.dim}}>Elgin L42 Pro Full — Térmica</div></div>
        </div>
        <div style={S.searchBar}>{I.search}<input style={S.searchIn} placeholder="Buscar por nome, SKU ou EAN..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:6,marginTop:10}}>
          {filtered.map(p=>{const inQ=queue.find(q=>q.pid===p.id);return <button key={p.id} onClick={()=>addQ(p)} style={{background:inQ?"rgba(255,215,64,.06)":C.s2,border:`1px solid ${inQ?C.brdH:C.brd}`,borderRadius:8,padding:8,cursor:"pointer",fontFamily:"inherit",color:C.txt,textAlign:"center",fontSize:10,position:"relative"}}>
            {inQ&&<div style={{position:"absolute",top:3,right:3,background:C.gold,color:C.bg,fontSize:8,fontWeight:800,width:16,height:16,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}>{inQ.qty}</div>}
            <div style={{fontSize:20}}>{p.img}</div>
            <div style={{fontWeight:600,fontSize:11,marginTop:2}}>{p.name}</div>
            <div style={{fontSize:9,color:C.dim}}>{p.sku}</div>
            <div style={{color:C.gold,fontWeight:800,fontSize:12}}>{fmt(p.price)}</div>
          </button>;})}
        </div>
      </div>
      <div style={{width:360,maxWidth:"100%"}}>
        <div style={{...S.card,marginBottom:10}}>
          <h3 style={{fontSize:12,color:C.dim,marginBottom:8}}>Preview da Etiqueta</h3>
          <div style={{display:"flex",justifyContent:"center",padding:16,background:"#f5f5f5",borderRadius:8,border:`1px dashed ${C.brd}`}}>
            {renderLabel(queue.length>0?(storeProducts.find(p=>p.id===queue[0].pid)||sample):sample,0)}
          </div>
          <div style={{fontSize:10,color:C.dim,textAlign:"center",marginTop:6}}>40mm × 40mm — Tamanho real aproximado</div>
        </div>
        <div style={S.card}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
            {I.printer}<span style={{fontSize:13,fontWeight:700,color:C.gold}}>Fila de Impressão ({totalLabels})</span>
          </div>
          {queue.length===0?<div style={{textAlign:"center",padding:20,color:C.dim,fontSize:11}}>🏷️ Clique nos produtos para adicionar</div>:
          <div>
            {queue.map(q=>{const p=storeProducts.find(pr=>pr.id===q.pid);if(!p)return null;return <div key={q.pid} style={{background:C.s2,borderRadius:8,padding:8,marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:14}}>{p.img}</span>
              <div style={{flex:1}}><div style={{fontSize:10,fontWeight:600}}>{p.name}</div><div style={{fontSize:8,color:C.dim}}>{p.ean||'Sem EAN'}</div></div>
              <button style={S.qBtn} onClick={()=>setQueue(prev=>prev.map(x=>x.pid===q.pid?(x.qty>1?{...x,qty:x.qty-1}:null):x).filter(Boolean))}>{I.minus}</button>
              <span style={{fontSize:13,fontWeight:700,minWidth:20,textAlign:"center"}}>{q.qty}</span>
              <button style={S.qBtn} onClick={()=>setQueue(prev=>prev.map(x=>x.pid===q.pid?{...x,qty:x.qty+1}:x))}>{I.plus}</button>
            </div>;})}
            <div style={{display:"flex",gap:6,marginTop:10}}>
              <button style={{...S.secBtn,flex:1,fontSize:10}} onClick={()=>setQueue([])}>Limpar</button>
              <button style={{...S.primBtn,flex:2,fontSize:12}} onClick={handlePrint}>{I.printer} Imprimir {totalLabels} etiqueta{totalLabels>1?'s':''}</button>
            </div>
          </div>}
        </div>
      </div>
      {showPreview&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:200,display:"flex",flexDirection:"column"}} onClick={()=>setShowPreview(false)}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 18px",background:C.s1,borderBottom:`1px solid ${C.brd}`}} onClick={e=>e.stopPropagation()}>
          <h3 style={{margin:0,fontSize:14,fontWeight:700,flex:1}}>{totalLabels} etiquetas</h3>
          <button style={S.primBtn} onClick={handlePrint}>{I.printer} Imprimir</button>
          <button style={{background:"none",border:"none",color:C.dim,cursor:"pointer"}} onClick={()=>setShowPreview(false)}>{I.x}</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:16,display:"flex",flexWrap:"wrap",gap:8,alignContent:"flex-start",justifyContent:"center"}} onClick={e=>e.stopPropagation()}>
          {queue.map(q=>{const p=storeProducts.find(pr=>pr.id===q.pid);if(!p)return null;return Array.from({length:q.qty},(_,i)=>renderLabel(p,i));})}
        </div>
      </div>}
    </div>
  );
}

// ═══════════════════════════════════
// ═══  FIDELIDADE MODULE          ═══
// ═══════════════════════════════════
function FidelidadeModule({customers,setCustomers,showToast}){
  const tiers=[{name:"Bronze",min:0,max:99,color:"#CD7F32",benefit:"5% desc."},{name:"Prata",min:100,max:299,color:"#C0C0C0",benefit:"10% desc."},{name:"Ouro",min:300,max:499,color:C.gold,benefit:"15% + brindes"},{name:"Diamante",min:500,max:Infinity,color:C.blu,benefit:"20% + prioridade"}];
  const getTier=(pts)=>tiers.find(t=>pts>=t.min&&pts<=t.max)||tiers[0];
  const sorted=[...customers].sort((a,b)=>b.points-a.points);
  const redeem=(cId,pts)=>{setCustomers(prev=>prev.map(c=>c.id===cId?{...c,points:Math.max(0,c.points-pts)}:c));showToast(pts+" pontos resgatados!");};
  return(
    <div>
      <div style={S.card}><h3 style={S.cardTitle}>Programa de Fidelidade</h3><p style={{fontSize:12,color:C.dim,marginBottom:12}}>R$10 = 1 ponto</p><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>{tiers.map(t=><div key={t.name} style={{...S.card,borderColor:t.color+"44",textAlign:"center"}}><div style={{fontSize:20,fontWeight:900,color:t.color}}>{t.name}</div><div style={{fontSize:11,color:C.dim}}>{t.max===Infinity?t.min+"+ pts":t.min+"-"+t.max+" pts"}</div><div style={{fontSize:12,fontWeight:600}}>{t.benefit}</div></div>)}</div></div>
      <div style={S.card}><h3 style={S.cardTitle}>Ranking</h3><div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>#</th><th style={S.th}>Cliente</th><th style={S.th}>Nível</th><th style={S.th}>Pontos</th><th style={S.th}>Gasto</th><th style={S.th}>Ações</th></tr></thead>
      <tbody>{sorted.map((c,i)=>{const tier=getTier(c.points);return <tr key={c.id} style={S.tr}><td style={{...S.td,fontWeight:800,color:C.gold}}>#{i+1}</td><td style={{...S.td,fontWeight:600}}>{c.name}</td><td style={S.td}><span style={{fontWeight:700,color:tier.color}}>{tier.name}</span></td><td style={{...S.td,fontWeight:700,color:C.gold,fontSize:15}}>{c.points}</td><td style={{...S.td,...S.tdM}}>{fmt(c.totalSpent)}</td><td style={S.td}><div style={{display:"flex",gap:3}}><button style={S.smBtn} onClick={()=>redeem(c.id,50)}>-50</button><button style={S.smBtn} onClick={()=>redeem(c.id,100)}>-100</button></div></td></tr>;})}</tbody></table></div></div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  PROMOÇÕES MODULE           ═══
// ═══════════════════════════════════
function PromosModule({promos,setPromos,showToast}){
  const [showForm,setShowForm]=useState(false);
  const [np,setNp]=useState({name:"",type:"percent",value:"",minPurchase:"",validUntil:""});
  const addP=()=>{
    if(!np.name)return showToast("Preencha!","error");
    const newP={...np,id:genId(),value:+np.value,minPurchase:+np.minPurchase,active:true,usageCount:0};
    setPromos(prev=>[...prev,newP]);
    api.createPromo(promoToApi(newP)).catch(console.error);
    setNp({name:"",type:"percent",value:"",minPurchase:"",validUntil:""});
    setShowForm(false);
    showToast("Cupom criado!");
  };
  return(
    <div>
      <div style={S.toolbar}><h3 style={{margin:0,fontSize:15}}>Cupons & Promoções</h3><div style={{flex:1}}/><button style={S.primBtn} onClick={()=>setShowForm(!showForm)}>{I.plus} Novo Cupom</button></div>
      {showForm&&<div style={S.formCard}><div style={S.formGrid}><input style={S.inp} placeholder="Código (PRETA10)" value={np.name} onChange={e=>setNp(p=>({...p,name:e.target.value.toUpperCase()}))}/><select style={S.sel} value={np.type} onChange={e=>setNp(p=>({...p,type:e.target.value}))}><option value="percent">%</option><option value="fixed">R$</option></select><input style={S.inp} type="number" placeholder="Valor" value={np.value} onChange={e=>setNp(p=>({...p,value:e.target.value}))}/><input style={S.inp} type="number" placeholder="Compra mín. R$" value={np.minPurchase} onChange={e=>setNp(p=>({...p,minPurchase:e.target.value}))}/><input style={S.inp} type="date" value={np.validUntil} onChange={e=>setNp(p=>({...p,validUntil:e.target.value}))}/></div><div style={S.formAct}><button style={S.secBtn} onClick={()=>setShowForm(false)}>Cancelar</button><button style={S.primBtn} onClick={addP}>Criar</button></div></div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>{promos.map(p=><div key={p.id} style={{...S.card,borderColor:p.active?C.brdH:"rgba(255,82,82,.15)"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}><span style={{fontSize:18,fontWeight:900,fontFamily:"monospace",color:p.active?C.gold:C.dim,letterSpacing:2}}>{p.name}</span><button style={{...S.smBtn,color:p.active?C.grn:C.red}} onClick={()=>setPromos(prev=>prev.map(pr=>pr.id===p.id?{...pr,active:!pr.active}:pr))}>{p.active?"Ativo":"Inativo"}</button></div><div style={{fontSize:26,fontWeight:900,color:C.gold,marginBottom:6}}>{p.type==="percent"?p.value+"% OFF":fmt(p.value)+" OFF"}</div><div style={{fontSize:11,color:C.dim}}>Mín: {fmt(p.minPurchase)} • Até: {p.validUntil?fmtDate(p.validUntil):"∞"} • Usado {p.usageCount}x</div></div>)}</div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  WHATSAPP MODULE            ═══
// ═══════════════════════════════════
function WhatsAppModule({customers}){
  const [search,setSearch]=useState("");const [msg,setMsg]=useState("Olá {nome}! 🖤 Novidades na D'Black! Passa aqui pra conferir.");
  const filtered=customers.filter(c=>c.whatsapp&&(c.name.toLowerCase().includes(search.toLowerCase())||c.phone.includes(search)));
  const openWa=(c)=>{const text=msg.replace("{nome}",c.name.split(" ")[0]);window.open("https://wa.me/"+c.whatsapp+"?text="+encodeURIComponent(text),"_blank");};
  return(
    <div>
      <div style={S.card}><h3 style={S.cardTitle}>Mensagem Padrão</h3><textarea style={{...S.inp,width:"100%",minHeight:60,resize:"vertical"}} value={msg} onChange={e=>setMsg(e.target.value)}/><div style={{fontSize:11,color:C.dim,marginTop:4}}>Use <strong>{"{nome}"}</strong> para o nome</div></div>
      <div style={S.toolbar}><div style={S.searchBar}>{I.search}<input style={S.searchIn} placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/></div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:10}}>{filtered.map(c=><div key={c.id} style={S.card}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><div style={S.avatar}>{c.name.charAt(0)}</div><div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{c.name}</div><div style={{fontSize:11,color:C.dim}}>{c.phone}</div></div></div><div style={{fontSize:11,color:C.dim,marginBottom:8}}>Gasto: {fmt(c.totalSpent)} • {c.points}pts</div><button onClick={()=>openWa(c)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px",borderRadius:8,border:"none",background:"#25D366",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>📱 Enviar Mensagem</button></div>)}</div>
    </div>
  );
}

// ═══════════════════════════════════
// ═══  INVESTIMENTOS MODULE       ═══
// ═══════════════════════════════════
function InvestimentosModule({investments,setInvestments,showToast}){
  const [showForm,setShowForm]=useState(false);
  const [ni,setNi]=useState({week:"",date:new Date().toISOString().split("T")[0],value:"",supplier:"",cats:"",notes:""});
  const addInv=()=>{
    if(!ni.value||!ni.supplier)return showToast("Preencha!","error");
    const wk=ni.week||("Sem. "+fmtDate(ni.date));
    const newInv={id:genId(),week:wk,date:ni.date,value:+ni.value,supplier:ni.supplier,categories:ni.cats?ni.cats.split(",").map(c=>c.trim()):[],notes:ni.notes};
    setInvestments(prev=>[newInv,...prev]);
    api.createInvestment(newInv).catch(console.error);
    setNi({week:"",date:new Date().toISOString().split('T')[0],value:"",supplier:"",cats:"",notes:""});
    setShowForm(false);
    showToast("Investimento registrado!");
  };
  const total=investments.reduce((s,i)=>s+i.value,0);const avg=investments.length>0?total/investments.length:0;const max=investments.length>0?Math.max(...investments.map(i=>i.value)):1;
  const bySup={};investments.forEach(i=>{bySup[i.supplier]=(bySup[i.supplier]||0)+i.value;});
  return(
    <div>
      <div style={S.kpiRow}><KPI icon={I.money} label="Total Investido" value={fmt(total)} sub={investments.length+" compras"} color={C.blu}/><KPI icon={I.chart} label="Média" value={fmt(avg)} sub="Por compra" color={C.pur}/><KPI icon={I.box} label="Maior" value={fmt(max)} sub="Máximo" color={C.gold}/></div>
      <div style={S.toolbar}><h3 style={{margin:0,fontSize:15}}>Investimento em Mercadoria</h3><div style={{flex:1}}/><button style={S.primBtn} onClick={()=>setShowForm(!showForm)}>{I.plus} Novo</button></div>
      {showForm&&<div style={S.formCard}><div style={S.formGrid}><input style={S.inp} type="date" value={ni.date} onChange={e=>setNi(i=>({...i,date:e.target.value}))}/><input style={S.inp} placeholder="Semana" value={ni.week} onChange={e=>setNi(i=>({...i,week:e.target.value}))}/><input style={S.inp} type="number" placeholder="Valor R$" value={ni.value} onChange={e=>setNi(i=>({...i,value:e.target.value}))}/><input style={S.inp} placeholder="Fornecedor" value={ni.supplier} onChange={e=>setNi(i=>({...i,supplier:e.target.value}))}/><input style={S.inp} placeholder="Categorias" value={ni.cats} onChange={e=>setNi(i=>({...i,cats:e.target.value}))}/><input style={S.inp} placeholder="Obs." value={ni.notes} onChange={e=>setNi(i=>({...i,notes:e.target.value}))}/></div><div style={S.formAct}><button style={S.secBtn} onClick={()=>setShowForm(false)}>Cancelar</button><button style={S.primBtn} onClick={addInv}>Registrar</button></div></div>}
      <div style={S.grid2}><div style={S.card}><h3 style={S.cardTitle}>Por Semana</h3>{investments.map(inv=><div key={inv.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{width:120,fontSize:11,flexShrink:0}}>{inv.week.length>18?inv.week.slice(0,18)+"…":inv.week}</span><div style={{flex:1,height:18,background:C.s2,borderRadius:9,overflow:"hidden"}}><div style={{height:"100%",borderRadius:9,background:`linear-gradient(90deg,${C.blu},${C.pur})`,width:(inv.value/max*100)+"%",minWidth:3}}/></div><span style={{fontSize:11,fontWeight:700,color:C.blu,minWidth:80,textAlign:"right",fontFamily:"monospace"}}>{fmt(inv.value)}</span></div>)}</div><div style={S.card}><h3 style={S.cardTitle}>Por Fornecedor</h3>{Object.entries(bySup).sort((a,b)=>b[1]-a[1]).map(([sup,v])=><div key={sup} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{width:100,fontSize:11,flexShrink:0}}>{sup}</span><div style={{flex:1,height:18,background:C.s2,borderRadius:9,overflow:"hidden"}}><div style={{height:"100%",borderRadius:9,background:`linear-gradient(90deg,${C.gold},${C.blu})`,width:(total>0?v/total*100:0)+"%",minWidth:3}}/></div><span style={{fontSize:11,fontWeight:700,color:C.gold,minWidth:80,textAlign:"right",fontFamily:"monospace"}}>{fmt(v)}</span></div>)}</div></div>
      <div style={S.card}><h3 style={S.cardTitle}>Histórico</h3><div style={S.tWrap}><table style={S.table}><thead><tr><th style={S.th}>Data</th><th style={S.th}>Semana</th><th style={S.th}>Fornecedor</th><th style={S.th}>Cat.</th><th style={S.th}>Valor</th><th style={S.th}>Obs.</th></tr></thead><tbody>{investments.map(inv=><tr key={inv.id} style={S.tr}><td style={S.td}>{fmtDate(inv.date)}</td><td style={{...S.td,fontSize:11}}>{inv.week}</td><td style={{...S.td,fontWeight:600}}>{inv.supplier}</td><td style={S.td}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{(inv.categories||[]).map((c,ci)=><span key={ci} style={S.tag}>{c}</span>)}</div></td><td style={{...S.td,fontWeight:700,color:C.blu,fontFamily:"monospace"}}>{fmt(inv.value)}</td><td style={{...S.td,fontSize:11,color:C.dim}}>{inv.notes||"-"}</td></tr>)}</tbody></table></div></div>
    </div>
  );
}

// ─── CSS ───
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,215,64,.2);border-radius:3px}
  input::placeholder{color:rgba(255,255,255,.3)}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes toastIn{from{transform:translateX(120%)}to{transform:translateX(0)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  button:hover{filter:brightness(1.1)}button:active{transform:scale(.97)}
  @media print {
    @page { margin: 0; size: 80mm auto; }
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    body * { visibility: hidden !important; }
    #receipt-print, #receipt-print * { visibility: visible !important; }
    #receipt-print {
      position: absolute !important;
      top: 0 !important; left: 0 !important;
      width: 70mm !important; max-width: 70mm !important;
      padding: 3mm 2mm !important;
      background: #fff !important;
      font-family: 'Courier New', Courier, monospace !important;
      font-size: 9pt !important;
      line-height: 1.55 !important;
      color: #000 !important;
      word-break: break-word !important;
      overflow-wrap: break-word !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    #receipt-print * {
      color: #000 !important;
      background: transparent !important;
      border-color: #000 !important;
      font-family: 'Courier New', Courier, monospace !important;
      font-weight: 700 !important;
      -webkit-text-fill-color: #000 !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
    #receipt-print svg { max-width: 66mm !important; height: auto !important; }
    .etiqueta-40x40 {
      width: 40mm !important; height: 40mm !important;
      background: #fff !important; color: #000 !important;
      border: none !important; padding: 2mm !important;
      page-break-after: always !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  }
  @media (max-width: 768px) {
    body { font-size: 13px; }
  }
`;

// ─── STYLES ───
const S = {
  app:{display:"flex",minHeight:"100vh",background:C.bg,color:C.txt,fontFamily:"'Outfit',sans-serif",fontSize:14,position:"relative"},
  side:{width:220,background:C.s1,borderRight:`1px solid ${C.brd}`,display:"flex",flexDirection:"column",position:"fixed",top:0,left:0,bottom:0,zIndex:100,transform:"translateX(-100%)",transition:"transform .3s ease",overflowY:"auto"},
  sideOn:{transform:"translateX(0)"},
  overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:99,backdropFilter:"blur(4px)"},
  logoBox:{padding:"20px 16px 12px",borderBottom:`1px solid ${C.brd}`,position:"relative"},
  logo:{fontSize:24,fontWeight:900,letterSpacing:6,background:`linear-gradient(135deg,${C.gold},#fff)`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"},
  logoSub:{fontSize:8,letterSpacing:3,color:C.dim,marginTop:2,fontWeight:500},
  closeBtn:{position:"absolute",top:12,right:10,background:"none",border:"none",color:C.dim,cursor:"pointer",padding:4,display:"flex"},
  nav:{flex:1,padding:"8px 6px",display:"flex",flexDirection:"column",gap:1},
  navBtn:{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"none",border:"none",color:"rgba(255,255,255,0.8)",cursor:"pointer",borderRadius:8,fontSize:12,fontFamily:"inherit",fontWeight:500,transition:"all .2s",textAlign:"left"},
  navAct:{background:`linear-gradient(135deg,rgba(255,215,64,.12),rgba(255,215,64,.04))`,color:C.gold,fontWeight:600},
  navIc:{display:"flex",alignItems:"center",flexShrink:0},
  main:{flex:1,display:"flex",flexDirection:"column",minHeight:"100vh",width:"100%"},
  topbar:{display:"flex",alignItems:"center",gap:10,padding:"10px 16px",borderBottom:`1px solid ${C.brd}`,background:C.s1,position:"sticky",top:0,zIndex:50},
  menuBtn:{background:"none",border:`1px solid ${C.brd}`,color:C.txt,cursor:"pointer",padding:6,borderRadius:8,display:"flex",alignItems:"center"},
  pageTitle:{fontSize:16,fontWeight:700,letterSpacing:1},
  content:{flex:1,padding:16,animation:"fadeIn .3s ease"},
  // KPI
  kpiRow:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:14},
  kpi:{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:14,padding:14,display:"flex",alignItems:"flex-start",gap:12},
  kpiIc:{width:38,height:38,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0},
  kpiInfo:{flex:1},kpiLabel:{fontSize:10,color:C.dim,fontWeight:500,marginBottom:2},kpiVal:{fontSize:18,fontWeight:800,letterSpacing:-.5},kpiSub:{fontSize:10,color:C.dim,marginTop:1},
  // Cards
  card:{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:14,padding:16,marginBottom:12},
  cardTitle:{fontSize:13,fontWeight:700,marginBottom:12,letterSpacing:.5},
  grid2:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:12,marginBottom:12},
  // Alert
  alertBox:{background:"rgba(255,82,82,.06)",border:"1px solid rgba(255,82,82,.2)",borderRadius:14,padding:14,marginBottom:14},
  alertTitle:{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:700,color:C.red,marginBottom:8},
  alertList:{display:"flex",flexWrap:"wrap",gap:6},
  alertItem:{display:"flex",alignItems:"center",gap:6,background:"rgba(255,82,82,.08)",padding:"5px 10px",borderRadius:8,fontSize:11},
  // Table
  tWrap:{overflowX:"auto"},table:{width:"100%",borderCollapse:"collapse"},
  th:{textAlign:"left",padding:"7px 10px",fontSize:10,fontWeight:700,letterSpacing:1,color:"rgba(255,255,255,0.85)",borderBottom:`1px solid ${C.brd}`,textTransform:"uppercase",whiteSpace:"nowrap"},
  tr:{transition:"background .15s"},td:{padding:"7px 10px",borderBottom:`1px solid ${C.brd}`,fontSize:12,whiteSpace:"nowrap"},
  tdM:{fontWeight:700,color:C.grn,fontFamily:"'JetBrains Mono',monospace"},
  // PDV
  pdvCard:{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:10,padding:10,cursor:"pointer",transition:"all .2s",textAlign:"center",fontFamily:"inherit",color:C.txt,display:"flex",flexDirection:"column",alignItems:"center",gap:2},
  cartPanel:{flex:"0 0 44%",minWidth:320,maxWidth:"100%",background:C.s1,border:`1px solid ${C.brd}`,borderRadius:14,display:"flex",flexDirection:"column",maxHeight:"90vh"},
  cartHead:{display:"flex",alignItems:"center",gap:8,padding:"12px 14px",borderBottom:`1px solid ${C.brd}`,color:C.gold},
  cartBadge:{background:C.gold,color:C.bg,fontSize:10,fontWeight:800,width:20,height:20,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",marginLeft:"auto"},
  // Form
  toolbar:{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"},
  searchBar:{display:"flex",alignItems:"center",gap:8,background:C.s1,border:`1px solid ${C.brd}`,borderRadius:10,padding:"8px 14px",flex:1,minWidth:160},
  searchIn:{background:"none",border:"none",color:C.txt,fontSize:13,fontFamily:"inherit",outline:"none",flex:1},
  formCard:{background:C.s1,border:`1px solid ${C.brdH}`,borderRadius:14,padding:20,marginBottom:14,animation:"fadeIn .3s ease"},
  formTitle:{fontSize:14,fontWeight:700,marginBottom:12},
  formGrid:{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8},
  formAct:{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12},
  inp:{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.brd}`,background:C.s2,color:C.txt,fontSize:13,fontFamily:"inherit",outline:"none"},
  sel:{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.brd}`,background:C.s2,color:C.txt,fontSize:13,fontFamily:"inherit",outline:"none",cursor:"pointer"},
  primBtn:{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,color:C.bg,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",letterSpacing:.5,whiteSpace:"nowrap"},
  secBtn:{padding:"8px 16px",borderRadius:10,border:`1px solid rgba(255,215,64,0.15)`,background:C.s2,color:C.txt,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  smBtn:{padding:"4px 10px",borderRadius:6,border:`1px solid rgba(255,215,64,0.15)`,background:C.s2,color:C.txt,cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600},
  qBtn:{width:26,height:26,borderRadius:6,border:`1px solid ${C.brd}`,background:C.s1,color:C.txt,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"},
  finBtn:{width:"100%",padding:"12px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,color:C.bg,fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",letterSpacing:2,display:"flex",alignItems:"center",justifyContent:"center",gap:8},
  // Badges
  stBadge:{padding:"2px 8px",borderRadius:6,fontSize:11,fontWeight:700},stOk:{background:"rgba(0,230,118,.1)",color:C.grn},stLow:{background:"rgba(255,82,82,.1)",color:C.red,animation:"pulse 2s infinite"},
  payBadge:{padding:"2px 8px",borderRadius:5,fontSize:10,fontWeight:600,background:"rgba(255,215,64,.08)",color:C.gold,border:`1px solid rgba(255,215,64,.15)`},
  payBtn:{padding:"10px 6px",borderRadius:8,border:`1px solid rgba(255,255,255,0.15)`,background:"rgba(255,255,255,0.06)",color:C.txt,cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600,transition:"all .2s"},
  payAct:{borderColor:C.gold,color:C.gold,background:"rgba(255,215,64,.15)",boxShadow:`0 0 0 1px ${C.gold}55`},
  crmCard:{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:C.s1,border:`1px solid ${C.brd}`,borderRadius:10,cursor:"pointer",transition:"all .2s",fontFamily:"inherit",color:C.txt,textAlign:"left",width:"100%"},
  tag:{fontSize:9,padding:"2px 6px",borderRadius:4,background:"rgba(255,215,64,.1)",color:C.gold,fontWeight:600},
  avatar:{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},${C.goldD})`,color:C.bg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:14,flexShrink:0},
  // Toast
  toast:{position:"fixed",bottom:20,right:20,background:C.s1,border:`1px solid rgba(0,230,118,.3)`,borderRadius:12,padding:"12px 18px",display:"flex",alignItems:"center",gap:8,boxShadow:"0 8px 32px rgba(0,0,0,.4)",zIndex:1000,color:C.grn,fontWeight:600,animation:"toastIn .4s ease",fontSize:13},
  toastErr:{borderColor:"rgba(255,82,82,.3)",color:C.red},
};

// ═══════════════════════════════════════
// ═══  VENDAS MODULE                  ═══
// ═══════════════════════════════════════
function VendasModule({storeSales,sales,setSales,activeStore,exchanges,setExchanges,users,loggedUser,showToast,stock,setStock,getStockId,cashState,setCashState}){
  const todayStr=new Date().toISOString().split("T")[0];
  const [dateFrom,setDateFrom]=useState(todayStr);
  const [dateTo,setDateTo]=useState(todayStr);
  const [search,setSearch]=useState("");
  const [showCanceled,setShowCanceled]=useState(false);
  const [payFilter,setPayFilter]=useState(""); // filtra por forma de pagamento
  // Receipt modal
  const [receiptSale,setReceiptSale]=useState(null);
  // Cancel modal
  const [cancelModal,setCancelModal]=useState(null);
  const [authPass,setAuthPass]=useState("");
  const [authError,setAuthError]=useState("");
  // Change payment modal
  const [payModal,setPayModal]=useState(null);
  const [editPayments,setEditPayments]=useState([]);
  const payMethods=["PIX","Dinheiro","Crédito","Débito","Pix Parcelado","Crédito 2x","Crédito 3x"];

  const allSales=storeSales||[];
  const filtered=allSales.filter(s=>{
    if(s.date<dateFrom||s.date>dateTo)return false;
    if(!showCanceled&&s.status==="Cancelada")return false;
    if(payFilter){
      const pays=s.payments&&s.payments.length>0?s.payments:[{method:s.payment||"Outros",value:s.total}];
      if(!pays.some(p=>(p.method||"Outros")===payFilter))return false;
    }
    if(search){
      const q=search.toLowerCase();
      return s.customer?.toLowerCase().includes(q)||s.cupom?.toLowerCase().includes(q)||s.seller?.toLowerCase().includes(q);
    }
    return true;
  });

  const ativas=filtered.filter(s=>s.status!=="Cancelada");
  const totalRev=ativas.reduce((s,v)=>s+v.total,0);
  const totalDesc=ativas.reduce((s,v)=>s+(v.discount||0),0);
  const canceladas=filtered.filter(s=>s.status==="Cancelada").length;

  // Resumo por forma de pagamento
  const paymentSummary={};
  ativas.forEach(s=>{
    const pays=s.payments&&s.payments.length>0?s.payments:[{method:s.payment||"Outros",value:s.total}];
    pays.forEach(p=>{
      const method=p.method||"Outros";
      if(!paymentSummary[method]) paymentSummary[method]={count:0,total:0};
      paymentSummary[method].count++;
      paymentSummary[method].total+=(+p.value||0);
    });
  });
  const isMultiDay=dateFrom!==dateTo;

  // Vendas do operador logado hoje
  const minhasVendas=allSales.filter(s=>s.date===todayStr&&s.status!=="Cancelada"&&(loggedUser?.id?s.sellerId===loggedUser.id:true));
  const meuTotal=minhasVendas.reduce((s,v)=>s+v.total,0);
  const meuTicket=minhasVendas.length>0?meuTotal/minhasVendas.length:0;

  // Cancela venda com autorização via backend
  const confirmarCancelamento=async()=>{
    try{
      const r=await fetch('/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:authPass})});
      const data=await r.json();
      if(!data.authorized){setAuthError("Senha inválida ou usuário sem permissão de cancelar");return;}
      const auth=data.user;
      const canceledAt=new Date().toLocaleTimeString("pt-BR");
      setSales(prev=>{
        const n={...prev};
        n[activeStore]=(n[activeStore]||[]).map(s=>
          s.id===cancelModal.id?{...s,status:"Cancelada",canceledBy:auth.name,canceledAt}:s
        );
        return n;
      });
      // Restaura estoque dos itens cancelados
      if(cancelModal.items?.length){
        setStock(prev=>{
          const n={...prev};
          const sid=getStockId(activeStore);
          const st={...(n[sid]||{})};
          cancelModal.items.forEach(item=>{if(item.id)st[item.id]=(st[item.id]||0)+item.qty;});
          n[sid]=st;return n;
        });
      }
      // Venda cancelada simplesmente para de ser contabilizada no caixa (filtro status !== "Cancelada")
      // Não precisa registrar saída — o valor deixa de existir nos cálculos automaticamente
      api.updateSale&&api.updateSale(cancelModal.id,{status:"Cancelada",canceledBy:auth.name,canceledAt}).catch(()=>{});
      setCancelModal(null);setAuthPass("");setAuthError("");
      showToast("Venda "+cancelModal.cupom+" cancelada por "+auth.name);
    }catch(e){setAuthError("Erro ao verificar senha. Tente novamente.");}
  };

  // Abre modal de alterar pagamento
  const abrirAlterarPagamento=(sale)=>{
    setPayModal(sale);
    setEditPayments(sale.payments&&sale.payments.length>0?[...sale.payments]:[{method:sale.payment||"PIX",value:sale.total}]);
  };

  // Salva novo pagamento
  const salvarPagamento=()=>{
    const totalPago=editPayments.reduce((s,p)=>s+(+p.value||0),0);
    if(Math.abs(totalPago-payModal.total)>0.01){showToast("Total dos pagamentos ("+fmt(totalPago)+") deve ser igual ao total da venda ("+fmt(payModal.total)+")","error");return;}
    setSales(prev=>{
      const n={...prev};
      n[activeStore]=(n[activeStore]||[]).map(s=>
        s.id===payModal.id?{...s,payments:editPayments,payment:editPayments.map(p=>p.method+": "+fmt(+p.value)).join(" + ")}:s
      );
      return n;
    });
    setPayModal(null);
    showToast("Forma de pagamento atualizada!");
  };

  const statusColor=(s)=>s==="Cancelada"?C.red:s==="Concluída"?C.grn:C.gold;

  return(
    <div>
      {/* ── TOOLBAR ── */}
      <div style={S.toolbar}>
        <h3 style={{margin:0,fontSize:15}}>📋 Conferência de Vendas</h3>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);if(e.target.value>dateTo)setDateTo(e.target.value);}}
            style={{...S.inp,padding:"7px 10px",fontSize:12,width:"auto"}}/>
          <span style={{color:C.dim,fontSize:11}}>até</span>
          <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} min={dateFrom}
            style={{...S.inp,padding:"7px 10px",fontSize:12,width:"auto"}}/>
          <button style={{...S.secBtn,fontSize:10,padding:"6px 10px"}} onClick={()=>{setDateFrom(todayStr);setDateTo(todayStr);}}>Hoje</button>
        </div>
        <div style={{...S.searchBar,flex:1,maxWidth:250}}>{I.search}
          <input style={S.searchIn} placeholder="Buscar cliente, cupom, vendedor..." value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        <button style={{...S.secBtn,fontSize:11,padding:"7px 12px",borderColor:showCanceled?C.red:"",color:showCanceled?C.red:""}}
          onClick={()=>setShowCanceled(s=>!s)}>
          {showCanceled?"🙈 Ocultar":"👁 Mostrar"} canceladas {canceladas>0&&`(${canceladas})`}
        </button>
      </div>

      {/* ── MINHAS VENDAS HOJE ── */}
      {dateFrom===todayStr&&dateTo===todayStr&&<div style={{background:"linear-gradient(135deg,rgba(255,215,64,.08),rgba(255,215,64,.03))",border:`1px solid rgba(255,215,64,.25)`,borderRadius:14,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
        <div style={{fontSize:22,lineHeight:1}}>🧑‍💼</div>
        <div style={{flex:1,minWidth:160}}>
          <div style={{fontSize:11,color:C.dim,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>Minhas vendas hoje</div>
          <div style={{fontSize:13,color:C.gold,fontWeight:700}}>{loggedUser?.name||"Operador"}</div>
        </div>
        <div style={{textAlign:"center",minWidth:80}}>
          <div style={{fontSize:22,fontWeight:800,color:C.grn}}>{minhasVendas.length}</div>
          <div style={{fontSize:10,color:C.dim}}>vendas</div>
        </div>
        <div style={{textAlign:"center",minWidth:110}}>
          <div style={{fontSize:22,fontWeight:800,color:C.gold}}>{fmt(meuTotal)}</div>
          <div style={{fontSize:10,color:C.dim}}>faturamento</div>
        </div>
        <div style={{textAlign:"center",minWidth:110}}>
          <div style={{fontSize:22,fontWeight:800,color:C.blu}}>{meuTicket>0?fmt(meuTicket):"—"}</div>
          <div style={{fontSize:10,color:C.dim}}>ticket médio</div>
        </div>
      </div>}

      {/* ── RESUMO DO DIA ── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:14}}>
        {[
          {label:"Vendas Ativas",val:ativas.length,color:C.grn,icon:"✅"},
          {label:"Faturamento",val:fmt(totalRev),color:C.gold,icon:"💰"},
          {label:"Descontos",val:fmt(totalDesc),color:C.red,icon:"🏷️"},
          {label:"Ticket Médio",val:ativas.length>0?fmt(totalRev/ativas.length):"—",color:C.blu,icon:"📊"},
          {label:"Canceladas",val:canceladas,color:canceladas>0?C.red:C.dim,icon:"❌"},
        ].map(k=><div key={k.label} style={{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:12,padding:"12px 14px"}}>
          <div style={{fontSize:11,color:C.dim,marginBottom:4}}>{k.icon} {k.label}</div>
          <div style={{fontSize:18,fontWeight:800,color:k.color}}>{k.val}</div>
        </div>)}
      </div>

      {/* ── RESUMO POR FORMA DE PAGAMENTO ── */}
      {ativas.length>0&&<div style={{background:C.s1,border:`1px solid ${C.brd}`,borderRadius:14,padding:"14px 18px",marginBottom:14}}>
        <div style={{fontSize:11,fontWeight:700,color:C.dim,letterSpacing:1,marginBottom:10}}>💳 VENDAS POR FORMA DE PAGAMENTO {isMultiDay?"("+fmtDate(dateFrom)+" a "+fmtDate(dateTo)+")":"— "+fmtDate(dateFrom)}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
          {Object.entries(paymentSummary).sort((a,b)=>b[1].total-a[1].total).map(([method,data])=>{
            const colors={"PIX":C.blu,"Dinheiro":C.grn,"Crédito":C.pur,"Débito":C.gold,"Pix Parcelado":"#00ACC1","Crédito 2x":"#AB47BC","Crédito 3x":"#7E57C2"};
            const color=colors[method]||C.dim;
            const active=payFilter===method;
            return <div key={method} onClick={()=>setPayFilter(active?"":method)} style={{background:active?color+"22":color+"10",border:`2px solid ${active?color:color+"33"}`,borderRadius:10,padding:"10px 16px",minWidth:120,textAlign:"center",cursor:"pointer",transform:active?"scale(1.05)":"",transition:"all .15s"}}>
              <div style={{fontSize:18,fontWeight:800,color}}>{fmt(data.total)}</div>
              <div style={{fontSize:12,fontWeight:700,color,marginTop:2}}>{method}</div>
              <div style={{fontSize:10,color:C.dim}}>{data.count} venda{data.count>1?"s":""}</div>
              {active&&<div style={{fontSize:9,color,marginTop:3,fontWeight:700}}>✓ FILTRADO</div>}
            </div>;
          })}
          <div onClick={()=>setPayFilter("")} style={{background:payFilter?"transparent":C.gold+"10",border:`2px solid ${payFilter?"transparent":C.gold+"44"}`,borderRadius:10,padding:"10px 16px",minWidth:140,textAlign:"center",cursor:"pointer"}}>
            <div style={{fontSize:22,fontWeight:900,color:C.gold}}>{fmt(totalRev)}</div>
            <div style={{fontSize:12,fontWeight:800,color:C.gold}}>TOTAL {isMultiDay?"PERÍODO":"DIA"}</div>
            <div style={{fontSize:10,color:C.dim}}>{ativas.length} venda{ativas.length>1?"s":""}</div>
            {payFilter&&<div style={{fontSize:9,color:C.gold,marginTop:3,fontWeight:700}}>Clique para ver todas</div>}
          </div>
        </div>
      </div>}

      {/* ── TABELA DE VENDAS ── */}
      {filtered.length===0
        ?<div style={{textAlign:"center",padding:"40px 0",color:C.dim,background:C.s1,borderRadius:12,border:`1px solid ${C.brd}`}}>
            Nenhuma venda encontrada para {isMultiDay?fmtDate(dateFrom)+" a "+fmtDate(dateTo):fmtDate(dateFrom)}
          </div>
        :<div style={S.tWrap}><table style={S.table}>
          <thead><tr>
            <th style={S.th}>Cupom</th>
            <th style={S.th}>Hora</th>
            <th style={S.th}>Cliente</th>
            <th style={S.th}>Vendedor</th>
            <th style={S.th}>Itens</th>
            <th style={S.th}>Desconto</th>
            <th style={S.th}>Total</th>
            <th style={S.th}>Pagamento</th>
            <th style={S.th}>Status</th>
            <th style={S.th}>Ações</th>
          </tr></thead>
          <tbody>{filtered.map(sale=>{
            const cancelada=sale.status==="Cancelada";
            const hora=sale.created_at?new Date(sale.created_at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}):"—";
            return <tr key={sale.id} style={{...S.tr,...(cancelada?{opacity:.45,background:"rgba(255,82,82,.04)"}:{})}}>
              <td style={{...S.td,fontFamily:"monospace",fontSize:11,color:C.gold}}>{sale.cupom}</td>
              <td style={{...S.td,fontFamily:"monospace",fontSize:11,color:C.dim}}>{hora}</td>
              <td style={{...S.td,fontWeight:600}}>{sale.customer}</td>
              <td style={{...S.td,fontSize:12,color:C.dim}}>{sale.seller}</td>
              <td style={S.td}>
                <div style={{fontSize:11,maxWidth:180}}>{(sale.items||[]).map((it,i)=><div key={i}>{it.qty}x {it.name}</div>)}</div>
              </td>
              <td style={{...S.td,color:C.red,fontSize:12}}>{sale.discount>0?"-"+fmt(sale.discount):"—"}</td>
              <td style={{...S.td,...S.tdM,color:cancelada?C.dim:C.grn}}>{fmt(sale.total)}</td>
              <td style={{...S.td,fontSize:11,maxWidth:160}}>
                {sale.payments&&sale.payments.length>0
                  ?sale.payments.map((p,i)=><div key={i} style={{whiteSpace:"nowrap"}}>{p.method}: {fmt(p.value)}</div>)
                  :<span>{sale.payment}</span>
                }
              </td>
              <td style={S.td}>
                <span style={{...S.stBadge,background:`${statusColor(sale.status)}18`,color:statusColor(sale.status)}}>
                  {sale.status}{sale.canceledBy&&<span style={{fontSize:9,display:"block"}}>por {sale.canceledBy}</span>}
                </span>
              </td>
              <td style={S.td}>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {/* Reimprimir cupom */}
                  <button style={{...S.smBtn,fontSize:10,whiteSpace:"nowrap"}}
                    onClick={()=>setReceiptSale(sale)}>
                    🖨️ Reimprimir
                  </button>
                  {/* Alterar pagamento */}
                  {!cancelada&&<button style={{...S.smBtn,fontSize:10,whiteSpace:"nowrap",color:C.blu,borderColor:C.blu+"44"}}
                    onClick={()=>abrirAlterarPagamento(sale)}>
                    💳 Alterar Pag.
                  </button>}
                  {/* Cancelar */}
                  {!cancelada&&<button style={{...S.smBtn,fontSize:10,whiteSpace:"nowrap",color:C.red,borderColor:C.red+"44"}}
                    onClick={()=>{setCancelModal(sale);setAuthPass("");setAuthError("");}}>
                    ❌ Cancelar
                  </button>}
                </div>
              </td>
            </tr>;
          })}</tbody>
        </table></div>
      }

      {/* ── MODAL: REIMPRIMIR ── */}
      {receiptSale&&<ReceiptCupom sale={receiptSale} onClose={()=>setReceiptSale(null)}/>}

      {/* ── MODAL: CANCELAR VENDA ── */}
      {cancelModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>{setCancelModal(null);setAuthPass("");setAuthError("");}}>
        <div style={{background:C.s1,border:`1px solid ${C.red}44`,borderRadius:18,padding:28,width:380,maxWidth:"92%"}} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:20,textAlign:"center",marginBottom:4}}>❌</div>
          <h3 style={{margin:"0 0 6px",textAlign:"center",fontSize:16}}>Cancelar Venda</h3>
          <div style={{textAlign:"center",fontSize:13,color:C.dim,marginBottom:18}}>
            {cancelModal.cupom} • {cancelModal.customer} • <strong style={{color:C.gold}}>{fmt(cancelModal.total)}</strong>
          </div>
          <div style={{background:"rgba(255,82,82,.08)",border:"1px solid rgba(255,82,82,.2)",borderRadius:10,padding:12,marginBottom:16,fontSize:12,color:C.red}}>
            ⚠️ Esta ação requer autorização de um <strong>Administrador, Gestor ou Gerente</strong>.
          </div>
          <label style={{fontSize:11,color:C.dim,display:"block",marginBottom:6}}>SENHA DE AUTORIZAÇÃO</label>
          <input type="password" placeholder="Digite a senha do responsável"
            value={authPass} onChange={e=>{setAuthPass(e.target.value);setAuthError("");}}
            onKeyDown={e=>e.key==="Enter"&&confirmarCancelamento()}
            style={{...S.inp,width:"100%",marginBottom:8,boxSizing:"border-box"}} autoFocus/>
          {authError&&<div style={{color:C.red,fontSize:12,marginBottom:10}}>{authError}</div>}
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button style={{...S.secBtn,flex:1}} onClick={()=>{setCancelModal(null);setAuthPass("");setAuthError("");}}>Voltar</button>
            <button style={{flex:2,padding:"10px",borderRadius:10,border:"none",background:C.red,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}
              onClick={confirmarCancelamento}>Confirmar Cancelamento</button>
          </div>
        </div>
      </div>}

      {/* ── MODAL: ALTERAR PAGAMENTO ── */}
      {payModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setPayModal(null)}>
        <div style={{background:C.s1,border:`1px solid ${C.blu}44`,borderRadius:18,padding:28,width:420,maxWidth:"92%"}} onClick={e=>e.stopPropagation()}>
          <h3 style={{margin:"0 0 4px",fontSize:16}}>💳 Alterar Forma de Pagamento</h3>
          <div style={{fontSize:12,color:C.dim,marginBottom:16}}>{payModal.cupom} • {payModal.customer} • Total: <strong style={{color:C.gold}}>{fmt(payModal.total)}</strong></div>

          {editPayments.map((p,i)=><div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
            <select style={{...S.sel,flex:2}} value={p.method} onChange={e=>setEditPayments(prev=>prev.map((x,j)=>j===i?{...x,method:e.target.value}:x))}>
              {payMethods.map(m=><option key={m}>{m}</option>)}
            </select>
            <input type="number" style={{...S.inp,flex:1}} value={p.value}
              onChange={e=>setEditPayments(prev=>prev.map((x,j)=>j===i?{...x,value:e.target.value}:x))}/>
            {editPayments.length>1&&<button style={{...S.smBtn,color:C.red,borderColor:C.red+"44"}} onClick={()=>setEditPayments(prev=>prev.filter((_,j)=>j!==i))}>✕</button>}
          </div>)}

          <button style={{...S.secBtn,fontSize:11,marginBottom:16}} onClick={()=>setEditPayments(prev=>[...prev,{method:"PIX",value:0}])}>
            + Adicionar forma de pagamento
          </button>

          {(()=>{const totalPago=editPayments.reduce((s,p)=>s+(+p.value||0),0);const diff=totalPago-payModal.total;return <div style={{fontSize:12,marginBottom:16,padding:"8px 12px",borderRadius:8,background:Math.abs(diff)<0.01?"rgba(0,230,118,.08)":"rgba(255,82,82,.08)",color:Math.abs(diff)<0.01?C.grn:C.red}}>
            Total informado: <strong>{fmt(totalPago)}</strong> {Math.abs(diff)<0.01?"✅":`(diferença: ${fmt(Math.abs(diff))})`}
          </div>;})()}

          <div style={{display:"flex",gap:8}}>
            <button style={{...S.secBtn,flex:1}} onClick={()=>setPayModal(null)}>Cancelar</button>
            <button style={{...S.primBtn,flex:2,justifyContent:"center"}} onClick={salvarPagamento}>{I.check} Salvar Alteração</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
