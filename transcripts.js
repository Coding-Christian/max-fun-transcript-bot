import { load } from 'cheerio';
import { mkdir, readFile, readdir, stat, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SHOWS, validateTranscriptOptions, validateTranscriptURL } from './transcript-command.js';
import { extractPDFText, normalizeSearchText, matchingExcerpt } from './transcript-text.js';
import { validateSearchOptions } from './search-command.js';

const ORIGIN = 'https://maximumfun.org';
const DEFAULT_CACHE = fileURLToPath(new URL('./transcripts/', import.meta.url));
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const clean = (value) => value.replace(/\s+/g, ' ').trim();

export class TranscriptError extends Error {}

function siteURL(value, base = ORIGIN) {
  const url = new URL(value, base);
  if (url.origin !== ORIGIN) throw new Error('Unexpected transcript URL.');
  return url.href;
}

function titleEpisode(title) {
  return title.match(/\bMBMBaM\s*(?:Ep(?:isode)?\.?\s*)?#?\s*0*(\d+)\b/i)?.[1];
}

function urlEpisode(url) {
  const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  return slug?.match(/(?:^|-)mbmbam-(?:ep(?:isode)?-?)?0*(\d+)(?:-|$)/i)?.[1];
}

function displayedEpisode(page) {
  const field = page('#from-episode-number');
  return clean(field.find('a').first().text() || field.text()).replace(/^Episode\s+number:\s*/i, '');
}

function isPDF(buffer) {
  return buffer.subarray(0, 5).toString() === '%PDF-';
}

function pageMetadata(page, url, show, episode, override = false) {
  const href = page('a.btn-transcript-download[href]').first().attr('href');
  if (!href) return null;
  const heading = clean(page('#transcript-title h1').text() || page('h1').first().text());
  let title = heading.replace(/^TRANSCRIPT\s*/i, '') || `${SHOWS[show].name} — Episode ${episode}`;
  if (override) {
    title = title.replace(/\b(MBMBaM\s*(?:Ep(?:isode)?\.?\s*)?#?\s*)0*\d+\b/i,
      (_, prefix) => prefix + episode);
  }
  return {
    show: SHOWS[show].name, episode, title,
    description: clean(page('#from-episode-description').text()) || 'No episode description is available.',
    sourceUrl: url,
    pdfUrl: siteURL(href, url),
    ...(override ? { sourceTitle: heading } : {}),
  };
}

// Inject the HTTP client and cache path so lookup behavior can be tested offline.
export function createTranscriptStore({
  cacheDir = process.env.TRANSCRIPT_DIR || DEFAULT_CACHE,
  fetchImpl = globalThis.fetch,
  extractText = extractPDFText,
  logger = console,
} = {}) {
  const pending = new Map();
  const textPending = new Map();

  function ensureText(show, episode, pdf) {
    const textPath = path.resolve(cacheDir, show, `${episode}.txt`);
    if (!textPending.has(textPath)) {
      const work = async () => {
        try {
          const text = await readFile(textPath, 'utf8');
          if (text.trim()) return text;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const text = await extractText(pdf ?? await readFile(path.resolve(cacheDir, show, `${episode}.pdf`)));
        if (!text.trim()) throw new Error('The PDF has no extractable text.');
        const temporaryPath = `${textPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, text, 'utf8');
        await rename(temporaryPath, textPath);
        return text;
      };
      textPending.set(textPath, work().finally(() => textPending.delete(textPath)));
    }
    return textPending.get(textPath);
  }

  async function inventory(show) {
    const entries = [];
    for (const slug of show ? [show] : Object.keys(SHOWS)) {
      const directory = path.resolve(cacheDir, slug);
      let files;
      try { files = await readdir(directory); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files.filter(file => /^[1-9]\d*\.json$/.test(file))) {
        const episode = Number(file.slice(0, -5));
        if (!Number.isSafeInteger(episode) || episode < 1) continue;
        let metadata;
        try {
          metadata = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
          const pdf = await stat(path.join(directory, `${episode}.pdf`));
          if (!pdf.isFile() || !pdf.size) continue;
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
          throw error;
        }
        if (metadata?.show !== SHOWS[slug].name || metadata.episode !== episode || typeof metadata.title !== 'string') continue;
        entries.push({ ...metadata, slug, pdfPath: path.join(directory, `${episode}.pdf`), filename: `${slug}-${episode}.pdf` });
      }
    }
    return entries.sort((a, b) => a.slug.localeCompare(b.slug) || b.episode - a.episode);
  }

  async function request(url, pdf = false, transcriptPage = false) {
    let currentURL = url;
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(currentURL, {
        signal: AbortSignal.timeout(30_000), redirect: 'manual',
        headers: { 'User-Agent': 'TranscriptBot/1.0', Accept: pdf ? 'application/pdf' : 'text/html' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects >= 5) throw new Error('Invalid or excessive Maximum Fun redirects.');
      currentURL = siteURL(location, currentURL);
      if (transcriptPage) currentURL = validateTranscriptURL(currentURL);
    }
    if (!response.ok) throw new Error(`Maximum Fun returned HTTP ${response.status}.`);
    if (!pdf) {
      const html = await response.text();
      return transcriptPage ? { html, url: currentURL } : html;
    }
    if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) {
      throw new TranscriptError('This transcript is too large to download.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_PDF_BYTES) {
        throw new TranscriptError('This transcript is too large to download.');
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (!isPDF(buffer)) throw new Error('The transcript download was not a PDF.');
    return buffer;
  }

  async function matchingMetadata(url, show, episode) {
    const page = load(await request(url));
    const heading = clean(page('#transcript-title h1').text() || page('h1').first().text());
    const explicitNumber = displayedEpisode(page);
    const headingNumber = titleEpisode(heading);
    const urlNumber = urlEpisode(url);
    const hasBothNumbers = Boolean(headingNumber && urlNumber);
    if (hasBothNumbers && Number(headingNumber) !== Number(urlNumber)) return null;
    // If either the URL or heading omits a number, prefer from-episode-number.
    // Otherwise the agreeing URL/title take precedence over the displayed field.
    const number = hasBothNumbers ? headingNumber : explicitNumber || headingNumber || urlNumber;
    if (!/^\d+$/.test(number || '') || Number(number) !== episode) return null;
    const metadata = pageMetadata(page, url, show, episode);
    if (metadata && hasBothNumbers && explicitNumber && Number(explicitNumber) !== episode) {
      logger.warn(`Transcript episode-number conflict: ${url} identifies episode ${episode} in its URL and title, but from-episode-number displays ${explicitNumber}. Using episode ${episode}.`);
    }
    return metadata;
  }

  async function findThroughEpisodePages(show, episode, visitedTranscripts) {
    const searchURL = new URL('/episodes/', ORIGIN);
    searchURL.searchParams.set('_podcast', show);
    searchURL.searchParams.set('_search', String(episode));
    const visitedEpisodes = new Set();
    for (let number = 1; number <= 20; number++) {
      if (number > 1) searchURL.searchParams.set('_paged', String(number));
      const results = load(await request(searchURL.href));
      const candidates = new Set();
      results('a[href]').each((_, element) => {
        const url = new URL(results(element).attr('href'), searchURL);
        if (url.origin === ORIGIN && url.pathname.startsWith(`/episodes/${show}/`) &&
            Number(urlEpisode(url.href)) === episode && !visitedEpisodes.has(url.href)) candidates.add(url.href);
      });
      if (!candidates.size) break;
      for (const url of candidates) {
        visitedEpisodes.add(url);
        const page = load(await request(url));
        const links = new Set();
        page('a[href]').each((_, element) => {
          const link = new URL(page(element).attr('href'), url);
          if (link.origin === ORIGIN && link.pathname.startsWith(`/transcripts/${show}/`) &&
              !visitedTranscripts.has(link.href)) links.add(link.href);
        });
        for (const link of links) {
          visitedTranscripts.add(link);
          const metadata = await matchingMetadata(link, show, episode);
          if (metadata) return metadata;
        }
      }
    }
    return null;
  }

  async function lookup(show, episode, reload, overrideURL) {
    const directory = path.resolve(cacheDir, show);
    const pdfPath = path.join(directory, `${episode}.pdf`);
    const metadataPath = path.join(directory, `${episode}.json`);
    if (!reload) {
      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        const pdf = await readFile(pdfPath);
        if (metadata?.show === SHOWS[show].name && metadata.episode === episode &&
            typeof metadata.title === 'string' && typeof metadata.description === 'string' && isPDF(pdf)) {
          return { ...metadata, pdf, filename: `${show}-${episode}.pdf` };
        }
      } catch (error) {
        // Missing or corrupt cache entries are downloaded again; filesystem errors surface.
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }

    let metadata;
    if (overrideURL) {
      const source = await request(overrideURL, false, true);
      const page = load(source.html);
      metadata = pageMetadata(page, source.url, show, episode, true);
      if (!metadata) throw new TranscriptError('No PDF transcript download link was found on the provided page.');
      const headingNumber = titleEpisode(metadata.sourceTitle);
      const urlNumber = urlEpisode(overrideURL);
      const displayed = displayedEpisode(page);
      if ([headingNumber, urlNumber, displayed].some(value => value && Number(value) !== episode)) {
        logger.warn(`Transcript URL override: saving ${overrideURL} as episode ${episode}; URL number: ${urlNumber || 'unknown'}, title number: ${headingNumber || 'unknown'}, from-episode-number: ${displayed || 'unknown'}. Using the requested episode number.`);
      }
    } else {
      const searchURL = new URL('/transcripts/', ORIGIN);
      searchURL.searchParams.set('_podcast', show);
      const visited = new Set();
      // Older transcripts use numbers such as 022; the site's index distinguishes them.
      const searchTerms = [...new Set([String(episode), String(episode).padStart(3, '0')])];
      for (const term of searchTerms) {
        if (metadata) break;
        searchURL.searchParams.delete('_paged');
        searchURL.searchParams.set('_search', term);
        // FacetWP uses _paged for subsequent search result pages.
        for (let page = 1; page <= 20 && !metadata; page++) {
          if (page > 1) searchURL.searchParams.set('_paged', String(page));
          const $ = load(await request(searchURL.href));
          const candidates = new Set();
          $('a[href]').each((_, element) => {
            const href = $(element).attr('href');
            const url = new URL(href, searchURL);
            if (url.origin === ORIGIN && url.pathname.startsWith(`/transcripts/${show}/`) &&
                !visited.has(url.href)) candidates.add(url.href);
          });
          if (!candidates.size) break;
          for (const url of candidates) {
            visited.add(url);
            metadata = await matchingMetadata(url, show, episode);
            if (metadata) break;
          }
        }
      }
      // Unnumbered transcripts can be absent from numeric transcript searches.
      if (!metadata) metadata = await findThroughEpisodePages(show, episode, visited);
    }
    if (!metadata) {
      throw new TranscriptError(`No PDF transcript was found for ${SHOWS[show].name}, episode ${episode}. It may not have been published yet.`);
    }
    const pdf = await request(metadata.pdfUrl, true);
    // Finish extraction before replacing any cached version, including on reload.
    await textPending.get(path.resolve(directory, `${episode}.txt`))?.catch(() => {});
    const text = await extractText(pdf);
    if (!text.trim()) throw new Error('The PDF has no extractable text.');
    await mkdir(directory, { recursive: true });
    // Stage complete files first; a fetch/download/extraction failure keeps the old cache.
    const suffix = `.${randomUUID()}.tmp`;
    const files = [[pdfPath, pdf], [path.join(directory, `${episode}.txt`), text], [metadataPath, JSON.stringify(metadata, null, 2)]];
    try {
      for (const [file, contents] of files) await writeFile(file + suffix, contents);
      for (const [file] of files) await rename(file + suffix, file);
    } finally {
      await Promise.all(files.map(([file]) => rm(file + suffix, { force: true })));
    }
    return { ...metadata, pdf, filename: `${show}-${episode}.pdf` };
  }

  return {
    async listTranscripts(show) {
      validateTranscriptOptions(show, 1);
      return (await inventory(show)).sort((a, b) => a.episode - b.episode);
    },
    async getTranscript(show, episode, reload = false, url) {
      validateTranscriptOptions(show, episode, reload);
      const overrideURL = url === undefined ? undefined : validateTranscriptURL(url);
      const refresh = reload || overrideURL !== undefined;
      const key = `${show}/${episode}`;
      const existing = pending.get(key);
      if (existing && (!refresh || (existing.reload && existing.url === overrideURL))) return existing.promise;
      const record = { reload: refresh, url: overrideURL };
      record.promise = (async () => {
        // A reload arriving during a normal fetch must still fetch a fresh copy.
        if (existing) await existing.promise.catch(() => {});
        const transcript = await lookup(show, episode, refresh, overrideURL);
        await ensureText(show, episode, transcript.pdf);
        return transcript;
      })().finally(() => {
        if (pending.get(key) === record) pending.delete(key);
      });
      pending.set(key, record);
      return record.promise;
    },
    async searchTranscripts(options) {
      validateSearchOptions(options);
      const entries = await inventory(options.show);
      const query = normalizeSearchText(options.query);
      const matches = [];
      for (const entry of entries) {
        if (options.episode !== undefined && entry.episode !== options.episode) continue;
        let text;
        try { text = await ensureText(entry.slug, entry.episode); } catch (error) {
          throw new TranscriptError(`Could not extract searchable text for ${entry.show}, episode ${entry.episode}. The search could not be completed.`, { cause: error });
        }
        const excerpt = matchingExcerpt(text, query) ?? matchingExcerpt(`${entry.show}\nEpisode ${entry.episode}\n${entry.title}`, query);
        if (excerpt !== null) matches.push({ ...entry, excerpt });
      }
      return { matches, missing: missingEpisodes(entries, options), searched: entries.filter(entry => options.episode === undefined || entry.episode === options.episode).length };
    },
  };
}

// Store ranges instead of enumerating potentially very large episode gaps.
export function missingEpisodes(entries, { show, episode } = {}) {
  return (show ? [show] : Object.keys(SHOWS)).map(slug => {
    const numbers = [...new Set(entries.filter(entry => entry.slug === slug).map(entry => entry.episode))].sort((a, b) => a - b);
    const highest = numbers.at(-1);
    const ranges = [];
    if (episode !== undefined) {
      if (episode < highest && !numbers.includes(episode)) ranges.push([episode, episode]);
    } else {
      let start = 1;
      for (const number of numbers) {
        if (number > start) ranges.push([start, number - 1]);
        start = number + 1;
      }
    }
    return { show: SHOWS[slug].name, highest, ranges, episode };
  });
}

export const transcriptStore = createTranscriptStore();
