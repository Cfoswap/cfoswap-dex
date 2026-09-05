# ============================================================
# Cfoswap 协议一键部署脚本 (Foundry + PowerShell)
#
# 部署顺序：
#   Phase A: 5 个路由库合约 (Dag/SmartSwap/SwapWrap/Unxswap/UnxswapV3 Router)
#   Phase B: 3 个独立业务合约 (CfoSwapToken, CfoMiningPool, CfoSwapMining)
#   Phase C: CfoswapRouter (链接 Phase A 的 5 个库)
#   Phase D: 11 条绑定交易 (核心功能 + 所有权转移)
#   Phase E: Sourcify / BscScan 开源验证 (可选)
# ============================================================
#Requires -Version 5.1

param(
    [switch]$SkipVerify,   # 跳过开源验证
    [switch]$SkipBind,     # 跳过绑定交易
    [switch]$DryRun        # 只显示命令不执行
)

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------
# 0. 工具路径配置
# ------------------------------------------------------------
$FORGE  = "C:\Users\华为\foundry\foundry_v1.8.1_win32_amd64\forge.exe"
$CAST   = "C:\Users\华为\foundry\foundry_v1.8.1_win32_amd64\cast.exe"

# ------------------------------------------------------------
# 1. 加载 .env 环境变量
# ------------------------------------------------------------
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Write-Host "`n[INFO] 加载配置文件: $envFile" -ForegroundColor Cyan
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $idx = $line.IndexOf("=")
            $k = $line.Substring(0, $idx).Trim()
            $v = $line.Substring($idx + 1).Trim().Trim('"', "'")
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
} else {
    Write-Host "`n[WARN] 未找到 .env 文件，将使用系统环境变量" -ForegroundColor Yellow
}

# ---- 兼容 PS 5.1 的辅助函数 ----
function Get-EnvStr([string]$name, [string]$default = "") {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}
function Get-EnvInt([string]$name, [int]$default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return [int]$v
}

# 必填配置
$PRIVATE_KEY      = [Environment]::GetEnvironmentVariable("PRIVATE_KEY")
$RPC_URL          = Get-EnvStr "RPC_URL"          "https://bsc-dataseed.binance.org/"
$CHAIN_ID         = Get-EnvStr "CHAIN_ID"         "56"
$BSCSCAN_API_KEY  = Get-EnvStr "BSCSCAN_API_KEY"  ""

# 可选：Gnosis Safe 多签地址（用于转移所有权，留空则跳过）
$SAFE_ADDRESS     = Get-EnvStr "SAFE_ADDRESS"     ""

# === 业务参数 (从环境变量读取，用户友好单位) ===
# Router Owner（默认用部署者）
$ROUTER_OWNER     = [Environment]::GetEnvironmentVariable("ROUTER_OWNER")

# CfoSwapToken 税费接收 3 地址 & 比例 (40%/30%/30% → 内部转 bp)
$TAX_WALLET_1     = [Environment]::GetEnvironmentVariable("TAX_WALLET_1")
$TAX_WALLET_2     = [Environment]::GetEnvironmentVariable("TAX_WALLET_2")
$TAX_WALLET_3     = [Environment]::GetEnvironmentVariable("TAX_WALLET_3")
$TAX_SHARE_1_PCT  = Get-EnvInt "TAX_SHARE_1_PCT" 40
$TAX_SHARE_2_PCT  = Get-EnvInt "TAX_SHARE_2_PCT" 30
$TAX_SHARE_3_PCT  = Get-EnvInt "TAX_SHARE_3_PCT" 30

# CfoMiningPool 助力费接收地址
$BOOST_FEE_RECIPIENT = [Environment]::GetEnvironmentVariable("BOOST_FEE_RECIPIENT")

