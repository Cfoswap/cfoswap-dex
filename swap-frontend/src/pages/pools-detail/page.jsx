import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { getAddress as viemGetAddress } from 'viem';
import {
  ArrowLeft, Zap, Copy, Gift, Users, ExternalLink, Shield, Sparkles,
  AlertTriangle, Clock, Coins, TrendingUp,
  Flame, ShieldCheck, Info
} from 'lucide-react';
import { TOKENS, MINING_POOL_ABI, MINING_POOL_FACTORY_ABI, MINING_POOL_FACTORY_ADDRESS, PAIR_ABI, ERC20_ABI } from '@/config/index.js';
import {
  formatBalance,
  shortenAddress,
  copyToClipboard,
  getExplorerAddressUrl,
  sanitizeAmountInput,
  blockInvalidNumericKeys,
  viemWriteContract,
  viemWaitForTransaction,
  viemFetchDecimals,
  viemParseTokenAmount,
  viemReadContract,
  viemFormatUnits,
  viemSimulateContract,
  calcBigIntPct,
} from '@/utils/index.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import { useChainPools } from '@/hooks/useChainPools.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';
import { tokenIconSrc } from '@/utils/tokens.js';

// Resolve symbol from token address (prioritize built-in TOKENS, fallback to on-chain ERC20.symbol)
async function getTokenSymbol(address) {
  if (!address) return '';
  const addr = address.toLowerCase();
  for (const key of Object.keys(TOKENS)) {
    const tok = TOKENS[key];
    if (tok.address && tok.address.toLowerCase() === addr) return key;
  }
  try {
    return await viemReadContract({
      address,
      abi: ERC20_ABI,
      functionName: 'symbol',
    });
  } catch {
    return address.slice(0, 6);
  }
}

// Pool display name: all-platform pool fixed as "All-Platform Trading Mining" (i18n key: pool_all_platform_mining), pair pool shows pair name (e.g. BNB/USDT)
function getPoolDisplayName(pool, t) {
  if (pool.mode === 'all_platform') return t('pool_all_platform_mining', '全平台交易挖矿');
  return pool.pairName || pool.name;
}

