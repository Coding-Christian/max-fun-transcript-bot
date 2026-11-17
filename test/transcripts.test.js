import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTranscriptStore, TranscriptError } from '../transcripts.js';
import { TRANSCRIPT_COMMAND, validateTranscriptOptions } from '../transcript-command.js';
import { editTranscriptResponse, respondWithTranscript } from '../transcript-response.js';

const show = 'my-brother-my-brother-and-me';
const base = 'https://maximumfun.org';
const pdf = Buffer.from('%PDF-1.4\nTest transcript');
const page = (episode, extra = '') => `
  <div id="transcript-title"><h1>TRANSCRIPT MBMBaM ${episode}: A title &amp; more</h1></div>
  <div id="from-episode-number"><a>${episode}</a></div>
  <div id="from-episode-description"><p>An episode <em>description</em>.</p></div>
  <a class="btn btn-transcript-download" href="/wp-content/uploads/test.pdf">PDF</a>${extra}`;

async function setup(t, pages, options = {}) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'transcript-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const store = createTranscriptStore({ cacheDir, extractText: async () => 'Test transcript text\n', fetchImpl: async (url) => {
    calls.push(url);
    assert.ok(pages.has(url), `Unexpected request: ${url}`);
    const data = pages.get(url);
    return data instanceof Response ? data.clone() : new Response(data, { status: 200 });
  }, ...options });
  return { store, calls, cacheDir };
}

function results(episode, urls = ['unusual-page-name']) {
  return new Map([
    [`${base}/transcripts/?_podcast=${show}&_search=${episode}`, urls.map(url =>
      `<h4><a href="/transcripts/${show}/${url}/">Transcript</a></h4>`).join('')],
    ...urls.map(url => [`${base}/transcripts/${show}/${url}/`, page(episode)]),
    [`${base}/wp-content/uploads/test.pdf`, pdf],
    ...(episode < 100 ? [[`${base}/transcripts/?_podcast=${show}&_search=${String(episode).padStart(3, '0')}`, '']] : []),
  ]);
}

test('command requires a supported show and an integer above 1', () => {
  assert.equal(TRANSCRIPT_COMMAND.name, 'transcript');
  assert.deepEqual(TRANSCRIPT_COMMAND.options.map(o => [o.name, o.required]), [['show', true], ['episode', true], ['reload', false]]);
  assert.equal(TRANSCRIPT_COMMAND.options[0].choices.length, 1);
  assert.equal(TRANSCRIPT_COMMAND.options[1].min_value, 2);
  validateTranscriptOptions(show, 2);
  assert.equal(TRANSCRIPT_COMMAND.options[2].type, 5);
  validateTranscriptOptions(show, 2, true);
  validateTranscriptOptions(show, 2, false);
  for (const reload of ['true', 1, null]) assert.throws(() => validateTranscriptOptions(show, 2, reload));
  for (const episode of [1, 0, -1, 2.1, '838', undefined, NaN]) {
    assert.throws(() => validateTranscriptOptions(show, episode));
  }
  for (const invalid of ['../escape', 'toString', '__proto__']) {
    assert.throws(() => validateTranscriptOptions(invalid, 838));
  }
});

test('follows unusual URLs, extracts metadata, and serves subsequent requests entirely from cache', async t => {
  const { store, calls, cacheDir } = await setup(t, results(710));
  const first = await store.getTranscript(show, 710);
  assert.equal(first.title, 'MBMBaM 710: A title & more');
  assert.equal(first.description, 'An episode description.');
  assert.equal(first.show, 'My Brother, My Brother and Me');
  assert.deepEqual(first.pdf, pdf);
  assert.equal(calls.length, 3);
  const second = await store.getTranscript(show, 710);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 3);
  assert.deepEqual(await readFile(path.join(cacheDir, show, '710.pdf')), pdf);
});

