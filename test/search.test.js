import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTranscriptStore, missingEpisodes } from '../transcripts.js';
import { SEARCH_COMMAND, validateSearchOptions } from '../search-command.js';
import { extractPDFText, normalizeSearchText, matchingExcerpt } from '../transcript-text.js';
import { respondWithSearch, noResultsMessage } from '../search-response.js';
import { editTranscriptResponse } from '../transcript-response.js';

const slug = 'my-brother-my-brother-and-me';
const show = 'My Brother, My Brother and Me';
const pdf = Buffer.from('%PDF-1.4\nFake PDF for injected extractors');
const interaction = { application_id: 'app', token: 'token', data: { options: [{ name: 'query', value: 'birds' }] } };

async function library(t, episodes = [], extra = {}) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'transcript-search-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const directory = path.join(cacheDir, slug);
  await mkdir(directory);
  for (const { episode, text, title = `MBMBaM ${episode}: A title`, ...metadata } of episodes) {
    await writeFile(path.join(directory, `${episode}.json`), JSON.stringify({ show, episode, title,
      description: 'Original episode description', sourceUrl: `https://maximumfun.org/transcripts/${slug}/episode-${episode}/`,
      pdfUrl: `https://maximumfun.org/${episode}.pdf`, ...metadata }));
    await writeFile(path.join(directory, `${episode}.pdf`), pdf);
    if (text !== undefined) await writeFile(path.join(directory, `${episode}.txt`), text);
  }
  let parses = 0;
  const storeOptions = {
    cacheDir,
    extractText: async () => { parses++; return 'Freshly extracted birds in a transcript.\n'; },
    fetchImpl: () => assert.fail('Local searches must not use the network'),
    ...extra,
  };
  return { directory, store: createTranscriptStore(storeOptions), storeOptions, parses: () => parses };
}

test('search schema and validation enforce the query limit and optional filters', () => {
  assert.equal(SEARCH_COMMAND.name, 'search');
  assert.deepEqual(SEARCH_COMMAND.options.map(({name, required}) => [name, required]), [['query', true], ['show', false], ['episode', false]]);
  assert.equal(SEARCH_COMMAND.options[0].max_length, 100);
  assert.equal(SEARCH_COMMAND.options[2].min_value, 2);
  validateSearchOptions({ query: 'q'.repeat(100) });
  validateSearchOptions({ query: 'birds', episode: 2 });
  validateSearchOptions({ query: 'birds', show: slug });
  for (const query of ['', '   ', '???', 'q'.repeat(101), undefined, 42]) {
    assert.throws(() => validateSearchOptions({ query }));
  }
  assert.throws(() => validateSearchOptions({ query: 'birds', show: '../escape' }));
  for (const episode of [1, 0, -2, 2.1, '22']) {
    assert.throws(() => validateSearchOptions({ query: 'birds', episode }));
  }
});

test('phrase matching handles casing, accents, punctuation, whitespace, ligatures and line wrapping', () => {
  for (const [text, query] of [
    ['CAFÉ isn’t a feed-the-birds party.', 'cafe ISNT a feed the birds party'],
    ['Birds\n\t and    GHOSTS', 'birds and ghosts'],
    ['The ﬁnal oﬃce & friends', 'the final office and friends'],
    ['An extraor-\n dinary ghost', 'extraordinary GHOST'],
    ['Hello—world… again!', 'hello world again'],
    ['soft\u00adhyphens and zero\u200bwidth', 'softhyphens and zerowidth'],
  ]) {
    const excerpt = matchingExcerpt(text, normalizeSearchText(query));
    assert.notEqual(excerpt, null, `${query} must match ${text}`);
    assert.ok(excerpt.includes(text.split(/\s/)[0]));
  }
  assert.equal(matchingExcerpt('birds are great', normalizeSearchText('great birds')), null);
  const original = `${'Earlier sentence. '.repeat(50)}CAFÉ isn’t a ghost.${' Later sentence.'.repeat(50)}`;
  const excerpt = matchingExcerpt(original, normalizeSearchText('cafe isnt a ghost'));
  assert.match(excerpt, /CAFÉ isn’t a ghost/);
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'));
  assert.ok(excerpt.length < 500);
});

