# ============================================================
# Cfoswap Foundry 部署服务 — 一键启动脚本
# 用法：
#   1) 第一次运行（没装依赖）：右键 - 使用 PowerShell 运行
#      会自动 cd 到 foundry 目录、npm install、启动服务
#   2) 以后每次：双击本脚本即可
# 服务地址：http://127.0.0.1:3011（部署服务专用；3001 是 SWAP 主前端，勿占用）
# ============================================================
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "`n[1/3] 检查依赖 (node_modules)..." -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
    Write-Host "   首次启动，正在 npm install（Express + CORS）..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
} else {
    Write-Host "   node_modules 已存在，跳过安装" -ForegroundColor Green
}

Write-Host "`n[2/3] 检查 forge/cast 可执行文件..." -ForegroundColor Cyan
$forgeExe = "C:\Users\华为\foundry\foundry_v1.8.1_win32_amd64\forge.exe"
$castExe  = "C:\Users\华为\foundry\foundry_v1.8.1_win32_amd64\cast.exe"
if (-not (Test-Path $forgeExe)) { throw "找不到 forge.exe: $forgeExe" }
if (-not (Test-Path $castExe))  { throw "找不到 cast.exe: $castExe" }
Write-Host "   forge: OK" -ForegroundColor Green
Write-Host "   cast : OK" -ForegroundColor Green

Write-Host "`n[3/3] 启动服务 (http://127.0.0.1:3011) ..." -ForegroundColor Cyan
Write-Host "   关闭此窗口即停止服务" -ForegroundColor DarkGray
Write-Host "   然后在浏览器打开 FoundryDeploy 页面即可开始部署`n" -ForegroundColor Yellow
node deploy-server.js
