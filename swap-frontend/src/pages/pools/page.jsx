import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Sparkles, Shield, Flame, Zap, CheckCircle2, Circle, HelpCircle, Users, Clock, X, AlertTriangle, Info, Copy, ExternalLink } from 'lucide-react';
import { getAddress as viemGetAddress, parseEther as viemParseEther, formatEther as viemFormatEther } from 'viem';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import { MINING_POOL_ABI, MINING_POOL_FACTORY_ADDRESS, MINING_POOL_FACTORY_ABI, ERC20_ABI } from '@/config/index.js';
import { tokenIconSrc } from '@/utils/tokens.js';
import { useChainPools } from '@/hooks/useChainPools.js';
import { formatTokenAmount, parseTokenAmount, fetchDecimals, sanitizeAmountInput, blockInvalidNumericKeys, getReadProvider, viemWriteContract, viemWaitForTransaction, viemReadContract, viemSimulateContract, copyToClipboard } from '@/utils/index.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';

// Icon component with tooltip
function PoolBadgeIcon({ Icon, colorClass, tooltipText }) {
  const [show, setShow] = useState(false);
  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); setShow(!show); }}
    >
      <Icon className={`w-4 h-4 shrink-0 ${colorClass}`} />
      {show && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-3 py-2 bg-white dark:bg-[#1a1a2e] border border-[var(--color-border)] rounded-lg shadow-xl text-xs text-[var(--color-text-secondary)] min-w-max max-w-[180px] z-[100]">
          {tooltipText}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white dark:bg-[#1a1a2e] border-l border-t border-[var(--color-border)] rotate-45" />
        </div>
      )}
    </div>
  );
}

// ==================== Helper Functions ====================
// BigInt(wei) → Compressed number (K/M/B)
function formatBigNum(bn) {
  const n = bn ? Number(viemFormatEther(bn)) : 0;
  return formatNum(n);
}

// BigInt(wei) → Normal amount (preserve decimal places)
function formatBigAmount(bn) {
  const n = bn ? Number(viemFormatEther(bn)) : 0;
  return formatAmount(n);
}

// Pool display name: cross-network pool fixed as "Network-Wide Trading Contest", trading pair pool shows pair (e.g. BNB/USDT)
function getPoolDisplayName(pool, t) {
  if (pool.mode === 'all_pairs') return t('pool_all_platform_contest', '全网交易竞赛');
  return pool.pairDisplay || pool.name;
}

function shortenAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getExplorerUrl(address) {
  return `https://bscscan.com/address/${address}`;
}

function formatRewardPerUsd(rate, symbol, t) {
  if (rate >= 1) return t('pools.reward_per_usd_rate', '交易 $1 产出 {{rate}} {{symbol}}', { rate, symbol });
  if (rate >= 0.001) return t('pools.reward_per_usd_rate', '交易 $1 产出 {{rate}} {{symbol}}', { rate, symbol });
  const usdNeeded = 1 / rate;
  if (usdNeeded >= 1_000_000) return t('pools.reward_per_usd_amount', '交易 ${{amount}} 产出 1 {{symbol}}', { amount: `${(usdNeeded / 1_000_000).toFixed(0)}M`, symbol });
  if (usdNeeded >= 1_000) return t('pools.reward_per_usd_amount', '交易 ${{amount}} 产出 1 {{symbol}}', { amount: `${(usdNeeded / 1_000).toFixed(0)}K`, symbol });
  return t('pools.reward_per_usd_amount', '交易 ${{amount}} 产出 1 {{symbol}}', { amount: usdNeeded.toFixed(0), symbol });
}

