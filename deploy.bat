@echo off
setlocal

rem Configure target outside the repo to avoid hardcoding internal host details.
if "%DEPLOY_HOST%"=="" set "DEPLOY_HOST=your-server"
if "%DEPLOY_USER%"=="" set "DEPLOY_USER=your-user"
if "%DEPLOY_PATH%"=="" set "DEPLOY_PATH=~/amc"
if "%REMOTE_ARCHIVE%"=="" set "REMOTE_ARCHIVE=~/deployment.tar"

if "%DEPLOY_HOST%"=="your-server" (
  echo Please set DEPLOY_HOST before running this script.
  echo Example:
  echo   set DEPLOY_HOST=example.internal
  echo   set DEPLOY_USER=ubuntu
  echo   deploy.bat
  exit /b 1
)

echo Packaging files (excluding node_modules)...
tar -cvf deployment.tar --exclude "node_modules" --exclude ".git" --exclude ".idea" --exclude "dist" --exclude "deployment.tar" .

echo Uploading to %DEPLOY_USER%@%DEPLOY_HOST%...
scp deployment.tar %DEPLOY_USER%@%DEPLOY_HOST%:%REMOTE_ARCHIVE%
if errorlevel 1 exit /b 1

echo Extracting and Deploying...
ssh %DEPLOY_USER%@%DEPLOY_HOST% "mkdir -p %DEPLOY_PATH% && tar -xvf %REMOTE_ARCHIVE% -C %DEPLOY_PATH% && rm %REMOTE_ARCHIVE% && cd %DEPLOY_PATH% && docker compose up -d --build"
if errorlevel 1 exit /b 1

echo Cleaning up local archive...
del deployment.tar

echo Deployment complete!
pause
