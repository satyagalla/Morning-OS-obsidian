@echo off
cd /d "%~dp0.."
call agent\.venv\Scripts\activate.bat
python -m agent.main
