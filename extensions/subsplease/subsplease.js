/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Backend : Nyaa.si  (hosts every SubsPlease release)
 * Strategy: Search broadly by title → filter by episode locally
 *           This avoids the "no results" problem caused by
 *           exact query mismatches (episode padding, resolution).
 *
 * Previous failure modes fixed here:
 *  - Silent [] return replaced with throw so errors are visible
 *  - Search no longer includes episode/resolution in query
 *    (episode is matched locally against the returned titles)
 *  - XML tag regex rebuilt with string concat (not template
 *    literals) to avoid the CDATA "Unmatched )" crash
 *  - &amp; in Nyaa magnet links decoded to &
 */

var NYAA = 'https://nyaa.si/?page=rss&c=1_2&f=0&q=';

// ─── XML helpers ──────────────────────────────────────────────────────────────

// Extracts text from <tag>...</tag> or <tag><![CDATA[...]]></tag>.
// Uses string concat, NOT template literals — template literals drop
// the backslash from \[ and \] turning them into unescaped brackets,
// which breaks the character class and causes "Unmatched )" errors.
function xmlTag(block, tag) {
  if (!block || !tag) return '';
  var cdata = block.match(
    new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i')
  );
  if (cdata) return cdata[1].trim();
  var plain = block.match(
    new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i')
  );
  return plain ? plain[1].trim() : '';
}

// Decode &amp; → & so magnet URIs are valid.
function decodeAmp(str) {
  return str ? str.replace(/&amp;/g, '&') : str;
}

// ─── Magnet / size helpers ────────────────────────────────────────────────────

function infoHash(magnet) {
  if (!magnet) return '';
  var m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

function parseSize(str) {
  if (!str) return 0;
  var m = str.match(/([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB)/i);
  if (!m) return 0;
  var v = parseFloat(m[1]);
  var u = m[2].toUpperCase();
  if (u === 'GIB' || u === 'GB') return Math.round(v * 1073741824);
  if (u === 'MIB' || u === 'MB') return Math.round(v * 1048576);
  if (u === 'KIB' || u === 'KB') return Math.round(v * 1024);
  return 0;
}

// ─── Title helpers ────────────────────────────────────────────────────────────

// Returns true if the string is mostly non-ASCII (Japanese / Korean / etc.).
// We skip these when building search queries — Nyaa stores romaji/English.
function isNonAscii(str) {
  if (!str || str.length === 0) return true;
  var ascii = 0;
  for (var i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) ascii++;
  }
  return ascii < str.length * 0.5;
}

// Checks whether a Nyaa item title matches the requested episode.
// Handles:  "- 01 "  "- 1 "  "- 01."  "- 01v2 "  "- 01)"
function matchesEpisode(itemTitle, epNum) {
  var n   = Number(epNum);
  if (isNaN(n)) return false;
  var pad = String(Math.round(n)).padStart(2, '0');
  var raw = String(Math.round(n));

  // Build patterns: " - 01" followed by space / dot / v / )
  var endings = [' ', '.', 'v', ')'];
  for (var i = 0; i < endings.length; i++) {
    if (itemTitle.includes(' - ' + pad + endings[i])) return true;
    if (itemTitle.includes(' - ' + raw + endings[i])) return true;
  }

  // Also handle half-episodes like 12.5
  if (!Number.isInteger(n)) {
    var half = n.toFixed(1);
    if (itemTitle.includes(' - ' + half)) return true;
  }

  return false;
}

// ─── Nyaa fetch + parse ───────────────────────────────────────────────────────

// Fetches Nyaa RSS for a query string and returns all [SubsPlease] results.
// Throws a descriptive error if the network request fails — this surfaces
// useful info instead of silently returning [].
async function nyaaSearch(fetchFn, query) {
  var url = NYAA + encodeURIComponent(query);
  var res;

  try {
    res = await fetchFn(url);
  } catch (netErr) {
    throw new Error('Network error reaching Nyaa.si: ' + netErr.message);
  }

  if (!res || !res.ok) {
    throw new Error(
      'Nyaa.si returned HTTP ' + (res ? res.status : 'no response') +
      ' for query: ' + query
    );
  }

  var xml = await res.text();
  if (!xml || xml.length < 50) {
    throw new Error('Nyaa.si returned an empty response for query: ' + query);
  }

  var items   = xml.split('<item>').slice(1);
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;

    var title = xmlTag(item, 'title');
    if (!title || !title.includes('[SubsPlease]')) continue;

    // <nyaa:magnetLink> holds the magnet URI — decode HTML entities
    var magnet = decodeAmp(xmlTag(item, 'nyaa:magnetLink'));
    if (!magnet || !magnet.startsWith('magnet:')) continue;

    var hash     = xmlTag(item, 'nyaa:infoHash') || infoHash(magnet);
    var seeders  = parseInt(xmlTag(item, 'nyaa:seeders'),  10) || 0;
    var leechers = parseInt(xmlTag(item, 'nyaa:leechers'), 10) || 0;
    var dls      = parseInt(xmlTag(item, 'nyaa:downloads'),10) || 0;
    var size     = parseSize(xmlTag(item, 'nyaa:size'));
    var pubDate  = xmlTag(item, 'pubDate');

    results.push({
      title:     title,
      link:      magnet,
      seeders:   seeders,
      leechers:  leechers,
      downloads: dls,
      accuracy:  'high',
      hash:      hash,
      size:      size,
      date:      pubDate ? new Date(pubDate) : new Date(),
    });
  }

  return results;
}

