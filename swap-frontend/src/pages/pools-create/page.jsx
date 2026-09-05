import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getAddress as viemGetAddress } from 'viem';
import {
  ArrowLeft, ChevronRight, AlertTriangle, Loader2, CheckCircle2,
  Coins, Layers, Clock, Percent, Shield, Sparkles, Settings, ExternalLink
} from 'lucide-react';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import {
  RELEASE_PERIOD_OPTIONS,
  MAX_BEHAVIOR_REWARD,
  TOKENS,
  CFO_TOKEN_ADDRESS,
  MINING_POOL_FACTORY_ADDRESS,
  MINING_POOL_FACTORY_ABI,
  MINING_POOL_ABI,
  ERC20_ABI,
  PANCAKE_FACTORY_ADDRESS,
  FACTORY_ABI,
  WBNB_ADDRESS,
} from '@/config/index.js';
import { formatBalance, fetchDecimals, parseTokenAmount, sanitizeAmountInput, blockInvalidNumericKeys, sanitizeIntegerInput, blockInvalidIntegerKeys, viemReadContract, viemSimulateContract, viemWriteContract, viemWaitForTransaction } from '@/utils/index.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

const MINING_MODES = {
  ALL_PLATFORM: 'all_platform',
  SPECIFIED_PAIR: 'specified_pair',
};

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
// Fireworks on creation success: one explosion point per layer (position/color/initial delay), 12 particles per layer scattering at 30° intervals
const FIREWORK_LAYERS = [
  { x: '50%', y: '40%', color: '#fbbf24', delay: 0 },
  { x: '36%', y: '34%', color: '#f472b6', delay: 260 },
  { x: '64%', y: '48%', color: '#34d399', delay: 520 },
];
// Pancake trading pair requires contract address: native BNB must be mapped to WBNB to resolve LP
const lpAddressForToken = (token) => (token?.isNative ? WBNB_ADDRESS : token?.address);

// Look up a token by id (built-in symbol / lowercase custom address): static TOKENS + user-imported custom tokens
function findTokenBySymbol(id, customTokens) {
  if (!id) return null;
  if (TOKENS[id]) return TOKENS[id];
  if (customTokens) {
    if (typeof id === 'string' && id.startsWith('0x')) {
      const byAddr = customTokens[id.toLowerCase()];
      if (byAddr) return byAddr;
    }
    // Legacy: referenced by symbol string
    const bySym = Object.values(customTokens).find(t => t.symbol === id);
    if (bySym) return bySym;
  }
  return null;
}

