import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Wallet, Copy, Check, Gift, Gem, TrendingUp, Calendar, Loader2, Link2, UserPlus, Clock, X, AlertTriangle, Power } from 'lucide-react';
import { getAddress as viemGetAddress } from 'viem';
import { formatBalance, copyToClipboard, shortenAddress, viemSimulateContract, viemWriteContract, viemWaitForTransaction } from '@/utils/index.js';
import { getStoredReferrer, clearStoredReferrer, isValidReferrer } from '@/utils/referral.js';
import { useWalletStore } from '@/store/walletStore.js';
import { useUiStore } from '@/store/uiStore.js';
import { useMiningStore } from '@/store/miningStore.js';
import { MINING_ABI, MINING_ADDRESS } from '@/config/index.js';

export default function MiningPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { address, connected } = useWalletStore();
  const { showToast, showWalletModal: openWallet } = useUiStore();

  // Get cached data from miningStore
  const {
    phase1Produced,
    phase2Produced,
    totalInviteBonus,
    phase1Cap,
    phase2Cap,
    pendingReward,
    totalMinedAmount,
    hasBound,
    inviterAddress,
    vestingTotal,
    vestingReleased,
    vestingClaimed,
    vestingCount,
    isOptedOut,
    maybeRefreshMining,
    invalidateMining,
  } = useMiningStore();

  // Local UI state
  const [copied, setCopied] = useState(false);
  const [loadingClaim, setLoadingClaim] = useState(false);
  const [pendingInviter, setPendingInviter] = useState('');
  const [showOptOutConfirm, setShowOptOutConfirm] = useState(false);
  const [loadingOptToggle, setLoadingOptToggle] = useState(false);

  // Silently refresh on page open/wallet change (prefer cache, no white screen)
  useEffect(() => {
    const userAddr = connected && address ? address : null;
    maybeRefreshMining(userAddr);
  }, [connected, address, maybeRefreshMining]);

  // Inviter display: if already bound on-chain -> clear the local staging; if unbound -> show the staged pending inviter.
  // Capturing ?ref= from the URL is handled uniformly by the global hook (useReferrerCapture).
  useEffect(() => {
    if (hasBound) {
      clearStoredReferrer();
      setPendingInviter('');
      return;
    }
    setPendingInviter(address ? isValidReferrer(getStoredReferrer(), address) : '');
  }, [address, hasBound, location.pathname, location.search]);

  const inviteLink = useMemo(() => {
    if (!address) return '';
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://cfoswap.com';
    return `${base}/?ref=${address}`;
  }, [address]);

  const phase1Percent = (phase1Produced / phase1Cap * 100);
  const phase1Completed = phase1Produced >= phase1Cap;
  const phase2Percent = phase1Completed ? (phase2Produced / phase2Cap * 100) : 0;
  const phase2Active = phase1Completed && phase2Produced < phase2Cap;

  const vestingPercent = useMemo(() => {
    const total = parseFloat(vestingTotal) || 0;
    const released = parseFloat(vestingReleased) || 0;
    return total > 0 ? (released / total * 100) : 0;
  }, [vestingTotal, vestingReleased]);

  const vestingRemaining = (parseFloat(vestingTotal) - parseFloat(vestingReleased)).toFixed(4);

  async function handleCopyLink() {
    if (!inviteLink) {
      showToast('warning', t('connect_to_get_link', { defaultValue: '请先连接钱包获取您的邀请链接' }));
      return;
    }
    const ok = await copyToClipboard(inviteLink);
    if (ok) {
      setCopied(true);
      showToast('success', t('link_copied', { defaultValue: '邀请链接已复制' }));
      setTimeout(() => setCopied(false), 2000);
    } else {
      showToast('error', t('copy_failed', { defaultValue: '复制失败' }));
    }
  }

  async function handleClaim() {
    if (!connected) { openWallet(); return; }
    if (parseFloat(pendingReward) <= 0) {
      showToast('info', 'no_reward_claim');
      return;
    }
    setLoadingClaim(true);
    try {
      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: viemGetAddress(MINING_ADDRESS),
        abi: MINING_ABI,
        functionName: 'claim',
      });
      showToast('info', 'confirm_claim_tx');
      // viem version: send claim transaction
      const { hash } = await viemWriteContract({
        address: viemGetAddress(MINING_ADDRESS),
        abi: MINING_ABI,
        functionName: 'claim',
      });
      showToast('info', 'tx_pending');
      await viemWaitForTransaction(hash);
      showToast('success', 'claim_success');
      // Invalidate cache, silently refresh latest data in background
      invalidateMining();
      useMiningStore.getState().fetchGlobal({ silent: true });
      useMiningStore.getState().fetchUser(address, { silent: true });
    } catch (e) {
      if (e?.code === 4001 || e?.message?.includes('rejected') || e?.cause?.message?.includes('rejected')) {
        showToast('error', 'user_rejected_tx');
      } else {
        console.error('[mining][viem] claim failed:', e);
        showToast('error', 'claim_failed');
      }
    } finally {
      setLoadingClaim(false);
    }
  }

  const mainClaimDisabled = !connected || parseFloat(pendingReward) <= 0 || loadingClaim;

  // Trade mining is opted in by default; setMiningOptOut(true) opts out (the user's own trades no longer generate rewards), false rejoins
  function handleToggleOptOut() {
    if (!connected) { openWallet(); return; }
    setShowOptOutConfirm(true);
  }

  async function confirmToggleOptOut() {
    const nextOptOut = !isOptedOut;
    setLoadingOptToggle(true);
    try {
      const miningAddr = viemGetAddress(MINING_ADDRESS);
      // P1 Pre-flight simulate first (fail fast, no wallet popup if would revert)
      await viemSimulateContract({
        address: miningAddr,
        abi: MINING_ABI,
        functionName: 'setMiningOptOut',
        args: [nextOptOut],
      });
      showToast('info', nextOptOut ? 'mining_opt_out_submitting' : 'mining_rejoin_submitting');
      const { hash } = await viemWriteContract({
        address: miningAddr,
        abi: MINING_ABI,
        functionName: 'setMiningOptOut',
        args: [nextOptOut],
      });
      showToast('info', 'tx_pending');
      await viemWaitForTransaction(hash);
      showToast('success', nextOptOut ? 'mining_opt_out_success' : 'mining_rejoin_success');
      setShowOptOutConfirm(false);
      useMiningStore.setState({ isOptedOut: nextOptOut });
      invalidateMining();
      useMiningStore.getState().fetchUser(address, { silent: true });
    } catch (e) {
      if (e?.code === 4001 || e?.message?.includes('rejected') || e?.cause?.message?.includes('rejected')) {
        showToast('error', 'user_rejected_tx');
      } else {
        console.error('[mining][viem] setMiningOptOut failed:', e);
        showToast('error', 'mining_opt_toggle_failed');
      }
    } finally {
      setLoadingOptToggle(false);
    }
  }

  return (
    <div className="space-y-5 max-w-5xl mx-auto animate-fadeIn">

      {/* Top: CFO logo + banner */}
      <div className="flex flex-col items-center gap-3 text-center">
        <img
          src="/img/tokens/cfo.png?v=6"
          alt="CFO"
          draggable={false}
          className="w-36 h-36 md:w-40 md:h-40 object-contain select-none"
        />
        <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          {t('mining_title', '欢迎来到CFOSWAP农场 畅享交易 快乐收割')}
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="rounded-xl p-5 md:p-6 order-1 lg:order-none"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'var(--gradient-primary)', color: 'white' }}
              >
                <UserPlus className="w-4.5 h-4.5" />
              </div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
                {t('invite_friends')}
              </h2>
            </div>

            <div className="mb-4">
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                {t('my_invite_link')}
              </div>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Link2 className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-tertiary)' }} />
                  <input
                    type="text"
                    readOnly
                    value={connected ? inviteLink : t('generate_after_connect')}
                    className="w-full h-10 pl-10 pr-3 rounded-xl text-xs outline-none truncate"
                    style={{
                      background: 'var(--color-bg-tertiary)',
                      color: connected ? 'var(--color-text-primary)' : 'var(--color-text-disabled)',
                      border: '1px solid var(--color-border-default)',
                    }}
                  />
                </div>
                <button
                  onClick={handleCopyLink}
                  className="h-10 px-4 rounded-xl flex items-center gap-1.5 text-sm font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    background: copied ? 'var(--state-success-bg)' : 'var(--color-bg-tertiary)',
                    color: copied ? 'var(--state-success)' : 'var(--color-text-primary)',
                    border: `1px solid ${copied ? 'rgba(16, 185, 129, 0.25)' : 'var(--color-border-default)'}`,
                  }}
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? t('copied', 'Copied') : t('copy_link')}
                </button>
              </div>
            </div>

            <div className="p-4 rounded-xl"
              style={{
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('my_inviter')}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold`} style={hasBound ? {
                  background: 'var(--state-success-bg)',
                  color: 'var(--state-success)',
                } : pendingInviter ? {
                  background: 'var(--state-info-bg)',
                  color: 'var(--state-info)',
                } : {
                  background: 'var(--state-warning-bg)',
                  color: 'var(--state-warning)',
                }}>
                  {hasBound ? t('bound') : pendingInviter ? t('pending_bound', '待绑定') : t('not_bound')}
                </span>
              </div>
              {hasBound ? (
                <div className="text-sm py-1.5" style={{ color: 'var(--color-text-primary)' }}>
                  {shortenAddress(inviterAddress, 6)}
                </div>
              ) : pendingInviter ? (
                <div className="text-sm py-1.5" style={{ color: 'var(--color-text-primary)' }}>
                  {shortenAddress(pendingInviter, 6)}
                  <div className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('pending_bound_tip', '进行首次挖矿后自动绑定')}
                  </div>
                </div>
              ) : (
                <div className="text-sm py-1.5 italic" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('no_inviter', '无邀请人')}
                </div>
              )}
            </div>

            {/* Trade-mining participation status: opted in by default, can opt out / rejoin */}
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('mining_participation_status', '挖矿参与状态')}
                </span>
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold"
                  style={isOptedOut ? {
                    background: 'var(--state-error-bg-soft, rgba(239, 68, 68, 0.1))',
                    color: 'var(--color-error, #ef4444)',
                  } : {
                    background: 'var(--state-success-bg)',
                    color: 'var(--state-success)',
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'currentColor' }} />
                  {isOptedOut ? t('mining_status_opted_out', '已退出') : t('mining_status_active', '参与中')}
                </span>
              </div>
              <button
                onClick={handleToggleOptOut}
                disabled={loadingOptToggle}
                className="w-full h-10 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={isOptedOut ? {
                  background: 'var(--gradient-primary)',
                  color: '#fff',
                } : {
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--state-warning)',
                  border: '1px solid var(--color-border-default)',
                }}
              >
                {loadingOptToggle
                  ? <div className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                  : <Power className="w-4 h-4" />}
                {!connected
                  ? t('connect_wallet_first', '请先连接钱包')
                  : isOptedOut
                    ? t('mining_rejoin_btn', '重新加入挖矿')
                    : t('mining_opt_out_btn', '退出挖矿')}
              </button>
            </div>
          </div>

          <div className="rounded-xl p-5 md:p-6 card-glow order-2 lg:order-none"
            style={{
              background: 'var(--gradient-card)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, #F97316 0%, #FACC15 100%)',
                  color: 'white',
                  boxShadow: '0 0 20px rgba(249, 115, 22, 0.2)',
                }}
              >
                <Gem className="w-4.5 h-4.5" />
              </div>
              <div>
                <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
                  {t('mining_reward_card_title')}
                </h2>
              </div>
            </div>

            <div className="rounded-xl p-5 mb-4 text-center"
              style={{
                background: 'var(--ministat-warn-bg)',
                border: '1px solid var(--state-warning-border-soft)',
              }}
            >
              <div className="text-xs mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('pending_reward')}
              </div>
              <div className="text-4xl font-bold font-numeric text-gradient-warn animate-countUp">
                {formatBalance(pendingReward, 6)}
              </div>
              <div className="text-sm font-semibold mt-1" style={{ color: 'var(--color-warn-500)' }}>
                CFO
              </div>
              <button
                onClick={handleClaim}
                disabled={mainClaimDisabled}
                className="mt-4 w-full h-11 rounded-xl font-bold text-sm inline-flex items-center justify-center gap-2 transition-all disabled:opacity-50 btn-primary"
              >
                {loadingClaim && <Loader2 className="w-4.5 h-4.5 animate-spin" />}
                {!connected ? (
                  <><Wallet className="w-4.5 h-4.5" />{t('connect_wallet')}</>
                ) : (
                  <><Gift className="w-4.5 h-4.5" />{t('claim')}</>
                )}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="p-3.5 rounded-xl"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('total_mined_amount')}
                </div>
                <div className="text-lg font-bold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                  {formatBalance(totalMinedAmount, 2)}
                  <span className="text-xs ml-1 font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>CFO</span>
                </div>
              </div>
              <div className="p-3.5 rounded-xl"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('total_invite_bonus')}
                </div>
                <div className="text-lg font-bold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                  {formatBalance(totalInviteBonus, 2)}
                  <span className="text-xs ml-1 font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>CFO</span>
                </div>
              </div>
            </div>

            <div className="py-2 flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                {t('mining_total_supply')}
              </span>
              <span className="text-xs" style={{ color: 'var(--color-border-default)' }}>|</span>
              <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                {t('mining_trading_supply')}
              </span>
            </div>
          </div>

          <div className="rounded-xl p-5 md:p-6 order-3 lg:order-none"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'var(--gradient-primary)', color: 'white' }}
              >
                <TrendingUp className="w-4.5 h-4.5" />
              </div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
                {t('mining_phase_progress')}
              </h2>
            </div>

            <div className="space-y-4">
              <div className="p-4 rounded-xl relative overflow-hidden"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: `1px solid ${phase1Completed ? 'rgba(16, 185, 129, 0.2)' : 'rgba(249, 115, 22, 0.2)'}`,
                }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>
                      {t('phase_1')}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                      style={{
                        background: 'rgba(249, 115, 22, 0.12)',
                        color: 'var(--color-warn-500)',
                      }}
                    >
                      {t('phase_10x')}
                    </span>
                  </div>
                  <span className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--color-text-tertiary)' }}>
                    {formatBalance(phase1Produced, 2)} / 10M CFO
                  </span>
                </div>
                <ProgressBar percent={phase1Percent} color="var(--gradient-warn)" />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('phase_1_rate')}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                    phase1Completed ? '' : ''
                  }`} style={phase1Completed ? {
                    background: 'var(--state-success-bg)',
                    color: 'var(--state-success)',
                  } : {
                    background: 'rgba(59, 130, 246, 0.12)',
                    color: 'var(--color-primary-500)',
                  }}>
                    {phase1Completed ? t('completed') : t('in_progress')}
                  </span>
                </div>
              </div>

              <div className="p-4 rounded-xl relative overflow-hidden"
                style={{
                  background: 'var(--color-bg-tertiary)',
                  border: `1px solid ${phase2Active ? 'rgba(59, 130, 246, 0.2)' : 'var(--color-border-subtle)'}`,
                }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>
                      {t('phase_2')}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                      style={{
                        background: 'rgba(139, 92, 246, 0.12)',
                        color: '#8B5CF6',
                      }}
                    >
                      {t('phase_1x')}
                    </span>
                  </div>
                  <span className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--color-text-tertiary)' }}>
                    {formatBalance(phase2Produced, 2)} / 90M CFO
                  </span>
                </div>
                <ProgressBar percent={phase2Percent} color="var(--gradient-primary)" muted={!phase1Completed} />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('phase_2_rate')}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold`}
                    style={phase2Active ? {
                      background: 'rgba(59, 130, 246, 0.12)',
                      color: 'var(--color-primary-500)',
                    } : !phase1Completed ? {
                      background: 'var(--state-info-bg)',
                      color: 'var(--state-info)',
                    } : {
                      background: 'var(--state-success-bg)',
                      color: 'var(--state-success)',
                    }}
                  >
                    {!phase1Completed ? t('pending') : phase2Active ? t('in_progress') : t('completed')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl p-5 md:p-6 order-4 lg:order-none"
            style={{
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{
                  background: 'rgba(16, 185, 129, 0.12)',
                  color: 'var(--state-success)',
                }}
              >
                <Calendar className="w-4.5 h-4.5" />
              </div>
              <div>
                <h2 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>
                  {t('vesting_progress')}
                </h2>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
              <div className="p-3 rounded-xl text-center"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('total_release_amount') || t('total_release')}
                </div>
                <div className="text-sm font-bold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
                  {formatBalance(vestingTotal, 4)}
                </div>
              </div>
              <div className="p-3 rounded-xl text-center"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('mining_claimed_amount')}
                </div>
                <div className="text-sm font-bold font-numeric" style={{ color: 'var(--state-success)' }}>
                  {formatBalance(vestingClaimed, 4)}
                </div>
              </div>
              <div className="p-3 rounded-xl text-center"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('remaining_release') || t('remaining')}
                </div>
                <div className="text-sm font-bold font-numeric" style={{ color: 'var(--color-primary-500)' }}>
                  {formatBalance(vestingRemaining, 4)}
                </div>
              </div>
              <div className="p-3 rounded-xl text-center"
                style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-subtle)' }}
              >
                <div className="text-xs mb-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('pending_reward')}
                </div>
                <div className="text-sm font-bold font-numeric" style={{ color: 'var(--color-warn-500)' }}>
                  {formatBalance(pendingReward, 4)}
                  <span className="text-xs ml-0.5 font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>CFO</span>
                </div>
              </div>
            </div>

            <ProgressBar percent={vestingPercent} color="var(--gradient-primary)" />

            {vestingCount !== null && (
              <div className="mt-2.5 flex items-center justify-between text-xs">
                <span style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('mining_pending_release_count')}
                </span>
                <span className="font-bold font-numeric" style={{ color: 'var(--color-warn-500)' }}>
                  {vestingCount}
                  <span className="ml-0.5 font-semibold" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('mining_unit')}
                  </span>
                </span>
              </div>
            )}

            <div className="mt-3 p-3 rounded-xl flex gap-2.5"
              style={{
                background: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.15)',
              }}
            >
              <Clock className="w-4.5 h-4.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--state-success)' }} />
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {t('linear_vesting_365') || t('vesting_desc')}
              </p>
            </div>
          </div>
      </div>

      {/* Opt out of mining / rejoin confirmation modal */}
      {showOptOutConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fadeIn" onClick={() => !loadingOptToggle && setShowOptOutConfirm(false)}>
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
              onClick={() => setShowOptOutConfirm(false)}
              disabled={loadingOptToggle}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80 disabled:opacity-50"
              style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
            >
              <X size={18} />
            </button>

            <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto"
              style={isOptedOut
                ? { background: 'var(--state-success-bg)', border: '1px solid var(--state-success)' }
                : { background: 'var(--state-warning-bg)', border: '1px solid var(--color-border-strong)' }}
            >
              <AlertTriangle size={28} style={{ color: isOptedOut ? 'var(--state-success)' : 'var(--color-warn-400)' }} />
            </div>
            <h3 className="text-xl font-bold text-center mb-3" style={{ color: 'var(--color-text-primary)' }}>
              {isOptedOut ? t('mining_rejoin_confirm_title', '重新加入挖矿') : t('mining_opt_out_confirm_title', '确认退出挖矿')}
            </h3>
            <p className="text-sm leading-relaxed mb-6 p-4 rounded-xl" style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}>
              {isOptedOut
                ? t('mining_rejoin_confirm_desc', '重新加入后，您的交易将恢复产生交易挖矿奖励。')
                : t('mining_opt_out_confirm_desc', '退出后，您的交易将不再产生交易挖矿奖励；已累积的奖励不受影响，仍可领取。可随时重新加入。')}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowOptOutConfirm(false)}
                disabled={loadingOptToggle}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-tertiary)' }}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={confirmToggleOptOut}
                disabled={loadingOptToggle}
                className="flex-1 px-4 py-3.5 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={isOptedOut
                  ? { background: 'var(--gradient-primary)', color: '#fff' }
                  : { background: 'linear-gradient(135deg, #ef4444, #dc2626)', color: '#fff' }}
              >
                {loadingOptToggle && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {loadingOptToggle
                  ? t('signing', '签名中...')
                  : isOptedOut ? t('mining_rejoin_confirm_btn', '确认加入') : t('mining_opt_out_confirm_btn', '确认退出')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressBar({ percent, color, muted = false }) {
  const p = Math.min(100, Math.max(0, percent || 0));
  // Keep minimum visible width (2%) for very small percentages, avoid visually invisible progress
  const width = p > 0 && p < 2 ? 2 : p;
  return (
    <div className="h-2.5 rounded-full relative overflow-hidden progress-shine"
      style={{
        background: muted ? 'rgba(148, 163, 184, 0.08)' : 'rgba(148, 163, 184, 0.12)',
      }}
    >
      <div
        className="h-full rounded-full transition-all duration-700 relative"
        style={{
          width: `${width}%`,
          background: muted ? 'rgba(148, 163, 184, 0.25)' : color,
          boxShadow: muted ? 'none' : '0 0 12px rgba(96, 165, 250, 0.35)',
        }}
      />
    </div>
  );
}