# CfoswapRouter 平台费 3 地址 & 比例 (40%/30%/30% → 内部转 bp)
$PLATFORM_WALLET_1     = [Environment]::GetEnvironmentVariable("PLATFORM_WALLET_1")
$PLATFORM_WALLET_2     = [Environment]::GetEnvironmentVariable("PLATFORM_WALLET_2")
$PLATFORM_WALLET_3     = [Environment]::GetEnvironmentVariable("PLATFORM_WALLET_3")
$PLATFORM_SHARE_1_PCT  = Get-EnvInt "PLATFORM_SHARE_1_PCT" 40
$PLATFORM_SHARE_2_PCT  = Get-EnvInt "PLATFORM_SHARE_2_PCT" 30
$PLATFORM_SHARE_3_PCT  = Get-EnvInt "PLATFORM_SHARE_3_PCT" 30

# 主矿池 vesting 天数 (默认 365 天，内部转秒)
$VESTING_DAYS = Get-EnvInt "VESTING_DAYS" 365

# 验证必填
if ([string]::IsNullOrWhiteSpace($PRIVATE_KEY)) { Write-Error "缺少 PRIVATE_KEY 环境变量"; exit 1 }

# ------------------------------------------------------------
# 2. 工具函数
# ------------------------------------------------------------
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Write-SubStep($msg) { Write-Host "    -> $msg" -ForegroundColor DarkGray }
function Write-OK($msg)  { Write-Host "   OK: $msg" -ForegroundColor Green }
function Write-Err($msg) { Write-Host "  ERR: $msg" -ForegroundColor Red }

# 百分比 → 基点 (1% = 100bp)
function Pct-ToBp([int]$pct) { return $pct * 100 }

# ---- DryRun 用的假地址/哈希生成 ----
$script:dryFakeCounter = 0
function New-FakeAddr {
    $script:dryFakeCounter++
    return "0x{0:X40}" -f $script:dryFakeCounter
}
function New-FakeHash {
    return "0x" + "F" * 63
}

# 执行外部命令并返回输出
function Invoke-Cmd([string]$exe, [string[]]$args, [switch]$ReturnOutput) {
    Write-SubStep "$exe $($args -join ' ')"
    if ($DryRun) { return "" }
    $output = & $exe @args 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Err "命令执行失败 (exit=$code)"
        Write-Host $output -ForegroundColor Red
        throw "命令失败: $exe $($args -join ' ')"
    }
    if ($ReturnOutput) { return ($output | Out-String).Trim() }
    Write-Host $output
}

# 部署合约: Forge-Deploy <ContractPath:Name> [ConstructorArgs...]
function Forge-Deploy {
    param(
        [Parameter(Mandatory)][string]$Contract,
        [string[]]$ConstructorArgs = @(),
        [string[]]$LibrariesArg = @(),
        [switch]$Verify
    )
    $forgeArgs = @("create", "--rpc-url", $RPC_URL, "--private-key", $PRIVATE_KEY, "--chain-id", $CHAIN_ID)
    if ($LibrariesArg.Count -gt 0) {
        $forgeArgs += @("--libraries", ($LibrariesArg -join ","))
    }
    $forgeArgs += @($Contract)
    if ($ConstructorArgs.Count -gt 0) {
        $forgeArgs += @("--constructor-args") + $ConstructorArgs
    }
    if ($Verify -and -not $SkipVerify) {
        $forgeArgs += @("--verify")
        if ($BSCSCAN_API_KEY) { $forgeArgs += @("--verifier-api-key", $BSCSCAN_API_KEY) }
    }
    $output = Invoke-Cmd $FORGE $forgeArgs -ReturnOutput
    if ($DryRun) {
        return @{ Address = (New-FakeAddr); TxHash = (New-FakeHash); Raw = "[DryRun] no output" }
    }
    # 从输出中提取部署地址和交易哈希
    $deployedMatch = [regex]::Match($output, "Deployed to:\s*(0x[a-fA-F0-9]{40})")
    $txHashMatch   = [regex]::Match($output, "##\s*(0x[a-fA-F0-9]{64})")
    if (-not $deployedMatch.Success) {
        # 备用模式：找 "to:" 或直接扫最后一个 0x40
        $allAddrs = [regex]::Matches($output, "0x[a-fA-F0-9]{40}")
        if ($allAddrs.Count -ge 1) {
            $deployedAddr = $allAddrs[$allAddrs.Count - 1].Value
        } else { throw "无法从 forge 输出解析部署地址`n$output" }
    } else { $deployedAddr = $deployedMatch.Groups[1].Value }
    $txHash = if ($txHashMatch.Success) { $txHashMatch.Groups[1].Value } else { "" }
    return @{ Address = $deployedAddr; TxHash = $txHash; Raw = $output }
}

