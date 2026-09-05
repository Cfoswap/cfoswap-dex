import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useWalletStore } from '@/store/walletStore.js';
import {
  readReferrerFromLocation,
  storeReferrer,
  clearStoredReferrer,
  isValidReferrer,
} from '@/utils/referral.js';

/**
 * Global referral-link capture.
 *
 * Mounted in the shared in-route layout (MainLayout): on landing on any page or during
 * SPA navigation, any ?ref= in the URL is validated and staged to localStorage, to be
 * attached to swap transactions for the contract. It is staged first while the wallet
 * is disconnected; after connecting, if it turns out to be a self-referral link it is cleared.
 */
export function useReferrerCapture() {
  const location = useLocation();
  const address = useWalletStore((s) => s.address);

  useEffect(() => {
    const refFromUrl = readReferrerFromLocation();
    if (!refFromUrl) return;
    if (isValidReferrer(refFromUrl, address || undefined)) {
      storeReferrer(refFromUrl);
    } else if (address && refFromUrl.toLowerCase() === address.toLowerCase()) {
      clearStoredReferrer();
    }
  }, [location.pathname, location.search, address]);
}

export default useReferrerCapture;
