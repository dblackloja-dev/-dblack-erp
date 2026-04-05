@echo off
echo.
echo  ==========================================
echo   D'BLACK ERP - Iniciando sistema...
echo  ==========================================
echo.
echo  Iniciando Backend (porta 3001)...
start "DBlack Backend" cmd /k "cd /d %~dp0backend && npm start"

timeout /t 3 /nobreak > nul

echo  Iniciando Frontend (porta 5173)...
start "DBlack Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 5 /nobreak > nul

echo.
echo  ==========================================
echo   SISTEMA RODANDO!
echo.
echo   Neste computador:
echo   http://localhost:5173
echo.
echo   Celular / Tablet (mesma rede Wi-Fi):
echo   http://10.3.152.93:5173
echo  ==========================================
echo.
pause
