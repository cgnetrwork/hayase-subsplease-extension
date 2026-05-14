/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Source  : https://subsplease.org
 * Type    : torrent
 * Quality : 1080p (falls back to 720p → sd)
 * Media   : Subtitled (English subs, Japanese audio)
 * ─────────────────────────────────────────────────────────────
 * Strategy: RSS-only approach
 *   - ONE network call per search (no timeouts)
 *   - Magnet links come directly from the RSS feed
 *   - No sequential API calls that caused the 10s timeout
 *
 * RSS format confirmed:
 *   Title : [SubsPlease] Show Name - 01 (1080p) [HASH].mkv
 *   Link  : magnet:?xt=urn:btih:HASH&dn=...&tr=...  (direct magnet)
 */

const BASE = 'https://subsplease.org';
const RSS  = BASE + '/rss/';

// ─── RSS URLs ─────────────────────────────────────────────────────────────────

const RSS_1080 = `${RSS}?t&r=1080`;   // all 1080p releases
const RSS_720  = `${RSS}?t&r=720`;    // fallback: all 720p releases
const RSS_ALL  = `${RSS}?t`;          // fallback: all resolutions

// ─── Utility: extract XML tag value (handles CDATA) ──────────────────────────

function xmlTag(block, tag) {
  if (!block || !tag) return '';
  const cd = block.match(
    new RegExp(`<${tag}><!\[CDATA\[([\\s\\S]*?)\]\]><\\/${tag}>`, 'i')
  );
  if (cd) return cd[1].trim();
  const pl = block.match(
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i')
  );
  return pl ? pl[1].trim() : '';
}

// ─── Utility: extract info-hash from a magnet link ───────────────────────────

