/**
 * SubsPlease Extension for Hayase
 * --------------------------------
 * Fetches anime torrent releases from subsplease.org using
 * their public RSS feed and JSON API endpoints.
 *
 * Endpoints used:
 *   RSS  – https://subsplease.org/rss/?t&r={resolution}
 *   API  – https://subsplease.org/api/?f=search&s={query}&tz=UTC
 *   API  – https://subsplease.org/api/?f=latest&tz=UTC
 *   API  – https://subsplease.org/api/?f=show&tz=UTC&sid={sid}
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL   = 'https://subsplease.org';
const API_URL    = `${BASE_URL}/api/`;
const RSS_URL    = `${BASE_URL}/rss/`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

/** Preferred resolution order – first match wins when multiple are available. */
const RESOLUTION_PRIORITY = ['1080p', '720p', 'sd'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts a CDATA-wrapped or plain text value from an XML string.
 * @param {string} xml  - Raw XML fragment (one <item> block)
 * @param {string} tag  - Tag name to extract (e.g. "title")
 * @returns {string}
 */
function extractXml(xml, tag) {
  const cdataRe = new RegExp(`<${tag}><!\[CDATA\[([\s\S]*?)\]\]><\/${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}>([\s\S]*?)<\/${tag}>`, 'i');
  const cdata   = xml.match(cdataRe);
  if (cdata) return cdata[1].trim();
  const plain   = xml.match(plainRe);
  return plain ? plain[1].trim() : '';
}

/**
 * Parses a SubsPlease release title into its components.
 * Expected format: [SubsPlease] Show Name - Episode (Resolution) [Hash]
 * @param {string} title
 * @returns {{ show: string, episode: string, resolution: string }}
 */
function parseTitle(title) {
  // Remove [SubsPlease] prefix and trailing hash
  const clean = title
    .replace(/^\[SubsPlease\]\s*/i, '')
    .replace(/\s*\[[0-9A-Fa-f]{8}\]\s*$/, '')
    .trim();

  // Match: Show Name - EpNum (Resolution)
  const match = clean.match(/^(.+?)\s+-\s+(\d+(?:v\d)?)\s+\((\d+p|sd)\)$/i);
  if (match) {
    return {
      show:       match[1].trim(),
      episode:    match[2],
      resolution: match[3].toLowerCase(),
    };
  }

  // Fallback – return raw title
  return { show: clean, episode: '?', resolution: 'unknown' };
}

/**
 * Picks the best available magnet link from a downloads object.
 * @param {{ [res]: { magnet: string, torrent: string } }} downloads
 * @returns {{ resolution: string, magnet: string, torrent: string } | null}
 */
function pickBestDownload(downloads) {
  if (!downloads) return null;
  for (const res of RESOLUTION_PRIORITY) {
    if (downloads[res]) {
      return { resolution: res, ...downloads[res] };
    }
  }
  // No priority match → take whatever is available
  const first = Object.keys(downloads)[0];
  return first ? { resolution: first, ...downloads[first] } : null;
}

/**
 * Selects a magnet URL from all available resolutions.
 * Returns an array so Hayase can offer the user a choice.
 * @param {{ [res]: { magnet: string, torrent: string } }} downloads
 * @returns {Array<{ label: string, url: string }>}
 */
function allMagnets(downloads) {
  if (!downloads) return [];
  return Object.entries(downloads)
    .map(([res, data]) => ({
      label: res.toUpperCase(),
      url:   data.magnet || data.torrent,
    }))
    .filter(item => !!item.url);
}

// ─── search() ─────────────────────────────────────────────────────────────────

/**
 * Search for anime by title.
 *
 * Strategy:
 *   1. Hit the SubsPlease JSON search API – returns all matching shows.
 *   2. Fall back to RSS keyword filter if the API returns nothing.
 *
 * @param {object} request - Hayase request helper ({ text(url): Promise<string> })
 * @param {string} query   - User search string
 * @returns {Promise<Array<{ title: string, url: string, thumbnail?: string, time?: string }>>}
 */
export async function search(request, query) {
  /* ── 1. JSON API search ──────────────────────────────────────────────────── */
  try {
    const apiEndpoint = `${API_URL}?f=search&s=${encodeURIComponent(query)}&tz=UTC`;
    const raw         = await request.text(apiEndpoint);
    const data        = JSON.parse(raw);

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Response: { "Show Name": { sid, poster, ... }, ... }
      const results = Object.entries(data).map(([showName, info]) => ({
        title:     showName,
        url:       `${API_URL}?f=show&tz=UTC&sid=${info.sid}`,
        thumbnail: info.image
          ? `${BASE_URL}/uploads/posters/${info.image}`
          : undefined,
        sid:       info.sid,
      }));

      if (results.length > 0) return results;
    }
  } catch (_) {
    // fall through to RSS
  }

  /* ── 2. RSS fallback ─────────────────────────────────────────────────────── */
  const rssUrl = `${RSS_URL}?t&r=1080`;
  const xml    = await request.text(rssUrl);
  const items  = xml.split('<item>').slice(1);
  const seen   = new Set();
  const results = [];

  for (const item of items) {
    const title   = extractXml(item, 'title');
    const link    = extractXml(item, 'link');
    const pubDate = extractXml(item, 'pubDate');
    const parsed  = parseTitle(title);

    if (!parsed.show.toLowerCase().includes(query.toLowerCase())) continue;
    if (seen.has(parsed.show)) continue;
    seen.add(parsed.show);

    results.push({
      title: parsed.show,
      url:   link,
      time:  pubDate,
    });
  }

  return results;
}

