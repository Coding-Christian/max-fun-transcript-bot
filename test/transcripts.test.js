import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function setup(t, pages) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'transcript-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const calls = [];
  const store = createTranscriptStore({ cacheDir, fetchImpl: async (url) => {
    calls.push(url);
    assert.ok(pages.has(url), `Unexpected request: ${url}`);
    const data = pages.get(url);
    return new Response(data, { status: 200 });
  } });
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
  assert.deepEqual(TRANSCRIPT_COMMAND.options.map(o => [o.name, o.required]), [['show', true], ['episode', true]]);
  assert.equal(TRANSCRIPT_COMMAND.options[0].choices.length, 1);
  assert.equal(TRANSCRIPT_COMMAND.options[1].min_value, 2);
  validateTranscriptOptions(show, 2);
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
  assert.equal(first.title, 'A title & more');
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
  assert.equal((await store.getTranscript(show, 22)).title, 'A title & more');
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
  assert.equal(edits[0][1].embeds[0].title, 'Show — Episode 22');
  assert.equal(edits[0][1].embeds[0].description, 'Description');
  assert.deepEqual(edits[0][2].pdf, pdf);
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