test('local searches backfill old downloads once and reuse text after a restart', async t => {
  const { store, directory, parses, storeOptions } = await library(t, [{ episode: 838 }]);
  const [search, fetched] = await Promise.all([
    store.searchTranscripts({ query: 'birds' }), store.getTranscript(slug, 838),
  ]);
  assert.equal(search.matches.length, 1);
  assert.equal(fetched.episode, 838);
  assert.equal(parses(), 1);
  const textPath = path.join(directory, '838.txt');
  const before = await stat(textPath);
  assert.match(await readFile(textPath, 'utf8'), /Freshly extracted/);
  const restarted = createTranscriptStore({ ...storeOptions, extractText: () => assert.fail('Already parsed') });
  await restarted.getTranscript(slug, 838);
  await restarted.searchTranscripts({ query: 'birds' });
  assert.equal((await stat(textPath)).mtimeMs, before.mtimeMs);
  assert.deepEqual((await readdir(directory)).sort(), ['838.json', '838.pdf', '838.txt']);
});

test('new downloads extract text once and keep a single text file across subsequent requests', async t => {
  const { directory, storeOptions } = await library(t);
  let parses = 0;
  const store = createTranscriptStore({ ...storeOptions, extractText: async () => { parses++; return 'New transcript birds.\n'; },
    fetchImpl: async url => {
      if (url.includes('/transcripts/?')) return new Response(`<a href="/transcripts/${slug}/unusual/">Episode</a>`);
      if (url.endsWith('/unusual/')) return new Response('<h1>TRANSCRIPT MBMBaM 838: Birds</h1><a class="btn-transcript-download" href="/test.pdf">Download</a>');
      assert.equal(url, 'https://maximumfun.org/test.pdf');
      return new Response(pdf);
    } });
  await Promise.all([store.getTranscript(slug, 838), store.getTranscript(slug, 838)]);
  await store.getTranscript(slug, 838);
  assert.equal((await store.searchTranscripts({ query: 'birds' })).matches.length, 1);
  assert.equal(parses, 1);
  assert.equal(await readFile(path.join(directory, '838.txt'), 'utf8'), 'New transcript birds.\n');
});

test('queries search body, show name, title and episode number and respect both filters', async t => {
  const { store, parses } = await library(t, [
    { episode: 3, text: 'CAFÉ isn’t a feed-the-birds party.', title: 'MBMBaM 3: Lovegoose' },
    { episode: 8, text: 'An unrelated passage', title: 'MBMBaM 8: Something else' },
  ]);
  assert.equal((await store.searchTranscripts({ query: 'cafe isnt a feed the birds' })).matches[0].episode, 3);
  assert.equal((await store.searchTranscripts({ query: 'LOVEGOOSE' })).matches[0].episode, 3);
  assert.equal((await store.searchTranscripts({ query: 'episode 8' })).matches[0].episode, 8);
  assert.deepEqual((await store.searchTranscripts({ query: 'my brother my brother & me' })).matches.map(m => m.episode), [8, 3]);
  assert.equal((await store.searchTranscripts({ query: 'birds', show: slug, episode: 8 })).matches.length, 0);
  assert.equal((await store.searchTranscripts({ query: 'birds', episode: 3 })).matches.length, 1);
  assert.equal(parses(), 0);
});

test('ignores orphan files and malformed metadata when determining downloads and gaps', async t => {
  const { store, directory } = await library(t, [{ episode: 3, text: 'No match' }, { episode: 8, text: 'No match' }]);
  await writeFile(path.join(directory, '4.pdf'), pdf);
  await writeFile(path.join(directory, '5.json'), '{bad json');
  await writeFile(path.join(directory, '6.json'), 'null');
  await writeFile(path.join(directory, '6.pdf'), pdf);
  await writeFile(path.join(directory, '999.txt'), 'birds');
  await writeFile(path.join(directory, '8.json.tmp'), '{}');
  const result = await store.searchTranscripts({ query: 'birds' });
  assert.equal(result.searched, 2);
  assert.deepEqual(result.missing[0].ranges, [[2, 2], [4, 7]]);
  assert.equal(result.missing[0].highest, 8);
});

test('missing episode ranges are bounded, respect filters and handle large episode numbers without enumeration', () => {
  const entries = [2, 4, 8].map(episode => ({ slug, episode }));
  assert.deepEqual(missingEpisodes(entries)[0].ranges, [[3, 3], [5, 7]]);
  assert.deepEqual(missingEpisodes(entries, { episode: 6 })[0].ranges, [[6, 6]]);
  assert.deepEqual(missingEpisodes(entries, { episode: 4 })[0].ranges, []);
  assert.deepEqual(missingEpisodes(entries, { episode: 900 })[0].ranges, []);
  assert.deepEqual(missingEpisodes([{ slug, episode: Number.MAX_SAFE_INTEGER }])[0].ranges, [[2, Number.MAX_SAFE_INTEGER - 1]]);
  assert.deepEqual(missingEpisodes([{ slug, episode: 2 }, { slug, episode: 3 }])[0].ranges, []);
});

