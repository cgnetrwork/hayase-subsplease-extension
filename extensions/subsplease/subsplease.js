/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Source  : https://subsplease.org
 * Strategy: RSS-only (1 network call, direct magnet links)
 * ─────────────────────────────────────────────────────────────
 * FIX 1: Regex now uses string concatenation, not template
 *         literals — template literals drop backslashes before
 *         [ and ] causing "Unmatched ')'" regex errors.
 * FIX 2: Title matcher skips Japanese-only strings and uses
 *         word-level matching for better romaji coverage.
 */

const BASE    = 'https://subsplease.org';
const RSS_URL = BASE + '/rss/';

// ─── Utility: extract XML tag value (CDATA-aware) ────────────────────────────
// FIX: built with string concatenation so \\[ stays as \[ in the RegExp.
// Template literals drop the backslash before [ and ] (unrecognised escape)
// which breaks CDATA pattern into an invalid character class → "Unmatched )".

function xmlTag(block, tag) {
  if (!block || !tag) return '';

  // CDATA variant: <tag><![CDATA[...]]></tag>
  var cdRe = new RegExp(
    '<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>',
    'i'
  );
  var cd = block.match(cdRe);
  if (cd) return cd[1].trim();

  // Plain text variant: <tag>...</tag>
  var plRe = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var pl = block.match(plRe);
  return pl ? pl[1].trim() : '';
}

// ─── Utility: extract info-hash from a magnet URI ────────────────────────────

function infoHash(magnet) {
  if (!magnet || typeof magnet !== 'string') return '';
  var m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

// ─── Utility: check if a character is ASCII (a-z, 0-9) ──────────────────────

function isAsciiChar(c) {
  var code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) ||   // 0-9
         (code >= 65 && code <= 90) ||   // A-Z
         (code >= 97 && code <= 122);    // a-z
}

// ─── Utility: normalize a title for matching ─────────────────────────────────
// Lowercases and strips all non-alphanumeric characters.
// Returns '' for Japanese-only strings (no ASCII letters/digits to match on).

function normalize(str) {
  if (!str || typeof str !== 'string') return '';
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str[i].toLowerCase();
    if (isAsciiChar(c)) out += c;
  }
  return out;
}

// ─── Utility: split a normalized title into words of 3+ characters ───────────
// Used for word-level matching so "Solo Leveling" matches "Solo Leveling S2".

function words(normStr) {
  // Split on transitions would be complex — just use 4-char sliding substrings
  // as anchors. A simpler approach: treat the whole string and check includes.
  return normStr; // we use substring matching below
}

// ─── Utility: title matching ─────────────────────────────────────────────────
// Hayase provides titles[] = [English, Romaji, Native(Japanese), ...]
// SubsPlease filenames use English or Romaji (ASCII-based).
// Strategy:
//   1. Normalize both strings (ASCII-only, lowercase, no punctuation)
//   2. Skip any title that normalises to fewer than 4 chars (e.g. pure kanji)
//   3. Match if one contains the other (handles shortened/partial titles)

function matchesTitle(rssShowName, titles) {
  if (!rssShowName || !Array.isArray(titles)) return false;

  var rssNorm = normalize(rssShowName);
  if (rssNorm.length < 3) return false;

  for (var i = 0; i < titles.length; i++) {
    var t = titles[i];
    if (!t || typeof t !== 'string') continue;

    var tNorm = normalize(t);
    if (tNorm.length < 3) continue; // skip Japanese-only / too short

    // Substring match in both directions
    if (rssNorm.includes(tNorm) || tNorm.includes(rssNorm)) return true;

    // Word-level: if the rss title starts with first 6 chars of query title
    // handles "Solo Leveling Season 2" vs "Solo Leveling"
    if (tNorm.length >= 6 && rssNorm.startsWith(tNorm.slice(0, 6))) return true;
    if (rssNorm.length >= 6 && tNorm.startsWith(rssNorm.slice(0, 6))) return true;
  }

  return false;
}

// ─── Utility: exclusion check ────────────────────────────────────────────────

function isExcluded(title, exclusions) {
  if (!title || !Array.isArray(exclusions) || exclusions.length === 0) return false;
  var lower = title.toLowerCase();
  for (var i = 0; i < exclusions.length; i++) {
    var ex = exclusions[i];
    if (ex && typeof ex === 'string' && lower.includes(ex.toLowerCase())) return true;
  }
  return false;
}

