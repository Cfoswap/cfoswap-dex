/**
 * Cfoswap Foundry 部署服务（方案 A v2：钱包签名 + 服务端仅构建/验证）
 *
 * 架构：
 *   - 前端（FoundryDeploy 页面）：使用 MetaMask/OKX 钱包 eth_sendTransaction 签名并发送部署/绑定交易
 *   - 本服务（deploy-server.js）：
 *       1. 提供合约构建信息（bytecode/abi/构造参数类型），帮助前端编码构造参数
 *       2. 为 CfoRouter 替换 5 个库链接占位符 → 返回链接好的创建字节码
 *       3. 使用 `forge verify-contract` 异步做合约开源验证（Sourcify + BscScan），无需私钥
 *       4. 管理 .env 配置和部署结果 JSON
 *
 * HTTP API：
 *   GET  /health                    健康检查
 *   GET  /api/env                   读取配置（不再有 PRIVATE_KEY）
 *   POST /api/env                   保存配置（body: { env: {...} }）
 *   GET  /api/build/contracts       返回 9 合约构建信息（abi/bytecode/构造类型/链接要求）
 *   POST /api/build/router-bytecode 链接 5 库地址 → 返回 CfoRouter 的创建字节码
 *   POST /api/forge/verify          异步提交 forge verify-contract 验证任务
 *   GET  /api/forge/verify/:id      查询验证任务状态
 *   GET  /api/deployer/result       读取部署结果
 *   POST /api/deployer/result       保存部署结果
 *
 * 路径约定：
 *   - Forge/Cast 默认为 C:\Users\华为\foundry\foundry_v1.8.1_win32_amd64\ 下的 exe
 *   - 工作目录：脚本所在目录（88DEX/foundry/）
 *   - 编译产物（forge build 的 out/）：<foundry>/out/
 *   - .env / deployed-addresses.json：<foundry>/
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ===== 路径常量 =====
const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'out');
const ENV_FILE = path.join(ROOT, '.env');
const RESULT_FILE = path.join(ROOT, 'deployed-addresses.json');
const VERIFY_TASKS_FILE = path.join(ROOT, 'verify-tasks.json');
const FORGE_EXE = process.env.FORGE_EXE ||
  'C:\\Users\\华为\\foundry\\foundry_v1.8.1_win32_amd64\\forge.exe';
const CAST_EXE = process.env.CAST_EXE ||
  'C:\\Users\\华为\\foundry\\foundry_v1.8.1_win32_amd64\\cast.exe';
// 部署服务专用端口 3011（3001 为 SWAP 主前端，禁止占用）
const PORT = process.env.PORT || 3011;

// ===== 编译参数硬编码（与 foundry.toml 严格一致）=====
const SOLC_BUILD_PROFILE = {
  optimizerRuns: 200,
  evmVersion: 'london',
  viaIR: true,
  solcVersion: '0.8.20',
};

// ===== 内存缓存 =====
let envCache = {};
let deployResultCache = null;
/** 验证任务：id → { status, stdout, stderr, startedAt, finishedAt, contract } */
const verifyTasks = new Map();

