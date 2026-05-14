/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Source  : https://subsplease.org
 * Type    : torrent
 * Quality : 1080p preferred (falls back to 720p → sd)
 * Media   : Subtitled (English subs, Japanese audio)
 * ─────────────────────────────────────────────────────────────
 * Official Hayase extension interface (manifestVersion 2):
 *   test()   – health check, returns true or throws
 *   single() – single episode search  → TorrentResult[]
 *   batch()  – full season search     → TorrentResult[]
 *   movie()  – movie / special search → TorrentResult[]
 */

const BASE = 'https://subsplease.org';
const API  = BASE + '/api/';
const RSS  = BASE + '/rss/';

// ─── Utility: extract info-hash from a magnet link ───────────────────────────

function infoHash(magnet) {
  if (!magnet || typeof magnet !== 'string') return '';
  const m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

// ─── Utility: find the correct episode key in SubsPlease's episode object ────
// SubsPlease uses zero-padded string keys: "01", "12", "12.5", "100"

function findEpKey(episodes, epNum) {
  // Guard: episodes must be an object, epNum must be a usable number
  if (!episodes || typeof episodes !== 'object') return null;
  const num = Number(epNum);
  if (isNaN(num)) return null;

  const candidates = [
    String(num).padStart(2, '0'),                          // "01", "12", "100"
    String(num),                                           // "1", "12"
    Number.isInteger(num) ? null : num.toFixed(1),         // "12.5"
  ].filter(Boolean);

  for (const key of candidates) {
    if (episodes[key] != null) return key;
  }
  return null;
}

// ─── Utility: extract XML tag value, handles CDATA ───────────────────────────

function xmlTag(block, tag) {
  if (!block || !tag) return '';
  const cd = block.match(new RegExp(`<${tag}><!\[CDATA\[([\\s\\S]*?)\]\]><\\/${tag}>`, 'i'));
  if (cd) return cd[1].trim();
  const pl = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return pl ? pl[1].trim() : '';
}

// ─── Utility: pick best resolution from a SubsPlease downloads object ────────
// FIX: Guard against downloads being null, undefined, or non-object

function bestDownload(downloads) {
  if (!downloads || typeof downloads !== 'object') return null;
  for (const res of ['1080p', '720p', 'sd']) {
    const d = downloads[res];
    if (d && typeof d === 'object' && (d.magnet || d.torrent)) {
      return { res, magnet: d.magnet || '', torrent: d.torrent || '' };
    }
  }
  return null;
}

// ─── Utility: build a TorrentResult object ───────────────────────────────────

function makeTorrent(title, link, date, type) {
  if (!title || !link) return null;
  const result = {
    title,
    link,
    seeders:   0,
    leechers:  0,
    downloads: 0,
    accuracy:  'high',
    hash:      infoHash(link),
    size:      0,
    date:      date ? new Date(date) : new Date(),
  };
  // Only set type if valid — docs warn not to set best/alt unless manually verified
  if (type === 'batch') result.type = 'batch';
  return result;
}

// ─── Utility: check if a title matches any exclusion keyword ─────────────────
// FIX: validate that exclusions is a real array and that each item is a string

function isExcluded(title, exclusions) {
  if (!title || !Array.isArray(exclusions) || exclusions.length === 0) return false;
  const lower = title.toLowerCase();
  return exclusions.some(ex => ex && typeof ex === 'string' && lower.includes(ex.toLowerCase()));
}

// ─── Core: search SubsPlease for a show, try each title variant ──────────────

async function findShow(fetchFn, titles) {
  // FIX: guard against titles being undefined/non-array
  if (!Array.isArray(titles) || titles.length === 0) return null;

  for (const title of titles) {
    if (!title || typeof title !== 'string') continue;
    try {
      const url = `${API}?f=search&s=${encodeURIComponent(title)}&tz=UTC`;
      const res = await fetchFn(url);
      if (!res?.ok) continue;

      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

      const entries = Object.entries(data);
      if (entries.length === 0) continue;

      // Prefer the entry whose name best matches our query
      const q  = title.toLowerCase();
      let best = entries[0];
      for (const entry of entries) {
        if (entry[0].toLowerCase().includes(q)) { best = entry; break; }
      }

      // FIX: guard against best[1] not being an object with a sid
      const sid = best[1]?.sid;
      if (!sid) continue;

      return { sid, showName: best[0] };
    } catch (_) {
      // Network or parse error — try the next title
    }
  }
  return null;
}

// ─── Core: fetch the full episode list for a show ────────────────────────────

async function fetchEpisodes(fetchFn, sid) {
  const url = `${API}?f=show&tz=UTC&sid=${encodeURIComponent(String(sid))}`;
  const res = await fetchFn(url);
  if (!res?.ok) throw new Error(`SubsPlease API returned HTTP ${res?.status ?? 'unknown'}`);
  const data = await res.json();
  if (!data?.episode || typeof data.episode !== 'object') {
    throw new Error('SubsPlease returned an unexpected response format.');
  }
  return data;
}

// ─── Extension export ─────────────────────────────────────────────────────────

export default {

  // ── test() ──────────────────────────────────────────────────────────────────
  // Hayase calls this on install and periodically to check the extension works.
  // Must return true if OK, or throw a user-friendly error if not.

  async test() {
    try {
      const res = await fetch(`${API}?f=latest&tz=UTC`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      return true;
    } catch (e) {
      throw new Error(
        `Cannot reach SubsPlease. Please check your internet connection. (${e.message})`
      );
    }
  },

  // ── single() ────────────────────────────────────────────────────────────────
  // Called when the user clicks a single episode.
  // Uses SubsPlease's JSON API for ID-based lookup — highly accurate.
  //
  // FIX 1: Return [] instead of undefined — Hayase calls .length on the result
  // FIX 2: Accept options as second parameter (required by official spec)
  // FIX 3: Validate all query fields before use

  async single(query, options = {}) {
    try {
      const titles     = query?.titles;
      const episode    = query?.episode;
      const fetchFn    = query?.fetch;
      const exclusions = query?.exclusions;

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles))        return [];

      const show = await findShow(fetchFn, titles);
      if (!show) return [];

      const data = await fetchEpisodes(fetchFn, show.sid);
      const key  = findEpKey(data.episode, episode);
      if (!key) return [];

      const epData = data.episode[key];
      if (!epData) return [];

      // FIX 3: null-coalesce only if undefined; null means "no downloads"
      const dl = bestDownload(epData.downloads ?? {});
      if (!dl) return [];

      const epStr = String(Number(episode) || 1).padStart(2, '0');
      const title = `[SubsPlease] ${show.showName} - ${epStr} (${dl.res})`;

      if (isExcluded(title, exclusions)) return [];

      const torrent = makeTorrent(title, dl.magnet || dl.torrent, null, null);
      return torrent ? [torrent] : [];

    } catch (e) {
      throw new Error(`SubsPlease episode search failed: ${e.message}`);
    }
  },

  // ── batch() ─────────────────────────────────────────────────────────────────
  // Called when the user wants a complete season pack.
  // Uses the SubsPlease RSS feed filtered to batch releases.
  //
  // FIX: Return [] instead of undefined

  async batch(query, options = {}) {
    try {
      const titles     = query?.titles;
      const fetchFn    = query?.fetch;
      const exclusions = query?.exclusions;

      if (typeof fetchFn !== 'function') return [];
      if (!Array.isArray(titles))        return [];

      const show = await findShow(fetchFn, titles);
      if (!show) return [];

      const rssUrl  = `${RSS}?t&a=${encodeURIComponent(String(show.sid))}&r=1080`;
      const res     = await fetchFn(rssUrl);
      if (!res?.ok) return [];

      const xmlText = await res.text();
      if (!xmlText)  return [];

      const items   = xmlText.split('<item>').slice(1);
      const results = [];

      for (const item of items) {
        if (!item) continue;

        const title   = xmlTag(item, 'title');
        const link    = xmlTag(item, 'link');
        const pubDate = xmlTag(item, 'pubDate');

        if (!title || !title.toLowerCase().includes('batch')) continue;
        if (!link)          continue;
        if (!infoHash(link)) continue;
        if (isExcluded(title, exclusions)) continue;

        const torrent = makeTorrent(title, link, pubDate, 'batch');
        if (torrent) results.push(torrent);
      }

      // FIX: always return an array, never undefined
      return results;

    } catch (e) {
      throw new Error(`SubsPlease batch search failed: ${e.message}`);
    }
  },

  // ── movie() ─────────────────────────────────────────────────────────────────
  // SubsPlease occasionally releases anime movies and specials.
  // They appear as single-episode entries, so we delegate to single().

  async movie(query, options = {}) {
    try {
      const episode = Number(query?.episode) || 1;
      return await this.single({ ...query, episode }, options);
    } catch (e) {
      throw new Error(`SubsPlease movie search failed: ${e.message}`);
    }
  },
};
