import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

// ─── Registra o Service Worker para funcionar offline ───
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[SW] Registrado com sucesso');
        // Verifica atualizações a cada 5 minutos
        setInterval(() => reg.update(), 5 * 60 * 1000);
      })
      .catch((err) => console.warn('[SW] Falha ao registrar:', err));
  });
}
