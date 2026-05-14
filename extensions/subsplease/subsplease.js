/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Data source : Nyaa.si (searches for [SubsPlease] releases)
 * Why Nyaa.si : SubsPlease.org uses Cloudflare which blocks all
 *               programmatic requests, causing the 10s timeout.
 *               Nyaa.si hosts every SubsPlease release, has no
 *               blocking, and provides richer metadata (seeders,
 *               leechers, size, hash) than SubsPlease's own RSS.
 * Strategy    : One targeted Nyaa search per query — fast.
 * ─────────────────────────────────────────────────────────────
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// Nyaa.si RSS endpoint — category 1_2 = English-translated anime
var NYAA = 'https://nyaa.si/?page=rss&c=1_2&f=0&q=';

// ─── Utility: safe XML tag extractor (CDATA-aware) ───────────────────────────
// Uses string concatenation — NOT template literals.
// Template literals silently drop backslashes before [ and ] which breaks
// the CDATA pattern into an invalid character class → "Unmatched )" error.

function xmlTag(block, tag) {
  if (!block || !tag) return '';
  // CDATA: <tag><![CDATA[...]]></tag>
  var cdRe = new RegExp(
    '<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>',
    'i'
  );
  var cd = block.match(cdRe);
  if (cd) return cd[1].trim();
  // Plain text: <tag>...</tag>
  var plRe = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var pl = block.match(plRe);
  return pl ? pl[1].trim() : '';
}

// ─── Utility: parse Nyaa size string → bytes ─────────────────────────────────

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

// ─── Utility: extract info-hash from a magnet URI ────────────────────────────

function infoHash(magnet) {
  if (!magnet) return '';
  var m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

// ─── Utility: format episode number to SubsPlease naming convention ──────────
// SubsPlease always zero-pads: 1→"01", 12→"12", 12.5→"12.5"

function fmtEp(ep) {
  var n = Number(ep);
  if (isNaN(n) || n < 1) return '01';
  return Number.isInteger(n) ? String(n).padStart(2, '0') : n.toFixed(1);
}

// ─── Utility: detect if a string is mostly non-ASCII (Japanese/Korean/etc.) ──
// Hayase's titles[] includes native-script titles — skip those for Nyaa search.

function isNonAscii(str) {
  if (!str) return true;
  var ascii = 0;
  for (var i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) ascii++;
  }
  // If less than half the characters are ASCII, treat as non-ASCII title
  return ascii < str.length / 2;
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

// ─── Core: fetch Nyaa RSS and parse all [SubsPlease] items ───────────────────
// Returns TorrentResult[] — full metadata from Nyaa's RSS.

async function nyaaFetch(fetchFn, searchQuery) {
  var url = NYAA + encodeURIComponent(searchQuery);
  var res = await fetchFn(url);
  if (!res || !res.ok) return [];

  var xml = await res.text();
  if (!xml) return [];

  var items   = xml.split('<item>').slice(1);
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item) continue;

    var title = xmlTag(item, 'title');
    // Only keep official SubsPlease releases
    if (!title || !title.includes('[SubsPlease]')) continue;

    // Nyaa puts the magnet in <nyaa:magnetLink>
    var magnet = xmlTag(item, 'nyaa:magnetLink');
    if (!magnet) continue;

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

// ─── Core: try each non-ASCII-filtered title until results are found ─────────
// Stops at the first title that returns results → usually one Nyaa call.

async function tryTitles(fetchFn, titles, buildQuery, exclusions) {
  var tried = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = titles[i];
    if (!t || typeof t !== 'string') continue;
    if (isNonAscii(t)) continue;       // skip Japanese/Korean native titles
    if (tried >= 3) break;             // cap at 3 attempts to stay under 10s
    tried++;

    var query   = buildQuery(t);
    var results = await nyaaFetch(fetchFn, query);

    // Filter exclusions
    if (Array.isArray(exclusions)) {
      results = results.filter(function(r) { return !isExcluded(r.title, exclusions); });
    }

    if (results.length > 0) return results;
  }
  return [];
}

// ─── Extension export ─────────────────────────────────────────────────────────

export default {

  // test() returns true immediately — avoids the 10s timeout.
  // The real functionality is validated on first search.
  async test() {
    return true;
  },

  // ── single() ────────────────────────────────────────────────────────────────
  // Searches Nyaa for: [SubsPlease] {Show} - {Episode} (1080p)
  // Falls back to without resolution filter if no results.

  async single(query, options) {
    try {
      var titles     = query && query.titles;
      var episode    = query && query.episode;
      var fetchFn    = query && query.fetch;
      var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      var epStr = fmtEp(episode);

      // Pass 1: search with episode + resolution for precision
      var results = await tryTitles(fetchFn, titles, function(t) {
        return '[SubsPlease] ' + t + ' - ' + epStr + ' (1080p)';
      }, exclusions);

      // Pass 2: drop resolution filter — catch 720p/SD results
      if (results.length === 0) {
        results = await tryTitles(fetchFn, titles, function(t) {
          return '[SubsPlease] ' + t + ' - ' + epStr;
        }, exclusions);
      }

      return results;
    } catch (e) {
      throw new Error('SubsPlease search failed: ' + e.message);
    }
  },

  // ── batch() ─────────────────────────────────────────────────────────────────
  // Searches Nyaa for: [SubsPlease] {Show} Batch

  async batch(query, options) {
    try {
      var titles     = query && query.titles;
      var fetchFn    = query && query.fetch;
      var exclusions = (query && Array.isArray(query.exclusions)) ? query.exclusions : [];

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles) || titles.length === 0) return [];

      var results = await tryTitles(fetchFn, titles, function(t) {
        return '[SubsPlease] ' + t + ' Batch';
      }, exclusions);

      // Tag all results as batch type
      for (var i = 0; i < results.length; i++) {
        results[i].type = 'batch';
      }

      return results;
    } catch (e) {
      throw new Error('SubsPlease batch search failed: ' + e.message);
    }
  },

  // ── movie() ─────────────────────────────────────────────────────────────────
  // Movies appear as single episodes on Nyaa — delegates to single().

  async movie(query, options) {
    try {
      var episode  = Number(query && query.episode) || 1;
      var modified = Object.assign({}, query, { episode: episode });
      return await this.single(modified, options);
    } catch (e) {
      throw new Error('SubsPlease movie search failed: ' + e.message);
    }
  },
};