test('ignores substring matches and unrelated shows and deduplicates links', async t => {
  const pages = results(22, ['wrong', 'outlier']);
  pages.set(`${base}/transcripts/${show}/wrong/`, page(222));
  const search = `${base}/transcripts/?_podcast=${show}&_search=22`;
  pages.set(search, pages.get(search) + `<a href="/transcripts/other-show/wrong/">22</a><a href="/transcripts/${show}/outlier/">Again</a>`);
  const { store, calls } = await setup(t, pages);
  assert.equal((await store.getTranscript(show, 22)).episode, 22);
  assert.equal(calls.length, 4);
});

test('uses title when the explicit episode field is absent', async t => {
  const pages = results(22);
  pages.set(`${base}/transcripts/${show}/unusual-page-name/`, page(22).replace('<div id="from-episode-number"><a>22</a></div>', ''));
  const { store } = await setup(t, pages);
  assert.equal((await store.getTranscript(show, 22)).episode, 22);
});

test('trusts agreeing URL and title over incorrect displayed episode and warns on the server', async t => {
  const slug = 'transcript-mbmbam-835-american-comedy-story';
  const pages = results(835, [slug]);
  pages.set(`${base}/transcripts/${show}/${slug}/`, page(835).replace('<a>835</a>', '<a href="/episodes/mbmbam-835-american-comedy-story/">833</a>'));
  const warnings = [];
  const { store } = await setup(t, pages, { logger: { warn: message => warnings.push(message) } });
  const transcript = await store.getTranscript(show, 835);
  assert.equal(transcript.episode, 835);
  assert.deepEqual(transcript.pdf, pdf);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /835.*from-episode-number displays 833.*Using episode 835/);
  await store.getTranscript(show, 835);
  assert.equal(warnings.length, 1);
});

test('does not mistake a conflicting displayed number for the requested episode', async t => {
  const slug = 'transcript-mbmbam-835-american-comedy-story';
  const pages = results(833, [slug]);
  pages.set(`${base}/transcripts/${show}/${slug}/`, page(835).replace('<a>835</a>', '<a>833</a>'));
  pages.set(`${base}/transcripts/?_podcast=${show}&_search=833&_paged=2`, '');
  const { store } = await setup(t, pages, { logger: { warn: () => assert.fail('Not a matching episode') } });
  await assert.rejects(store.getTranscript(show, 833), TranscriptError);
});

test('rejects conflicting URL and title numbers even if the displayed field matches', async t => {
  const slug = 'transcript-mbmbam-836-other-episode';
  const pages = results(835, [slug]);
  pages.set(`${base}/transcripts/?_podcast=${show}&_search=835&_paged=2`, '');
  const { store } = await setup(t, pages);
  await assert.rejects(store.getTranscript(show, 835), TranscriptError);
});

test('reload replaces PDF, metadata, and extracted text and shares concurrent reloads', async t => {
  const pages = results(710);
  let parses = 0;
  const { store, cacheDir, calls } = await setup(t, pages, { extractText: async buffer => {
    parses++;
    return buffer.equals(pdf) ? 'Old searchable passage\n' : 'Replacement searchable passage\n';
  } });
  await store.getTranscript(show, 710);
  assert.equal(parses, 1);
  const replacement = Buffer.from('%PDF-1.4\nReplacement PDF');
  pages.set(`${base}/wp-content/uploads/test.pdf`, replacement);
  pages.set(`${base}/transcripts/${show}/unusual-page-name/`, page(710).replace('A title &amp; more', 'Updated title'));
  assert.deepEqual((await store.getTranscript(show, 710, false)).pdf, pdf);
  assert.equal(calls.length, 3);
  const [first, second] = await Promise.all([store.getTranscript(show, 710, true), store.getTranscript(show, 710, true)]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.pdf, replacement);
  assert.equal(first.title, 'MBMBaM 710: Updated title');
  assert.equal(calls.length, 6);
  assert.equal(parses, 2);
  const directory = path.join(cacheDir, show);
  assert.deepEqual(await readFile(path.join(directory, '710.pdf')), replacement);
  assert.equal(JSON.parse(await readFile(path.join(directory, '710.json'), 'utf8')).title, first.title);
  assert.equal(await readFile(path.join(directory, '710.txt'), 'utf8'), 'Replacement searchable passage\n');
  assert.deepEqual((await readdir(directory)).sort(), ['710.json', '710.pdf', '710.txt']);
  assert.equal((await store.searchTranscripts({ query: 'Replacement searchable passage' })).matches.length, 1);
  assert.equal((await store.searchTranscripts({ query: 'Old searchable passage' })).matches.length, 0);
});