export default function CreatePoolPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { address, connected, cfoBalance, tokenBalances, customTokens } = useWalletStore();
  const showToast = useUiStore((s) => s.showToast);
  const openWalletModal = useUiStore((s) => s.showWalletModal);
  const openTokenSelectModal = useUiStore((s) => s.openTokenSelectModal);

  // Store the symbol string; the full token object is resolved via useMemo
  const [rewardSymbol, setRewardSymbol] = useState('CFO');
  const [pairASymbol, setPairASymbol] = useState('BNB');
  const [pairBSymbol, setPairBSymbol] = useState('USDT');
  const [pairBOpen, setPairBOpen] = useState(false);
  const pairBRef = useRef(null);
  // Collapse the Token B dropdown when clicking outside
  useEffect(() => {
    if (!pairBOpen) return;
    const handler = (e) => {
      if (pairBRef.current && !pairBRef.current.contains(e.target)) setPairBOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pairBOpen]);

  const rewardToken = useMemo(() => findTokenBySymbol(rewardSymbol, customTokens), [rewardSymbol, customTokens]);
  const pairTokenA = useMemo(() => findTokenBySymbol(pairASymbol, customTokens), [pairASymbol, customTokens]);
  const pairTokenB = useMemo(() => findTokenBySymbol(pairBSymbol, customTokens), [pairBSymbol, customTokens]);

  // In specified pair mode, real-time resolve the LP contract address corresponding to selected tokens
  const [lpAddress, setLpAddress] = useState('');
  const [lpError, setLpError] = useState('');

  const [miningMode, setMiningMode] = useState(MINING_MODES.ALL_PLATFORM);
  const [outputUsdt, setOutputUsdt] = useState('150');
  const [releaseDays, setReleaseDays] = useState(365);

  useEffect(() => {
    let cancelled = false;
    if (miningMode !== MINING_MODES.SPECIFIED_PAIR || !pairTokenA || !pairTokenB) {
      setLpAddress('');
      setLpError('');
      return;
    }
    setLpAddress('');
    setLpError('');
    (async () => {
      try {
        const lp = await viemReadContract({
          address: PANCAKE_FACTORY_ADDRESS,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [lpAddressForToken(pairTokenA), lpAddressForToken(pairTokenB)],
        });
        if (cancelled) return;
        if (lp && lp !== ZERO_ADDR) {
          setLpAddress(lp.toLowerCase());
        } else {
          setLpError('no liquidity');
        }
      } catch {
        if (!cancelled) setLpError('resolve failed');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miningMode, pairASymbol, pairBSymbol]);
  const [prepayAmount, setPrepayAmount] = useState('0');
  const [l1Ratio, setL1Ratio] = useState('20');
  const [l2Ratio, setL2Ratio] = useState('10');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showFeeConfirm, setShowFeeConfirm] = useState(false);
  const [createdPool, setCreatedPool] = useState(null);

  // Pool creation burn fee: the authoritative value comes from factory CREATE_POOL_FEE()
  // (owner-adjustable); the wei value drives the approval, the display value is converted
  // via CFO decimals
  const [createFeeWei, setCreateFeeWei] = useState(0n);
  const [createFeeHuman, setCreateFeeHuman] = useState('');
  const [createFeeLoading, setCreateFeeLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [feeWei, cfoDecimals] = await Promise.all([
          viemReadContract({
            address: MINING_POOL_FACTORY_ADDRESS,
            abi: MINING_POOL_FACTORY_ABI,
            functionName: 'CREATE_POOL_FEE',
          }),
          fetchDecimals(CFO_TOKEN_ADDRESS),
        ]);
        if (cancelled) return;
        setCreateFeeWei(BigInt(feeWei));
        setCreateFeeHuman(formatBalance(feeWei, cfoDecimals));
      } catch (e) {
        console.error('[cp/fee][viem] read CREATE_POOL_FEE failed', e);
      } finally {
        if (!cancelled) setCreateFeeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const behaviorTotal = useMemo(() => {
    const l1 = parseFloat(l1Ratio) || 0;
    const l2 = parseFloat(l2Ratio) || 0;
    return l1 + l2;
  }, [l1Ratio, l2Ratio]);

  const behaviorExceeded = behaviorTotal > MAX_BEHAVIOR_REWARD;

  const prepayNum = parseFloat(prepayAmount) || 0;
  const cfoBalanceNum = parseFloat(cfoBalance) || 0;
  // Actual total deposit required = totalReward * (10000 + l1bp + l2bp) / 10000;
  // l1/l2 are percentages while the contract uses basis points (x100)
  const l1Bp = parseInt(l1Ratio, 10) || 0;
  const l2Bp = parseInt(l2Ratio, 10) || 0;
  // Total deposit amount is prepayNum, referral rewards (L1+L2, hard cap 30%) deducted from total, no additional reserve needed
  const requiredHuman = prepayNum;
  const rewardTokenBal = rewardToken?.symbol === 'CFO'
    ? cfoBalanceNum
    : (parseFloat(tokenBalances?.[rewardToken?.symbol] || '0') || 0);
  // Insufficient balance: for CFO the balance must cover the deposit amount and the
  // creation fee at once; for other tokens it covers the deposit while the CFO balance
  // covers the creation fee
  const createFeeNum = parseFloat(createFeeHuman) || 0;
  const balanceInsufficient = prepayNum > 0 && (
    rewardToken?.symbol === 'CFO'
      ? (requiredHuman + createFeeNum > cfoBalanceNum)
      : (requiredHuman > rewardTokenBal || createFeeNum > cfoBalanceNum)
  );

  const modeValid = miningMode === MINING_MODES.ALL_PLATFORM || (pairTokenA && pairTokenB);
  const canApprove =
    connected &&
    !createFeeLoading &&
    !approving &&
    !approved &&
    prepayNum > 0 &&
    !balanceInsufficient &&
    !behaviorExceeded &&
    modeValid;

  const canCreate =
    connected &&
    approved &&
    !creating &&
    prepayNum > 0 &&
    !balanceInsufficient &&
    !behaviorExceeded &&
    modeValid;

  const openTokenPicker = useCallback((target) => {
    openTokenSelectModal(
      target === 'reward' ? 'pay' : 'from',
      // TokenSelectModal returns the token id (built-in symbol / lowercase custom address) exactly once
      (id) => {
        if (typeof id !== 'string') return;
        if (target === 'reward') {
          setRewardSymbol(id);
        } else if (target === 'pairA') {
          setPairASymbol(id);
        }
      },
      null
    );
  }, [openTokenSelectModal]);

  const handleBack = () => navigate('/pools');

  const handleApprove = async () => {
    if (!connected) {
      openWalletModal();
      return;
    }
    if (!canApprove) return;
    // First pop up creation fee burn confirmation, only initiate approval after user confirms
    setShowFeeConfirm(true);
  };

  const doApprove = async () => {
    setShowFeeConfirm(false);
    setApproving(true);
    try {
      // Approval amount = on-chain CREATE_POOL_FEE (wei): approve exactly what the contract charges
      const feeWei = createFeeWei;
      // Creation fee approval: approve exact amount (creation fee) directly, not unlimited allowance
      const factoryAddr = viemGetAddress(MINING_POOL_FACTORY_ADDRESS);
      const cfoTokenAddr = viemGetAddress(CFO_TOKEN_ADDRESS);
      const userAddr = viemGetAddress(address);
      // Check current allowance first; skip approve if already sufficient (avoid blind sign)
      const currentAllowance = await viemReadContract({
        address: cfoTokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddr, factoryAddr],
      });
      if (currentAllowance < feeWei) {
        // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
        await viemSimulateContract({
          address: cfoTokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [factoryAddr, feeWei],
        });
        showToast('info', 'cp_approving_msg');
        const { hash: approveHash } = await viemWriteContract({
          address: cfoTokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [factoryAddr, feeWei],
        });
        showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
        await viemWaitForTransaction(approveHash);
      }
      setApproved(true);
      showToast('success', 'cp_approve_success');
      // Auto-enter creation flow after approval succeeds, user doesn't need to go back to click Create Pool, completes subsequent signatures continuously
      await handleCreate(true);
    } catch (e) {
      console.error('[cp/approve][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('user_rejected') : (e?.shortMessage || 'cp_approve_failed'));
    } finally {
      setApproving(false);
    }
  };

  const handleCreate = async (force = false) => {
    if (!connected) {
      openWalletModal();
      return;
    }
    // Called directly by doApprove with force=true after approval succeeds, bypass canCreate async state guard
    if (!force && !canCreate) return;
    setCreating(true);
    try {
      const rewardTokenAddr = rewardToken.address;
      if (!rewardTokenAddr) throw new Error('rewardToken address missing');
      const rewardDecimals = await fetchDecimals(rewardTokenAddr);

      // 1. Compute contract parameters (l1/l2 percentages -> bp; rewardPerUsd = 1 / output rate)
      const totalRewardWei = parseTokenAmount(prepayNum, rewardDecimals);
      const outputUsdtNum = parseFloat(outputUsdt) || 0;
      if (outputUsdtNum <= 0) throw new Error('output rate invalid');
      const rewardPerUsdWei = parseTokenAmount(1 / outputUsdtNum, rewardDecimals);
      const vestingOption = RELEASE_PERIOD_OPTIONS.findIndex((o) => o.value === releaseDays);
      const modeValue = miningMode === MINING_MODES.SPECIFIED_PAIR ? 1 : 0;
      // Specified pair (mode=1): resolve LP address via Pancake factory as targetPair, instead of using token addresses directly
      let targetPair = ZERO_ADDR;
      if (modeValue === 1) {
        if (!pairTokenA || !pairTokenB) throw new Error('pair tokens required');
        targetPair = await viemReadContract({
          address: PANCAKE_FACTORY_ADDRESS,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [lpAddressForToken(pairTokenA), lpAddressForToken(pairTokenB)],
        });
        if (!targetPair || targetPair === ZERO_ADDR) {
          throw new Error('pair has no liquidity');
        }
      }
      const requiredWei = totalRewardWei;
      // Auto-generate pool name: specified pair → "Pair Trading Mining", all-platform → "Network-Wide Trading Mining"
      const finalName = modeValue === 1
        ? t('cp_pair_mining_name', { pair: `${pairTokenA?.symbol || pairASymbol}/${pairTokenB?.symbol || pairBSymbol}` })
        : (t('cp_default_all_platform_name', '全网交易挖矿'));

      // 2. Preview to obtain the new pool address (viem simulateContract)
      // Only L1/L2 referral rewards are configured; L3-L8 are 0 (pass an 8-level array)
      const referralRateBpArr = [BigInt(l1Bp * 100), BigInt(l2Bp * 100), 0n, 0n, 0n, 0n, 0n, 0n];
      const simulateResult = await viemSimulateContract({
        address: MINING_POOL_FACTORY_ADDRESS,
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'createPoolV2',
        args: [
          finalName,
          rewardTokenAddr,
          totalRewardWei,
          rewardPerUsdWei,
          modeValue,
          targetPair,
          vestingOption,
          referralRateBpArr
        ],
      });
      const poolAddr = simulateResult.result;

      // 3. Send the actual createPoolV2 transaction via viem
      showToast('info', 'cp_creating_msg');
      const factoryAddrViem = viemGetAddress(MINING_POOL_FACTORY_ADDRESS);
      const rewardTokenAddrViem = viemGetAddress(rewardTokenAddr);
      const targetPairViem = viemGetAddress(targetPair);
      const poolAddrViem = viemGetAddress(poolAddr);

      const { hash: createHash } = await viemWriteContract({
        address: factoryAddrViem,
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'createPoolV2',
        args: [
          finalName,
          rewardTokenAddrViem,
          totalRewardWei,
          rewardPerUsdWei,
          modeValue,
          targetPairViem,
          vestingOption,
          referralRateBpArr
        ],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(createHash);

      // 4. Approve and deposit reward tokens into the new pool to activate it
      // Deposit approval: approve exact deposit amount (specific value) directly, not unlimited allowance
      // Check current allowance first; skip approve if already sufficient (avoid blind sign)
      const userAddr = viemGetAddress(address);
      const currentAllowance = await viemReadContract({
        address: rewardTokenAddrViem,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddr, poolAddrViem],
      });
      if (currentAllowance < requiredWei) {
        // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
        await viemSimulateContract({
          address: rewardTokenAddrViem,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [poolAddrViem, requiredWei],
        });
        showToast('info', t('approve_sign_prompt', '📝 请在钱包中签名授权...'));
        const { hash: approveHash2 } = await viemWriteContract({
          address: rewardTokenAddrViem,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [poolAddrViem, requiredWei],
        });
        showToast('info', t('tx_confirming', '⏳ 签名成功，等待授权确认...'));
        await viemWaitForTransaction(approveHash2);
      }

      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: poolAddrViem,
        abi: MINING_POOL_ABI,
        functionName: 'depositReward',
        args: [requiredWei],
      });
      showToast('info', t('deposit_sign_prompt', '📝 请在钱包中签名充值...'));
      const { hash: depositHash } = await viemWriteContract({
        address: poolAddrViem,
        abi: MINING_POOL_ABI,
        functionName: 'depositReward',
        args: [requiredWei],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(depositHash);

      showToast('success', 'cp_create_success');
      // Show success popup (including pool address), create button is locked by overlay during popup to avoid duplicate creation
      setCreatedPool(poolAddr);
    } catch (e) {
      console.error('[cp/create][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('user_rejected') : (e?.shortMessage || 'cp_create_failed'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <button
          onClick={handleBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
          style={{
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-default)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1
            className="text-xl md:text-2xl font-bold"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {t('create_pool_title')}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            {t('pools_subtitle')}
          </p>
        </div>
      </div>

      <div
        className="rounded-xl p-4 flex items-start gap-3"
        style={{
          background: 'var(--cp-infobox-bg)',
          border: '1px solid var(--cp-infobox-border)',
        }}
      >
        <Sparkles
          className="w-5 h-5 flex-shrink-0 mt-0.5"
          style={{ color: 'var(--color-primary-400)' }}
        />
        <div className="text-sm font-medium leading-relaxed" style={{ color: 'var(--color-text-primary)' }}>
          {t('cp_create_tip_line', { fee: createFeeHuman || '—' })}
        </div>
      </div>

      <div
        className="rounded-xl overflow-hidden glass-surface card-glow"
        style={{ boxShadow: 'var(--pagecard-shadow)' }}
      >
        <div className="p-5 md:p-6 space-y-5">
          {/* 1. Mining mode */}
          <Section icon={Layers} title={t('cp_mining_mode_label')}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                {
                  key: MINING_MODES.ALL_PLATFORM,
                  label: t('cp_mode_all_platform'),
                  desc: t('cp_all_platform_mining_desc'),
                },
                {
                  key: MINING_MODES.SPECIFIED_PAIR,
                  label: t('cp_mode_specified_pair'),
                  desc: t('cp_specified_pair_mining_desc'),
                },
              ].map((opt) => {
                const active = miningMode === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setMiningMode(opt.key)}
                    className="relative p-4 rounded-xl text-left transition-all"
                    style={{
                      background: active
                        ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, rgba(249, 115, 22, 0.08) 100%)'
                        : 'var(--color-bg-tertiary)',
                      border: active
                        ? '1px solid var(--color-primary-500)'
                        : '1px solid var(--color-border-default)',
                      boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.04)' : 'none',
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="mt-0.5 w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 transition-all"
                        style={{
                          border: active
                            ? '2px solid var(--color-primary-500)'
                            : '2px solid var(--color-border-default)',
                          background: active ? 'var(--color-primary-500)' : 'transparent',
                        }}
                      >
                        {active && (
                          <div className="w-1.5 h-1.5 rounded-full bg-white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div
                          className="font-semibold text-sm mb-1"
                          style={{ color: 'var(--color-text-primary)' }}
                        >
                          {opt.label}
                        </div>
                        <div
                          className="text-xs leading-relaxed"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        >
                          {opt.desc}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {miningMode === MINING_MODES.SPECIFIED_PAIR && (
              <div
                className="mt-4 p-4 rounded-xl animate-slideDown"
                style={{
                  background: 'rgba(251, 191, 36, 0.04)',
                  border: '1px dashed rgba(249, 115, 22, 0.25)',
                }}
              >
                <div
                  className="text-xs font-semibold mb-3"
                  style={{ color: 'var(--color-primary-500)' }}
                >
                  {t('cp_pair_label')}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MiniTokenSelect label={t('token_a_label')} token={pairTokenA} onClick={() => openTokenPicker('pairA')} />
                  {/* Token B: fixed to 4 base coins; clicking the button opens a small icon menu instead of the large modal */}
                  <div ref={pairBRef} className="relative">
                    <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                      {t('token_b_label')}
                    </div>
                    <button
                      type="button"
                      onClick={() => setPairBOpen((v) => !v)}
                      className="w-full flex items-center gap-2 p-2.5 rounded-xl transition-all hover:opacity-80"
                      style={{
                        background: 'var(--color-bg-secondary)',
                        border: '1px solid var(--color-border-default)',
                      }}
                    >
                      {pairTokenB?.logoURI ? (
                        <TokenIcon src={pairTokenB.logoURI} symbol={pairTokenB?.symbol} size={24} />
                      ) : pairTokenB?.symbol ? (
                        <div className="w-6 h-6 flex items-center justify-center font-bold text-[10px] shrink-0 rounded"
                          style={{ background: 'var(--color-primary-500)', color: '#fff' }}>
                          {String(pairTokenB.symbol).slice(0, 3)}
                        </div>
                      ) : null}
                      <div className="flex-1 text-left min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                          {pairTokenB?.symbol || 'USDT'}
                        </div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                    </button>
                    {pairBOpen && (
                      <div
                        className="absolute left-0 right-0 z-20 mt-1 p-1.5 rounded-xl shadow-xl animate-slideDown"
                        style={{
                          background: 'var(--color-bg-secondary)',
                          border: '1px solid var(--color-border-default)',
                        }}
                      >
                        {['USDT', 'WBNB', 'USDC', 'DAI'].map((sym) => {
                          const tok = findTokenBySymbol(sym, customTokens) || { symbol: sym, logoURI: '' };
                          const active = sym === pairBSymbol;
                          return (
                            <button
                              type="button"
                              key={sym}
                              onClick={() => { setPairBSymbol(sym); setPairBOpen(false); }}
                              className="w-full flex items-center gap-2 p-2 rounded-lg transition-colors"
                              style={{
                                background: active ? 'rgba(249, 115, 22, 0.12)' : 'transparent',
                                color: active ? 'var(--color-primary-500)' : 'var(--color-text-primary)',
                              }}
                              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--color-bg-tertiary)'; }}
                              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                            >
                              {tok?.logoURI ? (
                                <TokenIcon src={tok.logoURI} symbol={tok.symbol} size={22} />
                              ) : (
                                <div className="w-[22px] h-[22px] flex items-center justify-center font-bold text-[10px] shrink-0 rounded"
                                  style={{ background: 'var(--color-primary-500)', color: '#fff' }}>
                                  {sym.slice(0, 3)}
                                </div>
                              )}
                              <span className="text-sm font-semibold flex-1 text-left">{sym}</span>
                              {active && <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-primary-500)' }} />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 px-3 py-2 rounded-lg" style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-default)' }}>
                  <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--color-primary-500)' }}>{t('cp_lp_contract_addr', 'LP 合约地址')}</div>
                  {lpAddress ? (
                    <span className="text-xs font-mono break-all" style={{ color: 'var(--color-text-primary)' }}>{lpAddress}</span>
                  ) : lpError ? (
                    <span className="text-xs" style={{ color: 'var(--color-danger-500, #ef4444)' }}>{lpError === 'no liquidity' ? t('cp_pair_no_liquidity', '该交易对无流动性，无法创建') : t('cp_pair_resolve_failed', 'LP 解析失败')}</span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('cp_resolving', '解析中…')}</span>
                  )}
                </div>
              </div>
            )}
          </Section>

          {/* Reward token + deposit amount (swap payment style) */}
          <Section icon={Coins} title={t('cp_reward_token_label')}>
            <div
              className="rounded-xl px-3.5 py-2.5 transition-colors"
              style={{
                background: 'var(--color-bg-tertiary)',
                border: balanceInsufficient
                  ? '1px solid var(--state-error)'
                  : '1px solid var(--color-border-subtle)',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('cp_prepay_amount_label', '充值数量')}
                </span>
                <span className="text-xs" style={{ color: balanceInsufficient ? 'var(--state-error)' : 'var(--color-text-tertiary)' }}>
                  {t('balance_colon')} <span className="font-numeric">{rewardToken?.symbol === 'CFO' ? formatBalance(cfoBalance, 2) : (tokenBalances?.[rewardToken?.symbol] || '0.00')}</span> {rewardToken?.symbol || 'CFO'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="0"
                    value={prepayAmount}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        setPrepayAmount('');
                        return;
                      }
                      setPrepayAmount(sanitizeIntegerInput(val));
                    }}
                    onKeyDown={blockInvalidIntegerKeys}
                    className="w-full bg-transparent outline-none text-xl font-semibold font-numeric"
                    style={{
                      color: 'var(--color-text-primary)',
                      caretColor: 'var(--color-primary-500)',
                    }}
                  />
                </div>
                {/* Token selection capsule button (swap style, icon only) */}
                <button
                  onClick={() => openTokenPicker('reward')}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-full transition-colors"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-border-default)',
                    color: 'var(--color-text-primary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-bg-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-bg-secondary)';
                  }}
                >
                  {rewardToken?.logoURI ? (
                    <TokenIcon src={rewardToken.logoURI} symbol={rewardToken?.symbol} size={24} />
                  ) : (
                    <div className="w-6 h-6 flex items-center justify-center font-bold text-[10px] shrink-0 rounded"
                      style={{ background: 'var(--color-primary-500)', color: '#fff' }}
                    >
                      {(rewardToken?.symbol || '?').slice(0, 3)}
                    </div>
                  )}
                  <span className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
                    {rewardToken?.symbol || t('select_token')}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 rotate-90" style={{ color: 'var(--color-text-tertiary)' }} />
                </button>
              </div>
              {balanceInsufficient && (
                <div className="mt-1 text-xs" style={{ color: 'var(--state-error)' }}>
                  {t('cp_err_balance_insufficient')}
                </div>
              )}
            </div>
            {rewardToken?.address && rewardToken.address !== '0x0000000000000000000000000000000000000000' && (
              <div className="mt-2 flex items-center gap-1.5 px-1">
                <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('pools.token_contract', '合约')}:
                </span>
                <a
                  href={`https://bscscan.com/address/${rewardToken.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-mono hover:opacity-80 transition-opacity underline underline-offset-2"
                  style={{ color: 'var(--color-primary-500)' }}
                >
                  {rewardToken.address.slice(0, 6)}...{rewardToken.address.slice(-4)}
                </a>
                <ExternalLink className="w-3 h-3" style={{ color: 'var(--color-text-tertiary)' }} />
              </div>
            )}
          </Section>

          {/* 2. Mining parameters (output rate + release cycle) */}
          <Section icon={Settings} title={t('cp_mining_params_label', '挖矿参数')}>
            <div className="space-y-3">
              {/* Output Rate */}
              <div
                className="flex items-center gap-2 p-3 rounded-xl"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-default)',
                }}
              >
                <span className="text-xs font-medium flex-shrink-0 w-16" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('cp_output_rate_label', '产出率')}
                </span>
                <div className="flex-1 flex justify-center">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={outputUsdt}
                    onChange={(e) => setOutputUsdt(sanitizeAmountInput(e.target.value))}
                    onKeyDown={blockInvalidNumericKeys}
                    className="w-20 bg-transparent outline-none text-base font-semibold font-numeric text-center"
                    style={{ color: 'var(--color-primary-500)' }}
                  />
                </div>
                <div className="flex items-center flex-shrink-0">
                  <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                    USDT
                  </span>
                  <span className="text-xs font-medium flex-shrink-0 mx-1" style={{ color: 'var(--color-text-secondary)' }}>
                    /
                  </span>
                  <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--state-success)' }}>
                    1{rewardToken?.symbol || 'CFO'}
                  </span>
                </div>
              </div>

              {/* Release Cycle */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium flex-shrink-0 w-16" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('cp_release_cycle_label', '释放周期')}
                  </span>
                  <div className="flex gap-1.5 flex-1">
                    {RELEASE_PERIOD_OPTIONS.map((opt) => {
                      const active = releaseDays === opt.value;
                      const labelKey =
                        opt.value === 30
                          ? 'cp_cycle_30d'
                          : opt.value === 90
                          ? 'cp_cycle_90d'
                          : opt.value === 180
                          ? 'cp_cycle_180d'
                          : 'cp_cycle_365d';
                      return (
                        <button
                          key={opt.value}
                          onClick={() => setReleaseDays(opt.value)}
                          className="flex-1 h-9 rounded-lg font-medium text-xs transition-all"
                          style={{
                            background: active ? 'var(--gradient-primary)' : 'var(--color-bg-tertiary)',
                            color: active ? '#fff' : 'var(--color-text-secondary)',
                            border: active ? 'none' : '1px solid var(--color-border-default)',
                          }}
                        >
                          {t(labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-[72px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  <Clock className="w-3 h-3" />
                  <span className="text-[11px]">
                    {t('cp_linear_release_label')} · {releaseDays}{t('cp_days_unit')}
                  </span>
                </div>
              </div>
            </div>
          </Section>

          {/* 3. Behavior rewards (restores the standalone card style from the previous version) */}
          <Section icon={Percent} title={t('cp_behavior_reward_label')}>
            <div className="grid grid-cols-2 gap-3">
              <RatioField
                label={t('cp_level1_direct_ratio')}
                value={l1Ratio}
                onChange={setL1Ratio}
              />
              <RatioField
                label={t('cp_level2_indirect_ratio')}
                value={l2Ratio}
                onChange={setL2Ratio}
              />
            </div>
            <div
              className={`mt-3 flex items-start gap-2 p-3 rounded-lg text-xs`}
              style={{
                background: behaviorExceeded
                  ? 'rgba(239, 68, 68, 0.08)'
                  : 'rgba(251, 191, 36, 0.04)',
                border: behaviorExceeded
                  ? '1px solid rgba(239, 68, 68, 0.25)'
                  : '1px solid rgba(249, 115, 22, 0.12)',
                color: behaviorExceeded
                  ? 'rgba(252, 165, 165, 0.95)'
                  : 'var(--color-text-secondary)',
              }}
            >
              {behaviorExceeded ? (
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              ) : (
                <Shield className="w-4 h-4 flex-shrink-0 mt-0.5" />
              )}
              <div>
                {behaviorExceeded
                  ? t('cp_err_ratio_total_exceeded')
                  : t('cp_behavior_reward_tip')}
                <div
                  className="mt-1 font-semibold font-numeric"
                  style={{
                    color: behaviorExceeded
                      ? 'rgba(252, 165, 165, 0.95)'
                      : behaviorTotal >= 25
                      ? 'var(--state-warning)'
                      : 'var(--state-success)',
                  }}
                >
                  L1 + L2 = {behaviorTotal}% / {MAX_BEHAVIOR_REWARD}%
                </div>
              </div>
            </div>
          </Section>

          <div
            className="p-4 rounded-xl"
            style={{
              background: 'rgba(245, 158, 11, 0.06)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
            }}
          >
            <div
              className="flex items-center gap-2 mb-3 font-semibold text-sm"
              style={{ color: 'var(--state-warning)' }}
            >
              <AlertTriangle className="w-4 h-4" />
              {t('cp_notice_title')}
            </div>
            <ul className="space-y-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {[
                'cp_notice_no_modify',
                'cp_notice_prepay_non_refund',
                'cp_notice_auto_stop',
                'cp_notice_ranked_bottom',
              ].map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <span
                    className="w-4 h-4 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center"
                    style={{
                      background: 'rgba(245, 158, 11, 0.12)',
                      color: 'var(--state-warning)',
                      fontSize: '10px',
                      fontWeight: 700,
                    }}
                  >
                    !
                  </span>
                  <span className="leading-relaxed">{t(k)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="pt-2 space-y-3">
            {!approved ? (
              <button
                onClick={handleApprove}
                disabled={!canApprove}
                className={`w-full h-11 rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-all ${canApprove ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/25' : ''}`}
                style={!canApprove ? {
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-default)',
                  color: 'var(--color-text-disabled)',
                } : {}}
              >
                {approving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('approving') || '授权中...'}</span>
                  </>
                ) : createFeeLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t('loading', '加载中...')}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      {t('cp_approve_cfo_btn')}{t('cp_create_fee_suffix', { fee: createFeeHuman })}
                    </span>
                  </>
                )}
              </button>
            ) : (
              <div
                className="flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold"
                style={{
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  color: 'var(--state-success)',
                }}
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{t('cp_approve_success')}</span>
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="w-full h-11 rounded-xl font-bold text-base flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/25 transition-all"
            >
              {creating ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{t('cp_creating_msg')}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5" />
                  <span>{t('cp_create_pool_btn')}</span>
                </>
              )}
            </button>
          </div>
        </div>
    </div>

    {showFeeConfirm && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn"
        onClick={(e) => { e.stopPropagation(); setShowFeeConfirm(false); }}
      >
        <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
        <div
          className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
          style={{ background: '#ffffff', border: '1px solid #e5e7eb', boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start gap-3 mb-4">
            <div
              className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0"
              style={{ background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444' }}
            >
              <AlertTriangle size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold" style={{ color: '#111827' }}>{t('cp_fee_confirm_title', '创建费销毁提醒')}</h3>
              <p className="text-xs mt-1" style={{ color: '#6b7280' }}>
                {t('cp_fee_confirm_desc', '创建矿池将销毁以下 CFO 代币，该操作不可找回：')}
              </p>
            </div>
          </div>

          <div
            className="flex items-center justify-between px-4 py-3 rounded-xl mb-4"
            style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
          >
            <span className="text-sm font-medium" style={{ color: '#111827' }}>{t('cp_fee_confirm_burn_label', '销毁数量')}</span>
            <span className="text-lg font-bold font-numeric" style={{ color: '#ef4444' }}>
              {createFeeHuman} CFO
            </span>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              className="flex-1 h-11 rounded-xl text-sm font-semibold"
              style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#374151' }}
              onClick={() => setShowFeeConfirm(false)}
            >
              {t('common_cancel', '取消')}
            </button>
            <button
              type="button"
              className="flex-1 h-11 rounded-xl text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #ef4444, #f97316)', boxShadow: '0 8px 20px rgba(239,68,68,.25)' }}
              onClick={doApprove}
            >
              {t('cp_fee_confirm_approve', '我已了解，继续授权')}
            </button>
          </div>
        </div>
      </div>
    )}

    {createdPool && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn"
        onClick={(e) => { e.stopPropagation(); }}
      >
        <style>{`
          .cfs-firework{position:fixed;inset:0;pointer-events:none;z-index:120;overflow:hidden}
          .cfs-firework-layer{position:absolute;width:0;height:0}
          .cfs-firework-particle{position:absolute;width:6px;height:6px;border-radius:50%;left:0;top:0;background:var(--c);opacity:0;animation:cfs-burst 1.1s cubic-bezier(.16,1,.3,1) var(--d) forwards}
          @keyframes cfs-burst{0%{transform:rotate(calc(var(--i)*30deg)) translateY(0) scale(1);opacity:1}100%{transform:rotate(calc(var(--i)*30deg)) translateY(82px) scale(.4);opacity:0}}
        `}</style>
        <div className="cfs-firework" aria-hidden>
          {FIREWORK_LAYERS.map((layer, li) => (
            <div key={li} className="cfs-firework-layer" style={{ left: layer.x, top: layer.y }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <i
                  key={i}
                  className="cfs-firework-particle"
                  style={{ '--i': i, '--c': layer.color, '--d': `${layer.delay + i * 25}ms` }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
        <div
          className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
          style={{ background: '#ffffff', border: '1px solid #e5e7eb', boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}
        >
          <div className="flex flex-col items-center text-center mb-4">
            <div
              className="flex items-center justify-center w-14 h-14 rounded-full mb-3"
              style={{ background: 'rgba(16, 185, 129, 0.12)', color: '#10b981' }}
            >
              <CheckCircle2 size={28} />
            </div>
            <h3 className="text-lg font-bold" style={{ color: '#111827' }}>{t('cp_create_success_title', '矿池创建成功！')}</h3>
            <p className="text-xs mt-1" style={{ color: '#6b7280' }}>
              {t('cp_create_success_desc', '请勿重复创建，以下为你的新矿池地址：')}
            </p>
          </div>

          <div
            className="px-4 py-3 rounded-xl mb-4"
            style={{ background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.2)' }}
          >
            <div className="text-[11px] font-medium mb-1" style={{ color: '#10b981' }}>
              {t('cp_create_success_addr_label', '矿池合约地址')}
            </div>
            <div className="text-xs font-mono break-all" style={{ color: '#111827' }}>
              {createdPool}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="w-full h-11 rounded-xl text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #10b981, #14b8a6)', boxShadow: '0 8px 20px rgba(16,185,129,.25)' }}
              onClick={() => navigate('/pools')}
            >
              {t('cp_goto_pools_btn', '前往韭菜庄园')}
            </button>
            <button
              type="button"
              className="w-full h-11 rounded-xl text-sm font-semibold"
              style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#374151' }}
              onClick={() => setCreatedPool(null)}
            >
              {t('common_cancel', '取消')}
            </button>
          </div>
        </div>
      </div>
    )}

    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{
            background: 'var(--state-info-bg)',
            color: 'var(--state-info)',
          }}
        >
          <Icon className="w-4 h-4" />
        </div>
        <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function RatioField({ label, value, onChange }) {
  return (
    <div>
      <label className="text-xs font-semibold mb-1.5 block" style={{ color: 'var(--color-text-secondary)' }}>
        {label}
      </label>
      <div
        className="relative flex items-center h-11 rounded-xl"
        style={{
          background: 'var(--color-bg-tertiary)',
          border: '1px solid var(--color-border-default)',
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(sanitizeIntegerInput(e.target.value))}
          onKeyDown={blockInvalidIntegerKeys}
          className="flex-1 bg-transparent outline-none text-base font-semibold font-numeric px-3.5 pr-8"
          style={{ color: 'var(--color-text-primary)' }}
        />
        <span
          className="absolute right-3 text-sm font-semibold pointer-events-none"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          %
        </span>
      </div>
    </div>
  );
}

function MiniTokenSelect({ label, token, onClick }) {
  return (
    <div>
      <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </div>
      <button
        onClick={onClick}
        className="w-full flex items-center gap-2 p-2.5 rounded-xl transition-all hover:opacity-80"
        style={{
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-default)',
        }}
      >
        {token?.logoURI && (
          <TokenIcon src={token.logoURI} symbol={token?.symbol} size={24} />
        )}
        <div className="flex-1 text-left min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
            {token?.symbol}
          </div>
        </div>
        <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
      </button>
    </div>
  );
}