# 发送绑定交易: Cast-Send <ContractAddr> <Signature> [Args...]
function Cast-Send {
    param(
        [Parameter(Mandatory)][string]$To,
        [Parameter(Mandatory)][string]$Sig,
        [string[]]$FnArgs = @()
    )
    $castArgs = @("send", "--rpc-url", $RPC_URL, "--private-key", $PRIVATE_KEY, "--chain-id", $CHAIN_ID, $To, $Sig)
    if ($FnArgs.Count -gt 0) { $castArgs += $FnArgs }
    $output = Invoke-Cmd $CAST $castArgs -ReturnOutput
    if ($DryRun) {
        return @{ TxHash = (New-FakeHash); Raw = "[DryRun] no output" }
    }
    # 提取交易哈希
    $txMatch = [regex]::Match($output, "(0x[a-fA-F0-9]{64})")
    return @{ TxHash = if ($txMatch.Success) { $txMatch.Groups[1].Value } else { "" }; Raw = $output }
}

# 保存部署结果到 JSON
function Save-Addresses($data) {
    $outFile = Join-Path $PSScriptRoot "deployed-addresses.json"
    $data | ConvertTo-Json -Depth 10 | Set-Content -Path $outFile -Encoding UTF8
    Write-OK "部署结果已保存: $outFile"
}

# ------------------------------------------------------------
# 3. 预检查：从私钥获取部署者地址
# ------------------------------------------------------------
Write-Step "阶段 0: 预检查"
$deployerAddr = Invoke-Cmd $CAST @("wallet", "address", "--private-key", $PRIVATE_KEY) -ReturnOutput
if ($DryRun -or [string]::IsNullOrWhiteSpace($deployerAddr)) {
    $deployerAddr = "0x1111111111111111111111111111111111111111"
}
Write-Host "   部署者地址: $deployerAddr" -ForegroundColor Cyan

# 如果没单独填 ROUTER_OWNER / TAX_WALLET / BOOST / PLATFORM_WALLET，默认用部署者
if ([string]::IsNullOrWhiteSpace($ROUTER_OWNER))        { $ROUTER_OWNER = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($TAX_WALLET_1))        { $TAX_WALLET_1 = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($TAX_WALLET_2))        { $TAX_WALLET_2 = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($TAX_WALLET_3))        { $TAX_WALLET_3 = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($BOOST_FEE_RECIPIENT)) { $BOOST_FEE_RECIPIENT = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($PLATFORM_WALLET_1))   { $PLATFORM_WALLET_1 = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($PLATFORM_WALLET_2))   { $PLATFORM_WALLET_2 = $deployerAddr }
if ([string]::IsNullOrWhiteSpace($PLATFORM_WALLET_3))   { $PLATFORM_WALLET_3 = $deployerAddr }

# 比例校验
$taxSum = $TAX_SHARE_1_PCT + $TAX_SHARE_2_PCT + $TAX_SHARE_3_PCT
if ($taxSum -ne 100) { Write-Error "税费比例之和必须 = 100%，当前 $taxSum%"; exit 1 }
$platformSum = $PLATFORM_SHARE_1_PCT + $PLATFORM_SHARE_2_PCT + $PLATFORM_SHARE_3_PCT
if ($platformSum -ne 100) { Write-Error "平台费比例之和必须 = 100%，当前 $platformSum%"; exit 1 }

