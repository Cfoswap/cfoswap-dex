/**
 * Referral relationship staging (single source of truth)
 *
 * Flow: referral link `?ref=<address>` -> captured by the global hook (useReferrerCapture)
 *       -> staged in localStorage -> encoded into extraData for swap transactions
 *       -> the contract binds the referral relationship on-chain (first-bind-wins).
 */

export const REFERRAL_STORAGE_KEY = 'cfoswap_ref';

const REFERRAL_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Parse the ref parameter from the current URL.
 * Covers both forms under hash routing:
 *   - Landing link: https://domain/?ref=0xABC#/swap   (ref is in the search before the hash)
 *   - In-route:     https://domain/#/mining?ref=0xABC (ref is in the hash query)
 * @returns {string} '' when not found
 */
export function readReferrerFromLocation(loc) {
  try {
    const l = loc || (typeof window !== 'undefined' ? window.location : null);
    if (!l) return '';
    const fromSearch = new URLSearchParams(l.search || '').get('ref');
    if (fromSearch) return fromSearch.trim();
    const hash = l.hash || '';
    const qi = hash.indexOf('?');
    if (qi >= 0) {
      const fromHash = new URLSearchParams(hash.slice(qi + 1)).get('ref');
      if (fromHash) return fromHash.trim();
    }
  } catch (_) { /* noop */ }
  return '';
}

export function getStoredReferrer() {
  try {
    return (localStorage.getItem(REFERRAL_STORAGE_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}

export function storeReferrer(addr) {
  try {
    localStorage.setItem(REFERRAL_STORAGE_KEY, addr);
  } catch (_) { /* noop */ }
}

export function clearStoredReferrer() {
  try {
    localStorage.removeItem(REFERRAL_STORAGE_KEY);
  } catch (_) { /* noop */ }
}

/**
 * Validate the referrer address: well-formed format and not the user themselves.
 * @param {string} addr address to validate
 * @param {string} [selfAddr] current wallet address; self-referral check is skipped when omitted
 * @returns {string} the address if valid, otherwise ''
 */
export function isValidReferrer(addr, selfAddr) {
  if (!addr || !REFERRAL_ADDRESS_RE.test(addr)) return '';
  if (selfAddr && addr.toLowerCase() === selfAddr.toLowerCase()) return '';
  return addr;
}
