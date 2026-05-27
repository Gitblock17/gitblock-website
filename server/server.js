const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// ══════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════
const CACHE_TTL_MS = 15000; // 15s polling
const MAX_TOKENS = 10000; // Track all tokens, not just recent
const CACHE_FILE = path.join(__dirname, '..', 'token-cache.json');

// All known launchpads on Base
const LAUNCHPADS = {
  clanker: {
    name: 'Clanker', url: 'https://clanker.world',
    factories: ['0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E','0x732560fa1d1A76350b1A500155BA978031B53833'],
    deployers: [],
    description: 'AI agent token launchpad — $8B+ volume',
  },
  bankr: {
    name: 'Bankr', url: 'https://bankr.chat',
    factories: [],
    deployers: ['0x002f07b0d63e8ac14f8ef6b73ccd8caf1fef074c'],
    description: 'Farcaster AI agent launchpad — powered by Clanker',
  },
  zora: {
    name: 'Zora', url: 'https://zora.co',
    factories: ['0x777777751622c0d3258f214F9DF38E35BF45baF3'],
    deployers: [],
    description: 'NFT & token creation platform — now on Base',
  },
  virtuals: {
    name: 'Virtuals Protocol', url: 'https://virtuals.io',
    factories: ['0x58AEbA5d13Fa00F2cf3cbaA1B6aDc849abDeB6Cb'],
    deployers: [],
    description: 'AI agent co-ownership & tokenization protocol',
  },
  aethernet: {
    name: 'Aethernet', url: 'https://aethernet.xyz',
    factories: [],
    deployers: [],
    description: 'Farcaster-native token launches',
  },
};

// Factory/deployer addresses for accurate on-chain detection
const LAUNCHPAD_FACTORIES = {
  clanker: ['0x375c15db32d28cecdcab5c03ab889bf15cbd2c5e', '0x732560fa1d1a76350b1a500155ba978031b53833'],
  bankr: ['0x002f07b0d63e8ac14f8ef6b73ccd8caf1fef074c'],
  zora: ['0x777777751622c0d3258f214f9df38e35bf45baf3'],
};

function detectLaunchpadFromCreator(creatorAddress) {
  if (!creatorAddress) return null;
  const addr = creatorAddress.toLowerCase();
  for (const [pad, factories] of Object.entries(LAUNCHPAD_FACTORIES)) {
    if (factories.includes(addr)) return pad;
  }
  return null;
}

// Keywords in token names/profiles that hint at launchpad origin
const LAUNCHPAD_KEYWORDS = {
  clanker: ['clanker', 'tokenbot'],
  bankr: ['bankr', 'bnkr'],
  zora: ['zora', 'zora coin', 'zora create'],
  virtuals: ['virtuals', 'virtual protocol', 'g.a.m.e', 'game protocol'],
  aethernet: ['aethernet', 'aether'],
};

// GoPlus + BaseScan APIs
const GOPLUS_API = 'https://api.gopluslabs.io/api/v1/token_security/8453';
const DEX_API = 'https://api.dexscreener.com';
const GECKO_API = 'https://api.geckoterminal.com/api/v2';

// ══════════════════════════════════════════════════════════════════════
// CACHE
// ══════════════════════════════════════════════════════════════════════
let cache = { data: [], updated: 0 };
let securityCache = {};
let txCache = {};

// Load persisted cache from disk on startup
try {
  if (require('fs').existsSync(CACHE_FILE)) {
    const saved = JSON.parse(require('fs').readFileSync(CACHE_FILE, 'utf8'));
    if (saved?.data?.length) {
      cache = saved;
      console.log(`Loaded ${cache.data.length} tokens from disk cache`);
    }
  }
} catch (e) { console.log('No disk cache found, starting fresh'); }

