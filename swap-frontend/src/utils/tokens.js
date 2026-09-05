/**
 * Token identity resolution module
 *
 * Identity rules:
 * - Built-in tokens (config.TOKENS) use their symbol as the global id, e.g. 'BNB' / 'USDT' / 'CFO'
 * - User-imported custom tokens use the lowercased contract address as the global id, e.g. '0x9a74…ab49'
 * - For on-chain interactions the native BNB coin is uniformly mapped to the WBNB contract address
 *
 * Therefore same-name contracts (such as a redeployed CFO) can coexist: the built-in CFO uses the
 * symbol id while the old CFO uses the address id, and neither overwrites the other.
 */
import { TOKENS, WBNB_ADDRESS } from '@/config/index.js';

const NATIVE_ID = 'BNB';
const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : '');
const isAddressLike = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

// Static tokens: lowercased address -> symbol index (module-level constant)
const STATIC_ADDR_TO_SYM = new Map();
for (const [sym, tok] of Object.entries(TOKENS)) {
  if (tok?.address) STATIC_ADDR_TO_SYM.set(tok.address.toLowerCase(), sym);
}

// Fixed contracts with known logos that are not in the TOKENS registry (matched by contract address, not by symbol)
const EXTRA_LOGO_BY_ADDR = new Map([
  ['0xba2ae424d960c26247dd6c32edc70b295c744c43', '/img/tokens/doge.png'],
]);

/**
 * Legacy persisted-data migration: customTokens used to be keyed by symbol;
 * convert them uniformly to lowercase-contract-address keys. Imported entries whose
 * address duplicates a built-in token are discarded.
 */
export function migrateCustomTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const val of Object.values(raw)) {
    if (!val || typeof val !== 'object' || !val.address) continue;
    const lower = lc(val.address);
    if (!isAddressLike(lower)) continue;
    if (STATIC_ADDR_TO_SYM.has(lower)) continue; // Built-in token, no need to import
    if (out[lower]) continue;
    out[lower] = { ...val, address: String(val.address) };
  }
  return out;
}

/** Whether the address belongs to a built-in token */
export function isStaticTokenAddress(addr) {
  return STATIC_ADDR_TO_SYM.has(lc(addr));
}

/**
 * Any id (symbol / address) or token object -> token object.
 * Also accepts callers passing the token object itself.
 */
export function resolveTokenById(id, customTokens) {
  if (!id) return null;
  if (typeof id === 'object') return id.address || id.isNative ? id : null;
  if (id === NATIVE_ID) return TOKENS.BNB;
  const staticTok = TOKENS[id];
  if (staticTok) return staticTok;
  if (isAddressLike(id)) {
    const lower = id.toLowerCase();
    const ct = customTokens?.[lower];
    if (ct) return ct;
    const sym = STATIC_ADDR_TO_SYM.get(lower);
    if (sym) return TOKENS[sym];
  }
  return null;
}

/** Token object -> global id (built-in = symbol, custom = lowercased address) */
export function tokenIdOf(token) {
  if (!token) return '';
  if (token.isNative || token.symbol === NATIVE_ID) return NATIVE_ID;
  const lower = lc(token.address);
  if (!lower) return '';
  const sym = STATIC_ADDR_TO_SYM.get(lower);
  return sym || lower;
}

/** id -> on-chain contract address (BNB / WBNB both resolve to WBNB) */
export function tokenAddrById(id, customTokens) {
  if (id === NATIVE_ID || id === 'WBNB') return WBNB_ADDRESS;
  const tok = resolveTokenById(id, customTokens);
  if (!tok?.address) return null;
  return tok.isNative ? WBNB_ADDRESS : tok.address;
}

/** id -> decimals (prefer the chain-read persisted decimalsOverride, fall back to the ERC20 standard 18) */
export function decimalsById(id, customTokens, decimalsOverride) {
  const tok = resolveTokenById(id, customTokens);
  if (!tok?.address) return 18;
  const ov = decimalsOverride?.[tok.address.toLowerCase()];
  return ov != null ? Number(ov) : 18;
}

/** On-chain address -> display symbol (WBNB shown as BNB; unknown addresses shown as a shortened address) */
export function addrToSymbol(addr, customTokens) {
  if (!addr) return '';
  const lower = lc(addr);
  const sym = STATIC_ADDR_TO_SYM.get(lower);
  if (sym) return sym === 'WBNB' ? NATIVE_ID : sym;
  const ct = customTokens?.[lower];
  if (ct?.symbol) return ct.symbol;
  for (const t of Object.values(customTokens || {})) {
    if (lc(t?.address) === lower) return t.symbol;
  }
  return `${String(addr).slice(0, 6)}...${String(addr).slice(-4)}`;
}

/** All selectable token entries (built-in + custom, deduped by address), returns [{ id, token }] */
export function allTokenEntries(customTokens) {
  const out = [];
  const seenAddr = new Set();
  for (const [sym, tok] of Object.entries(TOKENS)) {
    if (!tok) continue;
    const lower = lc(tok.address);
    if (lower) seenAddr.add(lower);
    out.push({ id: sym, token: tok });
  }
  for (const t of Object.values(customTokens || {})) {
    const lower = lc(t?.address);
    if (!lower || seenAddr.has(lower)) continue;
    seenAddr.add(lower);
    out.push({ id: lower, token: t });
  }
  return out;
}

/**
 * Whether a token's symbol collides with another token in the list (used by the UI
 * to append an address suffix for disambiguation). A collision means: a built-in token
 * has the same symbol, or another custom token has the same symbol (different address).
 */
export function hasSymbolConflict(token, customTokens) {
  const sym = String(token?.symbol || '').toUpperCase();
  if (!sym) return false;
  const myAddr = lc(token?.address);
  const staticTok = TOKENS[sym];
  if (staticTok && lc(staticTok.address) !== myAddr) return true;
  for (const t of Object.values(customTokens || {})) {
    if (lc(t?.address) === myAddr) continue;
    if (String(t?.symbol || '').toUpperCase() === sym) return true;
  }
  return false;
}

/**
 * Token icon src resolution (matched by contract address; same-name different-contract
 * tokens do not share an icon):
 * - An explicit logoURI (http/https/dataURI/relative path) is used directly;
 * - Otherwise the built-in icon is returned only when the token address matches a
 *   built-in TOKENS entry (or a known fixed contract);
 * - Same-name tokens at different addresses return undefined, and TokenIcon falls back
 *   to rendering the symbol text.
 */
export function tokenIconSrc(token) {
  if (!token) return undefined;
  let logoURI = token.logoURI || '';
  if (logoURI && !/^https?:\/\//i.test(logoURI) && !logoURI.startsWith('data:')) {
    logoURI = logoURI.startsWith('/') ? logoURI : `/${logoURI}`;
  }
  if (logoURI) return logoURI;
  const lower = lc(token.address);
  if (!lower) return undefined;
  const sym = STATIC_ADDR_TO_SYM.get(lower);
  if (sym) {
    const u = TOKENS[sym]?.logoURI;
    if (u) return u.startsWith('/') ? u : `/${u}`;
  }
  return EXTRA_LOGO_BY_ADDR.get(lower);
}

/** Shortened address, used as the suffix for same-name tokens, e.g. 0x9a74…ab49 */
export function shortAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
