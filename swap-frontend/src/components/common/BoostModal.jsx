import { useState, useEffect } from 'react';
import { X, Zap, AlertCircle, Wallet, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAddress as viemGetAddress, parseEther as viemParseEther, formatEther as viemFormatEther } from 'viem';
import { useUiStore } from '@/store/uiStore.js';
import { useWalletStore } from '@/store/walletStore.js';
import { usePoolsStore } from '@/store/poolsStore.js';
import { BOOST_MIN_BNB, BOOST_MAX_BNB, MINING_POOL_FACTORY_ADDRESS, MINING_POOL_FACTORY_ABI } from '@/config/index.js';
import TokenIcon from '@/components/common/TokenIcon.jsx';
import { sanitizeAmountInput, blockInvalidNumericKeys, viemGetBalance, viemSimulateContract, viemWriteContract, viemWaitForTransaction } from '@/utils/index.js';

export default function BoostModal() {
  const { t } = useTranslation();
  const closeModal = () => useUiStore.getState().closeBoostModal();
  const showToast = (type, msg) => useUiStore.getState().showToast(type, msg);
  const boostPoolAddress = useUiStore((s) => s.boostPoolAddress);
  const { connected, address } = useWalletStore();

  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [bnbBalance, setBnbBalance] = useState('0');

  // Load real on-chain BNB balance when modal opens / account changes
  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      if (!connected || !address) {
        setBnbBalance('0');
        return;
      }
      try {
        const wei = await viemGetBalance(address);
        if (!cancelled) setBnbBalance(viemFormatEther(wei));
      } catch (e) {
        console.warn('[Boost] load BNB balance failed:', e?.shortMessage || e?.message);
        if (!cancelled) setBnbBalance('0');
      }
    }
    loadBalance();
    return () => { cancelled = true; };
  }, [connected, address]);

  const numAmount = parseFloat(amount);
  const isEmpty = amount === '' || isNaN(numAmount);
  const errorMin = !isEmpty && numAmount < BOOST_MIN_BNB;
  const errorMax = !isEmpty && numAmount > BOOST_MAX_BNB;
  const errorInsufficient = !isEmpty && !isNaN(numAmount) && numAmount > parseFloat(bnbBalance);

  const hasError = errorMin || errorMax || errorInsufficient;
  const canSubmit = !hasError && !isEmpty && !loading && connected && !!boostPoolAddress;

  const handleBoost = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const valueWei = viemParseEther(amount);
      const factoryAddr = viemGetAddress(MINING_POOL_FACTORY_ADDRESS);
      const poolAddr = viemGetAddress(boostPoolAddress);

      // Pre-flight simulate first (fail before wallet popup)
      await viemSimulateContract({
        address: factoryAddr,
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'boostPool',
        args: [poolAddr],
        value: valueWei,
      });
      showToast('info', t('wallet_sign_prompt', '📝 请在钱包中签名...'));
      const { hash } = await viemWriteContract({
        address: factoryAddr,
        abi: MINING_POOL_FACTORY_ABI,
        functionName: 'boostPool',
        args: [poolAddr],
        value: valueWei,
      });
      showToast('info', t('tx_confirming', '⏳ 签名成功，等待链上确认...'));
      // viemWaitForTransaction throws when receipt.status === 'reverted'
      await viemWaitForTransaction(hash);
      showToast('success', t('boost_success'));
      // Refresh on-chain pool data so boost total / ranking update everywhere
      usePoolsStore.getState().refreshPools(address);
      closeModal();
    } catch (e) {
      console.error('[Boost] boost payment failed:', e);
      const errMsg = e?.message || '';
      const isRejected = errMsg.includes('rejected') || errMsg.includes('denied') || e?.code === 4001;
      showToast('error', isRejected
        ? t('common.user_rejected', '用户已取消签名')
        : (e?.shortMessage || t('pools.boost_failed', '助力失败')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fadeIn"
      onClick={(e) => {
        e.stopPropagation();
        closeModal();
      }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'var(--overlay-mask)', backdropFilter: 'blur(8px)' }}
      />

      <div
        className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-xl p-6 animate-slideUp sm:animate-fadeIn max-h-[92dvh] sm:max-h-none overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--gradient-surface)',
          border: '1px solid var(--color-border-default)',
          boxShadow: 'var(--modal-warn-shadow)',
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            closeModal();
          }}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
          style={{
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-tertiary)',
          }}
        >
          <X size={18} />
        </button>

        <div className="mb-6">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mb-4 mx-auto"
            style={{
              background: 'var(--state-warning-bg)',
              border: '1px solid var(--color-border-strong)',
            }}
          >
            <Zap size={28} style={{ color: 'var(--color-warn-400)' }} />
          </div>
          <h2
            className="text-xl font-bold text-center mb-1.5"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {t('pl_boost_modal_title')}
          </h2>
          <p className="text-sm text-center leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {t('pl_boost_modal_desc')}
          </p>
        </div>

        <div className="mb-5">
          <div
            className="rounded-xl p-4 transition-colors"
            style={{
              background: 'var(--color-bg-tertiary)',
              border: hasError
                ? '1px solid var(--state-error)'
                : amount
                ? '1px solid var(--color-border-strong)'
                : '1px solid var(--color-border-default)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {t('pl_boost_modal_input_hint')}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
                onKeyDown={blockInvalidNumericKeys}
                placeholder={t('pl_boost_modal_input_placeholder')}
                className="flex-1 bg-transparent outline-none text-xl font-semibold"
                style={{ color: 'var(--color-text-primary)' }}
              />
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
                style={{ background: 'var(--state-info-bg)' }}
              >
                <TokenIcon src="/img/tokens/bnb.png" symbol="BNB" size={20} />
                <span className="text-sm font-medium" style={{ color: 'var(--color-primary-400)' }}>BNB</span>
              </div>
            </div>
          </div>

          {(errorMin || errorMax || errorInsufficient) && (
            <div
              className="mt-3 flex items-start gap-2 p-3 rounded-lg text-xs"
              style={{
                background: 'var(--state-error-bg)',
                border: '1px solid var(--state-error)',
                color: 'var(--state-error)',
              }}
            >
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                {errorMin && t('pl_boost_error_min')}
                {errorMax && t('pl_boost_error_max')}
                {errorInsufficient && t('insufficient_balance')}
              </span>
            </div>
          )}
        </div>

        <div
          className="mb-6 flex items-center justify-between p-3 rounded-xl"
          style={{
            background: 'var(--color-bg-tertiary)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <div className="flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
            <Wallet size={16} />
            <span className="text-sm">{t('bnb_balance')}</span>
          </div>
          <span className="text-sm font-semibold font-numeric" style={{ color: 'var(--color-text-primary)' }}>
            {Number(bnbBalance).toFixed(4)} BNB
          </span>
        </div>

        <button
          onClick={handleBoost}
          disabled={!canSubmit}
          className={`w-full py-3.5 rounded-xl text-sm font-semibold transition-colors relative overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed ${canSubmit ? 'btn-primary' : ''}`}
          style={!canSubmit ? {
            background: 'var(--color-bg-tertiary)',
            color: 'var(--color-text-disabled)',
            border: '1px solid var(--color-border-subtle)',
          } : {}}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('confirming', 'Confirming...')}</span>
            </div>
          ) : (
            t('confirm_boost')
          )}
        </button>
      </div>
    </div>
  );
}