// ============================================================
// verifyTasks 持久化（服务端重启不丢）
// ============================================================
function loadVerifyTasks() {
  if (!fs.existsSync(VERIFY_TASKS_FILE)) return;
  try {
    const arr = JSON.parse(fs.readFileSync(VERIFY_TASKS_FILE, 'utf-8'));
    if (Array.isArray(arr)) {
      verifyTasks.clear();
      for (const t of arr) if (t && t.id) verifyTasks.set(t.id, t);
      console.log(`[verify] 从 ${VERIFY_TASKS_FILE} 恢复 ${verifyTasks.size} 条历史任务`);
    }
  } catch (e) {
    console.warn('[verify] 加载 verify-tasks.json 失败：', e.message);
  }
}
function saveVerifyTasks() {
  try {
    const arr = Array.from(verifyTasks.values());
    fs.writeFileSync(VERIFY_TASKS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[verify] 写入 verify-tasks.json 失败：', e.message);
  }
}

// ============================================================
// 9 合约元信息（和 foundry 编译产物 out 目录对应）
// ============================================================
const CONTRACTS = [
  // Phase A：5 个库合约（PhaseA 先部署）
  { key: 'CfoDagRouter',    name: 'CfoDagRouter',    sol: 'CfoDagRouter.sol',      relDir: 'src/router/router',    phase: 'A', order: 1,
    artifact: path.join(OUT_DIR, 'CfoDagRouter.sol', 'CfoDagRouter.json'),
    contract: 'src/router/router/CfoDagRouter.sol:CfoDagRouter' },
  { key: 'CfoSmartRouter',  name: 'CfoSmartRouter',  sol: 'CfoSmartRouter.sol',    relDir: 'src/router/router',    phase: 'A', order: 2,
    artifact: path.join(OUT_DIR, 'CfoSmartRouter.sol', 'CfoSmartRouter.json'),
    contract: 'src/router/router/CfoSmartRouter.sol:CfoSmartRouter' },
  { key: 'CfoWrapRouter',   name: 'CfoWrapRouter',   sol: 'CfoWrapRouter.sol',     relDir: 'src/router/router',    phase: 'A', order: 3,
    artifact: path.join(OUT_DIR, 'CfoWrapRouter.sol', 'CfoWrapRouter.json'),
    contract: 'src/router/router/CfoWrapRouter.sol:CfoWrapRouter' },
  { key: 'CfoUnxRouter',    name: 'CfoUnxRouter',    sol: 'CfoUnxRouter.sol',      relDir: 'src/router/router',    phase: 'A', order: 4,
    artifact: path.join(OUT_DIR, 'CfoUnxRouter.sol', 'CfoUnxRouter.json'),
    contract: 'src/router/router/CfoUnxRouter.sol:CfoUnxRouter' },
  { key: 'CfoUnxV3Router',  name: 'CfoUnxV3Router',  sol: 'CfoUnxV3Router.sol',    relDir: 'src/router/router',    phase: 'A', order: 5,
    artifact: path.join(OUT_DIR, 'CfoUnxV3Router.sol', 'CfoUnxV3Router.json'),
    contract: 'src/router/router/CfoUnxV3Router.sol:CfoUnxV3Router' },
  // Phase B：3 个独立业务合约
  { key: 'CfoToken',              name: 'CfoToken',              sol: 'CfoToken.sol',         relDir: 'src/token',            phase: 'B', order: 6,
    artifact: path.join(OUT_DIR, 'CfoToken.sol', 'CfoToken.json'),
    contract: 'src/token/CfoToken.sol:CfoToken' },
  { key: 'CfoMiningPoolFactory',  name: 'CfoMiningPoolFactory',  sol: 'CfoMiningPools.sol',  relDir: 'src/mining',           phase: 'B', order: 7,
    artifact: path.join(OUT_DIR, 'CfoMiningPools.sol', 'CfoMiningPoolFactory.json'),
    contract: 'src/mining/CfoMiningPools.sol:CfoMiningPoolFactory' },
  { key: 'CfoMining',             name: 'CfoMining',             sol: 'CfoMining.sol',       relDir: 'src/mining',           phase: 'B', order: 8,
    artifact: path.join(OUT_DIR, 'CfoMining.sol', 'CfoMining.json'),
    contract: 'src/mining/CfoMining.sol:CfoMining' },
  // Phase C：CfoRouter，链接 5 个库
  { key: 'CfoRouter',       name: 'CfoRouter',      sol: 'CfoRouter.sol',        relDir: 'src/router',           phase: 'C', order: 9,
    artifact: path.join(OUT_DIR, 'CfoRouter.sol', 'CfoRouter.json'),
    contract: 'src/router/CfoRouter.sol:CfoRouter',
    libraryDeps: ['CfoDagRouter','CfoSmartRouter','CfoWrapRouter','CfoUnxRouter','CfoUnxV3Router'] }
];

// ============================================================
// 工具函数
// ============================================================
function readEnvFile() {
  const obj = {};
  if (!fs.existsSync(ENV_FILE)) return obj;
  const lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    obj[k] = v;
  }
  return obj;
}

