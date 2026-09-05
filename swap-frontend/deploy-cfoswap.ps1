#Requires -Version 5.1
<#
.SYNOPSIS
  cfoswap.com 生产环境一键部署脚本（Njalla 45.142.141.164, Nginx）

.DESCRIPTION
  默认流程：检查本地dist -> 打包tar+MD5 -> SSH二次备份线上 -> SCP上传 -> 服务器端MD5强校验
           -> 方案2B清空 /var/www/cfoswap/* -> 解压 -> 755/644权限 -> Nginx reload
           -> 10项curl缓存头+内容验证 -> 写 deploy-log.json -> 保留最近N份备份+清理超出
  可选：-Rollback 一键回滚到上一个备份（不走tar流程，直接cp）

.EXAMPLE
  .\deploy-cfoswap.ps1                          # 完整部署（推荐）
  npm run deploy                                # 等价上面
  .\deploy-cfoswap.ps1 -DryRun                  # 只打包+算MD5，不SCP不部署
  .\deploy-cfoswap.ps1 -SkipBackup -SkipBrowser # 赶时间不备份不做浏览器截图
  .\deploy-cfoswap.ps1 -Rollback                # 一键回滚到最近备份
  npm run deploy:rollback                       # 等价上面
#>
[CmdletBinding()]
param(
    [switch]$Rollback,
    [switch]$DryRun,
    [switch]$NoBackup,
    [switch]$SkipBrowser,
    [switch]$SkipCurlVerify,
    [int]$KeepBackups = 5
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDir
try {

# ============== 🔧 配置区（写死，防写错域名/路径） ==============
$CFG = [pscustomobject]@{
    LocalDist          = Join-Path $scriptDir "dist"
    LocalTarPath       = Join-Path $env:TEMP "cfoswap-dist-deploy.tar.gz"
    RemoteSSHKey       = "C:\Users\华为\.ssh\id_ed25519"
    RemoteHost         = "45.142.141.164"
    RemoteUser         = "root"
    RemoteDeployDir    = "/var/www/cfoswap"
    RemoteTarPath      = "/tmp/cfoswap-dist-deploy.tar.gz"
    RemoteHelperPath   = "/tmp/cfoswap-deploy-helper.sh"
    PublicBaseUrl      = "https://cfoswap.com"
    KeepBackups        = [Math]::Max(0, $KeepBackups)
}
# =========================================================

function Write-Step($msg)  { Write-Host ("`n=== " + $msg + " ===") -ForegroundColor Cyan }
function Write-Info($msg)  { Write-Host ("  INFO  " + $msg) -ForegroundColor DarkGray }
function Write-Ok($msg)    { Write-Host ("  ✅  " + $msg) -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host ("  ⚠️  " + $msg) -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host ("  ❌  " + $msg) -ForegroundColor Red }
function Fail($msg, $code=1) { Write-Fail $msg; Pop-Location; exit $code }

# —— 公共：SSH/SCP 安全参数数组（避免 PowerShell 冒号解析盘符坑）
$sshCommon = @("-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes",
               "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=60",
               "-i", $CFG.RemoteSSHKey)
$sshTarget = $CFG.RemoteUser + "@" + $CFG.RemoteHost

function Invoke-SSH([string]$command) {
    Write-Verbose ("SSH> " + $command)
    # PowerShell 5.1 里 native command (ssh/scp) 往 stderr 写任何内容都会被包装成 NativeCommandError，
    # 在 $ErrorActionPreference="Stop" 下直接终止脚本。典型：nginx -t 正常的"syntax is ok"会打在stderr。
    # 修复：临时把 ErrorAction 降为 Continue 并把 stderr 合并后以普通文本方式输出，最后只靠退出码判断成败。
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & ssh @sshCommon $sshTarget $command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ }
        } | Out-Host
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($LASTEXITCODE -ne 0) { Fail ("SSH 命令执行失败 (exit=" + $LASTEXITCODE + "): " + $command) }
}
function Invoke-SCP([string]$src, [string]$dst) {
    Write-Verbose ("SCP> " + $src + " -> " + $dst)
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & scp @sshCommon $src $dst 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ }
        } | Out-Host
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($LASTEXITCODE -ne 0) { Fail ("SCP 传输失败: " + $src + " -> " + $dst) }
}

# =========================================================
# 🛑 模式 1：一键回滚 (-Rollback)
# =========================================================
if ($Rollback) {
    Write-Step "一键回滚模式：找到最近一个备份目录 -> 替换线上"
    $backups = ssh @sshCommon $sshTarget ("ls -1d " + $CFG.RemoteDeployDir + ".bak.* 2>/dev/null || true")
    if (-not $backups -or $backups.Count -eq 0) { Fail "服务器上没有任何备份目录，无法回滚" }
    $sorted = @($backups | Sort-Object -Descending)
    $latest = $sorted[0]
    Write-Info "可用备份列表（按时间倒序）"
    $showCount = [Math]::Min(5, $sorted.Count)
    for ($i=0; $i -lt $showCount; $i++) {
        $marker = if ($i -eq 0) { " ← 即将回滚到此份" } else { "" }
        Write-Host ("    [" + $i + "] " + $sorted[$i] + $marker)
    }
    Write-Host ""
    $ans = Read-Host ("确认回滚线上到 " + $latest + " ? [y/N]")
    if ($ans -notmatch '^[yY]') { Write-Warn "用户取消回滚"; Pop-Location; exit 0 }

    $DEPLOY_DIR = $CFG.RemoteDeployDir
    $rollBash = @'
set -euo pipefail
PRE_BAK="__DEPLOY_DIR__.before-rollback.$(date +%Y%m%d_%H%M%S)"
echo "先备份当前线上（回滚前）到 $PRE_BAK"
cp -a "__DEPLOY_DIR__" "$PRE_BAK"
echo "清空线上"
rm -rf "__DEPLOY_DIR__"/*
echo "拷贝 __LATEST__ -> 线上"
cp -a "__LATEST__"/* "__DEPLOY_DIR__"/
echo "权限 755/644 root:root"
find "__DEPLOY_DIR__" -type d -exec chmod 755 {} \;
find "__DEPLOY_DIR__" -type f -exec chmod 644 {} \;
chown -R root:root "__DEPLOY_DIR__"
echo "nginx -t && reload"
nginx -t >/dev/null
systemctl reload nginx
NEW_E=$(grep -oE '/assets/(index-[A-Za-z0-9_-]+.js)' "__DEPLOY_DIR__/index.html" | head -1)
echo "回滚完成，入口 JS = $NEW_E"
echo "系统状态 nginx: $(systemctl is-active nginx)"
'@
    $rollCmd = $rollBash.Replace("__DEPLOY_DIR__", $DEPLOY_DIR).Replace("__LATEST__", $latest)
    Invoke-SSH $rollCmd
    Write-Ok "回滚完成。如浏览器仍显示旧版请按 Ctrl+Shift+R 强刷。"
    Pop-Location
    exit 0
}

# =========================================================
# 🛑 前置检查
# =========================================================
Write-Step "0. 前置检查（dist 存在、SSH连通性）"
if (-not (Test-Path $CFG.LocalDist -PathType Container)) {
    Fail ("本地dist不存在: " + $CFG.LocalDist + "`n请先执行： npm run build")
}
$idxPath = Join-Path $CFG.LocalDist "index.html"
if (-not (Test-Path $idxPath)) { Fail "dist/index.html 不存在，dist是坏的，中止" }
$idxContent = Get-Content $idxPath -Raw
if ($idxContent -notmatch '\.?/assets/(index-[A-Za-z0-9_-]+\.js)') {
    Fail "dist/index.html 中没有 index-*.js 入口引用，dist疑似构建失败"
}
$LOCAL_ENTRY_JS = $Matches[1]
$LOCAL_ENTRY_CSS = ""
if ($idxContent -match '\.?/assets/(index-[A-Za-z0-9_-]+\.css)') { $LOCAL_ENTRY_CSS = $Matches[1] }
Write-Ok ("dist 就绪：入口 JS=" + $LOCAL_ENTRY_JS + "，CSS=" + $LOCAL_ENTRY_CSS)

# SSH连通性预测试
$null = ssh @sshCommon $sshTarget "echo SSH_OK"
if ($LASTEXITCODE -ne 0) { Fail ("SSH 连不上 " + $sshTarget + "，请检查 id_ed25519 权限和服务器状态") }
Write-Ok ("SSH 连通 " + $sshTarget + " 正常")

# =========================================================
# 步骤1：打包 + MD5
# =========================================================
Write-Step "步骤1：打包 dist 为 tar.gz 并计算本地 MD5"
if (Test-Path $CFG.LocalTarPath) { Remove-Item $CFG.LocalTarPath -Force -ErrorAction SilentlyContinue }
Push-Location $CFG.LocalDist
try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & tar.exe -czf $CFG.LocalTarPath .
    if ($LASTEXITCODE -ne 0) { Fail "tar.exe 打包失败" }
    $sw.Stop()
} finally { Pop-Location }
$tarInfo = Get-Item $CFG.LocalTarPath
$LOCAL_MD5 = (Get-FileHash $CFG.LocalTarPath -Algorithm MD5).Hash.ToLowerInvariant()
Write-Ok (("tar完成：{0:N2} MB，耗时 {1:N1}s，MD5={2}" -f ($tarInfo.Length/1MB), $sw.Elapsed.TotalSeconds, $LOCAL_MD5))

if ($DryRun) {
    Write-Warn "-DryRun 模式：到此停止，不上传不部署不备份"
    Write-Host ("   Tar文件：" + $CFG.LocalTarPath)
    Pop-Location
    exit 0
}

# =========================================================
# 步骤2：（可选）二次备份当前线上
# =========================================================
$NEW_BACKUP_DIR = ""
if (-not $NoBackup) {
    Write-Step "步骤2：二次备份当前线上版本"
    $DEPLOY_DIR2 = $CFG.RemoteDeployDir
    $bakBash = @'
TS=$(date +%Y%m%d_%H%M%S)
DST="__DEPLOY_DIR__.bak.$TS"
cp -a "__DEPLOY_DIR__" "$DST"
echo "$DST"
du -sh "$DST" | cut -f1
'@
    $bakCmd = $bakBash.Replace("__DEPLOY_DIR__", $DEPLOY_DIR2)
    $bakRaw = ssh @sshCommon $sshTarget $bakCmd
    if (-not $bakRaw -or $LASTEXITCODE -ne 0) { Fail "二次备份失败" }
    $lines = @(($bakRaw -split "`n") | Where-Object { $_.Trim().Length -gt 0 })
    $NEW_BACKUP_DIR = $lines[0].Trim()
    $bakSize = if ($lines.Count -ge 2) { $lines[1].Trim() } else { "?" }
    Write-Ok ("新备份路径：" + $NEW_BACKUP_DIR + "（大小 " + $bakSize + "）")
} else {
    Write-Warn "-NoBackup 已指定，跳过备份（回滚将不可用）"
}
$MODE_STR = if ($NoBackup) { "NOBACKUP" } else { "BACKUP" }

# =========================================================
# 步骤3：SCP 上传 + 服务器端 MD5 校验（强校验，不匹配立刻中止）
# =========================================================
Write-Step "步骤3：SCP 上传 tar.gz 到服务器 + 服务器端 MD5 强制匹配"
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
Invoke-SCP $CFG.LocalTarPath ($sshTarget + ":" + $CFG.RemoteTarPath)
$sw2.Stop()
Write-Ok (("上传完成：耗时 {0:N1}s" -f $sw2.Elapsed.TotalSeconds))

Write-Info ("服务器端 md5sum 校验（必须和本地 " + $LOCAL_MD5 + " 相同）")
# 注意：不要使用 ssh | awk '{print $1}'，因为 PowerShell 会在拼接字符串时把 $1 展开成空字符串导致 awk 打印整行。
# 修复：取回整行 md5sum 输出，在 PowerShell 本地拆分取第 1 段。
$REMOTE_MD5_RAW = (ssh @sshCommon $sshTarget ("md5sum """ + $CFG.RemoteTarPath + """")).Trim()
$REMOTE_MD5 = (($REMOTE_MD5_RAW -split '\s+')[0]).Trim().ToLowerInvariant()
Write-Info ("本地 MD5 = " + $LOCAL_MD5)
Write-Info ("远端 MD5 = " + $REMOTE_MD5)
if ($REMOTE_MD5 -ne $LOCAL_MD5) {
    Fail ("MD5 不匹配！立即中止，线上绝对未被触碰。`n建议：重跑脚本，如果还失败说明网络丢包。")
}
Write-Ok "MD5 完全一致 ✅ 安全，可以覆盖线上。"

# =========================================================
# 步骤4：方案2B 清空+解压+权限+Nginx reload + deploy-log.json + 备份保留
# =========================================================
Write-Step "步骤4：方案2B -> 清空旧目录 -> 解压 -> 权限 -> Nginx reload -> deploy-log -> 保留备份"

# 远端 bash helper 脚本（PS here-string 里注意：bash $ 变量 必须反引号转义为 `$）
$helper = @"
#!/bin/bash
set -euo pipefail
DEPLOY="$($CFG.RemoteDeployDir)"
TAR="$($CFG.RemoteTarPath)"
KEEP="$($CFG.KeepBackups)"
L_ENTRY_JS="$($LOCAL_ENTRY_JS)"
L_ENTRY_CSS="$($LOCAL_ENTRY_CSS)"
L_MD5="$($LOCAL_MD5)"
BAK_BEFORE="$($NEW_BACKUP_DIR)"
MODE_VAR="$($MODE_STR)"

echo "[4.1] 方案2B 清空旧目录 `$DEPLOY/*"
rm -rf "`${DEPLOY:?}"/*
echo "      清空后文件数: `$(ls -A "`$DEPLOY" | wc -l)"

echo "[4.2] 解压 tar.gz -> `$DEPLOY"
tar -xzf "`$TAR" -C "`$DEPLOY"
echo "      assets 文件数=`$(ls "`$DEPLOY/assets" 2>/dev/null | wc -l)"
NEW_IDX_ENTRY=`$(grep -oE '\.?/assets/(index-[A-Za-z0-9_-]+\.js)' "`$DEPLOY/index.html" | head -1 | sed 's|^\./|/|')
NEW_IDX_CSS=`$(grep -oE '\.?/assets/(index-[A-Za-z0-9_-]+\.css)' "`$DEPLOY/index.html" | head -1 | sed 's|^\./|/|')
echo "      解压后 index 引用 JS =`$NEW_IDX_ENTRY"
echo "      解压后 index 引用 CSS=`$NEW_IDX_CSS"
if [ "`$NEW_IDX_ENTRY" != "/assets/`$L_ENTRY_JS" ]; then
    echo "!!! FATAL: 服务器解压后的 index 引用 JS 与打包时不一致"
    echo "    打包时预期: /assets/`$L_ENTRY_JS"
    echo "    解压后实际: `$NEW_IDX_ENTRY"
    echo "    中止不重载 Nginx"
    exit 2
fi

echo "[4.3] 权限：dirs 755 / files 644 / root:root"
find "`$DEPLOY" -type d -exec chmod 755 {} \;
find "`$DEPLOY" -type f -exec chmod 644 {} \;
chown -R root:root "`$DEPLOY"
stat -c '%a %U:%G %n' "`$DEPLOY" "`$DEPLOY/index.html" "`$DEPLOY/assets"

echo "[4.4] Nginx: nginx -t 然后 reload"
nginx -t &>/dev/null
systemctl reload nginx &>/dev/null
echo "      nginx: `$(systemctl is-active nginx)"

echo "[4.5] 写 deploy-log.json"
TS_ISO=`$(date -Iseconds)
cat > "`$DEPLOY/deploy-log.json" <<'ENDJSONMARK'
{"deployed_at_utc_iso8601":"__TS__","entry_js":"__E__","entry_css":"__C__","tar_md5":"__M__","backup_dir_before_deploy":"__B__","mode":"__MODE__","deploy_script":"deploy-cfoswap.ps1"}
ENDJSONMARK
# 用 sed 替换占位符，避免 PowerShell 再次展开 $
sed -i "s|__TS__|`$TS_ISO|; s|__E__|`$NEW_IDX_ENTRY|; s|__C__|`$NEW_IDX_CSS|; s|__M__|`$L_MD5|; s|__B__|`$BAK_BEFORE|; s|__MODE__|`$MODE_VAR|" "`$DEPLOY/deploy-log.json"
chmod 644 "`$DEPLOY/deploy-log.json"
echo "      写入 deploy-log.json 成功"

echo "[4.6] 保留最近 `$KEEP 份备份，超出删除最老的"
if [ "`$KEEP" -gt 0 ]; then
    BAK_LIST=`$(ls -1d $($CFG.RemoteDeployDir).bak.* 2>/dev/null | sort -V || true)`
    TOTAL=`$(echo "`$BAK_LIST" | sed '/^$/d' | wc -l)`
    echo "      现有备份=`$TOTAL / 保留上限=`$KEEP"
    if [ "`$TOTAL" -gt "`$KEEP" ]; then
        DROP_N=`$((TOTAL - KEEP))`
        echo "      删除最老的 `$DROP_N 份"
        echo "`$BAK_LIST" | sed '/^$/d' | head -n "`$DROP_N" | while read -r OLD; do
            echo "        rm -rf `$OLD"
            rm -rf "`$OLD"
        done
        echo "      清理后剩余备份数: `$((TOTAL - DROP_N))"
    fi
fi

echo "[4.7] 清理 /tmp 临时 tar"
rm -f "`$TAR"
echo "DONE STEP4"
"@
$tmpHelper = Join-Path $env:TEMP "cfoswap-deploy-helper.sh"
# 强制写入 Unix LF 换行符，避免 bash 在 Linux 上因 CRLF 报 set: pipefail: invalid option
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$lfContent = $helper -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($tmpHelper, $lfContent, $utf8NoBom)
Invoke-SCP $tmpHelper ($sshTarget + ":" + $CFG.RemoteHelperPath)
Invoke-SSH ("chmod +x """ + $CFG.RemoteHelperPath + """ && bash """ + $CFG.RemoteHelperPath + """")
Remove-Item $tmpHelper -Force -ErrorAction SilentlyContinue
Remove-Item $CFG.LocalTarPath -Force -ErrorAction SilentlyContinue

# =========================================================
# 步骤5：curl 公网验证 10 项
# =========================================================
if ($SkipCurlVerify) {
    Write-Warn "-SkipCurlVerify：跳过公网验证，请自行打开页面确认"
} else {
    Write-Step ("步骤5：公网 curl 验证（新入口 " + $LOCAL_ENTRY_JS + "）")
    $h = @{"Cache-Control"="no-cache"; "Pragma"="no-cache"; "Accept-Encoding"=""}
    $checks = New-Object System.Collections.Generic.List[object]
    function Add-Check($name, $path, $minLen, $cacheMatch, [switch]$ExactIndexHtmlEntry) {
        $o = [pscustomobject]@{name=$name;path=$path;minLen=$minLen;cacheMatch=$cacheMatch;ExactIndex=$ExactIndexHtmlEntry.IsPresent}
        $checks.Add($o)
    }
    # 动态从本地 dist/index.html 提取所有 /assets/*.js 和 /assets/*.css 引用做验证
    # （不再硬编码 ethers/react-router 文件名，升级依赖也不会失效）
    Add-Check "index.html"      "/"                                                      2000  "no-store"            -ExactIndexHtmlEntry
    Add-Check "entry JS"        ("/assets/" + $LOCAL_ENTRY_JS)                           1000  "max-age=31536000"
    Add-Check "entry CSS"       ("/assets/" + $LOCAL_ENTRY_CSS)                          1000  "max-age=31536000"
    # 解析 index.html 所有 <script src="/assets/*.js"> 和 <link href="/assets/*.css"> 全部加验证
    $scriptMatches = [regex]::Matches($idxContent, '(?:src|href)="(\.?/assets/[^"]+\.(?:js|css))"') | ForEach-Object { $v = $_.Groups[1].Value; if ($v.StartsWith('./')) { $v = $v.Substring(1) }; $v } | Select-Object -Unique
    $i = 0
    foreach ($assRef in $scriptMatches) {
        if ($assRef -eq ("/assets/" + $LOCAL_ENTRY_JS) -or $assRef -eq ("/assets/" + $LOCAL_ENTRY_CSS)) { continue } # entry 已验证
        $i++
        $minLen = if ($assRef -match '\.css$') { 500 } else { 1 }  # ethers 空 js chunk 只有 1 byte，所以 minLen=1 即可
        $dispName = "asset-" + $i + " " + ($assRef -replace '/assets/', '')
        if ($dispName.Length -gt 20) { $dispName = $dispName.Substring(0,20) }
        Add-Check $dispName $assRef $minLen "max-age=31536000"
    }
    Add-Check "logo.png"        "/img/logo.png"                                          1000  "public"
    $passed=0; $failed=0
    foreach ($c in $checks) {
        try {
            $uri = $CFG.PublicBaseUrl + $c.path
            $r = Invoke-WebRequest -Uri $uri -Headers $h -UseBasicParsing
            $code = $r.StatusCode
            $bodyLen = if ($r.Content) { $r.Content.Length } else { 0 }
            $cc = ($r.Headers['Cache-Control'] -join ', ')
            $ok = ($code -eq 200) -and ($bodyLen -ge $c.minLen) -and ($cc -match [regex]::Escape($c.cacheMatch))
            if ($ok -and $c.ExactIndex) {
                $jsMatch = [regex]::Match($r.Content, '\.?/assets/(index-[A-Za-z0-9_-]+\.js)')
                if (-not $jsMatch.Success) { $ok = $false; Write-Warn "  index.html 未找到入口 JS 引用" }
                elseif ($jsMatch.Groups[1].Value -ne $LOCAL_ENTRY_JS) {
                    $ok = $false
                    Write-Warn ("  index.html 引用错误入口？预期=" + $LOCAL_ENTRY_JS + " / 实际=" + $jsMatch.Groups[1].Value)
                }
            }
            if ($ok) {
                $passed++
                Write-Ok ("{0,-18} code={1}, body={2,-8} CC={3}" -f $c.name, $code, $bodyLen, $cc)
            } else {
                $failed++
                Write-Fail ("{0,-18} code={1}, body={2} CC='{3}' ~需包含'{4}'" -f $c.name, $code, $bodyLen, $cc, $c.cacheMatch)
            }
        } catch {
            $failed++
            Write-Fail ("{0,-18} EXCEPTION: {1}" -f $c.name, $_.Exception.Message)
        }
    }
    # deploy-log.json 内容验证
    try {
        $dl = Invoke-RestMethod -Uri ($CFG.PublicBaseUrl + "/deploy-log.json") -Headers $h
        if ($dl.entry_js -match [regex]::Escape($LOCAL_ENTRY_JS)) {
            $passed++
            Write-Ok ("deploy-log.json 匹配: entry_js={0}, 时间={1}" -f $dl.entry_js, $dl.deployed_at_utc_iso8601)
        } else {
            $failed++
            Write-Fail ("deploy-log.json entry_js={0} 与本次入口 {1} 不匹配" -f $dl.entry_js, $LOCAL_ENTRY_JS)
        }
    } catch {
        $failed++
        Write-Fail ("deploy-log.json 读失败: " + $_.Exception.Message)
    }
    Write-Host ""
    Write-Host ("  Step5 curl 汇总：passed={0}, failed={1}" -f $passed, $failed)
    if ($failed -gt 0) {
        Write-Warn "验证有失败项，但线上已经覆盖。建议用 -Rollback 回滚或手动检查页面。"
    } else {
        Write-Ok "公网全部验证通过 ✅"
    }
}

# =========================================================
# 步骤6：可选浏览器验证
# =========================================================
if ($SkipBrowser) {
    Write-Warn "-SkipBrowser：不打开浏览器"
} else {
    Write-Step "步骤6：浏览器验证（提示）"
    Write-Info ("请访问： " + $CFG.PublicBaseUrl + "?v=deploy_" + (Get-Date -Format "HHmmss"))
    Write-Info "按 Ctrl+Shift+R 强刷一次，检查页面兑换/流动性/CFO农场正常渲染"
    Write-Info "验证通过的标志：Console 0 Error，Network 里实际加载的入口 JS 为 $LOCAL_ENTRY_JS"
}

# 收尾
Write-Host ""
Write-Step "部署完成！"
Write-Host ("  线上入口 JS = " + $LOCAL_ENTRY_JS) -ForegroundColor Green
Write-Host ("  线上 CSS     = " + $LOCAL_ENTRY_CSS) -ForegroundColor Green
Write-Host ("  访问地址     = " + $CFG.PublicBaseUrl) -ForegroundColor Green
if (-not $NoBackup) { Write-Host ("  部署前备份   = " + $NEW_BACKUP_DIR + " （出问题跑 .\deploy-cfoswap.ps1 -Rollback 一键回滚）") -ForegroundColor Green }
Write-Host ("  版本追溯     = " + $CFG.PublicBaseUrl + "/deploy-log.json") -ForegroundColor Green
Write-Host ("  一键快捷部署 = npm run deploy") -ForegroundColor Green
Write-Host ("  一键快捷回滚 = npm run deploy:rollback") -ForegroundColor Green

} finally {
    Pop-Location
}
