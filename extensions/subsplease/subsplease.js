/**
 * SubsPlease Extension for Hayase
 * ─────────────────────────────────────────────────────────────
 * Source  : https://subsplease.org
 * Type    : torrent
 * Quality : 1080p preferred (falls back to 720p → sd)
 * Media   : Subtitled (English subs, Japanese audio)
 * ─────────────────────────────────────────────────────────────
 * Implements the official Hayase extension interface:
 *   test()   – health check
 *   single() – single episode search
 *   batch()  – full season/batch search
 *   movie()  – movie / special search
 */

const BASE = 'https://subsplease.org';
const API  = BASE + '/api/';
const RSS  = BASE + '/rss/';

// ─── Utility: extract info-hash from magnet link ─────────────────────────────

function infoHash(magnet) {
  if (!magnet) return '';
  const m = magnet.match(/urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/i);
  return m ? m[1].toUpperCase() : '';
}

// ─── Utility: find the correct episode key ───────────────────────────────────
// SubsPlease API uses zero-padded string keys: "01", "12", "12.5", "100"

function findEpKey(episodes, epNum) {
  const candidates = [
    String(epNum).padStart(2, '0'),
    String(epNum),
    Number.isInteger(epNum) ? null : epNum.toFixed(1),
  ].filter(Boolean);

  for (const key of candidates) {
    if (episodes[key]) return key;
  }
  return null;
}

// ─── Utility: parse XML tag value (handles CDATA) ────────────────────────────

function xmlTag(block, tag) {
  const cd = block.match(new RegExp(`<${tag}><!\[CDATA\[([\\s\\S]*?)\]\]><\\/${tag}>`, 'i'));
  if (cd) return cd[1].trim();
  const pl = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return pl ? pl[1].trim() : '';
}

// ─── Utility: pick best available resolution ─────────────────────────────────

function bestDownload(downloads) {
  for (const res of ['1080p', '720p', 'sd']) {
    if (downloads[res]?.magnet || downloads[res]?.torrent) {
      return { res, ...downloads[res] };
    }
  }
  return null;
}

// ─── Utility: build a valid TorrentResult object ─────────────────────────────

function makeTorrent(title, link, date, type) {
  return {
    title,
    link,
    seeders:   0,
    leechers:  0,
    downloads: 0,
    accuracy:  'high',
    hash:      infoHash(link),
    size:      0,
    date:      date ? new Date(date) : new Date(),
    type,
  };
}

// ─── Core: find a show on SubsPlease by trying each title ────────────────────

async function findShow(fetchFn, titles) {
  for (const title of titles) {
    try {
      const url  = `${API}?f=search&s=${encodeURIComponent(title)}&tz=UTC`;
      const res  = await fetchFn(url);
      if (!res.ok) continue;

      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

      const entries = Object.entries(data);
      if (entries.length === 0) continue;

      // Prefer an entry whose name contains our search query
      const q  = title.toLowerCase();
      let best = entries[0];
      for (const entry of entries) {
        if (entry[0].toLowerCase().includes(q)) { best = entry; break; }
      }

      return { sid: best[1].sid, showName: best[0] };
    } catch (_) {
      // Try next title variant
    }
  }
  return null;
}

// ─── Core: fetch all episodes for a show ─────────────────────────────────────

async function fetchEpisodes(fetchFn, sid) {
  const res = await fetchFn(`${API}?f=show&tz=UTC&sid=${sid}`);
  if (!res.ok) throw new Error(`SubsPlease API returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.episode) throw new Error('SubsPlease returned an unexpected format.');
  return data;
}

// ─── Extension export (required by Hayase) ───────────────────────────────────

export default {

  // ── test() ─────────────────────────────────────────────────────────────────
  // Hayase calls this to verify the extension is working.
  // Must return true, or throw a user-friendly error.

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

  // ── single() ───────────────────────────────────────────────────────────────
  // Called when the user clicks a single episode.
  // Uses SubsPlease API for ID-based matching — very accurate.

  async single(query) {
    const { titles, episode, fetch: fetchFn, exclusions = [] } = query;

    try {
      const show = await findShow(fetchFn, titles);
      if (!show) return undefined;

      const data = await fetchEpisodes(fetchFn, show.sid);

      const key = findEpKey(data.episode, episode);
      if (!key) return undefined;

      const dl = bestDownload(data.episode[key].downloads ?? {});
      if (!dl) return undefined;

      const epStr = String(episode).padStart(2, '0');
      const title = `[SubsPlease] ${show.showName} - ${epStr} (${dl.res})`;

      if (exclusions.some(ex => title.toLowerCase().includes(ex.toLowerCase()))) {
        return undefined;
      }

      return [makeTorrent(title, dl.magnet || dl.torrent, null, 'best')];

    } catch (e) {
      throw new Error(`SubsPlease episode search failed: ${e.message}`);
    }
  },

  // ── batch() ────────────────────────────────────────────────────────────────
  // Called when the user wants a full season pack.
  // Uses the SubsPlease RSS feed filtered to batch releases.

  async batch(query) {
    const { titles, fetch: fetchFn, exclusions = [] } = query;

    try {
      const show = await findShow(fetchFn, titles);
      if (!show) return undefined;

      const rssUrl = `${RSS}?t&a=${show.sid}&r=1080`;
      const res    = await fetchFn(rssUrl);
      if (!res.ok) return undefined;

      const xmlText = await res.text();
      const items   = xmlText.split('<item>').slice(1);
      const results = [];

      for (const item of items) {
        const title   = xmlTag(item, 'title');
        const link    = xmlTag(item, 'link');
        const pubDate = xmlTag(item, 'pubDate');

        if (!title.toLowerCase().includes('batch')) continue;
        if (!link) continue;
        if (!infoHash(link)) continue;
        if (exclusions.some(ex => title.toLowerCase().includes(ex.toLowerCase()))) continue;

        results.push(makeTorrent(title, link, pubDate, 'batch'));
      }

      return results.length > 0 ? results : undefined;

    } catch (e) {
      throw new Error(`SubsPlease batch search failed: ${e.message}`);
    }
  },

  // ── movie() ────────────────────────────────────────────────────────────────
  // SubsPlease occasionally releases anime movies and specials.
  // Delegates to single() since they appear as episode 1.

  async movie(query) {
    const modified = { ...query, episode: query.episode ?? 1 };
    return this.single(modified);
  },
};