function writeEnvFile(obj) {
  const current = readEnvFile();
  const merged = { ...current, ...obj };
  const lines = [
    '# ============================================================',
    '# Cfoswap 部署配置文件 — 由 FoundryDeploy 页面/API 自动维护',
    '# 架构：前端钱包签名 + 服务端仅 forge build/verify（无私钥）',
    '# 生成时间: ' + new Date().toISOString(),
    '# ============================================================',
    ''
  ];
  for (const k of Object.keys(merged)) {
    const v = merged[k];
    if (v === undefined || v === null || v === '') continue;
    const val = String(v);
    if (val.includes('\n')) lines.push(`${k}="${val.replace(/"/g, '\\"')}"`);
    else lines.push(`${k}=${val}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf-8');
  envCache = merged;
  return merged;
}

function applyEnvToProcess(extra = {}) {
  const merged = { ...envCache, ...extra };
  for (const [k, v] of Object.entries(merged)) process.env[k] = v;
  return merged;
}

function runCmd(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: ROOT, env: process.env, windowsHide: true, shell: false
    });
    let stdout = ''; let stderr = ''; let combined = '';
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; combined += s; });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; combined += s; });
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr, combined, error: err.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr, combined }));
  });
}

/** 从 artifact JSON 读取构造参数类型列表 */
function getConstructorInputs(abi) {
  const ctor = (abi || []).find(x => x && x.type === 'constructor');
  if (!ctor || !Array.isArray(ctor.inputs)) return [];
  return ctor.inputs.map(i => ({ name: i.name, type: i.type, components: i.components }));
}

/** 读取单个合约的 artifact JSON */
function readArtifact(meta) {
  if (!fs.existsSync(meta.artifact)) return null;
  try { return JSON.parse(fs.readFileSync(meta.artifact, 'utf-8')); } catch { return null; }
}

/**
 * 替换链接占位符：
 *   hexBytecode: 0x 开头的创建字节码 hex（来自 artifact.bytecode.object）
 *   linkRefs:    artifact.bytecode.linkReferences 结构（{ filePath: { libName: [{start,length}, ...] } } }）
 *   libraryMap:  { [libName]: '0x...40 地址' }
 * 返回 0x 开头的替换后 hex
 */
function linkBytecode(hexBytecode, linkRefs, libraryMap) {
  if (!linkRefs || typeof linkRefs !== 'object') return hexBytecode;
  // hexBytecode 以 0x 开头，hex 字符（每 2 字符 = 1 字节），offset 是字节数
  let result = hexBytecode.slice(2); // 去掉 0x
  // 构建所有替换操作列表，按 start 从大到小做（防止前面替换改变后续偏移）
  const ops = [];
  for (const filePath of Object.keys(linkRefs)) {
    const libs = linkRefs[filePath] || {};
    for (const libName of Object.keys(libs)) {
      const libAddr = libraryMap[libName];
      if (!libAddr) continue;
      const libHex = libAddr.replace(/^0x/, '').toLowerCase();
      if (libHex.length !== 40) continue;
      const slots = libs[libName] || [];
      for (const slot of slots) {
        const startByte = Number(slot.start);
        const lenByte = Number(slot.length);
        if (!Number.isFinite(startByte) || !Number.isFinite(lenByte)) continue;
        const charStart = 2 + startByte * 2; // 原始字节码中 hex 字符位置（考虑 0x 前缀）
        const charLen = lenByte * 2;
        ops.push({ charStart, charLen, libHex });
      }
    }
  }
  ops.sort((a, b) => b.charStart - a.charStart);
  for (const op of ops) {
    const s = op.charStart - 2; // result 不带 0x，所以减 2
    if (s < 0 || s + op.charLen > result.length) continue;
    result = result.slice(0, s) + op.libHex + result.slice(s + op.charLen);
  }
  return '0x' + result;
}

/** 生成验证任务 id */
function newVerifyId() { return 'v_' + crypto.randomBytes(6).toString('hex'); }

// ============================================================
// Sourcify v2 直连验证（2026-08-31 实测方案）
// ------------------------------------------------------------
// 背景：forge verify-contract --verifier sourcify 默认只提交合约 import 闭包。
// viaIR 编译时，solc 收到的 sources 文件集不同会导致 AST ID 偏移，
// Sourcify 重编译字节码与链上不一致 → 报错 extra_file_input_bug
// （metadata hash match but bytecodes mismatch）。
// 解法：
//   1. forge verify-contract --show-standard-json-input 拿基础 stdJsonInput
//      （settings 与链上编译严格一致：viaIR/london/runs=200）
//   2. 按 artifact.id 定位 out/build-info 中的编译单元(crate)，
//      把该 crate source_id_to_path 里的【全部源文件】补齐进 sources
//   3. 直传 Sourcify v2 API：POST /server/v2/verify/{chainId}/{address}
// 已用 8 个已部署合约实测全部 exact_match（2026-08-31）。
// ============================================================
const SOURCIFY_HOST = 'sourcify.dev';
const SOURCIFY_CHAIN_ID = '56';
const SOURCIFY_COMPILER_VERSION = SOLC_BUILD_PROFILE.solcVersion + '+commit.a1b79de6';

/** Sourcify HTTP 请求（返回 {statusCode, json, raw}） */
function sourcifyRequest(reqPath, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { 'User-Agent': 'cfoswap-deploy-server', 'Accept': 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: SOURCIFY_HOST, path: reqPath, method, headers, timeout: 60000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON 响应 */ }
        resolve({ statusCode: res.statusCode, json, raw: d });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Sourcify 请求超时: ' + reqPath)); });
    if (data) req.write(data);
    req.end();
  });
}

/** 根据 artifact.id 在 out/build-info 中定位合约所属编译单元(crate) */
function findCrateForArtifact(artifact, srcPath) {
  const buildInfoDir = path.join(OUT_DIR, 'build-info');
  if (!fs.existsSync(buildInfoDir)) return null;
  const sid = artifact && artifact.id != null ? String(artifact.id) : null;
  for (const f of fs.readdirSync(buildInfoDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const bi = JSON.parse(fs.readFileSync(path.join(buildInfoDir, f), 'utf-8'));
      const map = bi && bi.source_id_to_path;
      if (!map) continue;
      if (sid && map[sid] === srcPath) return bi;
    } catch { /* 跳过损坏的 build-info */ }
  }
  return null;
}

/**
 * 递归补齐 sources 内所有【相对路径 import】（./ ../）引用但缺失的源文件，直到不动点。
 * 背景：crate 补齐可能命中旧编译单元（source_id_to_path 不含后来新增的文件），
 * 而文件 content 从磁盘读取的是最新版（含新 import），Sourcify 重编译会报
 * "Source ... not found"。相对 import 闭包兜底保证提交的 sources 自洽。
 * 返回新补文件数。
 */
function addMissingRelativeImports(std) {
  const importRe = /import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let added = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of Object.keys(std.sources)) {
      const content = std.sources[key] && std.sources[key].content;
      if (typeof content !== 'string') continue;
      importRe.lastIndex = 0;
      let m;
      while ((m = importRe.exec(content)) !== null) {
        const imp = m[1];
        if (imp[0] !== '.') continue; // remapping/库路径已在 forge 基础闭包内
        const dir = key.split('/').slice(0, -1).join('/');
        const resolved = path.posix.normalize(path.posix.join(dir, imp));
        if (std.sources[resolved]) continue;
        const abs = path.join(ROOT, resolved.split('/').join(path.sep));
        if (fs.existsSync(abs)) {
          std.sources[resolved] = { content: fs.readFileSync(abs, 'utf-8') };
          added++;
          changed = true;
        }
      }
    }
  }
  return added;
}

/**
 * 生成【全量源文件】standard JSON input：
 *   1. forge verify-contract --show-standard-json-input 取基础 stdJsonInput
 *   2. 按编译单元 source_id_to_path 补齐全部源文件 content（修复 extra_file_input_bug）
 *   3. 相对 import 递归闭包兜底（修复命中旧 crate 时漏传新依赖文件）
 */
async function buildFullStdJsonInput(meta, address) {
  const args = [
    'verify-contract', address, meta.contract,
    '--chain-id', SOURCIFY_CHAIN_ID,
    '--verifier', 'sourcify',
    '--compiler-version', 'v' + SOURCIFY_COMPILER_VERSION,
    '--num-of-optimizations', String(SOLC_BUILD_PROFILE.optimizerRuns),
    '--evm-version', SOLC_BUILD_PROFILE.evmVersion,
  ];
  if (SOLC_BUILD_PROFILE.viaIR) args.push('--via-ir');
  const artifact = readArtifact(meta);
  // 不传 --libraries / 不注入 settings.libraries：链上 bytecode 的库地址是
  // 部署时占位符替换写入的，metadata 哈希与未链接编译产物一致（已链上核对）；
  // Sourcify 比对时自动屏蔽库地址区域。注入 libraries 会改变 metadata 哈希，
  // 导致只能 partial match。
  args.push('--show-standard-json-input');

  const r = await runCmd(FORGE_EXE, args);
  if (r.exitCode !== 0) {
    throw new Error('forge --show-standard-json-input 失败(exit=' + r.exitCode + '): ' +
      (r.stderr || r.stdout || '').slice(-800));
  }
  let std;
  try {
    std = JSON.parse(r.stdout.trim());
  } catch (e) {
    throw new Error('stdJsonInput 解析失败: ' + e.message + '; stdout 末尾: ' + r.stdout.slice(-300));
  }
  std.sources = std.sources || {};
  std.settings = std.settings || {};

  // 补齐编译单元全量源文件
  const srcPath = meta.contract.split(':')[0];
  const crate = artifact ? findCrateForArtifact(artifact, srcPath) : null;
  let addedFromCrate = 0;
  if (crate && crate.source_id_to_path) {
    for (const p of Object.values(crate.source_id_to_path)) {
      if (std.sources[p]) continue;
      const abs = path.join(ROOT, p);
      if (fs.existsSync(abs)) {
        std.sources[p] = { content: fs.readFileSync(abs, 'utf-8') };
        addedFromCrate++;
      }
    }
  }
  // 相对 import 闭包兜底：命中旧 crate 文件列表时也能补全新依赖
  const addedFromImports = addMissingRelativeImports(std);
  return { std, sourcesCount: Object.keys(std.sources).length, addedFromCrate, addedFromImports, crateId: crate && crate.id };
}

/** 从 deployed-addresses.json 反查合约部署交易 hash（Sourcify 靠它提取创建码/构造参数）。
 *  仅当服务端记录的地址与待验证地址一致时才采用，避免重部署后回读到旧批次哈希。 */
function findTxHashForContract(contractKey, address) {
  try {
    if (!fs.existsSync(RESULT_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
    const states = raw.deployStates || {};
    const entry = Object.entries(ALIAS_TO_CONTRACT).find(([, v]) => v === contractKey);
    const alias = entry ? entry[0] : null;
    const st = alias ? states[alias] : null;
    if (st && st.txHash && (!address || !st.address || st.address.toLowerCase() === String(address).toLowerCase())) {
      return st.txHash;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 执行一次 Sourcify v2 验证（原地更新 task 对象并落盘）。
 * opts: { address, contractKey, txHash?, libraries? }
 */
async function runSourcifyVerifyV2(task, opts) {
  const { address, contractKey } = opts;
  const meta = CONTRACTS.find((c) => c.key === contractKey);
  if (!meta) {
    task.status = 'failed';
    task.tail = '未知 contractKey: ' + contractKey;
    task.finishedAt = new Date().toISOString();
    saveVerifyTasks();
    return;
  }
  task.verifier = 'sourcify-v2';
  task.status = 'running';
  task.startedAt = task.startedAt || new Date().toISOString();
  saveVerifyTasks();
  try {
    // 服务端部署回执优先（前端 localStorage 可能残留旧批次哈希）
    const txHash = findTxHashForContract(contractKey, address) || opts.txHash || null;
    task.txHash = txHash || null;

    const built = await buildFullStdJsonInput(meta, address);
    task.forgeNote = 'stdJsonInput: ' + built.sourcesCount + ' sources (crate ' + built.crateId +
      ', +' + built.addedFromCrate + ' from crate, +' + built.addedFromImports + ' from imports)';

    const body = {
      contractIdentifier: meta.contract,
      compilerVersion: SOURCIFY_COMPILER_VERSION,
      stdJsonInput: built.std,
    };
    if (txHash) body.creationTransactionHash = txHash;

    const postRes = await sourcifyRequest(
      '/server/v2/verify/' + SOURCIFY_CHAIN_ID + '/' + address, 'POST', body);
    // 409 already_verified：Sourcify 幂等响应，视为成功
    if (postRes.statusCode === 409 || (postRes.json && postRes.json.customCode === 'already_verified')) {
      task.status = 'success';
      task.match = 'already_verified';
      task.tail = (postRes.json && postRes.json.message) || 'Contract already verified on Sourcify';
      return;
    }
    if (postRes.statusCode !== 202 || !postRes.json || !postRes.json.verificationId) {
      task.status = 'failed';
      task.errorCode = postRes.json && (postRes.json.customCode || String(postRes.json.message || '').slice(0, 200));
      task.tail = 'Sourcify 提交失败 HTTP ' + postRes.statusCode + ': ' + (postRes.raw || '').slice(-600);
      return;
    }
    task.sourcifyJobId = postRes.json.verificationId;
    saveVerifyTasks();

    // 轮询异步验证结果（每 6s，最多 25 次 ≈ 150s）
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      const g = await sourcifyRequest('/server/v2/verify/' + task.sourcifyJobId, 'GET', null);
      const j = g.json;
      if (j && j.isJobCompleted) {
        if (j.contract && j.contract.match) {
          task.status = 'success';
          task.match = j.contract.match;
          task.tail = 'Sourcify ' + j.contract.match +
            ' (runtime=' + j.contract.runtimeMatch + ', creation=' + j.contract.creationMatch + ')';
        } else {
          task.status = 'failed';
          task.errorCode = j.error && j.error.customCode;
          task.tail = 'Sourcify 验证未匹配: ' + (j.error && j.error.customCode) +
            ' - ' + String((j.error && j.error.message) || '').slice(0, 500);
        }
        return;
      }
    }
    task.status = 'failed';
    task.tail = 'Sourcify 验证轮询超时（job ' + task.sourcifyJobId + '），可用 retry-all 重查';
  } catch (e) {
    task.status = 'failed';
    task.tail = '内部异常: ' + (e && e.message ? e.message : String(e));
    task.stderr = (task.stderr || '') + '\n' + (e && e.stack ? e.stack : String(e));
  } finally {
    task.finishedAt = new Date().toISOString();
    saveVerifyTasks();
    console.log('[verify-v2 ' + task.status + '] ' + contractKey + ' @ ' + address +
      (task.match ? ' match=' + task.match : '') + (task.errorCode ? ' err=' + task.errorCode : ''));
  }
}

/**
 * 把前端传来的构造参数值数组，转成 forge verify-contract 的 --constructor-args 独立参数表
 * 规则（forge verify-contract CLI 语义：数组必须把元素逐个作为独立 CLI arg，不允许 "[a,b,c]" 字符串）：
 *   - 原子类型 (address/uint256/bytes32/string/bool/bytes 等) → 单值字符串
 *   - 固定数组 T[N] / 动态数组 T[] → 把每个元素按类型 T 递归展开为多个独立 CLI arg
 *   - 元组 (tuple / (uint,address)) → 每个 component 按对应类型递归展开
 *   - 注意：嵌套数组（如 uint256[3][2]）少见，这里递归也能处理。
 */
function flattenConstructorArgsForForge(values, inputs) {
  const result = [];
  // 辅助：对单个 value + 它的 Solidity 类型字符串做递归展平
  function flattenOne(v, type, components) {
    // tuple 类型：components 子结构依次递归
    if (type === 'tuple' && Array.isArray(v) && Array.isArray(components)) {
      for (let i = 0; i < components.length; i++) {
        const comp = components[i] || {};
        flattenOne(v[i], comp.type, comp.components);
      }
      return;
    }
    // 数组类型：T[N] 或 T[]
    const arrMatch = /^(.+)\[(\d*)\]$/.exec(type || '');
    if (arrMatch) {
      const innerType = arrMatch[1];
      if (!Array.isArray(v)) {
        // 不是数组就原样 string（防御式：避免崩溃，让 forge 自己报）
        result.push(String(v));
        return;
      }
      for (const item of v) flattenOne(item, innerType, components);
      return;
    }
    // 原子：转字符串；bool/uint/address 正常化
    if (typeof v === 'boolean') {
      result.push(v ? 'true' : 'false');
    } else if (v === null || v === undefined) {
      result.push('');
    } else {
      result.push(String(v));
    }
  }

  const valuesArr = Array.isArray(values) ? values : [];
  const inputsArr = Array.isArray(inputs) ? inputs : [];
  for (let i = 0; i < Math.max(valuesArr.length, inputsArr.length); i++) {
    const v = valuesArr[i];
    const inp = inputsArr[i] || {};
    const type = inp.type || (Array.isArray(v) ? 'auto[]' : 'auto');
    if (type === 'auto') {
      // 没有类型信息时，非数组直接 String，数组按字符串递归（不会拆 tuple）
      if (Array.isArray(v)) { for (const x of v) result.push(String(x)); }
      else result.push(String(v ?? ''));
    } else if (type === 'auto[]' && Array.isArray(v)) {
      for (const x of v) result.push(String(x ?? ''));
    } else {
      flattenOne(v, type, inp.components);
    }
  }
  return result;
}

/**
 * 把 libraries map（{libName: addr}）转成 forge verify-contract 的 --libraries 参数字符串数组
 * 例如："--libraries src/router/router/CfoDagRouter.sol:CfoDagRouter:0x...,src/router/router/CfoSmartRouter.sol:0x..."
 * 但 forge 也支持重复传多个 --libraries 每个带单个条目，这里用逗号拼接一个更短的命令。
 */
/**
 * 把 libraries map（{libName: addr}）转成 forge verify-contract 的 --libraries 参数字符串。
 * 【V2：基于 artifact.linkReferences 精确定位】对 verify 时使用此函数：
 *   - 从待验证合约的 artifact.linkReferences 取真实 (filePath, libName) 对
 *   - 用 libName 作为 key 去 libraryMap 里查找地址
 *   - 格式："<filePath>:<libName>:<addr>"，多对用逗号连接
 * 这样保证 forge 替换占位符时 path 完全等于 solc 记录的引用源路径（CfoRouter 场景下不再因为路径写错导致 11 个占位符不被替换）。
 *
 * fallback：如果没传 artifact，用老的 CONTRACTS.contract 硬拼（兼容 PhaseA 库单独 verify）。
 */
function buildLibrariesArg(libraryMap, artifactWithLinkRefs = null) {
  if (!libraryMap) return null;
  const parts = [];
  if (artifactWithLinkRefs && artifactWithLinkRefs.bytecode && artifactWithLinkRefs.bytecode.linkReferences) {
    const linkRefs = artifactWithLinkRefs.bytecode.linkReferences;
    for (const filePath of Object.keys(linkRefs)) {
      const libs = linkRefs[filePath] || {};
      for (const libName of Object.keys(libs)) {
        const addr = libraryMap[libName];
        if (!addr) continue;
        parts.push(`${filePath}:${libName}:${addr}`);
      }
    }
    if (parts.length > 0) return parts.join(',');
  }
  // Fallback：遍历 CONTRACTS 按 meta.contract 硬拼（PhaseA 库 verify 不需要 linkReferences 也能工作）
  for (const meta of CONTRACTS) {
    if (meta.phase !== 'A') continue;
    const addr = libraryMap[meta.key];
    if (!addr) continue;
    parts.push(`${meta.contract}:${addr}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}

// ============================================================
// Express 应用
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 请求日志中间件
app.use((req, res, next) => {
  const t = new Date().toISOString().substr(11, 8);
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
  let forgeOk = false, castOk = false;
  try { forgeOk = fs.existsSync(FORGE_EXE); } catch {}
  try { castOk = fs.existsSync(CAST_EXE); } catch {}
  res.json({
    status: 'ok',
    server: 'cfoswap-foundry-deploy',
    version: 'v2-wallet-sign',
    port: PORT,
    forgePath: FORGE_EXE,
    forgeExists: forgeOk,
    castPath: CAST_EXE,
    castExists: castOk,
    pwd: ROOT
  });
});

// ---------- 读配置 ----------
app.get('/api/env', (req, res) => {
  envCache = readEnvFile();
  res.json({ ok: true, env: envCache, envFile: ENV_FILE });
});

// ---------- 写配置 ----------
app.post('/api/env', (req, res) => {
  const body = req.body || {};
  if (!body.env || typeof body.env !== 'object') {
    return res.status(400).json({ ok: false, saved: false, error: '缺少 env 对象' });
  }
  const merged = writeEnvFile(body.env);
  applyEnvToProcess();
  // 双端兼容：saved=true 给前端 ConfigPanel 判定，ok+env 保留旧调用方兼容
  res.json({ ok: true, saved: true, env: merged });
});

// ---------- 返回 9 合约构建信息 ----------
app.get('/api/build/contracts', (req, res) => {
  const list = [];
  for (const meta of CONTRACTS) {
    const artifact = readArtifact(meta);
    if (!artifact) {
      list.push({ key: meta.key, name: meta.name, error: 'artifact 不存在: ' + meta.artifact });
      continue;
    }
    const bytecode = artifact.bytecode && artifact.bytecode.object ? artifact.bytecode.object : '';
    const linkRefs = artifact.bytecode && artifact.bytecode.linkReferences ? artifact.bytecode.linkReferences : {};
    const requiresLinking = Object.keys(linkRefs).length > 0;
    const abi = artifact.abi || [];
    list.push({
      key: meta.key,
      name: meta.name,
      srcPath: meta.contract,
      contract: meta.contract, // forge verify-contract 用的 <path>:<name>
      abi,
      constructorInputs: getConstructorInputs(abi),
      bytecode,
      requiresLinking,
      phase: meta.phase,
      order: meta.order,
      libraryDeps: meta.libraryDeps || (requiresLinking ? Object.values(linkRefs).flatMap(x => Object.keys(x)) : undefined)
    });
  }
  // 用 order 排序
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json({ ok: true, contracts: list, outDir: OUT_DIR });
});

// ---------- 链接 5 库 → 返回 CfoRouter 创建字节码 ----------
app.post('/api/build/router-bytecode', (req, res) => {
  const b = req.body || {};
  const libs = b.libraries || {};
  // 5 个必填
  const required = ['CfoDagRouter','CfoSmartRouter','CfoWrapRouter','CfoUnxRouter','CfoUnxV3Router'];
  const missing = required.filter(n => !libs[n]);
  if (missing.length > 0) {
    return res.status(400).json({ ok: false, error: '缺少库地址: ' + missing.join(',') });
  }
  const routerMeta = CONTRACTS.find(c => c.key === 'CfoRouter');
  const artifact = readArtifact(routerMeta);
  if (!artifact) return res.status(500).json({ ok: false, error: 'CfoRouter artifact 不存在，请先 forge build' });
  const raw = artifact.bytecode && artifact.bytecode.object ? artifact.bytecode.object : '';
  const refs = artifact.bytecode && artifact.bytecode.linkReferences ? artifact.bytecode.linkReferences : {};
  if (!raw) return res.status(500).json({ ok: false, error: 'CfoRouter 字节码为空' });
  const linked = linkBytecode(raw, refs, libs);
  // 简单自检：没有 __$ 占位符残留
  const hasPlaceholder = /__\$[A-Za-z0-9_]{20,}\$__/.test(linked);
  res.json({ ok: !hasPlaceholder, bytecode: linked, placeholderRemaining: hasPlaceholder });
});

// ---------- 异步提交 Sourcify v2 验证（全量 stdJsonInput 直传，绕开 extra_file_input_bug）----------
// 主验证器：Sourcify v2 API（无需 API key、国内网络可达）。
// BscScan/Etherscan 侧：api.etherscan.io V2 统一网关在大陆网络 TCP 超时无法提交；
// Sourcify 验证通过后 BscScan 会自动聚合显示（Etherscan 家族已接入 Sourcify 数据源）。
app.post('/api/forge/verify', async (req, res) => {
  const b = req.body || {};
  const { address, contractKey, libraries = null, txHash = null } = b;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ ok: false, error: 'address 非法（需 0x + 40 hex）' });
  }
  const meta = CONTRACTS.find(c => c.key === contractKey);
  if (!meta) return res.status(400).json({ ok: false, error: '未知 contractKey: ' + contractKey });

  envCache = readEnvFile();
  applyEnvToProcess();

  const id = newVerifyId();
  const task = {
    id, contractKey, contract: meta.contract, address,
    verifier: 'sourcify-v2',
    solcProfile: { ...SOLC_BUILD_PROFILE },
    status: 'running', stdout: '', stderr: '',
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  verifyTasks.set(id, task);
  saveVerifyTasks();

  // 异步后台执行（立即返回，前端轮询 GET /api/forge/verify/:id）
  runSourcifyVerifyV2(task, { address, contractKey, txHash, libraries }).catch(() => {
    // 异常已在 runSourcifyVerifyV2 内部落盘
  });

  res.json({ ok: true, id, verifier: 'sourcify-v2', contract: meta.contract, address });
});