test('no matches distinguish empty libraries, gaps and complete bounded libraries', async t => {
  const { store } = await library(t);
  const empty = await store.searchTranscripts({ query: 'birds' });
  assert.match(noResultsMessage(empty), /No transcripts are downloaded yet/);
  const missing = missingEpisodes([2, 4, 8].map(episode => ({ slug, episode })));
  const message = noResultsMessage({ missing });
  assert.match(message, /3, 5–7/);
  assert.doesNotMatch(message, /8–/);
  assert.match(noResultsMessage({ missing: missingEpisodes([2, 3, 4].map(episode => ({slug, episode}))) }), /All episodes from 2 through 4 are downloaded and searched; no matches found/);
});

test('failed extraction is an incomplete search, and a later search can retry', async t => {
  let fail = true;
  const { store, directory } = await library(t, [{ episode: 2 }], { extractText: async () => {
    if (fail) throw new Error('Invalid PDF');
    return 'birds';
  } });
  const messages = [];
  await respondWithSearch(interaction, { store, edit: async (_, payload) => messages.push(payload), logger: {error() {}} });
  assert.match(messages[0].content, /search could not be completed/);
  assert.equal((await readdir(directory)).includes('2.txt'), false);
  fail = false;
  assert.equal((await store.searchTranscripts({ query: 'birds' })).matches.length, 1);
});

test('search responses replace descriptions with excerpts and attach up to five PDFs', async t => {
  const { store } = await library(t, Array.from({ length: 7 }, (_, i) => ({episode: i + 2, text: 'The birds are here.'})));
  const edits = [];
  await respondWithSearch(interaction, { store, edit: async (...args) => edits.push(args) });
  const [, payload, files] = edits[0];
  assert.match(payload.content, /Found 7 matching episodes.*first 5/);
  assert.equal(payload.embeds.length, 5);
  assert.equal(files.length, 5);
  assert.equal(payload.embeds[0].description, 'The birds are here.');
  assert.equal(payload.embeds[0].footer.text, `${show} — Episode 8`);
  assert.equal(files[0].filename, `${slug}-8.pdf`);
  assert.deepEqual(files[0].pdf, pdf);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('search responses link PDFs that exceed Discord attachment limits', async t => {
  const { store } = await library(t, [{episode: 2, text: 'birds'}]);
  await respondWithSearch({ ...interaction, attachment_size_limit: 1 }, {
    store, edit: async (_, payload, files) => {
      assert.equal(files, undefined);
      assert.match(payload.embeds[0].fields[0].value, /Download transcript/);
    },
  });
});

test('long missing-episode lists are attached completely as text', async () => {
  const result = { matches: [], missing: [{ show, highest: 10000, ranges: Array.from({length: 2000}, (_, i) => [i * 2 + 2, i * 2 + 2]) }] };
  await respondWithSearch(interaction, {
    store: { searchTranscripts: async () => result },
    edit: async (_, payload, file) => {
      assert.ok(payload.content.length < 2000);
      assert.equal(file.filename, 'missing-episodes.txt');
      assert.equal(file.contentType, 'text/plain');
      assert.equal(file.pdf.toString(), noResultsMessage(result));
    },
  });
});

test('multipart responses use distinct attachment IDs and honor content types', async () => {
  await editTranscriptResponse(interaction, { content: 'Matches' }, [
    { filename: '2.pdf', pdf }, { filename: 'missing.txt', pdf: Buffer.from('3–5'), contentType: 'text/plain' },
  ], async (_, {body}) => {
    assert.deepEqual(JSON.parse(body.get('payload_json')).attachments, [{id: 0, filename: '2.pdf'}, {id: 1, filename: 'missing.txt'}]);
    assert.equal(body.get('files[0]').type, 'application/pdf');
    assert.equal(body.get('files[1]').type, 'text/plain');
    assert.equal(await body.get('files[1]').text(), '3–5');
    return new Response('{}');
  });
});

test('PDF.js extracts readable text from a real PDF document', async () => {
  // A complete small PDF with correct cross-reference offsets (no mocked parser).
  const stream = 'BT /F1 12 Tf 20 100 Td (Birds and ghosts) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(source));
    source += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  assert.equal((await extractPDFText(Buffer.from(source))).trim(), 'Birds and ghosts');
});
