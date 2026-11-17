import { load } from 'cheerio';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SHOWS, validateTranscriptOptions } from './transcript-command.js';

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

function isPDF(buffer) {
  return buffer.subarray(0, 5).toString() === '%PDF-';
}

// Inject the HTTP client and cache path so lookup behavior can be tested offline.
export function createTranscriptStore({
  cacheDir = process.env.TRANSCRIPT_DIR || DEFAULT_CACHE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const pending = new Map();

  async function request(url, pdf = false) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'TranscriptBot/1.0', Accept: pdf ? 'application/pdf' : 'text/html' },
    });
    if (!response.ok) throw new Error(`Maximum Fun returned HTTP ${response.status}.`);
    if (!pdf) return response.text();
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

  async function lookup(show, episode) {
    const directory = path.resolve(cacheDir, show);
    const pdfPath = path.join(directory, `${episode}.pdf`);
    const metadataPath = path.join(directory, `${episode}.json`);
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

    const searchURL = new URL('/transcripts/', ORIGIN);
    searchURL.searchParams.set('_podcast', show);
    const visited = new Set();
    let metadata;
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
          const page = load(await request(url));
          const heading = clean(page('#transcript-title h1').text() || page('h1').first().text());
          const explicitNumber = clean(page('#from-episode-number a').first().text());
          const number = explicitNumber || titleEpisode(heading);
          if (!/^\d+$/.test(number || '') || Number(number) !== episode) continue;
          const href = page('a.btn-transcript-download[href]').first().attr('href');
          if (!href) continue;
          metadata = {
            show: SHOWS[show].name,
            episode,
            title: heading.replace(/^TRANSCRIPT\s*/i, '').replace(/^MBMBaM\s*(?:Ep(?:isode)?\.?\s*)?#?\s*\d+\s*[:–—-]?\s*/i, '') || heading,
            description: clean(page('#from-episode-description').text()) || 'No episode description is available.',
            sourceUrl: url,
            pdfUrl: siteURL(href, url),
          };
          break;
        }
      }
    }
    if (!metadata) {
      throw new TranscriptError(`No PDF transcript was found for ${SHOWS[show].name}, episode ${episode}. It may not have been published yet.`);
    }
    const pdf = await request(metadata.pdfUrl, true);
    await mkdir(directory, { recursive: true });
    // Readers only see complete files, and metadata is committed last.
    const suffix = `.${randomUUID()}.tmp`;
    await writeFile(pdfPath + suffix, pdf);
    await rename(pdfPath + suffix, pdfPath);
    await writeFile(metadataPath + suffix, JSON.stringify(metadata, null, 2));
    await rename(metadataPath + suffix, metadataPath);
    return { ...metadata, pdf, filename: `${show}-${episode}.pdf` };
  }

  return {
    async getTranscript(show, episode) {
      validateTranscriptOptions(show, episode);
      const key = `${show}/${episode}`;
      if (!pending.has(key)) {
        pending.set(key, lookup(show, episode).finally(() => pending.delete(key)));
      }
      return pending.get(key);
    },
  };
}

export const transcriptStore = createTranscriptStore();