// ---------- 查询验证任务状态 ----------
app.get('/api/forge/verify/:id', (req, res) => {
  const id = req.params.id;
  const t = verifyTasks.get(id);
  if (!t) return res.status(404).json({ ok: false, error: '任务不存在（服务端重启后请用 /retry-all 重提）' });
  res.json({
    ok: true,
    id: t.id,
    status: t.status,
    contractKey: t.contractKey,
    address: t.address,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    elapsedSec: t.elapsedSec,
    exitCode: t.exitCode,
    tail: t.tail,
    verifier: t.verifier,
    stdoutPreview: (t.stdout || '').slice(-2000),
    stderrPreview: (t.stderr || '').slice(-2000),
  });
});

// ---------- 一键重提 9 合约验证（读 deployed-addresses.json.deployed，按 alias 转回 contractKey）----------
// 部署完成后如果 verify 任务失败、或服务端重启丢任务，调用此接口重新提交 Sourcify 验证。
const ALIAS_TO_CONTRACT = {
  lib_dag: 'CfoDagRouter', lib_smart: 'CfoSmartRouter', lib_wrap: 'CfoWrapRouter',
  lib_unx: 'CfoUnxRouter', lib_unxv3: 'CfoUnxV3Router',
  biz_token: 'CfoToken', biz_pool: 'CfoMiningPoolFactory',
  biz_mining: 'CfoMining', biz_router: 'CfoRouter',
};
app.post('/api/forge/verify/retry-all', async (req, res) => {
  // 读部署结果
  let deployed = null;
  try {
    if (fs.existsSync(RESULT_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
      deployed = raw && raw.deployed ? raw.deployed : null;
    }
  } catch (e) { /* ignore */ }
  // body 里有 deployed 也允许覆盖传入
  if (req.body && req.body.deployed && typeof req.body.deployed === 'object') {
    deployed = { ...deployed, ...req.body.deployed };
  }
  if (!deployed || typeof deployed !== 'object') {
    return res.status(400).json({ ok: false, error: '未找到部署结果，请先部署合约或在 body 中传入 deployed={alias:addr}' });
  }

  // 按 CONTRACTS.order 顺序，串行提交 9 合约
  const submitted = [];
  const skipped = [];
  const ordered = [...CONTRACTS].sort((a, b) => a.order - b.order);
  for (const meta of ordered) {
    const aliasEntry = Object.entries(ALIAS_TO_CONTRACT).find(([, v]) => v === meta.key);
    const alias = aliasEntry ? aliasEntry[0] : null;
    const address = alias ? deployed[alias] : null;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      skipped.push({ contractKey: meta.key, alias, reason: alias ? `地址无效: ${address}` : '找不到 alias 映射' });
      continue;
    }
    // 走与 /api/forge/verify 相同的 Sourcify v2 提交流程：
    // stdJsonInput 全量源文件 + creationTransactionHash 取服务端部署回执，
    // 库地址不注入（Sourcify 自动屏蔽），构造参数由创建交易自动提取。
    const id = newVerifyId();
    const task = {
      id, contractKey: meta.key, contract: meta.contract, address, alias,
      verifier: 'sourcify-v2', solcProfile: { ...SOLC_BUILD_PROFILE },
      status: 'running', stdout: '', stderr: '',
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    verifyTasks.set(id, task);
    saveVerifyTasks();
    submitted.push({ id, contractKey: meta.key, alias, address });

    runSourcifyVerifyV2(task, { address, contractKey: meta.key }).catch(() => {
      // 异常已在 runSourcifyVerifyV2 内部落盘
    });
  }
  res.json({ ok: true, submitted, skipped, total: submitted.length, note: '已提交 Sourcify 验证，GET /api/forge/verify/:id 轮询每一条状态' });
});

// ---------- 部署结果 JSON 保存/读取 ----------
app.get('/api/deployer/result', (req, res) => {
  let data = deployResultCache;
  if (!data && fs.existsSync(RESULT_FILE)) {
    try { data = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8')); deployResultCache = data; } catch {}
  }
  res.json({ ok: true, data, file: RESULT_FILE, exists: !!data });
});

app.post('/api/deployer/result', (req, res) => {
  const data = req.body?.data;
  if (!data) return res.status(400).json({ ok: false, error: '缺少 data 对象' });
  deployResultCache = data;
  fs.writeFileSync(RESULT_FILE, JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true, file: RESULT_FILE, size: Buffer.byteLength(JSON.stringify(data)) });
});

// 清空已部署数据（重置回初始态，允许重新一键部署）
app.delete('/api/deployer/result', (req, res) => {
  const emptySnap = {
    savedAt: new Date().toISOString(),
    deployStates: {},
    deployed: {},
    bindStates: {},
  };
  deployResultCache = emptySnap;
  fs.writeFileSync(RESULT_FILE, JSON.stringify(emptySnap, null, 2), 'utf-8');
  res.json({ ok: true, message: '已清空全部部署数据' });
});

// ============================================================
// 启动
// ============================================================
envCache = readEnvFile();
applyEnvToProcess();

// 启动前快速自检：9 合约 artifact 是否都存在
console.log('\n[init] 自检 9 合约编译产物...');
let missing = 0;
for (const m of CONTRACTS) {
  const ok = fs.existsSync(m.artifact);
  if (!ok) { missing++; console.log(`  [MISS] ${m.key}  →  ${m.artifact}`); }
  else { console.log(`  [OK]   ${m.key}`); }
}
if (missing > 0) {
  console.log(`\n  ⚠️  ${missing} 个合约缺失编译产物，请执行：forge build`);
} else {
  console.log('  ✅ 全部 9 合约 artifact 就绪');
}

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n============================================================');
  console.log('  🚀 Cfoswap Foundry 部署服务已启动  (v2 - 钱包签名 + 服务端 forge verify)');
  console.log('     URL:       http://127.0.0.1:' + PORT);
  console.log('     健康检查:  http://127.0.0.1:' + PORT + '/health');
  console.log('     工作目录:  ' + ROOT);
  console.log('     Forge:     ' + FORGE_EXE);
  console.log('     Cast:      ' + CAST_EXE);
  console.log('============================================================\n');
});