Write-Host "   主矿池 Vesting: $VESTING_DAYS 天 ($($VESTING_DAYS * 86400) 秒)" -ForegroundColor Cyan
Write-Host "   税费分配:   Wallet1=$TAX_WALLET_1(${TAX_SHARE_1_PCT}%) Wallet2=$TAX_WALLET_2(${TAX_SHARE_2_PCT}%) Wallet3=$TAX_WALLET_3(${TAX_SHARE_3_PCT}%)" -ForegroundColor DarkCyan
Write-Host "   平台费分配: Wallet1=$PLATFORM_WALLET_1(${PLATFORM_SHARE_1_PCT}%) Wallet2=$PLATFORM_WALLET_2(${PLATFORM_SHARE_2_PCT}%) Wallet3=$PLATFORM_WALLET_3(${PLATFORM_SHARE_3_PCT}%)" -ForegroundColor DarkCyan
Write-Host "   助力费地址: $BOOST_FEE_RECIPIENT" -ForegroundColor DarkCyan
if ($SAFE_ADDRESS) { Write-Host "   多签Safe:    $SAFE_ADDRESS (部署后转移所有权)" -ForegroundColor Yellow }
else              { Write-Host "   多签Safe:    未设置 (跳过所有权转移)" -ForegroundColor DarkGray }

# ------------------------------------------------------------
# 4. Phase A: 5 个路由库合约
# ------------------------------------------------------------
Write-Step "阶段 A: 部署 5 个路由库合约"

$libSpecs = @(
    @{ Key = "DagRouter";       Contract = "src/router/router/DagRouter.sol:DagRouter" },
    @{ Key = "SmartSwapRouter"; Contract = "src/router/router/SmartSwapRouter.sol:SmartSwapRouter" },
    @{ Key = "SwapWrapRouter";  Contract = "src/router/router/SwapWrapRouter.sol:SwapWrapRouter" },
    @{ Key = "UnxswapRouter";   Contract = "src/router/router/UnxswapRouter.sol:UnxswapRouter" },
    @{ Key = "UnxswapV3Router"; Contract = "src/router/router/UnxswapV3Router.sol:UnxswapV3Router" }
)

$libs = @{}
foreach ($spec in $libSpecs) {
    Write-Host "`n   [A-$($libSpecs.IndexOf($spec)+1)/5] $($spec.Key)" -ForegroundColor Cyan
    $res = Forge-Deploy -Contract $spec.Contract -Verify:(-not $SkipVerify)
    $libs[$spec.Key] = @{ Address = $res.Address; TxHash = $res.TxHash }
    Write-OK "$($spec.Key) -> $($res.Address)"
}

# 生成库链接参数: file.sol:LibName:0x...
$libPathMap = @{
    "DagRouter"       = "src/router/router/DagRouter.sol"
    "SmartSwapRouter" = "src/router/router/SmartSwapRouter.sol"
    "SwapWrapRouter"  = "src/router/router/SwapWrapRouter.sol"
    "UnxswapRouter"   = "src/router/router/UnxswapRouter.sol"
    "UnxswapV3Router" = "src/router/router/UnxswapV3Router.sol"
}
$librariesArg = foreach ($k in $libs.Keys) {
    "$($libPathMap[$k]):$k`:$($libs[$k].Address)"
}

# ------------------------------------------------------------
# 5. Phase B: 3 个独立业务合约
# ------------------------------------------------------------
Write-Step "阶段 B: 部署 3 个独立业务合约"

# B1: CfoSwapToken (无构造参数)
Write-Host "`n   [B-1/3] CfoSwapToken (Chief Financial Officer / CFO)" -ForegroundColor Cyan
$token = Forge-Deploy -Contract "src/token/CfoSwapToken.sol:CfoSwapToken" -Verify:(-not $SkipVerify)
Write-OK "CfoSwapToken -> $($token.Address)"

# B2: CfoMiningPool (无构造参数)
Write-Host "`n   [B-2/3] CfoMiningPool (矿池工厂)" -ForegroundColor Cyan
$poolFactory = Forge-Deploy -Contract "src/mining/MiningPools.sol:CfoMiningPool" -Verify:(-not $SkipVerify)
Write-OK "CfoMiningPool -> $($poolFactory.Address)"