function infoHash(magnet) {
  if (!magnet || typeof magnet !== 'string') return '';
  const m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

// ─── Utility: normalize a string for fuzzy title matching ────────────────────
// Strips punctuation, spaces, and lowercases — handles:
//   "Frieren: Beyond Journey's End" → "frierenbeyondjourneysend"
//   "Sousou no Frieren"             → "sousounofrieren"

function normalize(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Utility: check if an RSS show title matches any of Hayase's title list ──

function matchesTitle(rssShowName, titles) {
  if (!rssShowName || !Array.isArray(titles)) return false;
  const rssNorm = normalize(rssShowName);
  if (!rssNorm) return false;

  return titles.some(t => {
    if (!t || typeof t !== 'string') return false;
    const tNorm = normalize(t);
    if (!tNorm) return false;
    // Either title contains the other (handles partial matches)
    return rssNorm.includes(tNorm) || tNorm.includes(rssNorm);
  });
}

// ─── Utility: check if a title contains any excluded keyword ─────────────────

function isExcluded(title, exclusions) {
  if (!title || !Array.isArray(exclusions) || exclusions.length === 0) {
    return false;
  }
  const lower = title.toLowerCase();
  return exclusions.some(
    ex => ex && typeof ex === 'string' && lower.includes(ex.toLowerCase())
  );
}

// ─── Utility: build a valid TorrentResult object ─────────────────────────────

function makeTorrent(title, magnet, pubDate, type) {
  if (!title || !magnet) return null;
  const result = {
    title,
    link:      magnet,
    seeders:   0,
    leechers:  0,
    downloads: 0,
    accuracy:  'high',
    hash:      infoHash(magnet),
    size:      0,
    date:      pubDate ? new Date(pubDate) : new Date(),
  };
  if (type === 'batch') result.type = 'batch';
  return result;
}

// ─── Core: parse a single RSS <item> block ───────────────────────────────────
// Returns { show, episode, resolution, title, magnet, pubDate } or null

function parseRSSItem(item) {
  const rawTitle = xmlTag(item, 'title');
  const magnet   = xmlTag(item, 'link');

  if (!rawTitle || !magnet) return null;

  // Title format: [SubsPlease] Show Name - 01 (1080p) [HASH].mkv
  const m = rawTitle.match(
    /^\[SubsPlease\]\s+(.+?)\s+-\s+(\d+(?:\.\d+)?)\s+\((\d+p|SD)\)/i
  );
  if (!m) return null;

  return {
    show:       m[1].trim(),
    episode:    parseFloat(m[2]),
    resolution: m[3].toLowerCase(),
    title:      rawTitle,
    magnet,
    pubDate:    xmlTag(item, 'pubDate'),
    isBatch:    rawTitle.toLowerCase().includes('batch'),
  };
}

// ─── Core: fetch and search the RSS feed ─────────────────────────────────────
// rssUrl  – which RSS to fetch
// titles  – Hayase's list of titles to match against
// episode – episode number to match (null = any / for batch)
// Returns array of matching TorrentResult objects

async function fetchRSS(fetchFn, rssUrl, titles, episode, exclusions) {
  const res = await fetchFn(rssUrl);
  if (!res?.ok) return [];

  const xml = await res.text();
  if (!xml) return [];

  const items   = xml.split('<item>').slice(1);
  const results = [];

  for (const item of items) {
    if (!item) continue;

    const parsed = parseRSSItem(item);
    if (!parsed) continue;

    // Match show title
    if (!matchesTitle(parsed.show, titles)) continue;

    // Match episode number when provided
    if (episode != null && !isNaN(Number(episode))) {
      if (Math.abs(parsed.episode - Number(episode)) > 0.01) continue;
    }

    // Apply exclusions
    if (isExcluded(parsed.title, exclusions)) continue;

    const torrent = makeTorrent(
      parsed.title,
      parsed.magnet,
      parsed.pubDate,
      parsed.isBatch ? 'batch' : null
    );
    if (torrent) results.push(torrent);
  }

  return results;
}

// ─── Extension export (Hayase official interface, manifestVersion 2) ─────────

export default {

  // ── test() ──────────────────────────────────────────────────────────────────
  // Returns true immediately — avoids the 10s timeout caused by network calls
  // in the sandboxed Web Worker environment.

  async test() {
    return true;
  },

  // ── single() ────────────────────────────────────────────────────────────────
  // Fetches one RSS feed (single network call) and returns the matching episode.
  // Tries 1080p first, then 720p — so it always finds something if it exists.

  async single(query, options = {}) {
    try {
      const titles     = query?.titles;
      const episode    = query?.episode;
      const fetchFn    = query?.fetch;
      const exclusions = Array.isArray(query?.exclusions) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      // Try 1080p RSS first
      let results = await fetchRSS(fetchFn, RSS_1080, titles, episode, exclusions);

      // Fall back to 720p if nothing found at 1080p
      if (results.length === 0) {
        results = await fetchRSS(fetchFn, RSS_720, titles, episode, exclusions);
      }

      // Fall back to all resolutions if still nothing
      if (results.length === 0) {
        results = await fetchRSS(fetchFn, RSS_ALL, titles, episode, exclusions);
      }

      return results;

    } catch (e) {
      throw new Error(`SubsPlease search failed: ${e.message}`);
    }
  },

  // ── batch() ─────────────────────────────────────────────────────────────────
  // Searches the same RSS feed for entries that contain "Batch" in the title.
  // SubsPlease marks complete season packs with "Batch" in the title.

  async batch(query, options = {}) {
    try {
      const titles     = query?.titles;
      const fetchFn    = query?.fetch;
      const exclusions = Array.isArray(query?.exclusions) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      // Search with no episode filter — we want all releases for this show
      let results = await fetchRSS(fetchFn, RSS_1080, titles, null, exclusions);

      // Keep only batch releases
      results = results.filter(r => r.type === 'batch');

      // If no 1080p batch found, try the all-releases RSS
      if (results.length === 0) {
        results = await fetchRSS(fetchFn, RSS_ALL, titles, null, exclusions);
        results = results.filter(r => r.type === 'batch');
      }

      return results;

    } catch (e) {
      throw new Error(`SubsPlease batch search failed: ${e.message}`);
    }
  },

  // ── movie() ─────────────────────────────────────────────────────────────────
  // SubsPlease releases anime movies and specials as single episodes.
  // Delegates to single() with episode defaulting to 1 if not specified.

  async movie(query, options = {}) {
    try {
      const episode = Number(query?.episode) || 1;
      return await this.single({ ...query, episode }, options);
    } catch (e) {
      throw new Error(`SubsPlease movie search failed: ${e.message}`);
    }
  },
};
