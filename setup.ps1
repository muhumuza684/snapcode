# Sandbox IDE — one-command setup (Windows PowerShell)
# Run this from the project root: .\setup.ps1

Write-Host "Checking Docker..." -ForegroundColor Cyan
docker ps > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker isn't running. Start Docker Desktop first, then re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "Building sandbox-python image..." -ForegroundColor Cyan
docker build -t sandbox-python -f docker/python.Dockerfile docker/
if ($LASTEXITCODE -ne 0) { Write-Host "Python image build failed." -ForegroundColor Red; exit 1 }

Write-Host "Building sandbox-node image..." -ForegroundColor Cyan
docker build -t sandbox-node -f docker/node.Dockerfile docker/
if ($LASTEXITCODE -ne 0) { Write-Host "Node image build failed." -ForegroundColor Red; exit 1 }

Write-Host "Building sandbox-dart image..." -ForegroundColor Cyan
docker build -t sandbox-dart -f docker/dart.Dockerfile docker/
if ($LASTEXITCODE -ne 0) { Write-Host "Dart image build failed." -ForegroundColor Red; exit 1 }

Write-Host "Installing server dependencies..." -ForegroundColor Cyan
Push-Location server
npm install
Pop-Location

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Start the server with:  cd server; npm start" -ForegroundColor Green
Write-Host "Then open:              http://localhost:4000" -ForegroundColor Green