test('failed reloads leave all existing cached files intact and allow a subsequent retry', async t => {
  const pages = results(710);
  let parseFailure = false;
  const { store, cacheDir } = await setup(t, pages, { extractText: async () => {
    if (parseFailure) throw new Error('PDF parsing failed');
    return 'Existing searchable text\n';
  } });
  await store.getTranscript(show, 710);
  const paths = ['710.pdf', '710.json', '710.txt'].map(file => path.join(cacheDir, show, file));
  const originals = await Promise.all(paths.map(file => readFile(file)));
  for (const stage of ['search', 'download', 'invalid-pdf', 'parse']) {
    const searchURL = `${base}/transcripts/?_podcast=${show}&_search=710`;
    const downloadURL = `${base}/wp-content/uploads/test.pdf`;
    const savedSearch = pages.get(searchURL);
    pages.set(searchURL, stage === 'search' ? new Response('Unavailable', {status: 503}) : savedSearch);
    pages.set(downloadURL, stage === 'download' ? new Response('Unavailable', {status: 503}) : stage === 'invalid-pdf' ? '<html>Error</html>' : pdf);
    parseFailure = stage === 'parse';
    await assert.rejects(store.getTranscript(show, 710, true));
    const after = await Promise.all(paths.map(file => readFile(file)));
    assert.deepEqual(after, originals, `Cache must survive ${stage} failure`);
    assert.deepEqual((await store.getTranscript(show, 710)).pdf, pdf);
    pages.set(searchURL, savedSearch);
  }
  parseFailure = false;
  await store.getTranscript(show, 710, true);
  assert.deepEqual((await readdir(path.join(cacheDir, show))).sort(), ['710.json', '710.pdf', '710.txt']);
});

test('reload arriving during a normal fetch performs a new fetch after it completes', async t => {
  const pages = results(710);
  let release;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const { store } = await setup(t, pages, { fetchImpl: async url => {
    requests++;
    if (requests === 1) { started(); await gate; }
    return new Response(pages.get(url));
  } });
  const normal = store.getTranscript(show, 710);
  await start;
  const reload = store.getTranscript(show, 710, true);
  release();
  await Promise.all([normal, reload]);
  assert.equal(requests, 6);
});

test('uses subsequent search result pages', async t => {
  const pages = results(22, ['wrong']);
  pages.set(`${base}/transcripts/${show}/wrong/`, page(222));
  pages.set(`${base}/transcripts/?_podcast=${show}&_search=22&_paged=2`, `<a href="/transcripts/${show}/outlier/">22</a>`);
  pages.set(`${base}/transcripts/${show}/outlier/`, page(22));
  const { store } = await setup(t, pages);
  assert.equal((await store.getTranscript(show, 22)).episode, 22);
});

test('reports missing transcripts', async t => {
  const { store } = await setup(t, results(22, []));
  await assert.rejects(store.getTranscript(show, 22), TranscriptError);
});

test('retries a short episode number with leading zeros for older transcripts', async t => {
  const pages = results(22);
  pages.set(`${base}/transcripts/?_podcast=${show}&_search=022`, pages.get(`${base}/transcripts/?_podcast=${show}&_search=22`));
  pages.set(`${base}/transcripts/?_podcast=${show}&_search=22`, 'No results');
  pages.set(`${base}/transcripts/${show}/unusual-page-name/`, page('022'));
  const { store } = await setup(t, pages);
  assert.equal((await store.getTranscript(show, 22)).title, 'MBMBaM 022: A title & more');
});