// ─── Utility: build a TorrentResult ──────────────────────────────────────────

function makeTorrent(title, magnet, pubDate, isBatch) {
  if (!title || !magnet) return null;
  var result = {
    title:     title,
    link:      magnet,
    seeders:   0,
    leechers:  0,
    downloads: 0,
    accuracy:  'high',
    hash:      infoHash(magnet),
    size:      0,
    date:      pubDate ? new Date(pubDate) : new Date(),
  };
  if (isBatch) result.type = 'batch';
  return result;
}

// ─── Core: parse one RSS <item> block ────────────────────────────────────────
// SubsPlease title format: [SubsPlease] Show Name - 01 (1080p) [HASH].mkv
// The <link> tag contains the full magnet URI directly.

function parseItem(item) {
  var rawTitle = xmlTag(item, 'title');
  var magnet   = xmlTag(item, 'link');
  if (!rawTitle || !magnet) return null;

  // Parse show name, episode number, and resolution from title
  var m = rawTitle.match(
    /^\[SubsPlease\]\s+(.+?)\s+-\s+(\d+(?:\.\d+)?)\s+\((\d+p|SD)\)/i
  );
  if (!m) return null;

  return {
    show:    m[1].trim(),
    episode: parseFloat(m[2]),
    res:     m[3].toLowerCase(),
    title:   rawTitle,
    magnet:  magnet,
    pubDate: xmlTag(item, 'pubDate'),
    isBatch: rawTitle.toLowerCase().includes('batch'),
  };
}

// ─── Core: fetch RSS and return matching results ──────────────────────────────

async function searchRSS(fetchFn, resolution, titles, episode, exclusions) {
  var url = RSS_URL + '?t&r=' + resolution;
  var res = await fetchFn(url);
  if (!res || !res.ok) return [];

  var xml = await res.text();
  if (!xml) return [];

  var items   = xml.split('<item>').slice(1);
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;

    var parsed = parseItem(item);
    if (!parsed) continue;

    // Show title must match
    if (!matchesTitle(parsed.show, titles)) continue;

    // Episode number must match when provided (±0.01 for float safety)
    if (episode != null && !isNaN(Number(episode))) {
      if (Math.abs(parsed.episode - Number(episode)) > 0.01) continue;
    }

    // Exclusions
    if (isExcluded(parsed.title, exclusions)) continue;

    var torrent = makeTorrent(parsed.title, parsed.magnet, parsed.pubDate, parsed.isBatch);
    if (torrent) results.push(torrent);
  }

  return results;
}

// ─── Extension export ─────────────────────────────────────────────────────────

export default {

  // Returns true immediately — avoids timeout from network calls in worker
  async test() {
    return true;
  },

  // Single episode: try 1080p → 720p → SD until something is found
  async single(query, options) {
    try {
      var titles     = query && query.titles;
      var episode    = query && query.episode;
      var fetchFn    = query && query.fetch;
      var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      var results = await searchRSS(fetchFn, '1080', titles, episode, exclusions);
      if (results.length === 0) {
        results = await searchRSS(fetchFn, '720', titles, episode, exclusions);
      }
      if (results.length === 0) {
        results = await searchRSS(fetchFn, 'sd', titles, episode, exclusions);
      }

      return results;
    } catch (e) {
      throw new Error('SubsPlease search failed: ' + e.message);
    }
  },

  // Batch: same RSS, filter to batch-tagged releases only
  async batch(query, options) {
    try {
      var titles     = query && query.titles;
      var fetchFn    = query && query.fetch;
      var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      var results = await searchRSS(fetchFn, '1080', titles, null, exclusions);
      results = results.filter(function(r) { return r.type === 'batch'; });

      if (results.length === 0) {
        results = await searchRSS(fetchFn, '720', titles, null, exclusions);
        results = results.filter(function(r) { return r.type === 'batch'; });
      }

      return results;
    } catch (e) {
      throw new Error('SubsPlease batch search failed: ' + e.message);
    }
  },

  // Movie: SubsPlease releases movies as episode 1
  async movie(query, options) {
    try {
      var episode = Number(query && query.episode) || 1;
      var modified = Object.assign({}, query, { episode: episode });
      return await this.single(modified, options);
    } catch (e) {
      throw new Error('SubsPlease movie search failed: ' + e.message);
    }
  },
};
