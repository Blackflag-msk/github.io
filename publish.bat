@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Публикация книги «Переплёт»

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Не найден Node.js.
  echo  Установите его с https://nodejs.org/   (кнопка LTS), затем запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

echo  Запускаю сервер издания...
echo  Это окно нужно держать открытым, пока вы публикуете книгу.
echo  Закройте его (или нажмите Ctrl+C), когда закончите.
echo.
start "Сервер издания Переплёт" /min node serve.js

timeout /t 3 >nul
echo  Готово. Теперь в браузере нажмите «Публиковать» и затем «⇧ Жду сервер и публикую».
echo  Если страница закрыта — откройте её двойным кликом по index.html и войдите в кабинет автора.
echo.
pause