// ─── latest() ─────────────────────────────────────────────────────────────────

/**
 * Fetch the latest releases from SubsPlease (today's airings).
 * Useful for a "New & Hot" feed inside Hayase.
 *
 * @param {object} request
 * @returns {Promise<Array<{ title: string, episode: string, url: string, resolution: string, time: string }>>}
 */
export async function latest(request) {
  /* ── JSON API latest ─────────────────────────────────────────────────────── */
  try {
    const apiEndpoint = `${API_URL}?f=latest&tz=UTC`;
    const raw         = await request.text(apiEndpoint);
    const data        = JSON.parse(raw);

    if (data?.batches && Array.isArray(data.batches)) {
      return data.batches.map(ep => {
        const best = pickBestDownload(ep.downloads);
        return {
          title:      ep.show,
          episode:    ep.episode,
          url:        best?.magnet || best?.torrent || '',
          resolution: best?.resolution || '?',
          time:       ep.release_date || '',
          thumbnail:  ep.image
            ? `${BASE_URL}/uploads/posters/${ep.image}`
            : undefined,
        };
      }).filter(ep => ep.url);
    }
  } catch (_) {
    // fall through to RSS
  }

  /* ── RSS fallback ────────────────────────────────────────────────────────── */
  const rssUrl = `${RSS_URL}?t&r=1080`;
  const xml    = await request.text(rssUrl);
  const items  = xml.split('<item>').slice(1);

  return items.map(item => {
    const title   = extractXml(item, 'title');
    const link    = extractXml(item, 'link');
    const pubDate = extractXml(item, 'pubDate');
    const parsed  = parseTitle(title);

    return {
      title:      parsed.show,
      episode:    parsed.episode,
      url:        link,
      resolution: parsed.resolution,
      time:       pubDate,
    };
  }).filter(ep => ep.url);
}

// ─── detail() ─────────────────────────────────────────────────────────────────

/**
 * Fetch detailed episode list for a show.
 *
 * @param {object} request
 * @param {string} url  - Either the API show URL (f=show&sid=…) or a page URL
 * @returns {Promise<{
 *   title:     string,
 *   thumbnail: string | undefined,
 *   episodes:  Array<{ title: string, url: string, resolution: string }>
 * }>}
 */
export async function detail(request, url) {
  /* ── Try JSON API (sid-based URL) ────────────────────────────────────────── */
  if (url.includes('f=show')) {
    try {
      const raw  = await request.text(url);
      const data = JSON.parse(raw);

      if (data && data.episode) {
        // data.episode: { "1": { downloads: { "1080p": { magnet, torrent }, ... } }, ... }
        const showTitle = data.show || 'Unknown Show';
        const thumbnail = data.poster
          ? `${BASE_URL}/uploads/posters/${data.poster}`
          : undefined;

        const episodes = Object.entries(data.episode)
          .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
          .flatMap(([epNum, epData]) => {
            const magnets = allMagnets(epData.downloads);
            if (magnets.length === 0) return [];

            // Return best resolution as primary, others as alternates
            const best = pickBestDownload(epData.downloads);
            return [{
              title:      `Episode ${epNum}`,
              url:        best?.magnet || best?.torrent || '',
              resolution: best?.resolution || '?',
              alternates: magnets,
            }];
          })
          .filter(ep => ep.url);

        return { title: showTitle, thumbnail, episodes };
      }
    } catch (_) {
      // fall through to HTML scrape
    }
  }

  /* ── HTML scrape fallback ────────────────────────────────────────────────── */
  const html     = await request.text(url);
  const magnets  = [...html.matchAll(/href="(magnet:\?xt=urn:btih:[^"]+)"/g)];
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const showTitle  = titleMatch
    ? titleMatch[1].replace(/\s*[-–|].*$/, '').trim()
    : 'Unknown Show';

  const episodes = magnets.map((m, i) => ({
    title:      `Episode ${i + 1}`,
    url:        m[1],
    resolution: '1080p',
  }));

  return { title: showTitle, thumbnail: undefined, episodes };
}

// ─── schedule() ───────────────────────────────────────────────────────────────

/**
 * Fetch the weekly airing schedule from SubsPlease.
 *
 * @param {object} request
 * @returns {Promise<Array<{ day: string, shows: Array<{ title: string, time: string }> }>>}
 */
export async function schedule(request) {
  try {
    const apiEndpoint = `${API_URL}?f=schedule&h=true&tz=UTC`;
    const raw         = await request.text(apiEndpoint);
    const data        = JSON.parse(raw);

    if (data?.schedule) {
      const days = [
        'Monday', 'Tuesday', 'Wednesday', 'Thursday',
        'Friday', 'Saturday', 'Sunday',
      ];

      return days.map(day => ({
        day,
        shows: (data.schedule[day] || []).map(entry => ({
          title: entry.title,
          time:  entry.time || '',
        })),
      })).filter(d => d.shows.length > 0);
    }
  } catch (_) {
    return [];
  }

  return [];
}