function saveCacheToDisk() {
  try {
    require('fs').writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════

function age(iso) {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function identifyLaunchpad(pair, profile) {
  // Collect all text signals
  const parts = [
    (pair?.baseToken?.name || '').toLowerCase(),
    (pair?.baseToken?.symbol || '').toLowerCase(),
    (pair?.dexId || '').toLowerCase(),
    (pair?.labels || []).join(' ').toLowerCase(),
    ((pair?.info?.socials || []).map(s => (s.url || '').toLowerCase()).join(' ')),
  ];
  if (profile) {
    parts.push((profile.description || '').toLowerCase());
    parts.push((profile.labels || []).join(' ').toLowerCase());
    parts.push((profile.url || '').toLowerCase());
  }
  const combined = parts.join(' ');

  // 1. Exact Bankr detection (name/symbol/profile mentions "bankr")
  if (combined.includes('bankr') || combined.includes('bnkr')) return 'bankr';

  // 2. Exact Clanker detection (name/symbol/profile mentions "clanker" or "tokenbot")
  if (combined.includes('clanker') || combined.includes('tokenbot')) return 'clanker';

  // 3. Exact Zora detection
  if (combined.includes('zora') && (combined.includes('coin') || combined.includes('create'))) return 'zora';

  // 4. Virtuals detection
  if (combined.includes('virtuals') || combined.includes('virtual protocol') || combined.includes('g.a.m.e')) return 'virtuals';

  // 5. Heuristic: Uniswap V3/V4 on Base, recent (<7d), = most likely Clanker
  const dexId = (pair?.dexId || '').toLowerCase();
  if (dexId === 'uniswap' || dexId.includes('uniswap')) {
    const created = pair?.pairCreatedAt ? new Date(pair.pairCreatedAt).getTime() : 0;
    const hoursOld = (Date.now() - created) / 3600000;
    const liq = parseFloat(pair?.liquidity?.usd || 0);
    if (hoursOld > 0 && hoursOld < 168 && liq < 500000) {
      return 'clanker';
    }
  }

  // 6. Aerodrome pairs = "Other" (not a launchpad, just a DEX)
  if (dexId === 'aerodrome') return 'other';

  return 'other';
}

function enrichToken(pair, profile) {
  const launchpad = identifyLaunchpad(pair, profile);
  const lpMeta = LAUNCHPADS[launchpad] || (launchpad === 'likely-clanker' ? LAUNCHPADS.clanker : null);

  // Socials from both pair info and profile
  const pairSocials = (pair?.info?.socials || []).reduce((acc, s) => {
    const t = (s.type || '').toLowerCase();
    if (t === 'twitter' && !acc.twitter) acc.twitter = s.url || s.handle;
    if (t === 'telegram' && !acc.telegram) acc.telegram = s.url;
    if (t === 'website' && !acc.website) acc.website = s.url;
    return acc;
  }, {});

  const profileLinks = (profile?.links || []).reduce((acc, l) => {
    const t = (l.type || l.label || '').toLowerCase();
    if ((t === 'twitter' || t === 'x') && !acc.twitter) acc.twitter = l.url;
    if (t === 'telegram' && !acc.telegram) acc.telegram = l.url;
    if (t === 'website' && !acc.website) acc.website = l.url;
    return acc;
  }, {});

  const socials = { ...profileLinks, ...pairSocials };

  return {
    address: pair?.baseToken?.address || '',
    name: pair?.baseToken?.name || profile?.name || 'Unknown',
    symbol: pair?.baseToken?.symbol || '???',
    chain: 'Base',
    chainId: 'base',
    priceUsd: pair?.priceUsd || '0',
    priceChange24h: pair?.priceChange?.h24 || null,
    priceChange1h: pair?.priceChange?.h1 || null,
    priceChange5m: pair?.priceChange?.m5 || null,
    marketCap: pair?.marketCap || null,
    fdv: pair?.fdv || null,
    liquidityUsd: pair?.liquidity?.usd || 0,
    volume24h: pair?.volume?.h24 || null,
    volume1h: pair?.volume?.h1 || null,
    txns24h: pair?.txns?.h24?.buys + pair?.txns?.h24?.sells || null,
    buys24h: pair?.txns?.h24?.buys || null,
    sells24h: pair?.txns?.h24?.sells || null,
    dex: pair?.dexId || 'unknown',
    pairAddress: pair?.pairAddress || '',
    pairCreatedAt: pair?.pairCreatedAt || null,
    age: age(pair?.pairCreatedAt),
    ageSeconds: pair?.pairCreatedAt ? Math.floor((Date.now() - new Date(pair.pairCreatedAt).getTime()) / 1000) : null,
    image: profile?.imageUrl || profile?.icon ||
      (profile?.links || []).find(l => (l.type || '').toLowerCase() === 'image')?.url ||
      pair?.info?.imageUrl || pair?.info?.image || null,
    description: profile?.description || '',
    website: socials.website || profile?.url || '',
    twitter: socials.twitter || '',
    telegram: socials.telegram || '',
    launchpad,
    launchpadName: lpMeta?.name || null,
    launchpadUrl: lpMeta?.url || null,
    launchpadConfidence: launchpad === 'likely-clanker' ? 'medium' : (lpMeta ? 'high' : 'low'),
    url: pair?.pairAddress ? `https://dexscreener.com/base/${pair.pairAddress}` : `https://dexscreener.com/base/${pair?.baseToken?.address}`,
    basescanUrl: `https://basescan.org/token/${pair?.baseToken?.address}`,
  };
}

function scoreToken(t) {
  let score = 0;
  const liq = parseFloat(t.liquidityUsd) || 0;
  const vol = parseFloat(t.volume24h) || 0;
  const secs = t.ageSeconds;
  if (secs !== null) {
    if (secs < 300) score += 200;
    else if (secs < 900) score += 130;
    else if (secs < 3600) score += 70;
    else if (secs < 86400) score += 20;
  }
  if (liq > 100000) score += 40;
  else if (liq > 10000) score += 25;
  else if (liq > 1000) score += 10;
  if (vol > 500000) score += 25;
  else if (vol > 50000) score += 12;
  if (t.launchpad !== 'unknown') score += 20;
  if (t.twitter) score += 15;
  if (t.website) score += 8;
  if (t.image) score += 8;
  return score;
}

// ══════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ══════════════════════════════════════════════════════════════════════

async function fetchJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}

async function fetchTokenProfiles() {
  const data = await fetchJSON(`${DEX_API}/token-profiles/latest/v1`);
  return (data || []).filter(p => p.chainId === 'base');
}

async function fetchPairsForAddresses(addresses) {
  if (!addresses.length) return [];
  const data = await fetchJSON(`${DEX_API}/latest/dex/tokens/${addresses.join(',')}`);
  return (data?.pairs || []).filter(p => p.chainId === 'base');
}

async function fetchSearchResults(query) {
  const data = await fetchJSON(`${DEX_API}/latest/dex/search?q=${encodeURIComponent(query + ' base')}`);
  return (data?.pairs || []).filter(p => p.chainId === 'base');
}

async function fetchNewPools(page = 1) {
  const data = await fetchJSON(`${GECKO_API}/networks/base/new_pools?include=base_token&page=${page}`, 10000);
  if (!data?.data) return [];
  return data.data.map(p => ({
    poolAddress: p.id?.split('_').pop() || '',
    tokenAddress: p.relationships?.base_token?.data?.id?.split('_').pop() || '',
    tokenName: p.attributes?.name || '',
    tokenSymbol: '',
    createdAt: p.attributes?.pool_created_at || null,
    dexType: p.attributes?.dex_type || '',
  }));
}

async function fetchTrendingPools() {
  const data = await fetchJSON(`${GECKO_API}/networks/base/pools?include=base_token&page=1`, 10000);
  if (!data?.data) return [];
  return data.data.map(p => ({
    poolAddress: p.id?.split('_').pop() || '',
    tokenAddress: p.relationships?.base_token?.data?.id?.split('_').pop() || '',
    tokenName: p.attributes?.name || '',
    tokenSymbol: '',
    createdAt: p.attributes?.pool_created_at || null,
    dexType: p.attributes?.dex_type || '',
  }));
}

async function refreshCache() {
  console.log('Refreshing...');
  try {
    // 1. Fetch new pools from GeckoTerminal (pages 1-5 = up to 100 new tokens)
    const allPools = [];
    for (let page = 1; page <= 5; page++) {
      const pools = await fetchNewPools(page);
      if (!pools.length) break;
      allPools.push(...pools);
    }
    console.log(`  GeckoTerminal new pools: ${allPools.length}`);

    // 1b. Also fetch trending pools (established/older tokens)
    const trendingPools = await fetchTrendingPools();
    const existingAddrs = new Set(allPools.map(p => p.tokenAddress.toLowerCase()));
    for (const tp of trendingPools) {
      if (!existingAddrs.has(tp.tokenAddress.toLowerCase())) {
        allPools.push(tp);
      }
    }
    console.log(`  GeckoTerminal trending pools: ${trendingPools.length} (${allPools.length} total unique)`);

    // 2. Get DEX Screener pair data for these tokens (enriches with price, volume, socials)
    const tokenAddrs = [...new Set(allPools.map(p => p.tokenAddress).filter(Boolean))];
    console.log(`  Unique tokens: ${tokenAddrs.length}`);

    const pairDataMap = new Map();
    for (let i = 0; i < tokenAddrs.length; i += 5) {
      const batch = tokenAddrs.slice(i, i + 5);
      const pairs = await fetchPairsForAddresses(batch);
      for (const p of pairs) {
        const addr = (p.baseToken?.address || '').toLowerCase();
        if (addr && !pairDataMap.has(addr)) pairDataMap.set(addr, p);
      }
    }

    // 3. Also get token profiles for social links
    const profiles = await fetchTokenProfiles();
    const profileMap = new Map();
    for (const p of profiles) profileMap.set((p.tokenAddress || '').toLowerCase(), p);

    // 4. Build enriched tokens
    const fresh = [];
    for (const pool of allPools) {
      const addr = pool.tokenAddress.toLowerCase();
      const pair = pairDataMap.get(addr);
      const profile = profileMap.get(addr);
      if (pair) {
        fresh.push(enrichToken(pair, profile));
      } else {
        // Fallback: minimal token from pool data
        fresh.push({
          address: pool.tokenAddress,
          name: pool.tokenName || 'Unknown',
          symbol: '???',
          chain: 'Base',
          chainId: 'base',
          priceUsd: '0',
          priceChange24h: null,
          marketCap: null,
          fdv: null,
          liquidityUsd: 0,
          volume24h: null,
          dex: pool.dexType || 'unknown',
          pairAddress: pool.poolAddress,
          pairCreatedAt: pool.createdAt,
          age: age(pool.createdAt),
          ageSeconds: pool.createdAt ? Math.floor((Date.now() - new Date(pool.createdAt).getTime()) / 1000) : null,
          image: null,
          description: '',
          website: '',
          twitter: '',
          telegram: '',
          launchpad: 'other',
          launchpadName: null,
          launchpadUrl: null,
          launchpadConfidence: 'low',
          url: `https://dexscreener.com/base/${pool.poolAddress}`,
          basescanUrl: `https://basescan.org/token/${pool.tokenAddress}`,
        });
      }
    }
    console.log(`  Fresh tokens: ${fresh.length}`);

    // 5. Broader search: pull from DEX Screener with varied queries to catch more tokens
    const searchQueries = ['base', 'token', 'coin', 'eth', 'usdc', 'ai', 'defi'];
    for (const q of searchQueries) {
      const searchPairs = await fetchSearchResults(q);
      for (const p of searchPairs) {
        const addr = (p.baseToken?.address || '').toLowerCase();
        if (addr && !fresh.find(t => t.address.toLowerCase() === addr)) {
          fresh.push(enrichToken(p, null));
        }
      }
    }
    console.log(`  After DEX searches: ${fresh.length}`);

    // 5b. Add Base token profiles not yet in cache (includes older tokens with logos)
    const allProfiles = await fetchTokenProfiles();
    const freshAddrs = new Set(fresh.map(t => t.address.toLowerCase()));
    const cachedAddrs = new Set(cache.data.map(t => t.address.toLowerCase()));
    const newProfiles = allProfiles.filter(p => {
      const a = (p.tokenAddress || '').toLowerCase();
      return a && !freshAddrs.has(a) && !cachedAddrs.has(a);
    });
    if (newProfiles.length > 0) {
      console.log(`  Fetching pairs for ${newProfiles.length} new profiles...`);
      // Batch fetch pairs (5 addresses per call)
      const addrs = newProfiles.map(p => p.tokenAddress);
      const pairMap = new Map();
      for (let i = 0; i < addrs.length; i += 5) {
        const batch = addrs.slice(i, i + 5);
        const pairs = await fetchPairsForAddresses(batch);
        for (const p of pairs) {
          pairMap.set((p.baseToken?.address || '').toLowerCase(), p);
        }
      }
      for (const profile of newProfiles) {
        const addr = (profile.tokenAddress || '').toLowerCase();
        const pair = pairMap.get(addr);
        if (pair || profile.name) {
          fresh.push(enrichToken(pair || { baseToken: { address: profile.tokenAddress, name: profile.name, symbol: profile.symbol || '???' } }, profile));
        }
      }
    }
    console.log(`  After token profiles: ${fresh.length}`);

    // 6. Merge with existing cache
    const merged = new Map();
    for (const t of cache.data) merged.set(t.address.toLowerCase(), t);
    for (const t of fresh) {
      const key = t.address.toLowerCase();
      if (merged.has(key)) {
        merged.set(key, { ...merged.get(key), ...t });
      } else {
        merged.set(key, t);
      }
    }

    const all = [...merged.values()];
    all.sort((a, b) => scoreToken(b) - scoreToken(a));

    cache = { data: all.slice(0, MAX_TOKENS), updated: Date.now() };
    saveCacheToDisk();
    console.log(`  Cache: ${cache.data.length} tokens`);
  } catch (e) { console.error('Refresh error:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════
// SECURITY (GoPlus)
// ══════════════════════════════════════════════════════════════════════

async function checkTokenSecurity(address) {
  const key = address.toLowerCase();
  if (securityCache[key] && (Date.now() - securityCache[key].ts < 300000)) {
    return securityCache[key].data;
  }

  try {
    const data = await fetchJSON(`${GOPLUS_API}?contract_addresses=${address}`, 8000);
    if (!data || data.code !== 1) return null;

    const result = data.result?.[address.toLowerCase()];
    if (!result) return null;

    const sec = {
      isHoneypot: result.is_honeypot === '1',
      isBlacklisted: result.is_blacklisted === '1',
      isOpenSource: result.is_open_source === '1',
      buyTax: result.buy_tax || '0',
      sellTax: result.sell_tax || '0',
      cannotBuy: result.cannot_buy === '1',
      cannotSellAll: result.cannot_sell_all === '1',
      holderCount: result.holder_count || '0',
      totalSupply: result.total_supply || '0',
      ownerAddress: result.owner_address || '',
      isRenounced: result.is_owner_renounced === '1',
      creatorAddress: result.creator_address || '',
      hasBlacklist: result.is_blacklisted === '1',
      hasWhitelist: result.is_whitelisted === '1',
      canMint: result.can_mint === '1',
      isProxy: result.is_proxy === '1',
      lpHolderCount: result.lp_holder_count || '0',
      lpTotalSupply: result.lp_total_supply || '0',
      riskLevel: 'low',
      riskFlags: [],
    };

    // Risk assessment
    if (sec.isHoneypot) { sec.riskLevel = 'critical'; sec.riskFlags.push('HONEYPOT: Cannot sell'); }
    if (parseFloat(sec.sellTax) > 10) { sec.riskLevel = 'high'; sec.riskFlags.push(`SELL TAX: ${sec.sellTax}%`); }
    if (parseFloat(sec.buyTax) > 10) { sec.riskLevel = sec.riskLevel === 'low' ? 'medium' : sec.riskLevel; sec.riskFlags.push(`BUY TAX: ${sec.buyTax}%`); }
    if (sec.cannotBuy) { sec.riskLevel = 'critical'; sec.riskFlags.push('BUY DISABLED'); }
    if (!sec.isRenounced && !sec.ownerAddress.match(/^0x0+$/)) { if (sec.riskLevel === 'low') sec.riskLevel = 'medium'; sec.riskFlags.push('OWNER NOT RENOUNCED'); }
    if (sec.canMint) { sec.riskLevel = 'high'; sec.riskFlags.push('CAN MINT NEW TOKENS'); }
    if (sec.isProxy) { sec.riskLevel = sec.riskLevel === 'low' ? 'medium' : sec.riskLevel; sec.riskFlags.push('PROXY CONTRACT'); }
    if (sec.hasBlacklist) { sec.riskLevel = 'high'; sec.riskFlags.push('HAS BLACKLIST'); }
    if (!sec.isOpenSource) { sec.riskFlags.push('NOT OPEN SOURCE'); }

    score: if (sec.riskLevel === 'critical') sec.riskScore = 100;
    else if (sec.riskLevel === 'high') sec.riskScore = 75;
    else if (sec.riskLevel === 'medium') sec.riskScore = 40;
    else sec.riskScore = 10;

    securityCache[key] = { data: sec, ts: Date.now() };
    return sec;
  } catch (e) {
    console.error('GoPlus error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// TRANSACTIONS (DEX Screener pair data)
// ══════════════════════════════════════════════════════════════════════

async function fetchPairDetail(pairAddress) {
  const key = pairAddress.toLowerCase();
  if (txCache[key] && (Date.now() - txCache[key].ts < 30000)) return txCache[key].data;

  try {
    const data = await fetchJSON(`${DEX_API}/latest/dex/pairs/base/${pairAddress}`, 8000);
    if (!data?.pair) return null;

    const pair = data.pair;
    const result = {
      pair,
      txns: pair.txns || {},
      volume: pair.volume || {},
      priceChange: pair.priceChange || {},
    };
    txCache[key] = { data: result, ts: Date.now() };
    return result;
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', uptime: Math.floor(process.uptime()),
    cacheSize: cache.data.length,
    cacheAge: Math.floor((Date.now() - cache.updated) / 1000),
    chain: 'Base',
    launchpads: Object.keys(LAUNCHPADS),
  });
});

// GET /v1/new-tokens
app.get('/v1/new-tokens', async (req, res) => {
  try {
    const launchpad = (req.query.launchpad || '').toLowerCase();
    const minLiquidity = parseFloat(req.query.minLiquidity) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const maxAge = req.query.maxAge || '';
    const groupBy = req.query.groupBy || ''; // 'launchpad' for grouped response
    let tokens = [...cache.data];

    if (launchpad === 'all-known') tokens = tokens.filter(t => t.launchpad !== 'unknown');
    else if (launchpad && LAUNCHPADS[launchpad]) tokens = tokens.filter(t => t.launchpad === launchpad);

    if (minLiquidity > 0) tokens = tokens.filter(t => parseFloat(t.liquidityUsd) >= minLiquidity);

    if (maxAge) {
      const msMap = { '5m': 300000, '15m': 900000, '1h': 3600000, '6h': 21600000, '24h': 86400000 };
      const maxMs = msMap[maxAge] || 86400000;
      tokens = tokens.filter(t => t.pairCreatedAt && (Date.now() - new Date(t.pairCreatedAt).getTime()) < maxMs);
    }

    // Group by launchpad if requested
    if (groupBy === 'launchpad') {
      const groups = {};
      for (const t of tokens) {
        const pad = t.launchpadName || t.launchpad || 'Unknown';
        if (!groups[pad]) groups[pad] = { name: pad, count: 0, tokens: [] };
        groups[pad].count++;
        groups[pad].tokens.push(t);
      }
      return res.json({
        ok: true,
        groups: Object.values(groups).sort((a, b) => b.count - a.count),
        total: tokens.length,
        meta: { cacheUpdated: new Date(cache.updated).toISOString(), cacheAge: Math.floor((Date.now() - cache.updated) / 1000), totalInCache: cache.data.length },
      });
    }

    const stats = { total: tokens.length, byLaunchpad: {}, totalLiquidity: 0, totalVolume24h: 0 };
    for (const t of tokens) {
      stats.byLaunchpad[t.launchpad] = (stats.byLaunchpad[t.launchpad] || 0) + 1;
      stats.totalLiquidity += parseFloat(t.liquidityUsd) || 0;
      stats.totalVolume24h += parseFloat(t.volume24h) || 0;
    }
    stats.totalLiquidity = stats.totalLiquidity.toFixed(2);
    stats.totalVolume24h = stats.totalVolume24h.toFixed(2);

    res.json({
      ok: true, data: tokens.slice(0, limit), stats,
      meta: { cacheUpdated: new Date(cache.updated).toISOString(), cacheAge: Math.floor((Date.now() - cache.updated) / 1000), totalInCache: cache.data.length },
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// GET /v1/token/:address — full detail with security + transactions
app.get('/v1/token/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase();

    // Check cache
    const cached = cache.data.find(t => t.address.toLowerCase() === address);
    let token = cached;

    if (!token) {
      const pairData = await fetchJSON(`${DEX_API}/latest/dex/tokens/${address}`);
      const pair = (pairData?.pairs || []).find(p => p.chainId === 'base') || (pairData?.pairs || [])[0];
      if (!pair) return res.json({ ok: false, error: 'Token not found' });
      token = enrichToken(pair, null);
    }

    // Get security score (GoPlus gives us creator_address for accurate launchpad detection)
    const security = await checkTokenSecurity(token.address);

    // Use creator address from GoPlus to accurately detect launchpad
    if (security?.creatorAddress) {
      const detected = detectLaunchpadFromCreator(security.creatorAddress);
      if (detected) {
        token = { ...token, launchpad: detected, launchpadName: LAUNCHPADS[detected]?.name || null, launchpadUrl: LAUNCHPADS[detected]?.url || null, launchpadConfidence: 'high' };
      } else {
        // If creator doesn't match known factories but token is on Uniswap Base, default to Clanker
        // (Clanker is the dominant launchpad and has 30+ factory versions we can't all track)
        const dexId = (token.dex || '').toLowerCase();
        if (dexId === 'uniswap') {
          token = { ...token, launchpad: 'clanker', launchpadName: 'Clanker', launchpadUrl: 'https://clanker.world', launchpadConfidence: 'medium' };
        }
      }
    }

    // Get pair detail (transactions, volume)
    const pairDetail = token.pairAddress ? await fetchPairDetail(token.pairAddress) : null;

    res.json({
      ok: true,
      data: {
        ...token,
        security,
        pairDetail: pairDetail ? {
          txns24hBuys: pairDetail.txns?.h24?.buys || 0,
          txns24hSells: pairDetail.txns?.h24?.sells || 0,
          txns1hBuys: pairDetail.txns?.h1?.buys || 0,
          txns1hSells: pairDetail.txns?.h1?.sells || 0,
          volume1h: pairDetail.volume?.h1 || 0,
          volume5m: pairDetail.volume?.m5 || 0,
          priceChange5m: pairDetail.priceChange?.m5 || null,
        } : null,
      },
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// GET /v1/launchpads
app.get('/v1/launchpads', (req, res) => {
  const pads = Object.entries(LAUNCHPADS).map(([key, val]) => ({
    id: key, ...val,
    tokenCount: cache.data.filter(t => t.launchpad === key).length,
  }));
  res.json({ ok: true, data: pads });
});

// ══════════════════════════════════════════════════════════════════════
// RATINGS (in-memory, per-token aggregate)
// ══════════════════════════════════════════════════════════════════════
// { address: { total: number, count: number } }
const ratings = {};

app.get('/v1/rating/:address', (req, res) => {
  const key = req.params.address.toLowerCase();
  const r = ratings[key];
  if (!r || r.count === 0) return res.json({ ok: true, data: { avg: 0, count: 0 } });
  res.json({ ok: true, data: { avg: parseFloat((r.total / r.count).toFixed(1)), count: r.count } });
});

app.post('/v1/rating/:address', express.json(), (req, res) => {
  const key = req.params.address.toLowerCase();
  const stars = parseInt(req.body.stars);
  if (!stars || stars < 1 || stars > 5) return res.json({ ok: false, error: 'Stars must be 1-5' });
  if (!ratings[key]) ratings[key] = { total: 0, count: 0 };
  ratings[key].total += stars;
  ratings[key].count += 1;
  const r = ratings[key];
  res.json({ ok: true, data: { avg: parseFloat((r.total / r.count).toFixed(1)), count: r.count } });
});

// Bulk ratings for multiple tokens
app.get('/v1/ratings', (req, res) => {
  const addrs = (req.query.addresses || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
  const result = {};
  for (const addr of addrs) {
    const r = ratings[addr];
    result[addr] = r && r.count > 0 ? { avg: parseFloat((r.total / r.count).toFixed(1)), count: r.count } : { avg: 0, count: 0 };
  }
  res.json({ ok: true, data: result });
});

// GET /v1/search — searches cache first, then DEX Screener live
app.get('/v1/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ ok: false, error: 'Query too short' });
  const ql = q.toLowerCase();

  // Search cache
  const cacheResults = cache.data.filter(t =>
    t.name.toLowerCase().includes(ql) || t.symbol.toLowerCase().includes(ql) || t.address.toLowerCase().includes(ql)
  );

  // Also search DEX Screener live + fetch token profiles for logos
  let dexResults = [];
  try {
    const searchData = await fetchJSON(`${DEX_API}/latest/dex/search?q=${encodeURIComponent(q)}`, 8000);
    if (searchData?.pairs) {
      const basePairs = searchData.pairs.filter(p => p.chainId === 'base');
      // Collect token addresses to batch-fetch profiles (logos, socials)
      const addrs = basePairs.map(p => p.baseToken?.address).filter(Boolean);
      const profiles = [];
      for (let i = 0; i < addrs.length; i += 5) {
        const batch = addrs.slice(i, i + 5);
        try {
          const profileData = await fetchJSON(`${DEX_API}/token-profiles/latest/v1`);
          if (profileData) {
            for (const addr of batch) {
              const p = profileData.find(x => (x.tokenAddress || '').toLowerCase() === addr.toLowerCase());
              if (p) profiles.push(p);
            }
          }
        } catch (e) { /* ignore */ }
      }
      const profileMap = new Map();
      for (const p of profiles) profileMap.set((p.tokenAddress || '').toLowerCase(), p);

      dexResults = basePairs.map(p => {
        const profile = profileMap.get((p.baseToken?.address || '').toLowerCase());
        return enrichToken(p, profile);
      }).filter(t => t.address);
    }
  } catch (e) { /* ignore */ }

  // Merge: cache first, then DEX results not in cache
  const cacheAddrs = new Set(cacheResults.map(t => t.address.toLowerCase()));
  const merged = [...cacheResults];
  for (const t of dexResults) {
    if (!cacheAddrs.has(t.address.toLowerCase())) {
      merged.push(t);
      cacheAddrs.add(t.address.toLowerCase());
    }
  }

  res.json({ ok: true, data: merged.slice(0, 30), total: merged.length, fromCache: cacheResults.length, fromDex: dexResults.length });
});

// GET /v1/ohlcv/:poolAddress — OHLCV candles from GeckoTerminal
app.get('/v1/ohlcv/:poolAddress', async (req, res) => {
  try {
    const pool = req.params.poolAddress;
    const timeframe = req.query.timeframe || 'minute';
    // GeckoTerminal pool IDs are "base_<address>"
    const poolId = pool.startsWith('base_') ? pool : `base_${pool}`;
    const data = await fetchJSON(
      `${GECKO_API}/networks/base/pools/${poolId}/ohlcv/${timeframe}?limit=100`,
      10000
    );
    if (!data?.data) return res.json({ ok: false, error: 'No OHLCV data' });

    const candles = data.data.map(c => ({
      time: new Date(c.attributes?.timestamp).getTime() / 1000,
      open: parseFloat(c.attributes?.open || 0),
      high: parseFloat(c.attributes?.high || 0),
      low: parseFloat(c.attributes?.low || 0),
      close: parseFloat(c.attributes?.close || 0),
      volume: parseFloat(c.attributes?.volume || 0),
    }));

    res.json({ ok: true, data: candles });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// GET /v1/stats
app.get('/v1/stats', async (req, res) => {
  const tokens = cache.data;
  const byLaunchpad = {};
  let totalLiq = 0, totalVol = 0;
  for (const t of tokens) {
    byLaunchpad[t.launchpad] = (byLaunchpad[t.launchpad] || 0) + 1;
    totalLiq += parseFloat(t.liquidityUsd) || 0;
    totalVol += parseFloat(t.volume24h) || 0;
  }
  const hotTokens = tokens.filter(t => t.pairCreatedAt && (Date.now() - new Date(t.pairCreatedAt).getTime()) < 3600000);
  res.json({
    ok: true, data: {
      totalTokens: tokens.length, totalLiquidity: totalLiq.toFixed(2), totalVolume24h: totalVol.toFixed(2),
      byLaunchpad, hotTokens: hotTokens.length,
      launchesToday: tokens.filter(t => t.pairCreatedAt && (Date.now() - new Date(t.pairCreatedAt).getTime()) < 86400000).length,
      lastUpdated: new Date(cache.updated).toISOString(),
    },
  });
});

// ══════════════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════════════

// Serve scanner frontend
app.use(express.static(require('path').join(__dirname, '..', 'gitblock')));

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  BASE TOKEN DETECTOR  v2.0                           ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}   |  Poll: 15s   |  Chain: Base L2        ║`);
  console.log(`║  Launchpads: ${Object.keys(LAUNCHPADS).join(', ')}`);
  console.log('║  Security: GoPlus  |  TX: BaseScan                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  refreshCache();
  setInterval(refreshCache, CACHE_TTL_MS);
});