# B3: CfoSwapMining (vestingDuration 秒)
$vestingSeconds = $VESTING_DAYS * 86400
Write-Host "`n   [B-3/3] CfoSwapMining (vesting=$VESTING_DAYS 天 = $vestingSeconds 秒)" -ForegroundColor Cyan
$mining = Forge-Deploy -Contract "src/mining/CfoSwapMining.sol:CfoSwapMining" -ConstructorArgs @($vestingSeconds) -Verify:(-not $SkipVerify)
Write-OK "CfoSwapMining -> $($mining.Address)"

# ------------------------------------------------------------
# 6. Phase C: CfoswapRouter (需要链接 5 个库)
# ------------------------------------------------------------
Write-Step "阶段 C: 部署 CfoswapRouter (链接 5 个路由库)"

$feeRecipients = @($PLATFORM_WALLET_1, $PLATFORM_WALLET_2, $PLATFORM_WALLET_3)
$feeSharesBp   = @((Pct-ToBp $PLATFORM_SHARE_1_PCT), (Pct-ToBp $PLATFORM_SHARE_2_PCT), (Pct-ToBp $PLATFORM_SHARE_3_PCT))

# cast 编码数组类型参数时，每个元素单独传值（按位置展开）
# constructor(address _owner, address[3] memory feeRecipients, uint256[3] memory feeShares)
$routerArgs = @(
    $ROUTER_OWNER,
    $feeRecipients[0], $feeRecipients[1], $feeRecipients[2],
    $feeSharesBp[0],   $feeSharesBp[1],   $feeSharesBp[2]
)