// Format timestamp as YYYY-MM-DD HH:mm:ss
function formatDateTime(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatNum(n) {
  if (typeof n === 'bigint') n = Number(n);
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toFixed(4);
}

function formatAmount(n) {
  // Compatible with wei unit BigInt / string: uniformly convert to readable ether value, avoid n.toFixed error on BigInt
  if (typeof n === 'bigint') n = Number(viemFormatEther(n));
  if (typeof n === 'string') n = Number(n);
  if (!isFinite(n)) n = 0;
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function PoolLogoPair({ pool, size = 'md' }) {
  const { t } = useTranslation();
  const sizeClass = size === 'sm' ? 'w-6 h-6' : size === 'lg' ? 'w-8 h-8' : 'w-7 h-7';
  const logoSize = size === 'sm' ? 24 : size === 'lg' ? 32 : 28;

  const parsePair = () => {
    if (pool.mode === 'all_pairs') return null;
    const basePair = pool.pairDisplay.includes('LP') ? pool.pairDisplay.replace(' LP', '') : pool.pairDisplay;
    if (!basePair.includes('/')) return null;
    const [a, b] = basePair.split('/');
    return { a: a.trim(), b: b.trim() };
  };

  const pair = parsePair();

  return (
    <div className="flex -space-x-2 shrink-0">
      {pair && (
        <>
          <TokenIcon src={tokenIconSrc({ address: pool.pairTokenA })} symbol={pair.a} size={logoSize} className="border-2 border-[var(--color-card-bg)] shadow-sm" />
          <TokenIcon src={tokenIconSrc({ address: pool.pairTokenB })} symbol={pair.b} size={logoSize} className="border-2 border-[var(--color-card-bg)] shadow-sm" />
        </>
      )}
      {pool.mode === 'all_pairs' && (
        <TokenIcon src="/img/logo.png?v=6" symbol="CFO" size={logoSize} className="border-2 border-[var(--color-card-bg)] shadow-sm" />
      )}
    </div>
  );
}

// ==================== Components ====================
export default function PoolsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { connected: isConnected, address } = useWalletStore();
  const { showToast, showWalletModal: openWalletModal } = useUiStore();
  const { pools, loading, reload } = useChainPools();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('active');
  const [sortBy, setSortBy] = useState('boost');
  const [onlyEnrolled, setOnlyEnrolled] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [showBoostTooltip, setShowBoostTooltip] = useState(false);
  const [confirmEnrollPool, setConfirmEnrollPool] = useState(null);
  const [confirmUnenrollPool, setConfirmUnenrollPool] = useState(null);
  const [detailPool, setDetailPool] = useState(null);
  const [boostPool, setBoostPool] = useState(null);
  const [boostAmount, setBoostAmount] = useState('0.1');
  const [activatePool, setActivatePool] = useState(null);
  const [activateAmount, setActivateAmount] = useState('');
  const [activating, setActivating] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [unenrolling, setUnenrolling] = useState(false);
  const [claimingPool, setClaimingPool] = useState(null);
  const [claimingAll, setClaimingAll] = useState(false);
  const [boosting, setBoosting] = useState(false);

  // Whether current wallet is pool creator (pool owner)
  const isPoolOwner = useCallback(
    (pool) => isConnected && address && pool?.creator && pool.creator.toLowerCase() === address.toLowerCase(),
    [isConnected, address]
  );

  // Filtering and sorting
  const filteredPools = useMemo(() => {
    let list = [...pools];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.rewardTokenSymbol || '').toLowerCase().includes(q) ||
        (p.pairDisplay || '').toLowerCase().includes(q)
      );
    }
    if (activeFilter === 'active') list = list.filter(p => !p.isEnded && p.isActivated);
    if (activeFilter === 'inactive') list = list.filter(p => !p.isEnded && !p.isActivated);
    if (activeFilter === 'ended') list = list.filter(p => p.isEnded);
    if (activeFilter === 'newest') list = list.filter(p => p.progress < 10 && !p.isEnded && p.isActivated);
    // Claim entry only checks pending balance: accrued rewards remain claimable after
    // unenrolling (contract claim does not verify enrollment status)
    if (activeFilter === 'claimable') list = list.filter(p => p.myPending > 0n);
    if (onlyEnrolled) list = list.filter(p => p.isEnrolled);

    // Inactive tab: show only unactivated pools, newest first
    if (activeFilter === 'inactive') {
      list.sort((a, b) => b.startTime - a.startTime);
      return list;
    }

    // Split into two groups: boosted vs unboosted (activated pools only)
    const boosted = list.filter(p => p.boostPaid > 0 && !p.isEnded && p.isActivated);
    const unboosted = list.filter(p => p.boostPaid === 0 && !p.isEnded && p.isActivated);
    const inactive = list.filter(p => !p.isEnded && !p.isActivated);
    const ended = list.filter(p => p.isEnded);

    // Boosted: fixed in descending boost-amount order, unaffected by the sort dropdown
    boosted.sort((a, b) => b.boostPaid - a.boostPaid);

    // Unboosted: sorted according to the dropdown selection
    unboosted.sort((a, b) => {
      if (sortBy === 'participants') return b.participants - a.participants;
      if (sortBy === 'progress') return a.progress - b.progress;
      if (sortBy === 'newest') return b.startTime - a.startTime;
      return b.startTime - a.startTime; // Default: newest launch first
    });

    // Inactive: newest first
    inactive.sort((a, b) => b.startTime - a.startTime);

    // Ended pools come last, ordered by start time descending
    ended.sort((a, b) => b.startTime - a.startTime);

    return [...boosted, ...unboosted, ...inactive, ...ended];
  }, [pools, searchQuery, activeFilter, sortBy, onlyEnrolled]);

  // Count enrolled mining pools
  const enrolledCount = useMemo(() => pools.filter(p => p.isEnrolled).length, [pools]);
  const hasPendingReward = useMemo(() => pools.some(p => p.myPending > 0n), [pools]);

  // Pending claim details by pool (each pool displayed independently, avoid merging same token across different pools)
  const pendingByPool = useMemo(() => pools.filter(p => p.myPending > 0n), [pools]);

  // Aggregate unreleased amounts per token (vestingTotal - myClaimed)
  const vestingByToken = useMemo(() => {
    // Group by reward token contract address: same-symbol tokens from different
    // contracts must not be merged
    const map = {};
    for (const pool of pools) {
      if (pool.vestingTotal > pool.myClaimed) {
        const key = (pool.rewardToken || '').toLowerCase();
        if (!key) continue;
        const pending = pool.vestingTotal - pool.myClaimed;
        if (!map[key]) map[key] = { symbol: pool.rewardTokenSymbol, address: pool.rewardToken, total: 0n, released: 0n, pending: 0n, pools: 0 };
        map[key].total += pool.vestingTotal;
        map[key].released += pool.myClaimed;
        map[key].pending += pending;
        map[key].pools += 1;
      }
    }
    return Object.values(map).map((data) => {
      const progress = data.total > 0n ? Number((data.released * 100n) / data.total) : 0;
      return { ...data, progress };
    });
  }, [pools]);

  // Network-wide behavior rewards: cumulative L1+L2 referral rewards actually
  // distributed across all pools (contract field distributedReferral), summed per
  // reward token address. When the wallet is connected and owns self-created pools,
  // only tokens used by those pools are shown; when disconnected or owning no pools,
  // the full network-wide totals for all tokens are shown (public data).
  const networkReferralByToken = useMemo(() => {
    const byToken = new Map();
    for (const pool of pools) {
      const tokenAddr = (pool.rewardToken || '').toLowerCase();
      if (!tokenAddr) continue;
      if (!byToken.has(tokenAddr)) {
        byToken.set(tokenAddr, { symbol: pool.rewardTokenSymbol, address: pool.rewardToken, amount: 0n });
      }
      byToken.get(tokenAddr).amount += BigInt(pool.totalReferralDistributed || 0n);
    }
    if (isConnected && address) {
      const myTokenAddrs = new Set(
        pools
          .filter(p => p.creator && p.creator.toLowerCase() === address.toLowerCase())
          .map(p => (p.rewardToken || '').toLowerCase())
          .filter(Boolean)
      );
      if (myTokenAddrs.size > 0) {
        return [...byToken.entries()]
          .filter(([addr]) => myTokenAddrs.has(addr))
          .map(([, entry]) => entry);
      }
    }
    return [...byToken.values()].filter(entry => entry.amount > 0n);
  }, [pools, isConnected, address]);

  const handleEnroll = (pool) => {
    if (!isConnected) { openWalletModal(); return; }
    setConfirmEnrollPool(pool);
  };

  // Map pool enrollment custom errors (viem surfaces raw 4-byte selectors when
  // the ABI lacks error declarations). `stale` flags a UI/chain state mismatch
  // that self-heals via reload() (e.g. already left on-chain but page stale).
  const mapEnrollError = (e) => {
    const raw = `${e?.message || ''} ${e?.cause?.message || ''} ${e?.shortMessage || ''} ${e?.data?.errorName || ''}`;
    if (raw.includes('rejected') || e?.code === 4001) return { msg: t('common.user_rejected', '用户已取消签名'), stale: false };
    if (raw.includes('AlreadyEnrolled') || raw.toLowerCase().includes('0x6d6d97d9')) return { msg: t('pools.err_already_enrolled', '已报名该矿池，无需重复报名'), stale: true };
    if (raw.includes('NotEnrolled') || raw.toLowerCase().includes('0xc950bf92')) return { msg: t('pools.err_not_enrolled', '当前未报名该矿池（可能已退出），正在刷新页面状态…'), stale: true };
    return { msg: '', stale: false };
  };

  const confirmEnroll = async () => {
    const pool = confirmEnrollPool;
    if (!pool) return;
    setEnrolling(true);
    try {
      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'enroll',
        args: [],
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'enroll',
        args: [],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      showToast('success', t('pools.enroll_success', '✅ 已报名「{{name}}」', { name: pool.name }));
      setConfirmEnrollPool(null);
      reload();
    } catch (e) {
      console.error('[enroll][viem]', e);
      const mapped = mapEnrollError(e);
      showToast('error', mapped.msg || t('pools.enroll_failed', '报名失败'));
      if (mapped.stale) reload();
    } finally {
      setEnrolling(false);
    }
  };

  const handleUnenroll = (pool) => {
    if (!isConnected) { openWalletModal(); return; }
    setConfirmUnenrollPool(pool);
  };

  const confirmUnenroll = async () => {
    const pool = confirmUnenrollPool;
    if (!pool) return;
    setUnenrolling(true);
    try {
      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'unenroll',
        args: [],
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'unenroll',
        args: [],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      showToast('success', t('pools.unenroll_success', '已取消报名「{{name}}」', { name: pool.name }));
      setConfirmUnenrollPool(null);
      reload();
    } catch (e) {
      console.error('[unenroll][viem]', e);
      const mapped = mapEnrollError(e);
      showToast('error', mapped.msg || t('pools.unenroll_failed', '取消报名失败'));
      if (mapped.stale) reload();
    } finally {
      setUnenrolling(false);
    }
  };

  const handleClaim = async (pool) => {
    if (!isConnected) { openWalletModal(); return; }
    setClaimingPool(pool.address);
    try {
      // P1-08 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'claim',
        args: [],
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: viemGetAddress(pool.address),
        abi: MINING_POOL_ABI,
        functionName: 'claim',
        args: [],
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      showToast('success', t('pools.claim_success', '🎉 领取 {{amount}} {{symbol}} 成功', { amount: formatBigAmount(pool.myPending), symbol: pool.rewardTokenSymbol }));
      reload();
    } catch (e) {
      console.error('[claim][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('common.user_rejected', '用户已取消签名') : (e?.shortMessage || t('pools.claim_failed', '领取失败')));
    } finally {
      setClaimingPool(null);
    }
  };

  const handleClaimAll = async () => {
    if (!isConnected) { openWalletModal(); return; }
    // Pools the batch is expected to settle; on-chain getClaimable is the final gate.
    const claimablePools = pools.filter(p => p.myPending > 0n);
    setClaimingAll(true);
    try {
      // P1-08 Pre-flight simulate first
      await viemSimulateContract({
        address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'claimAllMyPools',
        args: [],
      });

      // Factory loops registered pools with `if (gasleft() < 150_000) break;` and
      // stops silently — the tx still succeeds, so wallet gas estimation converges
      // to covering only the first claim (skipped pools cost nothing). With several
      // pending pools the loop breaks before reaching later pools. Pass an explicit
      // budget: base overhead + per-pool stipend; unused gas is refunded.
      const BATCH_GAS_BASE = 120000n;
      const BATCH_GAS_PER_POOL = 170000n;
      const BATCH_GAS_CAP = 30000000n; // factory caps at 200 pools x 150k stipend
      const poolCount = BigInt(Math.max(claimablePools.length, 1));
      const batchGas = BATCH_GAS_BASE + poolCount * BATCH_GAS_PER_POOL < BATCH_GAS_CAP
        ? BATCH_GAS_BASE + poolCount * BATCH_GAS_PER_POOL
        : BATCH_GAS_CAP;

      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'claimAllMyPools',
        args: [],
        gas: batchGas,
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);

      // Batch claim is best-effort by contract design. Re-read each pool and settle
      // whatever remains with direct pool.claim() calls (single-pool tx, no gas cap).
      const remainingPools = [];
      for (const pool of claimablePools) {
        try {
          const left = await viemReadContract({
            address: viemGetAddress(pool.address),
            abi: MINING_POOL_ABI,
            functionName: 'getClaimable',
            args: [viemGetAddress(address)],
          });
          if (left > 0n) remainingPools.push(pool);
        } catch (e) {
          console.warn('[claimAll] getClaimable read failed:', pool.address, e?.shortMessage || e.message);
        }
      }

      let fallbackClaimed = 0;
      let fallbackFailed = 0;
      if (remainingPools.length > 0) {
        showToast('info', t('pools.claim_all_fallback_notice', '⏳ {{count}} 个矿池批量未覆盖，将逐笔补领，请在钱包中完成签名', { count: remainingPools.length }));
      }
      for (const pool of remainingPools) {
        try {
          await viemSimulateContract({
            address: viemGetAddress(pool.address),
            abi: MINING_POOL_ABI,
            functionName: 'claim',
            args: [],
          });
          const { hash: claimHash } = await viemWriteContract({
            address: viemGetAddress(pool.address),
            abi: MINING_POOL_ABI,
            functionName: 'claim',
            args: [],
          });
          await viemWaitForTransaction(claimHash);
          fallbackClaimed++;
        } catch (e) {
          const errMsg = e?.message || e?.cause?.message || '';
          if (e?.code === 4001 || /rejected|denied/i.test(errMsg)) {
            // User rejected signing: count rest as not settled and stop popups
            fallbackFailed += remainingPools.length - fallbackClaimed - fallbackFailed;
            showToast('info', t('common.user_rejected', '用户已取消签名'));
            break;
          }
          fallbackFailed++;
          console.error('[claimAll][fallback] pool claim failed:', pool.address, e);
        }
      }

      reload();

      if (fallbackClaimed === 0 && fallbackFailed === 0) {
        showToast('success', t('pools.claim_all_success', '🎉 一键领取成功'));
      } else if (fallbackFailed === 0) {
        showToast('success', t('pools.claim_all_with_fallback', '✅ 一键领取完成，已自动补领 {{count}} 个矿池的奖励', { count: fallbackClaimed }));
      } else {
        showToast('warning', t('pools.claim_all_partial', '⚠️ 领取已完成：补领成功 {{ok}} 个，{{fail}} 个未到账，请点对应矿池的「领取」按钮重试', { ok: fallbackClaimed, fail: fallbackFailed }));
      }
    } catch (e) {
      console.error('[claimAll][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('common.user_rejected', '用户已取消签名') : (e?.shortMessage || t('pools.claim_all_failed', '一键领取失败')));
    } finally {
      setClaimingAll(false);
    }
  };

  const handleCreatePool = () => {
    if (!isConnected) { openWalletModal(); return; }
    navigate('/pools/create');
  };

  const openBoostModal = (pool) => {
    if (!isConnected) { openWalletModal(); return; }
    setBoostPool(pool);
    setBoostAmount('0.1');
  };

  const confirmBoost = async () => {
    const pool = boostPool;
    const amount = parseFloat(boostAmount);
    if (isNaN(amount) || amount < 0.01 || amount > 1) {
      showToast('error', t('pools.boost_amount_invalid', '助力金额必须在0.01 BNB到1 BNB之间'));
      return;
    }
    setBoosting(true);
    try {
      const valueWei = viemParseEther(boostAmount);
      // P1-08 Pre-flight simulate first (fail before wallet popup)
      await viemSimulateContract({
        address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'boostPool',
        args: [viemGetAddress(pool.address)],
        value: valueWei,
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: viemGetAddress(MINING_POOL_FACTORY_ADDRESS),
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'boostPool',
        args: [viemGetAddress(pool.address)],
        value: valueWei,
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      await viemWaitForTransaction(hash);
      showToast('success', t('pools.boost_success', '⚡ 助力成功！已为「{{name}}」助力 {{amount}} BNB', { name: pool.name, amount }));
      setBoostPool(null);
      reload();
    } catch (e) {
      console.error('[boost][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('common.user_rejected', '用户已取消签名') : (e?.shortMessage || t('pools.boost_failed', '助力失败')));
    } finally {
      setBoosting(false);
    }
  };

  const toggleBoostTooltip = (e) => {
    e.stopPropagation();
    setShowBoostTooltip(!showBoostTooltip);
  };

  // Open deposit activation panel: if wallet not connected open wallet, only activate if not yet activated
  const openActivateModal = (pool) => {
    if (!isConnected) { openWalletModal(); return; }
    if (pool.isEnded || pool.isActivated) return;
    setActivatePool(pool);
    // Default deposit amount = pool total reward
    setActivateAmount(totalRewardDefault(pool));
  };

  // Default deposit amount when inactive = pool total reward
  const totalRewardDefault = (pool) => {
    try {
      const n = Number(viemFormatEther(pool.totalReward));
      return isFinite(n) && n > 0 ? String(n) : '';
    } catch {
      return '';
    }
  };

  // Pool owner deposits reward tokens to activate pool
  const handleActivate = async () => {
    const pool = activatePool;
    if (!pool) return;
    if (!isConnected) { openWalletModal(); return; }
    const amount = activateAmount;
    if (!amount || Number(amount) <= 0) {
      showToast('error', t('pd_activate_amount_invalid', '请输入有效的充值金额'));
      return;
    }
    setActivating(true);
    try {
      const provider = getReadProvider(true);
      const decimals = await fetchDecimals(pool.rewardToken, provider);
      const amountWei = parseTokenAmount(amount, decimals);
      if (amountWei <= 0n) {
        showToast('error', t('pd_activate_amount_invalid', '请输入有效的充值金额'));
        setActivating(false);
        return;
      }
      const poolAddr = viemGetAddress(pool.address);
      const rewardTokenAddr = viemGetAddress(pool.rewardToken);
      const userAddr = viemGetAddress(address);
      
      // Step 1: Approve — skip when allowance already sufficient (avoid blind sign)
      const currentAllowance = await viemReadContract({
        address: rewardTokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddr, poolAddr],
      });
      if (currentAllowance < amountWei) {
        // P1 Pre-flight simulate first (exact amount approval, not MAX)
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
      
      // Step 2: Deposit — P1 Pre-flight simulate first
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
      setActivatePool(null);
    } catch (e) {
      console.error('[pools/activate][viem]', e);
      const errMsg = e?.message || e?.cause?.message || '';
      showToast('error', errMsg.includes('rejected') || e?.code === 4001 ? t('common.user_rejected', '用户已取消签名') : (e?.shortMessage || t('pd_activate_failed', '充值激活失败，请重试')));
    } finally {
      setActivating(false);
    }
  };

  const filterTabs = [
    { key: 'all', label: t('pools.filters.all', '全部') },
    { key: 'active', label: t('pools.filters.active', '进行中') },
    { key: 'inactive', label: t('pools.filters.inactive', '待激活') },
    { key: 'ended', label: t('pools.filters.ended', '已结束') },
    { key: 'newest', label: t('pools.filters.new', '新上线') },
    { key: 'claimable', label: t('pools.claimable', '🔔 可领取') },
  ];

  const sortOptions = [
    { key: 'boost', label: t('pools.sort.boost', '助力排名') },
    { key: 'newest', label: t('pools.sort.newest', '最新上线') },
    { key: 'participants', label: t('pools.sort.participants', '参与人数') },
    { key: 'progress', label: t('pools.sort.progress', '进度最少') },
  ];

  const showClaimButton = (pool) => {
    // Accrued rewards remain claimable after unenrolling; the gate only checks pending balance
    return pool.myPending > 0n;
  };

  // Unified prompt for inactive pool button clicks
  const handleInactiveClick = () => {
    showToast('warning', t('pd_inactive_tip', '矿池未激活，请等待池主充值激活'));
  };

  return (
    <div className="max-w-6xl mx-auto px-3 md:px-6 py-4 md:py-8" onClick={() => { if (showBoostTooltip) setShowBoostTooltip(false); if (showSortDropdown) setShowSortDropdown(false); }}>
      {/* Title area */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          {t('pools.title', '🍀 欢迎来到韭菜庄园 一起体验收割的乐趣')}
        </h1>
      </div>

      {/* Search + create mining pool */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('pools.search', '搜索矿池名称或代币...')}
            className="w-full pl-10 pr-4 py-3 rounded-xl bg-[var(--color-card-bg)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary-500)] focus:ring-2 focus:ring-[var(--color-primary-500)]/15 transition-all"
          />
        </div>
        <button
          onClick={handleCreatePool}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-white text-sm font-semibold hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/30 transition-all whitespace-nowrap"
        >
          <Plus className="w-[18px] h-[18px]" />
          {t('pools.create_pool', '创建矿池')}
        </button>
      </div>

      {/* My pending rewards - main card, most prominent */}
      <div className="mb-5 rounded-2xl bg-gradient-to-br from-[var(--color-primary-100)]/60 via-[var(--color-primary-50)]/40 to-[var(--color-primary-100)]/30 dark:from-[var(--color-primary-900)]/25 dark:via-[var(--color-primary-900)]/15 dark:to-[var(--color-primary-900)]/10 border border-[var(--color-primary-300)]/40 dark:border-[var(--color-primary-700)]/30 p-6 shadow-lg shadow-[var(--color-primary-500)]/5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[var(--color-primary-400)] to-[var(--color-primary-600)] flex items-center justify-center shadow-md shadow-[var(--color-primary-500)]/20">
              <Sparkles className="w-[18px] h-[18px] text-white" />
            </div>
            <span className="text-lg font-bold text-[var(--color-text-primary)]">{t('pools.my_pending_rewards', '我的待领取奖励')}</span>
            {pendingByPool.length > 0 && (
              <span className="text-sm text-[var(--color-text-muted)] bg-[var(--color-card-bg)] px-2 py-0.5 rounded-lg">({enrolledCount}{t('pools.pools_enrolled', '个矿池已报名')})</span>
            )}
          </div>
          <button
            onClick={handleClaimAll}
            disabled={!hasPendingReward || claimingAll}
            title={!hasPendingReward ? t('pools.no_pending') : ''}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-400 to-green-500 text-white text-sm font-bold hover:from-emerald-500 hover:to-green-600 hover:shadow-lg hover:shadow-green-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0"
          >
            {claimingAll ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {claimingAll ? t('processing', '处理中...') : t('pools.claim_all', '一键领取全部')}
          </button>
        </div>
        {pendingByPool.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {pendingByPool.map((pool) => (
              <div key={pool.address} className="inline-flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-[var(--color-card-bg)] border border-[var(--color-border)] shadow-sm hover:shadow-md hover:border-[var(--color-primary-300)]/50 transition-all">
                <div className="flex items-center gap-2.5 min-w-0">
                  <TokenIcon src={tokenIconSrc({ address: pool.rewardToken })} symbol={pool.rewardTokenSymbol} size={30} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="text-[var(--color-primary-600)] dark:text-[var(--color-primary-400)] font-bold text-lg leading-tight whitespace-nowrap">
                        {formatAmount(pool.myPending)}
                      </span>
                      <span className="text-[var(--color-text-secondary)] font-semibold text-sm shrink-0">{pool.rewardTokenSymbol}</span>
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] truncate leading-tight max-w-[140px]">{getPoolDisplayName(pool, t)}</div>
                  </div>
                </div>
                <button
                  onClick={() => handleClaim(pool)}
                  disabled={claimingPool === pool.address}
                  className="px-3.5 py-2 rounded-lg text-sm bg-gradient-to-r from-emerald-400 to-green-500 text-white font-semibold hover:from-emerald-500 hover:to-green-600 hover:shadow-md hover:shadow-green-500/25 disabled:opacity-60 disabled:cursor-not-allowed transition-all shrink-0 flex items-center gap-1.5"
                >
                  {claimingPool === pool.address && (
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {claimingPool === pool.address ? t('claiming', '领取中') : t('pools.claim', '领取')}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-[var(--color-text-muted)]">
            {isConnected ? t('pools.no_pending', '暂无待领取奖励，快去报名挖矿吧~') : t('pools.connect_wallet', '请连接钱包查看奖励')}
          </div>
        )}
      </div>

      {/* Network behavior rewards + vesting rewards - two side-by-side small cards */}
      <div className="mb-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Network behavior rewards - cumulative L1+L2 referral rewards actually distributed across all pools, aggregated by reward token */}
        <div className="rounded-xl bg-[var(--color-card-bg)] border border-[var(--color-border)] p-5 hover:border-emerald-500/30 transition-colors">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            </div>
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t('total_invite_bonus', '全网行为奖励')}</span>
            <span className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">{t('farm_card_total_referral_tag', '全网累计')}</span>
          </div>
          {networkReferralByToken.length > 0 ? (
            <div className="flex flex-wrap gap-2.5">
              {networkReferralByToken.map((br) => (
                <div key={br.address} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/5">
                  <TokenIcon src={tokenIconSrc({ address: br.address })} symbol={br.symbol} size={20} />
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold text-sm">{formatAmount(br.amount)}</span>
                  <span className="text-[var(--color-text-muted)] text-xs">{br.symbol}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] py-2">
              {t('pools.no_behavior', '暂无行为奖励')}
            </div>
          )}
        </div>

        {/* Unreleased Rewards - Linear Vesting in Progress */}
        <div className="rounded-xl bg-[var(--color-card-bg)] border border-[var(--color-border)] p-5 hover:border-sky-500/30 transition-colors">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center">
              <Clock className="w-4 h-4 text-sky-500" />
            </div>
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t('pools.vesting_rewards', '待释放奖励')}</span>
            <span className="text-xs text-sky-600 dark:text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded-full">{t('pools.auto_release', '释放中')}</span>
          </div>
          {isConnected ? (
            vestingByToken.length > 0 ? (
              <div className="space-y-3">
                {vestingByToken.map((vr) => (
                  <div key={vr.address} className="flex items-center gap-2.5">
                    <TokenIcon src={tokenIconSrc({ address: vr.address })} symbol={vr.symbol} size={20} />
                    <span className="text-sky-600 dark:text-sky-400 font-bold text-sm min-w-[90px]">{formatAmount(vr.pending)}</span>
                    <span className="text-[var(--color-text-muted)] text-xs w-10">{vr.symbol}</span>
                    <div className="flex-1 h-2 bg-sky-500/10 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-sky-400 to-sky-500 rounded-full" style={{ width: `${vr.progress}%` }} />
                    </div>
                    <span className="text-[10px] text-[var(--color-text-muted)] whitespace-nowrap">{vr.progress}%·{vr.pools}{t('pools.pools_count', '个矿池')}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-[var(--color-text-muted)] py-2">
                {t('pools.no_vesting', '暂无待释放')}
              </div>
            )
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] py-2">
              {t('pools.connect_wallet', '连接钱包查看')}
            </div>
          )}
        </div>
      </div>

      {/* Filter bar - placed above the pool list, no outer frame */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveFilter(tab.key)}
            className={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all duration-200 ${
              activeFilter === tab.key
                ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-bg-secondary)]/70'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <button
          onClick={() => setOnlyEnrolled(!onlyEnrolled)}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all duration-200 ${
            onlyEnrolled
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-bg-secondary)]/70'
          }`}
        >
          {onlyEnrolled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
          {t('pools.only_enrolled', '仅已报名')}
        </button>
      </div>

      {/* Pool list - desktop table */}
      <div className="hidden md:block relative rounded-2xl bg-[var(--color-card-bg)] border border-[var(--color-border)] shadow-sm">
        <div className="overflow-x-auto rounded-2xl pb-8">
        <table className="w-full text-sm min-w-[850px]">
          <thead className="relative z-10">
            <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)] bg-[var(--color-card-bg-secondary)]/30 overflow-visible">
              <th className="px-5 py-4 font-medium">{t('pools.pool', '矿池')}</th>
              <th className="px-5 py-4 font-medium text-right">{t('pools.total_reward', '已挖/总奖励')}</th>
              <th className="px-5 py-4 font-medium text-right relative overflow-visible">
                <div className="flex items-center justify-end gap-1 relative">
                  <span>{t('pools.boost', '助力')}</span>
                  <button
                    onClick={toggleBoostTooltip}
                    onMouseEnter={() => setShowBoostTooltip(true)}
                    onMouseLeave={() => setShowBoostTooltip(false)}
                    className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors relative z-10"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                  </button>
                  {showBoostTooltip && (
                    <div className="absolute top-full right-0 mt-2 w-56 p-3 bg-white dark:bg-[#1a1a2e] border border-[var(--color-border)] rounded-xl shadow-xl text-xs text-[var(--color-text-secondary)] leading-relaxed z-[200] whitespace-normal break-words">
                      {t('pools.boost_tooltip', '为矿池助力BNB提升曝光排名，助力越多排名越靠前（0.01-1 BNB）')}
                      <div className="absolute -top-1.5 right-3 w-2.5 h-2.5 bg-white dark:bg-[#1a1a2e] border-l border-t border-[var(--color-border)] rotate-45" />
                    </div>
                  )}
                </div>
              </th>
              <th className="px-5 py-4 font-medium text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Users className="w-4 h-4" />
                  <span>{t('pools.participants', '人数')}</span>
                </div>
              </th>
              <th className="px-5 py-4 font-medium text-right">{t('pools.my_pending', '待领取')}</th>
              <th className="px-5 py-4 font-medium text-right">{t('pools.action', '操作')}</th>
              <th className="px-5 py-4 font-medium text-center w-16">{t('pools.detail', '详情')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredPools.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-16 text-center text-[var(--color-text-muted)]">
                  {t('pools.no_data', '暂无符合条件的矿池')}
                </td>
              </tr>
            ) : (
              filteredPools.map((pool) => (
                <React.Fragment key={pool.address}>
                  <tr className="hover:bg-[var(--color-card-bg-secondary)]/20 transition-colors">
                    <td className="px-5 pt-4 pb-2">
                      <div className="flex items-center gap-3">
                        <PoolLogoPair pool={pool} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-[var(--color-text-primary)]">{getPoolDisplayName(pool, t)}</span>
                            {pool.mode !== 'all_pairs' && (
                              <span className="px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-500 shrink-0 font-medium">{t('pools.trading_contest', '交易竞赛')}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {!pool.isEnded && !pool.isActivated && (
                              <span className="px-2 py-0.5 rounded text-[10px] bg-orange-500/10 text-orange-500 shrink-0 font-medium">{t('pd_inactive', '未激活')}</span>
                            )}
                            {pool.isHot && (
                              <span className="px-2 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-600 shrink-0 font-medium">{t('pools.hot_pool', '火热')}</span>
                            )}
                            {pool.isEnrolled && (
                              <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-500 shrink-0 font-medium">{t('pools.enrolled_participating', '已报名')}</span>
                            )}
                            {pool.isEnded && (
                              <span className="px-2 py-0.5 rounded text-[10px] bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)] shrink-0 font-medium">{t('pools.ended', '已结束')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 pt-4 pb-2 text-right align-top">
                      <div className="flex flex-col items-end">
                        <span className="whitespace-nowrap">
                          <span className="text-[var(--color-primary-500)] font-bold">{formatTokenAmount(pool.totalDistributed, 18, 2)}</span>
                          <span className="text-[var(--color-text-muted)] mx-0.5">/</span>
                          <span className="text-[var(--color-text-primary)] font-bold">{formatTokenAmount(pool.totalReward, 18, 4)}</span>
                          <span className="text-[var(--color-text-secondary)] font-medium ml-1">{pool.rewardTokenSymbol}</span>
                        </span>
                        {pool.rewardToken && (
                          <a
                            href={getExplorerUrl(pool.rewardToken)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-primary-500)] font-mono mt-0.5 transition-colors"
                          >
                            {shortenAddress(pool.rewardToken)}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-5 pt-4 pb-2 text-right align-top">
                      {pool.boostPaid > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400 font-bold">
                          {pool.boostPaid} BNB
                        </span>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">-</span>
                      )}
                    </td>
                    <td className="px-5 pt-4 pb-2 text-right align-top text-[var(--color-text-secondary)] font-semibold">
                      {pool.participants > 0 ? pool.participants.toLocaleString() : '—'}
                    </td>
                    <td className="px-5 pt-4 pb-2 text-right align-top">
                      {pool.myPending > 0n ? (
                        <span className="text-[var(--color-primary-500)] font-bold whitespace-nowrap">{formatAmount(pool.myPending)} {pool.rewardTokenSymbol}</span>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">-</span>
                      )}
                    </td>
                    <td className="px-5 pt-4 pb-2 text-right align-top">
                      <div className="flex items-center gap-1.5 justify-end flex-nowrap">
                        {!pool.isEnded && !pool.isActivated && isPoolOwner(pool) && (
                          <button
                            onClick={() => openActivateModal(pool)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold hover:shadow-lg hover:shadow-orange-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all shrink-0"
                          >
                            <Zap className="w-3 h-3" />
                            {t('pd_activate_btn', '充值激活')}
                          </button>
                        )}
                        {!pool.isEnded && (
                          pool.isActivated ? (
                            <button
                              onClick={() => openBoostModal(pool)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-gradient-to-r from-yellow-400 to-amber-500 text-white font-bold hover:shadow-lg hover:shadow-amber-500/25 hover:scale-[1.02] active:scale-[0.98] transition-all shrink-0"
                            >
                              <Zap className="w-3 h-3" />
                              {t('pools.boost_btn', '助力')}
                            </button>
                          ) : (
                            <button
                              onClick={handleInactiveClick}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-bold cursor-not-allowed shrink-0"
                            >
                              <Zap className="w-3 h-3" />
                              {t('pools.boost_btn', '助力')}
                            </button>
                          )
                        )}
                        {showClaimButton(pool) && (
                          (pool.isActivated || pool.isEnded) ? (
                            <button
                              onClick={() => handleClaim(pool)}
                              disabled={claimingPool === pool.address}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-gradient-to-r from-emerald-400 to-green-500 text-white font-semibold hover:from-emerald-500 hover:to-green-600 hover:shadow-lg hover:shadow-green-500/25 disabled:opacity-60 disabled:cursor-not-allowed transition-all shrink-0 flex items-center gap-1"
                            >
                              {claimingPool === pool.address && (
                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                              )}
                              {claimingPool === pool.address ? '...' : t('pools.claim', '领取')}
                            </button>
                          ) : (
                            <button
                              onClick={handleInactiveClick}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-semibold cursor-not-allowed shrink-0"
                            >
                              {t('pools.claim', '领取')}
                            </button>
                          )
                        )}
                        {!pool.isEnded && !pool.isEnrolled && (
                          pool.isActivated ? (
                            <button
                              onClick={() => handleEnroll(pool)}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-gradient-to-r from-amber-400 to-orange-500 text-white font-semibold hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/25 transition-all shrink-0"
                            >
                              {t('pools.enroll', '报名')}
                            </button>
                          ) : (
                            <button
                              onClick={handleInactiveClick}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-semibold cursor-not-allowed shrink-0"
                            >
                              {t('pools.enroll', '报名')}
                            </button>
                          )
                        )}
                        {pool.isEnrolled && !pool.isEnded && (
                          pool.isActivated ? (
                            <button
                              onClick={() => handleUnenroll(pool)}
                              className="px-1.5 py-1.5 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-red-500 transition-colors shrink-0 font-medium"
                            >
                              {t('pools.cancel', '取消')}
                            </button>
                          ) : (
                            <button
                              onClick={handleInactiveClick}
                              className="px-1.5 py-1.5 rounded-lg text-xs text-gray-400 cursor-not-allowed shrink-0 font-medium"
                            >
                              {t('pools.cancel', '取消')}
                            </button>
                          )
                        )}
                      </div>
                    </td>
                    <td className="px-3 pt-4 pb-2 text-center align-top">
                      <button
                        onClick={() => setDetailPool(pool)}
                        className="text-xs font-medium hover:opacity-80 transition-opacity"
                        style={{ color: 'var(--color-primary-500)' }}
                      >
                        {t('pools.detail', '详情')}
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="px-5 pb-1">
                      <div className="h-1 bg-[var(--color-card-bg-secondary)] rounded-full overflow-hidden relative">
                        <div
                          className={`h-full rounded-full transition-all ${pool.progress >= 100 ? 'bg-[var(--color-text-muted)]' : 'bg-gradient-to-r from-[var(--color-primary-400)] to-[var(--color-primary-600)]'}`}
                          style={{ width: `${Math.min(pool.progress, 100)}%` }}
                        />
                        <span className="absolute right-0 -top-5 text-xs text-[var(--color-text-secondary)] font-medium">{pool.progress.toFixed(0)}%</span>
                      </div>
                    </td>
                  </tr>
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden">
        <div className="space-y-4">
        {filteredPools.map((pool) => (
          <div key={pool.address} className="p-[18px] rounded-2xl bg-[var(--color-card-bg)] border border-[var(--color-border)] shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <PoolLogoPair pool={pool} size="lg" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-[var(--color-text-primary)] text-base">{getPoolDisplayName(pool, t)}</span>
                    {pool.mode !== 'all_pairs' && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-500 shrink-0 font-medium">{t('pools.trading_contest', '交易竞赛')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {!pool.isEnded && !pool.isActivated && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-orange-500/10 text-orange-500 shrink-0 font-medium">{t('pd_inactive', '未激活')}</span>
                    )}
                    {pool.isHot && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-600 shrink-0 font-medium">{t('pools.hot_pool', '火热')}</span>
                    )}
                    {pool.isEnrolled && !pool.isEnded && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-500 shrink-0 font-medium">{t('pools.enrolled_participating', '已报名')}</span>
                    )}
                  </div>
                </div>
              </div>
              {pool.isEnded && (
                <span className="px-2 py-1 rounded-lg text-[11px] bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)] shrink-0 font-medium">{t('pools.ended', '已结束')}</span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4 mb-4">
              <div>
                <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('pools.total_reward', '总奖励')}</div>
                <div className="whitespace-nowrap">
                  <span className="text-[var(--color-text-primary)] font-bold">{formatTokenAmount(pool.totalReward, 18, 4)}</span>
                  <span className="text-[var(--color-text-secondary)] font-medium ml-1">{pool.rewardTokenSymbol}</span>
                </div>
                {pool.rewardToken && (
                  <a
                    href={getExplorerUrl(pool.rewardToken)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-primary-500)] font-mono block mt-0.5 transition-colors"
                  >
                    {shortenAddress(pool.rewardToken)}
                  </a>
                )}
              </div>
              <div>
                <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] mb-1">
                  <Users className="w-3.5 h-3.5" />
                  <span>{t('pools.participants', '人数')}</span>
                </div>
                <div className="text-[var(--color-text-secondary)] font-bold">{pool.participants > 0 ? pool.participants.toLocaleString() : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('pools.my_pending', '待领取')}</div>
                <div className={pool.myPending > 0n ? 'text-[var(--color-primary-500)] font-bold' : 'text-[var(--color-text-muted)]'}>
                  {pool.myPending > 0n ? `${formatAmount(pool.myPending)} ${pool.rewardTokenSymbol}` : '-'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 mb-2">
              <div className="flex-1 h-2 bg-[var(--color-card-bg-secondary)] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${pool.progress >= 100 ? 'bg-[var(--color-text-muted)]' : 'bg-gradient-to-r from-[var(--color-primary-400)] to-[var(--color-primary-600)]'}`}
                  style={{ width: `${Math.min(pool.progress, 100)}%` }}
                />
              </div>
              {pool.boostPaid > 0 && <span className="text-amber-600 dark:text-amber-400 text-sm shrink-0 font-bold">{pool.boostPaid} BNB</span>}
            </div>

            <div className="flex items-center justify-between mb-3">
              <span className="text-base text-[var(--color-text-secondary)] font-bold">{pool.progress.toFixed(0)}%</span>
              <button
                onClick={() => setDetailPool(pool)}
                className="text-sm font-medium hover:opacity-80 transition-opacity"
                style={{ color: 'var(--color-primary-500)' }}
              >
                {t('pools.detail', '详情')}
              </button>
            </div>

            <div className="flex gap-2 items-center">
              {!pool.isEnded && !pool.isActivated && isPoolOwner(pool) && (
                <button
                  onClick={() => openActivateModal(pool)}
                  className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-sm bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold shrink-0 shadow-md shadow-orange-500/20"
                >
                  <Zap className="w-3.5 h-3.5" />
                  {t('pd_activate_btn', '充值激活')}
                </button>
              )}
              {!pool.isEnded && (
                pool.isActivated ? (
                  <button
                    onClick={() => openBoostModal(pool)}
                    className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-sm bg-gradient-to-r from-yellow-400 to-amber-500 text-white font-bold shrink-0 shadow-md shadow-amber-500/20"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {t('pools.boost_btn', '助力')}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-sm bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-bold shrink-0 cursor-not-allowed"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {t('pools.boost_btn', '助力')}
                  </button>
                )
              )}
              {!pool.isEnded && !pool.isEnrolled && (
                pool.isActivated ? (
                  <button
                    onClick={() => handleEnroll(pool)}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-gradient-to-r from-amber-400 to-orange-500 text-white font-semibold shadow-md shadow-orange-500/20 hover:from-amber-500 hover:to-orange-600 transition-all"
                  >
                    {t('pools.enroll_btn', '报名挖矿')}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-semibold cursor-not-allowed"
                  >
                    {t('pools.enroll_btn', '报名挖矿')}
                  </button>
                )
              )}
              {showClaimButton(pool) && (
                (pool.isActivated || pool.isEnded) ? (
                  <button
                    onClick={() => handleClaim(pool)}
                    disabled={claimingPool === pool.address}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-gradient-to-r from-emerald-400 to-green-500 text-white font-semibold shadow-md shadow-green-500/20 hover:from-emerald-500 hover:to-green-600 disabled:opacity-60 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-1.5"
                  >
                    {claimingPool === pool.address && (
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    )}
                    {claimingPool === pool.address ? t('claiming', '领取中') : `${t('pools.claim', '领取')} ${formatAmount(pool.myPending)} ${pool.rewardTokenSymbol}`}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-semibold cursor-not-allowed"
                  >
                    {t('pools.claim', '领取')} {formatAmount(pool.myPending)} {pool.rewardTokenSymbol}
                  </button>
                )
              )}
              {pool.isEnrolled && !pool.isEnded && (
                pool.isActivated ? (
                  <button
                    onClick={() => handleUnenroll(pool)}
                    className="px-2 py-2 text-xs text-[var(--color-text-muted)] font-medium shrink-0"
                  >
                    {t('common.cancel', '取消')}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="px-2 py-2 text-xs text-gray-400 font-medium shrink-0 cursor-not-allowed"
                  >
                    {t('common.cancel', '取消')}
                  </button>
                )
              )}
            </div>
          </div>
        ))}

        {filteredPools.length === 0 && (
          <div className="py-20 text-center text-[var(--color-text-muted)] text-sm">
            {t('pools.no_data', '暂无符合条件的矿池')}
          </div>
        )}
        </div>
      </div>

      {/* Enrollment confirmation modal */}
      {confirmEnrollPool && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => setConfirmEnrollPool(null)}>
          <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
          <div
            className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--gradient-surface)',
              border: '1px solid var(--color-border-default)',
              boxShadow: 'var(--modal-warn-shadow)',
            }}
          >
            <button
              onClick={() => setConfirmEnrollPool(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto" style={{ background: 'var(--state-warning-bg)', border: '1px solid var(--color-border-strong)' }}>
              <AlertTriangle size={28} style={{ color: 'var(--color-warn-400)' }} />
            </div>
            <h3 className="text-xl font-bold text-center mb-3" style={{ color: 'var(--color-text-primary)' }}>
              {t('pools.confirm_enroll', '风险提示')}
            </h3>
            <p className="text-sm leading-relaxed mb-4 p-4 rounded-xl" style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}>
              {t('pools.risk_warning', '此矿池为用户自主创建，平台不对奖励代币的安全性、流动性、价格做任何担保。请自行甄别后再决定是否参与，风险自负！')}
            </p>
            {confirmEnrollPool.rewardToken && (
              <div className="text-center mb-4">
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t('pools.check_token_tip', '如不了解该代币，请点击查询合约地址：')}
                </span>
                <a
                  href={getExplorerUrl(confirmEnrollPool.rewardToken)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono ml-1 underline hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--color-primary-500)' }}
                >
                  {shortenAddress(confirmEnrollPool.rewardToken)}
                </a>
              </div>
            )}
            <div className="text-center mb-5">
              <button
                onClick={() => {
                  const pool = confirmEnrollPool;
                  setConfirmEnrollPool(null);
                  setTimeout(() => setDetailPool(pool), 100);
                }}
                className="text-xs underline hover:opacity-80 transition-opacity inline-flex items-center gap-1"
                style={{ color: 'var(--color-primary-500)' }}
              >
                <Info className="w-3 h-3" />
                {t('pools.view_pool_detail', '查看矿池详情')}
              </button>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmEnrollPool(null)}
                disabled={enrolling}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={confirmEnroll}
                disabled={enrolling}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/30 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {enrolling && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {enrolling ? t('signing', '签名中...') : t('pools.confirm_enroll_btn', '确认报名')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unenrollment confirmation modal */}
      {confirmUnenrollPool && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => setConfirmUnenrollPool(null)}>
          <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
          <div
            className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--gradient-surface)',
              border: '1px solid var(--color-border-default)',
              boxShadow: 'var(--modal-warn-shadow)',
            }}
          >
            <button
              onClick={() => setConfirmUnenrollPool(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto" style={{ background: 'var(--state-error-bg-soft, rgba(239, 68, 68, 0.1))', border: '1px solid var(--color-error, #ef4444)' }}>
              <AlertTriangle size={28} style={{ color: 'var(--color-error, #ef4444)' }} />
            </div>
            <h3 className="text-xl font-bold text-center mb-3" style={{ color: 'var(--color-text-primary)' }}>
              {t('pools.confirm_unenroll', '确认取消报名')}
            </h3>
            <p className="text-sm leading-relaxed mb-6 p-4 rounded-xl" style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}>
              {t('pools.unenroll_warning', '取消报名后将停止参与此矿池挖矿，待领取奖励仍可领取。确定要取消吗？')}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmUnenrollPool(null)}
                disabled={unenrolling}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
              >
                {t('common.back', '返回')}
              </button>
              <button
                onClick={confirmUnenroll}
                disabled={unenrolling}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', color: '#fff' }}
              >
                {unenrolling && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {unenrolling ? t('signing', '签名中...') : t('pools.confirm_unenroll_btn', '确认取消')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pool detail modal */}
      {detailPool && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => setDetailPool(null)}>
          <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
          <div
            className="relative w-full max-w-lg rounded-xl p-6 animate-fadeIn max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--gradient-surface)',
              border: '1px solid var(--color-border-default)',
              boxShadow: 'var(--modal-shadow)',
            }}
          >
            <button
              onClick={() => setDetailPool(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <h3 className="text-xl font-bold mb-5 flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
              <Info size={22} style={{ color: 'var(--color-primary-500)' }} />
              {t('pools.pool_detail', '矿池详情')}
            </h3>

            <div className="space-y-4">
              {/* Pool name + tokens */}
              <div className="flex items-center gap-3 pb-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
                <PoolLogoPair pool={detailPool} size="lg" />
                <div>
                  <div className="font-bold text-lg" style={{ color: 'var(--color-text-primary)' }}>{getPoolDisplayName(detailPool, t)}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {detailPool.isVerified && <PoolBadgeIcon Icon={Shield} colorClass="text-blue-500" tooltipText={t('pools.verified_pool', '官方认证池')} />}
                    {detailPool.isHot && <PoolBadgeIcon Icon={Flame} colorClass="text-orange-500" tooltipText={t('pools.hot_pool', '火热池')} />}
                    {detailPool.isEnrolled && <PoolBadgeIcon Icon={CheckCircle2} colorClass="text-emerald-500" tooltipText={t('pools.enrolled_participating', '已报名参与')} />}
                    {detailPool.isEnded && <span className="px-2 py-0.5 rounded text-xs bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)]">{t('pools.ended', '已结束')}</span>}
                  </div>
                </div>
              </div>

              {/* Detail item list */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.reward_token', '奖励代币')}</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{detailPool.rewardTokenSymbol}</span>
                </div>

                <div className="flex justify-between items-start">
                  <span className="text-sm shrink-0" style={{ color: 'var(--color-text-muted)' }}>{t('pools.token_contract', '代币合约')}</span>
                  {detailPool.rewardToken ? (
                    <a
                      href={getExplorerUrl(detailPool.rewardToken)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono ml-4 underline hover:opacity-80 transition-opacity break-all text-right"
                      style={{ color: 'var(--color-primary-500)' }}
                    >
                      {shortenAddress(detailPool.rewardToken)}
                    </a>
                  ) : (
                    <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>BNB (Native)</span>
                  )}
                </div>

                <div className="flex justify-between items-start">
                  <span className="text-sm shrink-0" style={{ color: 'var(--color-text-muted)' }}>{t('pools.pool_contract', '矿池合约')}</span>
                  <div className="flex items-start gap-2 ml-4 min-w-0 flex-1 justify-end">
                    <button
                      onClick={async () => {
                        const ok = await copyToClipboard(detailPool.address);
                        showToast(ok ? 'success' : 'error', ok ? t('copied', { defaultValue: '已复制' }) : t('copy_failed', { defaultValue: '复制失败' }));
                      }}
                      className="text-sm font-mono inline-flex items-start gap-1 hover:opacity-80 transition-opacity break-all text-right"
                      style={{ color: 'var(--color-primary-500)' }}
                      title={detailPool.address}
                    >
                      {detailPool.address}
                      <Copy className="w-3 h-3 shrink-0 mt-0.5" />
                    </button>
                    <a
                      href={getExplorerUrl(detailPool.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:opacity-80 transition-opacity shrink-0 mt-0.5"
                      style={{ color: 'var(--color-text-tertiary)' }}
                      title={t('view_on_explorer', { defaultValue: '区块浏览器' })}
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.total_reward', '总奖励')}</span>
                  <span className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>{formatTokenAmount(detailPool.totalReward, 18, 4)} {detailPool.rewardTokenSymbol}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.pool_balance', '矿池余额')}</span>
                  <span className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>{formatTokenAmount(detailPool.poolBalance || 0n, 18, 4)} {detailPool.rewardTokenSymbol}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.start_time', '开始时间')}</span>
                  <span className="text-sm font-medium font-mono" style={{ color: 'var(--color-text-primary)' }}>{formatDateTime(detailPool.startTime)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.participants', '参与人数')}</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{detailPool.participants > 0 ? detailPool.participants.toLocaleString() : '—'}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.mining_progress', '挖矿进度')}</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{detailPool.progress.toFixed(0)}%</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{t('pools.referral_reward', '行为奖励')}</span>
                  <span className="text-sm font-bold" style={{ color: 'var(--color-primary-500)' }}>{detailPool.referralRewardPercent}%</span>
                </div>

                <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="text-sm font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>{t('pools.mining_rule', '挖矿规则')}</div>
                  <div className="space-y-2 pl-1">
                    <div className="flex justify-between items-center">
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('pools.output_rate', '产出比率')}</span>
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>{formatRewardPerUsd(detailPool.rewardPerUsd, detailPool.rewardTokenSymbol, t)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('pools.vesting_period', '释放周期')}</span>
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>{detailPool.vestingDays} {t('pools.days', '天')}</span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-between items-start">
                  <span className="text-sm shrink-0" style={{ color: 'var(--color-text-muted)' }}>{t('pools.creator', '创建者')}</span>
                  <a
                    href={getExplorerUrl(detailPool.creator)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono ml-4 underline hover:opacity-80 transition-opacity break-all text-right"
                    style={{ color: 'var(--color-primary-500)' }}
                  >
                    {detailPool.creator}
                  </a>
                </div>

                {detailPool.isEnrolled && detailPool.myPending > 0n && (
                  <div className="flex justify-between items-center pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('pools.my_pending', '我的待领取')}</span>
                    <span className="text-sm font-bold" style={{ color: 'var(--color-primary-500)' }}>{formatAmount(detailPool.myPending)} {detailPool.rewardTokenSymbol}</span>
                  </div>
                )}
              </div>

              {/* Pool owner deposit activation entry (shown when inactive + user is pool owner) */}
              {!detailPool.isEnded && !detailPool.isActivated && isPoolOwner(detailPool) && (
                <button
                  onClick={() => {
                    const p = detailPool;
                    setDetailPool(null);
                    setTimeout(() => openActivateModal(p), 100);
                  }}
                  className="w-full mt-5 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 hover:shadow-lg hover:shadow-orange-500/30 flex items-center justify-center gap-2"
                >
                  <Zap className="w-4 h-4" />
                  {t('pd_activate_btn', '充值激活')}
                </button>
              )}

              {/* Join now button */}
              {!detailPool.isEnded && !detailPool.isEnrolled && (
                detailPool.isActivated ? (
                  <button
                    onClick={() => {
                      const pool = detailPool;
                      setDetailPool(null);
                      setTimeout(() => setConfirmEnrollPool(pool), 100);
                    }}
                    className="w-full mt-5 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:from-amber-500 hover:to-orange-600 hover:shadow-lg hover:shadow-orange-500/30"
                  >
                    {t('pools.enroll_btn', '立即参与')}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="w-full mt-5 px-4 py-3.5 rounded-xl text-sm font-bold bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed"
                  >
                    {t('pools.enroll_btn', '立即参与')}
                  </button>
                )
              )}

              {detailPool.isEnrolled && !detailPool.isEnded && showClaimButton(detailPool) && (
                detailPool.isActivated ? (
                  <button
                    onClick={() => {
                      handleClaim(detailPool);
                      setDetailPool(null);
                    }}
                    className="w-full mt-5 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-emerald-400 to-green-500 text-white hover:from-emerald-500 hover:to-green-600 hover:shadow-lg hover:shadow-green-500/30"
                  >
                    {t('pools.claim', '领取')} {formatAmount(detailPool.myPending)} {detailPool.rewardTokenSymbol}
                  </button>
                ) : (
                  <button
                    onClick={handleInactiveClick}
                    className="w-full mt-5 px-4 py-3.5 rounded-xl text-sm font-bold bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed"
                  >
                    {t('pools.claim', '领取')} {formatAmount(detailPool.myPending)} {detailPool.rewardTokenSymbol}
                  </button>
                )
              )}

              {/* Bottom hint */}
              <div className="mt-5 p-3 rounded-lg text-xs" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-muted)' }}>
                {t('pools.detail_tip', '提示：点击合约地址或创建者地址可跳转至 BSCscan 区块浏览器查看详情')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Boost modal */}
      {boostPool && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => setBoostPool(null)}>
          <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
          <div
            className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--gradient-surface)',
              border: '1px solid var(--color-border-default)',
              boxShadow: 'var(--modal-warn-shadow)',
            }}
          >
            <button
              onClick={() => setBoostPool(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <div className="mb-6">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto" style={{ background: 'var(--state-warning-bg)', border: '1px solid var(--color-border-strong)' }}>
                <Zap size={28} style={{ color: 'var(--color-warn-400)' }} />
              </div>
              <h3 className="text-xl font-bold text-center mb-1.5" style={{ color: 'var(--color-text-primary)' }}>
                {t('pools.boost_pool', '助力矿池')}
              </h3>
              <p className="text-sm text-center" style={{ color: 'var(--color-text-secondary)' }}>
                {boostPool.name}
              </p>
            </div>

            <p className="text-xs leading-relaxed mb-5 p-3 rounded-xl" style={{ color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)' }}>
              {t('pools.boost_desc', '为矿池助力BNB可提升曝光排名，助力越多排名越靠前（范围0.01-1 BNB）')}
            </p>

            <div className="mb-6">
              <div
                className="rounded-xl p-4 transition-colors"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: '1px solid var(--color-border-default)',
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('pools.boost_amount', '助力金额 (BNB)')}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={boostAmount}
                    onChange={(e) => setBoostAmount(sanitizeAmountInput(e.target.value))}
                    onKeyDown={blockInvalidNumericKeys}
                    className="flex-1 bg-transparent outline-none text-xl font-semibold"
                    style={{ color: 'var(--color-text-primary)' }}
                  />
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--state-info-bg)' }}>
                    <TokenIcon src="/img/tokens/bnb.png" symbol="BNB" size={20} />
                    <span className="text-sm font-medium" style={{ color: 'var(--color-primary-400)' }}>BNB</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mt-3">
                {['0.01', '0.1', '0.5', '1'].map(amt => (
                  <button
                    key={amt}
                    onClick={() => setBoostAmount(amt)}
                    className="flex-1 px-2 py-2.5 rounded-xl text-sm font-semibold transition-all"
                    style={boostAmount === amt
                      ? { border: '1px solid var(--color-warn-400)', background: 'var(--state-warning-bg)', color: 'var(--color-warn-400)' }
                      : { border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'transparent' }
                    }
                    onMouseEnter={(e) => {
                      if (boostAmount !== amt) {
                        e.currentTarget.style.borderColor = 'var(--color-warn-400)';
                        e.currentTarget.style.background = 'var(--state-warning-bg)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (boostAmount !== amt) {
                        e.currentTarget.style.borderColor = 'var(--color-border-default)';
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    {amt}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setBoostPool(null)}
                disabled={boosting}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={confirmBoost}
                disabled={boosting}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-yellow-400 to-amber-500 text-white hover:from-yellow-500 hover:to-amber-600 hover:shadow-lg hover:shadow-amber-500/30 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {boosting ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                {boosting ? t('signing', '签名中...') : t('pools.confirm_boost', '确认助力')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deposit activation modal (pool owner, for inactive pools) */}
      {activatePool && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => setActivatePool(null)}>
          <div className="absolute inset-0" style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }} />
          <div
            className="relative w-full max-w-md rounded-xl p-6 animate-fadeIn"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--gradient-surface)',
              border: '1px solid var(--color-border-default)',
              boxShadow: 'var(--modal-warn-shadow)',
            }}
          >
            <button
              onClick={() => setActivatePool(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto" style={{ background: 'var(--state-warning-bg)', border: '1px solid var(--color-border-strong)' }}>
              <Zap size={28} style={{ color: 'var(--color-warn-400)' }} />
            </div>
            <h3 className="text-xl font-bold text-center mb-1.5" style={{ color: 'var(--color-text-primary)' }}>
              {t('pd_activate_title', '矿池尚未激活')}
            </h3>
            <p className="text-sm text-center mb-5" style={{ color: 'var(--color-text-secondary)' }}>
              {getPoolDisplayName(activatePool, t)}
            </p>

            <p className="text-xs leading-relaxed mb-5 p-3 rounded-xl" style={{ color: 'var(--color-text-tertiary)', background: 'var(--color-bg-tertiary)' }}>
              {t('pd_activate_desc', '你是该矿池的创建者。充入奖励代币激活后，报名交易者才能正常挖矿。')}
            </p>

            <div className="mb-6">
              <div
                className="rounded-xl p-4 transition-colors"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-default)' }}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('pd_activate_amount', '充值金额')} ({activatePool.rewardTokenSymbol})
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={activateAmount}
                    onChange={(e) => setActivateAmount(sanitizeAmountInput(e.target.value))}
                    onKeyDown={blockInvalidNumericKeys}
                    placeholder="0"
                    className="flex-1 bg-transparent outline-none text-xl font-semibold"
                    style={{ color: 'var(--color-text-primary)' }}
                  />
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--state-info-bg)' }}>
                    <TokenIcon src={tokenIconSrc({ address: activatePool.rewardToken })} symbol={activatePool.rewardTokenSymbol} size={20} />
                    <span className="text-sm font-medium" style={{ color: 'var(--color-primary-400)' }}>{activatePool.rewardTokenSymbol}</span>
                  </div>
                </div>
              </div>
              <div className="text-[11px] mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('pd_activate_hint', '充值金额需 ≥ 矿池总奖励，默认已填好总奖励数量。')}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setActivatePool(null)}
                disabled={activating}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={handleActivate}
                disabled={activating}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-bold transition-all bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 hover:shadow-lg hover:shadow-orange-500/30 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {activating ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Zap className="w-4 h-4" />
                )}
                {activating ? t('processing', '处理中...') : t('pd_activate_btn', '充值激活')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