// Format timestamp to YYYY-MM-DD HH:mm:ss (Beijing time)
function formatDateTime(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Map on-chain pool object to detail page display fields
function mapDetailPool(p) {
  return {
    address: p.address,
    name: p.name,
    rewardToken: p.rewardTokenSymbol,
    rewardTokenLogo: tokenIconSrc({ address: p.rewardToken }),
    rewardTokenAddress: p.rewardToken,
    mode: p.mode === 'target_pair' ? 'target_pair' : 'all_platform',
    pairName: p.pairDisplay || '',
    outputRate: p.rewardPerUsd,
    releaseDays: p.vestingDays,
    creator: p.creator,
    createdAt: p.startTime,
    totalReward: p.totalReward,
    minedReward: p.totalDistributed,
    remainingReward: p.remainingReward,
    poolBalance: p.poolBalance || 0n,
    myPending: p.myPending,
    boostAmount: p.boostPaid,
    isHot: p.isHot,
    isVerified: p.isVerified,
    isActivated: p.isActivated,
    status: p.isEnded ? 'ended' : (p.isActivated ? 'active' : 'inactive'),
    referralRewardPercent: p.referralRewardPercent,
    participants: p.participants || 0,
    vesting: {
      total: p.vestingTotal,
      // getVestingInfo item 3 (releasedNow) is the "released" amount; myClaimed is what was already claimed
      released: p.vestingReleased ?? 0n,
      remaining: p.vestingTotal > (p.vestingReleased ?? 0n) ? p.vestingTotal - (p.vestingReleased ?? 0n) : 0n,
      percent: calcBigIntPct(p.vestingReleased ?? 0n, p.vestingTotal),
      days: p.vestingDays,
    },
  };
}

export default function PoolDetailPage() {
  const { t } = useTranslation();
  const { poolAddress } = useParams();
  const navigate = useNavigate();
  const { connected, address, getProvider } = useWalletStore();
  const showBoostModal = useUiStore((s) => s.showBoostModal);
  const showToast = useUiStore((s) => s.showToast);

  const [claiming, setClaiming] = useState(false);
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [activateAmount, setActivateAmount] = useState('');

  const { pools, reload } = useChainPools();

  const chainPool = useMemo(
    () =>
      pools.find(
        (p) => p.address.toLowerCase() === (poolAddress || '').toLowerCase()
      ),
    [pools, poolAddress]
  );

  // Whether current wallet is the creator of this pool (pool owner)
  const isOwner = useMemo(
    () => connected && address && pool?.creator && pool.creator.toLowerCase() === address.toLowerCase(),
    [connected, address, pool]
  );

  // Default deposit amount for owner when inactive = pool total reward
  useEffect(() => {
    if (pool && pool.status === 'inactive' && pool.totalReward > 0n) {
      setActivateAmount((prev) => (prev && Number(prev) > 0 ? prev : formatBalance(pool.totalReward, 0)));
    }
  }, [pool]);

  // Prioritize existing on-chain list; if direct URL access not covered by list, read pool contract on-demand
  useEffect(() => {
    let active = true;
    if (chainPool) {
      setPool(mapDetailPool(chainPool));
      setLoading(false);
      return;
    }
    if (!poolAddress) {
      setLoading(false);
      return;
    }
    async function loadDirect() {
      try {
        const poolAddr = viemGetAddress(poolAddress);
        // Only pools created by the configured factory exist as far as the UI
        // is concerned; anything else (old-contract pools, random addresses)
        // renders the not-found state.
        const registered = await viemReadContract({
          address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
          abi: MINING_POOL_FACTORY_ABI,
          functionName: 'isRegistered',
          args: [poolAddr],
        }).catch(() => false);
        if (!registered) {
          if (active) { setPool(null); setLoading(false); }
          return;
        }
        const info = await viemReadContract({
          address: poolAddr,
          abi: MINING_POOL_ABI,
          functionName: 'poolInfo',
        });
        const userAddr = connected && address ? viemGetAddress(address) : null;
        let myPending = 0n;
        let myClaimed = 0n;
        let vestingTotal = 0n;
        let vestingReleased = 0n;
        let isEnrolled = false;
        if (userAddr) {
          try {
            const [pendingVal, enrolledVal] = await Promise.all([
              viemReadContract({
                address: poolAddr,
                abi: MINING_POOL_ABI,
                functionName: 'getClaimable',
                args: [userAddr],
              }).catch(() => 0n),
              viemReadContract({
                address: poolAddr,
                abi: MINING_POOL_ABI,
                functionName: 'enrolledTraders',
                args: [userAddr],
              }).catch(() => false),
            ]);
            myPending = BigInt(pendingVal || 0n);
            isEnrolled = !!enrolledVal;
            // Daily-bucket linear vesting tuple:
            // (totalAllocated, totalClaimed, releasedNow, claimableNow)
            const acc = await viemReadContract({
              address: poolAddr,
              abi: MINING_POOL_ABI,
              functionName: 'getVestingInfo',
              args: [userAddr],
            }).catch(() => null);
            if (acc) {
              // getVestingInfo: (totalAllocated, totalClaimed, releasedNow, claimableNow)
              vestingTotal = BigInt(acc[0] ?? 0n);
              myClaimed = BigInt(acc[1] ?? 0n);
              vestingReleased = BigInt(acc[2] ?? 0n);
            }
            // isEnrolled is determined solely by on-chain enrolledTraders: accrued rewards remain claimable after unenrolling.
          } catch {
            // User-level read failure does not affect pool display
          }
        }
        // poolInfo() layout: name, rewardToken, totalReward, totalRewardRequired,
        // depositedReward, distributedReward, distributedReferral, remainingReward,
        // vestingDuration, mode, targetPair, isActivated, isEnded, isVerified,
        // isDelisted, startTime, boostPaidTotal, poolOwner, rewardPerUsd, l1bp, l2bp, referralRateBp[8]
        const [
          name, rewardToken, totalRewardRaw, , , , distributedReferral,
          remainingRewardRaw, vestingDuration, mode, targetPair,
          isActivated, isEnded, isVerified, , startTime,
          boostPaidTotal, creator, rewardPerUsd, l1bp, l2bp,
        ] = info;
        const totalReward = BigInt(totalRewardRaw || 0);
        const remainingReward = BigInt(remainingRewardRaw || 0);
        const totalDistributed = totalReward - remainingReward;
        const rewardTokenAddr = rewardToken;
        let rewardTokenSymbol = '';
        for (const key of Object.keys(TOKENS)) {
          const tok = TOKENS[key];
          if (tok.address && tok.address.toLowerCase() === rewardTokenAddr.toLowerCase()) {
            rewardTokenSymbol = key;
            break;
          }
        }
        if (!rewardTokenSymbol) rewardTokenSymbol = shortenAddress(rewardTokenAddr);
        const vestingDays = Number(vestingDuration || 0) / 86400;
        const referralRewardPercent = (Number(l1bp || 0) + Number(l2bp || 0)) / 100;
        const isEndedBool = !!isEnded;
        // Resolve pair name in target pair mode (includes fallback to LP reads when getPairTokens fails)
        let pairDisplay = '';
        if (Number(mode) === 1 && targetPair) {
          try {
            let t0, t1;
            try {
              [t0, t1] = await viemReadContract({
                address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
                abi: MINING_POOL_FACTORY_ABI,
                functionName: 'getPairTokens',
                args: [targetPair],
              });
            } catch (e) {
              t0 = await viemReadContract({
                address: targetPair,
                abi: PAIR_ABI,
                functionName: 'token0',
              });
              t1 = await viemReadContract({
                address: targetPair,
                abi: PAIR_ABI,
                functionName: 'token1',
              });
            }
            let s0 = await getTokenSymbol(t0);
            let s1 = await getTokenSymbol(t1);
            if (s0 === 'WBNB') s0 = 'BNB';
            if (s1 === 'WBNB') s1 = 'BNB';
            if (s1 === 'BNB') { const tmp = s0; s0 = s1; s1 = tmp; }
            pairDisplay = `${s0}/${s1}`;
          } catch (e) {
            pairDisplay = '';
          }
        }
        const boostPaidFormatted = viemFormatUnits(boostPaidTotal || 0n, 18);
        const rewardPerUsdFormatted = viemFormatUnits(rewardPerUsd || 0n, 18);
        // Read reward token balance of pool contract
        let poolBalance = 0n;
        try {
          poolBalance = await Promise.race([
            viemReadContract({
              address: rewardTokenAddr,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [poolAddr],
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('balanceOf timeout')), 3000))
          ]);
        } catch (e) {
          poolBalance = 0n;
        }
        // On-chain participant counter (enroll +1 / unenroll -1). Best
        // effort: a read failure leaves the count at 0 (UI shows '—').
        let participants = 0;
        try {
          const enrolledCount = await Promise.race([
            viemReadContract({
              address: poolAddr,
              abi: MINING_POOL_ABI,
              functionName: 'enrolledCount',
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('enrolledCount timeout')), 3000))
          ]);
          participants = Number(enrolledCount || 0n);
        } catch {
          participants = 0;
        }
        const raw = {
          address: poolAddress,
          name,
          rewardToken: rewardTokenAddr,
          rewardTokenSymbol,
          mode: Number(mode) === 1 ? 'target_pair' : 'all_platform',
          pairDisplay,
          totalReward,
          remainingReward,
          totalDistributed,
          poolBalance,
          progress: calcBigIntPct(totalDistributed, totalReward),
          boostPaid: Number(boostPaidFormatted),
          myPending,
          myClaimed,
          vestingTotal,
          vestingReleased,
          isEnrolled: isEnrolled,
          isVerified: !!isVerified,
          isActivated: !!isActivated,
          isHot: Number(boostPaidFormatted) > 0,
          isEnded: isEndedBool,
          startTime: startTime ? Number(startTime) * 1000 : 0,
          referralRewardPercent,
          creator,
          rewardPerUsd: Number(rewardPerUsdFormatted),
          vestingDays,
          participants,
        };
        if (active) setPool(mapDetailPool(raw));
      } catch (e) {
        console.error('[pools-detail] pool detail read failed:', e?.message || e);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadDirect();
    return () => {
      active = false;
    };
  }, [poolAddress, chainPool, connected, address]);

  const handleBack = () => navigate('/pools');

  const handleBoost = () => {
    if (!connected) {
      useUiStore.getState().showWalletModal();
      return;
    }
    if (pool) showBoostModal(pool.address);
  };

  const handleShare = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const ok = await copyToClipboard(url);
    showToast(ok ? 'success' : 'error', ok ? t('copied', { defaultValue: '已复制到剪贴板' }) : t('copy_failed', { defaultValue: '复制失败' }));
  };

  const handleClaim = async () => {
    if (!connected) {
      useUiStore.getState().showWalletModal();
      return;
    }
    if (!pool || pool.myPending <= 0n) return;
    setClaiming(true);
    try {
      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'claim',
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      // viem version: send claim transaction
      const { hash } = await viemWriteContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'claim',
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      showToast('success', t('claim_success', '🎉 领取成功'));
      reload();
    } catch (e) {
      console.error('[claim][viem]', e);
      if (e?.code === 4001 || e?.message?.includes('rejected') || e?.cause?.message?.includes('rejected')) {
        showToast('error', t('common.user_rejected', '用户已取消签名'));
      } else {
        showToast('error', t('claim_failed', '领取失败'));
      }
    } finally {
      setClaiming(false);
    }
  };

  // Owner deposits reward tokens to activate pool: only available when inactive and current wallet is owner - viem version
  const handleActivate = async () => {
    if (!connected) {
      useUiStore.getState().showWalletModal();
      return;
    }
    if (!pool || pool.status !== 'inactive') return;
    const amount = activateAmount;
    if (!amount || Number(amount) <= 0) {
      showToast('error', t('pd_activate_amount_invalid', '请输入有效的充值金额'));
      return;
    }
    setActivating(true);
    try {
      // viem version: fetch token decimals
      const decimals = await viemFetchDecimals(pool.rewardTokenAddress);
      const amountWei = viemParseTokenAmount(amount, decimals);
      if (amountWei <= 0n) {
        showToast('error', t('pd_activate_amount_invalid', '请输入有效的充值金额'));
        setActivating(false);
        return;
      }
      const rewardTokenAddr = viemGetAddress(pool.rewardTokenAddress);
      const poolAddr = viemGetAddress(pool.address);
      const userAddr = viemGetAddress(address);
      // Step 1: Approve — skip when allowance already sufficient (avoid blind sign)
      const currentAllowance = await viemReadContract({
        address: rewardTokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddr, poolAddr],
      });
      if (currentAllowance < amountWei) {
        // P1 Pre-flight simulate first
        await viemSimulateContract({
          address: rewardTokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [poolAddr, amountWei],
        });
        showToast('info', t('approve_sign_prompt', '📝 请在钱包中签名授权...'));
        const { hash: approveHash } = await viemWriteContract({
          address: rewardTokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [poolAddr, amountWei],
        });
        showToast('info', t('tx_confirming', '⏳ 签名成功，等待授权确认...'));
        await viemWaitForTransaction(approveHash);
      }
      // Step 2: Deposit (P1 Pre-flight simulate first)
      await viemSimulateContract({
        address: poolAddr,
        abi: MINING_POOL_ABI,
        functionName: 'depositReward',
        args: [amountWei],
      });
      showToast('info', t('deposit_sign_prompt', '📝 请在钱包中签名充值...'));
      const { hash: depositHash } = await viemWriteContract({
        address: poolAddr,
        abi: MINING_POOL_ABI,
        functionName: 'depositReward',
        args: [amountWei],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(depositHash);
      showToast('success', t('pd_activate_success', '矿池已激活，开始挖矿！'));
      reload();
    } catch (e) {
      console.error('[pools-detail][viem] deposit/activate tx failed:', e?.message || e);
      if (e?.code === 4001 || e?.message?.includes('rejected') || e?.cause?.message?.includes('rejected')) {
        showToast('error', t('common.user_rejected', '用户已取消签名'));
      } else {
        showToast('error', t('pd_activate_failed', '充值激活失败，请重试'));
      }
    } finally {
      setActivating(false);
    }
  };

  // Unified click prompt for buttons on inactive pools
  const handleInactiveClick = () => {
    showToast('warning', 'pd_inactive_tip');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin w-8 h-8 border-4 rounded-full"
          style={{
            borderColor: 'var(--color-border-default)',
            borderTopColor: 'var(--color-primary-500)',
          }}
        />
      </div>
    );
  }

  if (!pool) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center space-y-3">
          <Shield className="w-10 h-10 mx-auto" style={{ color: 'var(--color-text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {t('pd_not_found', '未找到该矿池，可能已被下线')}
          </div>
          <button
            onClick={handleBack}
            className="h-10 px-4 rounded-xl text-sm font-semibold"
            style={{
              background: 'var(--color-primary-500)',
              color: '#fff',
            }}
          >
            {t('back_to_pools')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
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
        <span
          className="text-xs font-semibold"
          style={{ color: 'var(--color-text-secondary)' }}
          onClick={handleBack}
        >
          {t('back_to_pools')}
        </span>
      </div>

      <div
        className="rounded-xl overflow-hidden glass-surface card-glow"
        style={{ boxShadow: 'var(--pagecard-shadow)' }}
      >
        <div className="p-5 md:p-6 border-b" style={{ borderColor: 'var(--color-border-default)' }}>
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div
                className="w-10 h-10 flex items-center justify-center flex-shrink-0"
              >
                <TokenIcon
                  src={pool.rewardTokenLogo}
                  symbol={pool.rewardToken}
                  size={40}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1
                    className="text-xl md:text-2xl font-bold truncate"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {getPoolDisplayName(pool, t)}
                  </h1>

                  {pool.status === 'active' ? (
                    <span
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{
                        background: 'rgba(16, 185, 129, 0.1)',
                        color: 'var(--state-success)',
                        border: '1px solid rgba(16, 185, 129, 0.2)',
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: 'var(--state-success)' }}
                      />
                      {t('active')}
                    </span>
                  ) : pool.status === 'inactive' ? (
                    <span
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{
                        background: 'rgba(245, 158, 11, 0.1)',
                        color: 'var(--color-warn-500)',
                        border: '1px solid rgba(245, 158, 11, 0.25)',
                      }}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      {t('pd_inactive', '未激活')}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{
                        background: 'rgba(148, 163, 184, 0.1)',
                        color: 'var(--color-text-tertiary)',
                        border: '1px solid rgba(148, 163, 184, 0.15)',
                      }}
                    >
                      {t('ended')}
                    </span>
                  )}

                  {pool.isVerified && (
                    <span
                      className="inline-flex items-center gap-0.5 px-2 py-1 rounded text-[11px] font-semibold"
                      style={{
                        background: 'rgba(16, 185, 129, 0.1)',
                        color: 'var(--state-success)',
                      }}
                      title={t('pool_verified_badge')}
                    >
                      <ShieldCheck className="w-3 h-3" />
                      {t('verified').replace('✅', '')}
                    </span>
                  )}
                  {pool.isHot && (
                    <span
                      className="inline-flex items-center gap-0.5 px-2 py-1 rounded text-[11px] font-bold"
                      style={{
                        background:
                          'linear-gradient(135deg, #f97316 0%, #fb923c 100%)',
                        color: '#fff',
                      }}
                    >
                      <Flame className="w-3 h-3" />
                      {t('hot').replace('🔥', '')}
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px] mt-1 flex items-center gap-2 flex-wrap"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  {shortenAddress(pool.address)}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={pool.status === 'active' ? handleBoost : handleInactiveClick}
                className={`h-10 px-3.5 rounded-xl font-semibold text-xs flex items-center gap-1.5 ${pool.status !== 'active' ? 'opacity-40 cursor-not-allowed' : ''}`}
                style={{
                  background: pool.status === 'active' ? 'rgba(249, 115, 22, 0.08)' : 'var(--color-bg-tertiary)',
                  border: pool.status === 'active' ? '1px solid rgba(249, 115, 22, 0.3)' : '1px solid var(--color-border-default)',
                  color: pool.status === 'active' ? 'var(--color-warn-500)' : 'var(--color-text-disabled)',
                }}
              >
                <Zap className="w-3.5 h-3.5" />
                {t('boost')}
              </button>
              <button
                onClick={handleShare}
                className="h-10 px-3.5 rounded-xl font-semibold text-xs flex items-center gap-1.5"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-default)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <Copy className="w-3.5 h-3.5" />
                {t('share')}
              </button>
            </div>
          </div>
        </div>

        <div className="p-5 md:p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <CoreStatCard
              icon={Coins}
              label={t('pool_total_reward_label')}
              value={`${formatBalance(pool.totalReward, 0)}`}
              unit={pool.rewardToken}
              gradient="var(--gradient-primary)"
            />
            <CoreStatCard
              icon={TrendingUp}
              label={t('mined')}
              value={`${formatBalance(pool.minedReward, 0)}`}
              unit={pool.rewardToken}
              subValue={`${pool.progress.toFixed(1)}%`}
              gradient="var(--gradient-warn)"
            />
            <CoreStatCard
              icon={Gift}
              label={t('remaining_reward')}
              value={`${formatBalance(pool.remainingReward, 0)}`}
              unit={pool.rewardToken}
              gradient="linear-gradient(135deg, #10b981 0%, #06b6d4 100%)"
            />
            <CoreStatCard
              icon={Users}
              label={t('my_pending')}
              value={`${formatBalance(pool.myPending, 4)}`}
              unit={pool.rewardToken}
              highlight={pool.myPending > 0n}
              gradient="linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)"
            />
          </div>

          <Section title={t('mining_phases')} icon={Sparkles}>
            <div
              className="p-4 rounded-xl"
              style={{
                background:
                  'linear-gradient(135deg, rgba(59, 130, 246, 0.06) 0%, rgba(139, 92, 246, 0.04) 100%)',
                border: '1px solid var(--color-border-strong)',
              }}
            >
              <div className="flex items-center justify-between mb-2.5">
                <span
                  className="font-semibold text-sm"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {t('pd_mining_progress', '挖矿总进度')}
                </span>
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-bold"
                  style={{
                    background: 'var(--gradient-warn)',
                    color: '#fff',
                  }}
                >
                  {t('status_active', 'Active')}
                </span>
              </div>
              <div className="flex items-center justify-between mb-1.5 text-xs">
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {formatBalance(pool.minedReward, 0)} / {formatBalance(pool.totalReward, 0)}{' '}
                  {pool.rewardToken}
                </span>
                <span
                  className="font-semibold font-numeric"
                  style={{ color: 'var(--color-primary-400)' }}
                >
                  {pool.progress.toFixed(1)}%
                </span>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'rgba(148, 163, 184, 0.12)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(pool.progress, 100)}%`,
                    background: pool.status === 'ended' ? 'var(--state-success)' : 'var(--color-primary-500)',
                  }}
                />
              </div>
            </div>
          </Section>

          <Section title={t('release_progress')} icon={Clock} className="mt-6">
            <div
              className="p-4 rounded-xl"
              style={{
                background:
                  'linear-gradient(135deg, rgba(16, 185, 129, 0.06) 0%, rgba(6, 182, 212, 0.04) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.15)',
              }}
            >
              <div className="grid grid-cols-3 gap-3 mb-4">
                <MiniStat
                  label={t('total_release_amount')}
                  value={formatBalance(pool.vesting.total, 4)}
                  unit={pool.rewardToken}
                />
                <MiniStat
                  label={t('released_amount')}
                  value={formatBalance(pool.vesting.released, 4)}
                  unit={pool.rewardToken}
                  color="var(--state-success)"
                />
                <MiniStat
                  label={t('remaining_release')}
                  value={formatBalance(pool.vesting.remaining, 4)}
                  unit={pool.rewardToken}
                  color="var(--color-primary-400)"
                />
              </div>
              <div className="flex items-center justify-between mb-1.5 text-xs">
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {t('released_of_total', { pct: pool.vesting.percent.toFixed(1), defaultValue: `已释放 ${pool.vesting.percent.toFixed(1)}%` })}
                </span>
                <span
                  className="font-semibold font-numeric"
                  style={{ color: 'var(--state-success)' }}
                >
                  {pool.vesting.percent.toFixed(1)}%
                </span>
              </div>
              <div
                className="h-2.5 rounded-full overflow-hidden mb-3"
                style={{ background: 'rgba(148, 163, 184, 0.12)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(pool.vesting.percent, 100)}%`,
                    background: 'var(--state-success)',
                  }}
                />
              </div>
              <div
                className="text-xs flex items-center gap-1.5"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                <Clock className="w-3.5 h-3.5" />
                <span>
                  {t('pd_linear_vesting_general', { days: pool.vesting.days, defaultValue: `${pool.vesting.days}天线性释放，${pool.vesting.days}天内均匀释放已挖出奖励` })}
                </span>
              </div>
            </div>
          </Section>

          <Section title={t('mining_rules_explain')} icon={Shield} className="mt-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <RuleCard
                title={t('rule_trade_mine_title')}
                desc={t('rule_trade_mine_desc')}
                color="primary"
              />
              <RuleCard
                title={t('rule_phases_title')}
                desc={t('rule_phases_desc')}
                color="warn"
              />
              <RuleCard
                title={t('rule_vesting_title')}
                desc={t('rule_vesting_desc', { defaultValue: `每笔挖矿收益按 ${pool.vesting.days} 天线性释放，可随时领取已释放部分。` })}
                color="success"
              />
            </div>
          </Section>

          <Section title={t('contract_info')} icon={Info} className="mt-6">
            <div
              className="p-4 rounded-xl divide-y"
              style={{
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-default)',
              }}
            >
              <ParamRow
                label={t('reward_token_info')}
                value={
                  <div className="flex items-center gap-2">
                    <TokenIcon src={pool.rewardTokenLogo} symbol={pool.rewardToken} size={16} />
                    <span
                      className="font-semibold"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {pool.rewardToken}
                    </span>
                    <a
                      href={getExplorerAddressUrl(pool.rewardTokenAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-xs"
                      style={{ color: 'var(--color-primary-400)' }}
                    >
                      {shortenAddress(pool.rewardTokenAddress)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                }
              />
              <ParamRow
                label={t('mode')}
                value={
                  <span
                    className="font-semibold text-xs"
                    style={{
                      color:
                        pool.mode === 'all_platform'
                          ? 'var(--state-info)'
                          : 'var(--color-primary-500)',
                    }}
                  >
                    {pool.mode === 'all_platform'
                      ? t('mode_all_platform')
                      : `${t('mode_pair')} · ${pool.pairName || '--'}`}
                  </span>
                }
              />
              <ParamRow
                label={t('output_rate')}
                value={
                  <span
                    className="font-semibold text-sm font-numeric"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {formatRewardPerUsd(pool.outputRate, pool.rewardToken, t)}
                  </span>
                }
              />
              <ParamRow
                label={t('vesting_rule')}
                value={
                  <span style={{ color: 'var(--color-text-primary)' }}>
                    {t('pd_rules_linear_vesting_days', {
                      days: pool.releaseDays,
                      defaultValue: `${pool.releaseDays} 天线性释放`,
                    })}
                  </span>
                }
              />
              <ParamRow
                label={t('behavior_reward')}
                value={
                  <span
                    className="text-xs font-numeric font-semibold"
                    style={{ color: 'var(--color-primary-500)' }}
                  >
                    {t('pd_behavior_total', { defaultValue: 'L1+L2 合计' })} {pool.referralRewardPercent}%
                  </span>
                }
              />
              <ParamRow
                label={t('creator')}
                value={
                  <a
                    href={getExplorerAddressUrl(pool.creator)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs"
                    style={{ color: 'var(--color-primary-400)' }}
                  >
                    {shortenAddress(pool.creator)}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                }
              />
              <ParamRow
                label={t('contract_address')}
                value={
                  <div className="flex items-start gap-2 justify-end">
                    <button
                      onClick={async () => {
                        const ok = await copyToClipboard(pool.address);
                        showToast(ok ? 'success' : 'error', ok ? t('copied', { defaultValue: '已复制' }) : t('copy_failed', { defaultValue: '复制失败' }));
                      }}
                      className="inline-flex items-start gap-1 text-xs hover:opacity-80 transition-opacity break-all text-right"
                      style={{ color: 'var(--color-primary-400)' }}
                      title={pool.address}
                    >
                      {pool.address}
                      <Copy className="w-3 h-3 shrink-0 mt-0.5" />
                    </button>
                    <a
                      href={getExplorerAddressUrl(pool.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center shrink-0 mt-0.5"
                      style={{ color: 'var(--color-text-tertiary)' }}
                      title={t('view_on_explorer', { defaultValue: '在区块浏览器查看' })}
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                }
              />
              <ParamRow
                label={t('pool_balance', { defaultValue: '矿池余额' })}
                value={
                  <span
                    className="font-semibold text-xs font-numeric"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {formatBalance(pool.poolBalance, 4)} {pool.rewardToken}
                  </span>
                }
              />
              <ParamRow
                label={t('pools.participants', { defaultValue: '参与人数' })}
                value={
                  <span
                    className="font-semibold text-xs font-numeric"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {pool.participants > 0 ? pool.participants.toLocaleString() : '—'}
                  </span>
                }
              />
              {pool.createdAt > 0 && (
                <ParamRow
                  label={t('created_at')}
                  value={
                    <span
                      className="text-xs"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {formatDateTime(pool.createdAt)}
                    </span>
                  }
                />
              )}
            </div>
          </Section>

          {/* Owner deposit activation: only show when inactive and current wallet is owner */}
          {pool.status === 'inactive' && isOwner && (
            <div
              className="mt-6 p-4 rounded-xl"
              style={{
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(249, 115, 22, 0.05) 100%)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" style={{ color: 'var(--color-warn-500)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--color-warn-500)' }}>
                  {t('pd_activate_title', '矿池尚未激活')}
                </span>
              </div>
              <p className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {t('pd_activate_desc', '你是该矿池的创建者。充入奖励代币激活后，报名交易者才能正常挖矿。')}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  value={activateAmount}
                  onChange={(e) => setActivateAmount(sanitizeAmountInput(e.target.value))}
                  onKeyDown={blockInvalidNumericKeys}
                  placeholder="0"
                  className="flex-1 h-11 rounded-xl px-3 text-sm font-semibold outline-none"
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    border: '1px solid var(--color-border-default)',
                    color: 'var(--color-text-primary)',
                  }}
                />
                <button
                  onClick={handleActivate}
                  disabled={activating}
                  className="h-11 px-5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background: 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)',
                    color: '#fff',
                  }}
                >
                  {activating ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                  {activating ? t('processing', '处理中...') : t('pd_activate_btn', '充值激活')}
                </button>
              </div>
              <div className="text-[11px] mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('pd_activate_hint', '充值金额需 ≥ 矿池总奖励，默认已填好总奖励数量。')}
              </div>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <button
              onClick={pool.status === 'active' ? handleClaim : handleInactiveClick}
              disabled={pool.status !== 'active' || claiming}
              className={`h-11 rounded-xl font-bold text-sm flex items-center justify-center gap-2 btn-warn ${pool.status !== 'active' ? 'opacity-40 cursor-not-allowed' : ''} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {claiming ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Gift className="w-4 h-4" />
              )}
              {claiming
                ? t('signing', '签名中...')
                : `${t('claim')} ${formatBalance(pool.myPending, 4)} ${pool.rewardToken}`}
            </button>
            <button
              onClick={pool.status === 'active' ? handleBoost : handleInactiveClick}
              className={`h-11 rounded-xl font-bold text-sm flex items-center justify-center gap-2 ${pool.status !== 'active' ? 'opacity-40 cursor-not-allowed' : ''}`}
              style={{
                background:
                  pool.status === 'active'
                    ? 'linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(139, 92, 246, 0.1) 100%)'
                    : 'var(--color-bg-tertiary)',
                border:
                  pool.status === 'active'
                    ? '1px solid var(--color-border-strong)'
                    : '1px solid var(--color-border-default)',
                color:
                  pool.status === 'active'
                    ? 'var(--color-primary-400)'
                    : 'var(--color-text-disabled)',
              }}
            >
              <Zap className="w-4 h-4" />
              {t('boost')} · {pool.boostAmount.toFixed(2)} BNB
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRewardPerUsd(rate, symbol, t) {
  if (rate >= 1) return t('pd_output_rate_per_usd', { amount: rate, symbol });
  if (rate >= 0.001) return t('pd_output_rate_per_usd', { amount: rate, symbol });
  const usdNeeded = 1 / rate;
  if (usdNeeded >= 1_000_000) return t('pd_output_rate_m', { usd: (usdNeeded / 1_000_000).toFixed(0), symbol });
  if (usdNeeded >= 1_000) return t('pd_output_rate_k', { usd: (usdNeeded / 1_000).toFixed(0), symbol });
  return t('pd_output_rate_usd', { usd: usdNeeded.toFixed(0), symbol });
}

function Section({ title, icon: Icon, children, className = '' }) {
  const { t } = useTranslation();
  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{
            background: 'var(--state-info-bg)',
            color: 'var(--state-info)',
          }}
        >
          <Icon className="w-3.5 h-3.5" />
        </div>
        <h3
          className="font-semibold text-sm"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function CoreStatCard({
  icon: Icon,
  label,
  value,
  unit,
  subValue,
  highlight,
  gradient,
}) {
  return (
    <div
      className="relative p-4 rounded-xl overflow-hidden"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: highlight
          ? '1px solid var(--color-border-glow)'
          : '1px solid var(--color-border-default)',
        boxShadow: highlight ? 'var(--shadow-glow)' : 'none',
      }}
    >
      <div
        className="absolute top-0 right-0 w-20 h-20 rounded-full opacity-20"
        style={{
          background: gradient,
          transform: 'translate(40%, -40%)',
          filter: 'blur(12px)',
        }}
      />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span
            className="text-[11px] font-medium"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            {label}
          </span>
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{
              background: `${gradient}22`,
            }}
          >
            <Icon className="w-3.5 h-3.5" style={{
              background: gradient,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }} />
          </div>
        </div>
        <div className="flex items-baseline gap-1">
          <span
            className="text-lg md:text-xl font-bold font-numeric"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {value}
          </span>
          <span
            className="text-xs font-semibold"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            {unit}
          </span>
        </div>
        {subValue && (
          <div
            className="mt-0.5 text-xs font-semibold font-numeric"
            style={{ color: 'var(--color-warn-500)' }}
          >
            {subValue}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, unit, color }) {
  return (
    <div className="text-center">
      <div
        className="text-[11px] mb-1"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        {label}
      </div>
      <div
        className="text-base font-bold font-numeric"
        style={{ color: color || 'var(--color-text-primary)' }}
      >
        {value}
      </div>
      <div
        className="text-[10px] font-semibold"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        {unit}
      </div>
    </div>
  );
}

function RuleCard({ title, desc, color }) {
  const styles = {
    primary: {
      bg: 'rgba(59, 130, 246, 0.06)',
      border: 'rgba(59, 130, 246, 0.18)',
      text: 'var(--state-info)',
    },
    warn: {
      bg: 'rgba(249, 115, 22, 0.06)',
      border: 'rgba(249, 115, 22, 0.2)',
      text: 'var(--color-warn-500)',
    },
    success: {
      bg: 'rgba(16, 185, 129, 0.06)',
      border: 'rgba(16, 185, 129, 0.18)',
      text: 'var(--state-success)',
    },
  };
  const s = styles[color] || styles.primary;
  return (
    <div
      className="p-4 rounded-xl"
      style={{ background: s.bg, border: `1px solid ${s.border}` }}
    >
      <div
        className="text-sm font-semibold mb-1.5"
        style={{ color: s.text }}
      >
        {title}
      </div>
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {desc}
      </p>
    </div>
  );
}

function ParamRow({ label, value }) {
  return (
    <div
      className="flex items-start justify-between py-3 first:pt-0 last:pb-0"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <span
        className="text-xs font-medium flex-shrink-0 mr-4"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1 text-right">{value}</div>
    </div>
  );
}