// ─── Title iteration helper ───────────────────────────────────────────────────

// Tries each title variant (skipping Japanese) and calls searchFn(title).
// Returns the first non-empty result array, or [] if all fail.
// Limits to 3 attempts so we never exceed the 10 s timeout.
async function withTitles(titles, searchFn) {
  var tried = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = titles[i];
    if (!t || typeof t !== 'string') continue;
    if (isNonAscii(t)) continue;
    if (tried >= 3) break;
    tried++;

    var results = await searchFn(t);
    if (results.length > 0) return results;
  }
  return [];
}

// ─── Extension export ─────────────────────────────────────────────────────────

export default {

  // Health check — returns true immediately.
  // A network-based test would time out in some Hayase environments.
  async test() {
    return true;
  },

  // Single episode search.
  // Queries Nyaa by show title only, then filters by episode number locally.
  async single(query, options) {
    var titles     = query && query.titles;
    var episode    = query && query.episode;
    var fetchFn    = query && query.fetch;
    var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

    if (typeof fetchFn !== 'function') {
      throw new Error('Hayase did not provide a fetch function.');
    }
    if (!Array.isArray(titles) || titles.length === 0) {
      throw new Error('No titles provided in query.');
    }

    // Build search: "[SubsPlease] Show Title" — no episode, no resolution.
    // Nyaa returns all episodes for the show; we filter locally below.
    return withTitles(titles, async function(title) {
      var all = await nyaaSearch(fetchFn, '[SubsPlease] ' + title);

      // Keep only the requested episode
      var ep = all.filter(function(r) {
        return matchesEpisode(r.title, episode);
      });

      // Apply exclusions
      var excl = exclusions;
      ep = ep.filter(function(r) {
        for (var i = 0; i < excl.length; i++) {
          if (excl[i] && r.title.toLowerCase().includes(excl[i].toLowerCase())) return false;
        }
        return true;
      });

      return ep;
    });
  },

  // Batch / full-season search.
  async batch(query, options) {
    var titles     = query && query.titles;
    var fetchFn    = query && query.fetch;
    var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

    if (typeof fetchFn !== 'function') {
      throw new Error('Hayase did not provide a fetch function.');
    }
    if (!Array.isArray(titles) || titles.length === 0) {
      throw new Error('No titles provided in query.');
    }

    return withTitles(titles, async function(title) {
      var all = await nyaaSearch(fetchFn, '[SubsPlease] ' + title + ' Batch');

      // Only keep items that say "Batch" in their title
      var batch = all.filter(function(r) {
        return r.title.toLowerCase().includes('batch');
      });

      // Tag as batch type and apply exclusions
      var excl = exclusions;
      batch = batch.filter(function(r) {
        for (var i = 0; i < excl.length; i++) {
          if (excl[i] && r.title.toLowerCase().includes(excl[i].toLowerCase())) return false;
        }
        return true;
      });
      batch.forEach(function(r) { r.type = 'batch'; });

      return batch;
    });
  },

  // Movie search — same as single with episode defaulting to 1.
  async movie(query, options) {
    var episode  = Number(query && query.episode) || 1;
    var modified = Object.assign({}, query, { episode: episode });
    return this.single(modified, options);
  },
};
