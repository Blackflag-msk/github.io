@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Pereplet server

where node >nul 2>nul
if errorlevel 1 goto nonode

echo Starting local server for publishing...
echo Keep this window open while you publish.
echo.
start "Pereplet server" /min node serve.js

echo Waiting 3 seconds...
ping -n 4 127.0.0.1 >nul
echo Server started. Now press "Publish" in the book page.
echo If the page is closed, open index.html with a double click.
echo.
pause
exit /b 0

:nonode
echo.
echo Node.js is not installed.
echo Download it from https://nodejs.org/ (LTS button), install, then run this file again.
echo.
pause
exit /b 1