Write-Host "   Owner:       $ROUTER_OWNER" -ForegroundColor Cyan
Write-Host "   库链接数:    $($librariesArg.Count)" -ForegroundColor Cyan
$router = Forge-Deploy -Contract "src/router/DexRouter.sol:CfoswapRouter" `
    -ConstructorArgs $routerArgs `
    -LibrariesArg $librariesArg `
    -Verify:(-not $SkipVerify)
Write-OK "CfoswapRouter -> $($router.Address)"

# ------------------------------------------------------------
# 7. Phase D: 11 条绑定交易
# ------------------------------------------------------------
if ($SkipBind) {
    Write-Host "`n[WARN] 已跳过绑定交易 (--SkipBind)" -ForegroundColor Yellow
} else {
    Write-Step "阶段 D: 执行 11 条绑定交易"

    # 把比例转 bp
    $taxSharesBp = @((Pct-ToBp $TAX_SHARE_1_PCT), (Pct-ToBp $TAX_SHARE_2_PCT), (Pct-ToBp $TAX_SHARE_3_PCT))

    $binds = [System.Collections.Generic.List[object]]::new()

    # ---- D1-D3: CfoSwapToken 绑定 ----
    # D1: setTeamDistribution(address[3] wallets, uint256[3] sharesBp)
    $binds.Add(@{ Name = "D1. Token.setTeamDistribution (税费 3 地址 40/30/30)"
                  To   = $token.Address
                  Sig  = "setTeamDistribution(address[3],uint256[3])"
                  Args = @($TAX_WALLET_1,$TAX_WALLET_2,$TAX_WALLET_3, $taxSharesBp[0],$taxSharesBp[1],$taxSharesBp[2]) })

    # D2: setMainMiningContract(address) —— 让代币知道主挖矿合约（用于 mint 权限）
    $binds.Add(@{ Name = "D2. Token.setMainMiningContract (指向 CfoSwapMining)"
                  To   = $token.Address
                  Sig  = "setMainMiningContract(address)"
                  Args = @($mining.Address) })

    # D3: setTaxEnabled(bool) —— 开交易税（默认开）
    $binds.Add(@{ Name = "D3. Token.setTaxEnabled(true) (开启交易税)"
                  To   = $token.Address
                  Sig  = "setTaxEnabled(bool)"
                  Args = @("true") })

    # ---- D4-D6: CfoMiningPool 绑定 ----
    # D4: setCfoSwapToken(address)
    $binds.Add(@{ Name = "D4. CfoMiningPool.setCfoSwapToken"
                  To   = $poolFactory.Address
                  Sig  = "setCfoSwapToken(address)"
                  Args = @($token.Address) })

    # D5: setCfoSwapMining(address)
    $binds.Add(@{ Name = "D5. CfoMiningPool.setCfoSwapMining"
                  To   = $poolFactory.Address
                  Sig  = "setCfoSwapMining(address)"
                  Args = @($mining.Address) })

    # D6: setBoostFeeRecipient(address) —— 助力费接收者
    $binds.Add(@{ Name = "D6. CfoMiningPool.setBoostFeeRecipient"
                  To   = $poolFactory.Address
                  Sig  = "setBoostFeeRecipient(address)"
                  Args = @($BOOST_FEE_RECIPIENT) })

    # ---- D7-D8: CfoSwapMining 绑定 ----
    # D7: setCfoSwapToken(address)
    $binds.Add(@{ Name = "D7. CfoSwapMining.setCfoSwapToken"
                  To   = $mining.Address
                  Sig  = "setCfoSwapToken(address)"
                  Args = @($token.Address) })

    # D8: setMiningPoolFactory(address)
    $binds.Add(@{ Name = "D8. CfoSwapMining.setMiningPoolFactory"
                  To   = $mining.Address
                  Sig  = "setMiningPoolFactory(address)"
                  Args = @($poolFactory.Address) })

    # ---- D9: CfoswapRouter 绑定 ----
    # D9: setMiningTargets(cfoSwapMining, miningPoolFactory) —— 挖矿通知目标
    $binds.Add(@{ Name = "D9. Router.setMiningTargets (挖矿目标双地址)"
                  To   = $router.Address
                  Sig  = "setMiningTargets(address,address)"
                  Args = @($mining.Address, $poolFactory.Address) })

    # ---- 白名单权限 (D10-D11): Router 加入 Mining + PoolFactory 的调用白名单 ----
    # D10: CfoSwapMining.addCaller(Router) —— Router 触发交易挖矿
    $binds.Add(@{ Name = "D10. CfoSwapMining.addCaller(Router地址) 授权交易挖矿调用"
                  To   = $mining.Address
                  Sig  = "addCaller(address)"
                  Args = @($router.Address) })

    # D11: CfoMiningPool.addCaller(Router) —— Router 触发矿池 onSwap
    $binds.Add(@{ Name = "D11. CfoMiningPool.addCaller(Router地址) 授权矿池转发调用"
                  To   = $poolFactory.Address
                  Sig  = "addCaller(address)"
                  Args = @($router.Address) })

    # ---- 可选 D12-15: 所有权转移到 Gnosis Safe ----
    if ($SAFE_ADDRESS) {
        $binds.Add(@{ Name = "D12. Token.transferOwnership -> Safe"
                      To   = $token.Address;       Sig = "transferOwnership(address)"; Args = @($SAFE_ADDRESS) })
        $binds.Add(@{ Name = "D13. CfoMiningPool.transferOwnership -> Safe"
                      To   = $poolFactory.Address; Sig = "transferOwnership(address)"; Args = @($SAFE_ADDRESS) })
        $binds.Add(@{ Name = "D14. CfoSwapMining.transferOwnership -> Safe"
                      To   = $mining.Address;      Sig = "transferOwnership(address)"; Args = @($SAFE_ADDRESS) })
        $binds.Add(@{ Name = "D15. Router.transferOwnership -> Safe"
                      To   = $router.Address;      Sig = "transferOwnership(address)"; Args = @($SAFE_ADDRESS) })
    }

    $bindResults = @()
    foreach ($b in $binds) {
        $idx = $binds.IndexOf($b) + 1
        Write-Host "`n   [D-$idx/$($binds.Count)] $($b.Name)" -ForegroundColor Cyan
        try {
            $res = Cast-Send -To $b.To -Sig $b.Sig -FnArgs $b.Args
            Write-OK "TX: $($res.TxHash)"
            $bindResults += @{ Name = $b.Name; To = $b.To; Sig = $b.Sig; TxHash = $res.TxHash; Status = "success" }
        } catch {
            Write-Err "绑定失败: $_"
            $bindResults += @{ Name = $b.Name; To = $b.To; Sig = $b.Sig; TxHash = ""; Status = "failed"; Error = "$_" }
        }
    }
}