test('rejects HTML masquerading as a PDF and retries failed lookups', async t => {
  const pages = results(22);
  pages.set(`${base}/wp-content/uploads/test.pdf`, '<html>Error</html>');
  const { store } = await setup(t, pages);
  await assert.rejects(store.getTranscript(show, 22), /not a PDF/);
  pages.set(`${base}/wp-content/uploads/test.pdf`, pdf);
  assert.deepEqual((await store.getTranscript(show, 22)).pdf, pdf);
});

test('repairs corrupt cache and shares simultaneous downloads', async t => {
  const { store, cacheDir, calls } = await setup(t, results(22));
  await Promise.all([store.getTranscript(show, 22), store.getTranscript(show, 22)]);
  assert.equal(calls.length, 3);
  await writeFile(path.join(cacheDir, show, '22.pdf'), 'broken');
  await store.getTranscript(show, 22);
  assert.equal(calls.length, 6);
  await writeFile(path.join(cacheDir, show, '22.json'), '{broken');
  await store.getTranscript(show, 22);
  assert.equal(calls.length, 9);
  await writeFile(path.join(cacheDir, show, '22.json'), 'null');
  await store.getTranscript(show, 22);
  assert.equal(calls.length, 12);
});

test('edits deferred response with multipart PDF and correct attachment reference', async () => {
  await editTranscriptResponse({ application_id: 'app', token: 'token' }, { content: 'Episode' }, {
    filename: '22.pdf', pdf,
  }, async (url, options) => {
    assert.equal(url, 'https://discord.com/api/v10/webhooks/app/token/messages/@original');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body.get('payload_json')), {
      content: 'Episode', attachments: [{ id: 0, filename: '22.pdf' }],
    });
    assert.deepEqual(Buffer.from(await options.body.get('files[0]').arrayBuffer()), pdf);
    return new Response('{}');
  });
});

const interaction = { data: { options: [{ name: 'episode', value: 22 }, { name: 'show', value: show }] } };

test('returns metadata and PDF to Discord', async () => {
  const edits = [];
  await respondWithTranscript(interaction, {
    store: { getTranscript: async (s, ep) => {
      assert.equal(s, show);
      assert.equal(ep, 22);
      return { show: 'Show', episode: 22, title: 'Title', description: 'Description', pdf };
    } },
    edit: async (...args) => edits.push(args),
  });
  assert.equal(edits[0][1].embeds[0].title, 'Title');
  assert.equal(edits[0][1].embeds[0].description, 'Description');
  assert.deepEqual(edits[0][2].pdf, pdf);
});

test('passes the optional reload boolean from Discord to the transcript store', async () => {
  let received;
  await respondWithTranscript({ ...interaction, data: { options: [...interaction.data.options, {name: 'reload', value: true}] } }, {
    store: { getTranscript: async (...options) => {
      received = options;
      return { title: 'Title', description: 'Description', pdf };
    } }, edit: async () => {},
  });
  assert.deepEqual(received, [show, 22, true]);
});

test('sends useful errors and handles Discord upload failures', async () => {
  const messages = [];
  for (const error of [new TranscriptError('Not found'), new Error('Network error')]) {
    await respondWithTranscript(interaction, {
      store: { getTranscript: async () => { throw error; } },
      edit: async (_, payload) => messages.push(payload), logger: { error() {} },
    });
  }
  assert.equal(messages[0].content, 'Not found');
  assert.match(messages[1].content, /try again/);
  let count = 0;
  await respondWithTranscript(interaction, {
    store: { getTranscript: async () => ({ show: 'Show', episode: 22, title: 'Title', description: 'Description', pdf }) },
    edit: async () => { if (++count === 1) throw new Error('Upload failed'); },
    logger: { error() {} },
  });
  assert.equal(count, 2);
});

test('offers download link if the PDF exceeds Discord attachment limit', async () => {
  await respondWithTranscript({ ...interaction, attachment_size_limit: 1 }, {
    store: { getTranscript: async () => ({ pdf, pdfUrl: `${base}/test.pdf` }) },
    edit: async (_, payload, file) => {
      assert.equal(file, undefined);
      assert.match(payload.content, /https:\/\/maximumfun.org\/test.pdf/);
    }, logger: { error() {} },
  });
});
