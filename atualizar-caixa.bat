@echo off
title D'Black ERP — Atualizando Caixa...
echo.
echo   ========================================
echo   D'Black ERP — Atualizacao do Caixa
echo   ========================================
echo.
echo   Baixando versao mais recente...
echo.
powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/dblackloja-dev/-dblack-erp/main/caixa-local.js' -OutFile 'caixa-local.js'"
echo.
if %ERRORLEVEL% EQU 0 (
  echo   ========================================
  echo   Atualizado com sucesso!
  echo.
  echo   Agora feche esta janela e abra
  echo   o "iniciar-caixa.bat" novamente.
  echo   ========================================
) else (
  echo   ERRO: Sem internet ou falha no download.
  echo   Verifique a conexao e tente novamente.
)
echo.
pause