# ------------------------------------------------------------
# 8. 汇总 & 保存
# ------------------------------------------------------------
Write-Step "阶段 E: 汇总部署结果"

$deployData = [ordered]@{
    deployedAt     = (Get-Date -Format "o")
    chainId        = $CHAIN_ID
    deployer       = $deployerAddr
    routerOwner    = $ROUTER_OWNER
    vestingDays    = $VESTING_DAYS
    safeAddress    = $SAFE_ADDRESS

    libraries      = [ordered]@{
        DagRouter       = @{ Address = $libs["DagRouter"].Address;       TxHash = $libs["DagRouter"].TxHash }
        SmartSwapRouter = @{ Address = $libs["SmartSwapRouter"].Address; TxHash = $libs["SmartSwapRouter"].TxHash }
        SwapWrapRouter  = @{ Address = $libs["SwapWrapRouter"].Address;  TxHash = $libs["SwapWrapRouter"].TxHash }
        UnxswapRouter   = @{ Address = $libs["UnxswapRouter"].Address;   TxHash = $libs["UnxswapRouter"].TxHash }
        UnxswapV3Router = @{ Address = $libs["UnxswapV3Router"].Address; TxHash = $libs["UnxswapV3Router"].TxHash }
    }
    contracts      = [ordered]@{
        CfoSwapToken   = @{ Address = $token.Address;       TxHash = $token.TxHash }
        CfoMiningPool  = @{ Address = $poolFactory.Address; TxHash = $poolFactory.TxHash }
        CfoSwapMining  = @{ Address = $mining.Address;      TxHash = $mining.TxHash }
        CfoswapRouter  = @{ Address = $router.Address;      TxHash = $router.TxHash }
    }
    taxDistribution = [ordered]@{
        wallets = @($TAX_WALLET_1, $TAX_WALLET_2, $TAX_WALLET_3)
        pct     = @($TAX_SHARE_1_PCT, $TAX_SHARE_2_PCT, $TAX_SHARE_3_PCT)
        bp      = @($taxSharesBp[0], $taxSharesBp[1], $taxSharesBp[2])
    }
    platformFeeDistribution = [ordered]@{
        wallets = @($PLATFORM_WALLET_1, $PLATFORM_WALLET_2, $PLATFORM_WALLET_3)
        pct     = @($PLATFORM_SHARE_1_PCT, $PLATFORM_SHARE_2_PCT, $PLATFORM_SHARE_3_PCT)
        bp      = @($feeSharesBp[0], $feeSharesBp[1], $feeSharesBp[2])
    }
    boostFeeRecipient = $BOOST_FEE_RECIPIENT
    bindings        = $bindResults
}

Save-Addresses $deployData

# 打印汇总
Write-Host "`n============================================================" -ForegroundColor Magenta
Write-Host "  所有合约部署完成！共 9 个合约 + $($bindResults.Count) 条绑定" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "`n  【5 个路由库】" -ForegroundColor Cyan
foreach ($k in $libs.Keys) {
    Write-Host "   $k : $($libs[$k].Address)"
}
Write-Host "`n  【4 个业务合约】" -ForegroundColor Cyan
Write-Host "   CfoSwapToken   : $($token.Address)"
Write-Host "   CfoMiningPool  : $($poolFactory.Address)"
Write-Host "   CfoSwapMining  : $($mining.Address)"
Write-Host "   CfoswapRouter  : $($router.Address)"
Write-Host "`n  详细结果请查看: $(Join-Path $PSScriptRoot "deployed-addresses.json")" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Magenta
