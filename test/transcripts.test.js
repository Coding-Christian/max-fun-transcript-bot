import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTranscriptStore, TranscriptError } from '../transcripts.js';
import { TRANSCRIPT_COMMAND, validateTranscriptOptions, parseEpisodes, validateBulkTranscriptOptions, validateTranscriptURL } from '../transcript-command.js';
import { editTranscriptResponse, respondWithTranscript, completeTranscriptResponse } from '../transcript-response.js';

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
  const store = createTranscriptStore({ cacheDir, extractText: async () => 'Test transcript text\n', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual');
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
    [`${base}/episodes/?_podcast=${show}&_search=${episode}`, ''],
    ...(episode < 100 ? [[`${base}/transcripts/?_podcast=${show}&_search=${String(episode).padStart(3, '0')}`, '']] : []),
  ]);
}

test('command requires a supported show and episode list with optional reload', () => {
  assert.equal(TRANSCRIPT_COMMAND.name, 'transcript');
  assert.deepEqual(TRANSCRIPT_COMMAND.options.map(o => [o.name, o.required]), [['show', true], ['episodes', true], ['reload', false], ['url', false]]);
  assert.equal(TRANSCRIPT_COMMAND.options[0].choices.length, 1);
  assert.equal(TRANSCRIPT_COMMAND.options[1].type, 3);
  validateTranscriptOptions(show, 1);
  validateTranscriptOptions(show, 2);
  assert.equal(TRANSCRIPT_COMMAND.options[2].type, 5);
  assert.equal(TRANSCRIPT_COMMAND.options[3].type, 3);
  validateTranscriptOptions(show, 2, true);
  validateTranscriptOptions(show, 2, false);
  for (const reload of ['true', 1, null]) assert.throws(() => validateTranscriptOptions(show, 2, reload));
  for (const episode of [0, -1, 2.1, '838', undefined, NaN]) {
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

test('episode 1 can be downloaded and is included in the searchable library', async t => {
  const { store } = await setup(t, results(1));
  assert.equal((await store.getTranscript(show, 1)).episode, 1);
  const result = await store.searchTranscripts({query: 'Test transcript text'});
  assert.equal(result.matches[0].episode, 1);
  assert.deepEqual(result.missing[0].ranges, []);
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

test('uses from-episode-number when the URL, title, or both omit a number', async t => {
  for (const [slug, heading] of [
    ['transcript-mbmbam-am-i-the-sphincter', 'TRANSCRIPT MBMBaM: Am I the Sphincter?'],
    ['transcript-mbmbam-677-am-i-the-sphincter', 'TRANSCRIPT MBMBaM: Am I the Sphincter?'],
    ['transcript-mbmbam-am-i-the-sphincter', 'TRANSCRIPT MBMBaM 678: Am I the Sphincter?'],
    ['transcript-mbmbam-678-am-i-the-sphincter', 'TRANSCRIPT MBMBaM: Am I the Sphincter?'],
  ]) {
    for (const plainText of [false, true]) {
      const pages = results(677, [slug]);
      let html = page(677).replace('TRANSCRIPT MBMBaM 677: A title &amp; more', heading);
      if (plainText) html = html.replace('<a>677</a>', '<strong>Episode number:</strong> 677');
      pages.set(`${base}/transcripts/${show}/${slug}/`, html);
      const {store} = await setup(t, pages);
      const transcript = await store.getTranscript(show, 677);
      assert.equal(transcript.episode, 677);
      assert.equal(transcript.filename, `${show}-677.pdf`);
      assert.deepEqual(transcript.pdf, pdf);
    }
  }
});

test('finds unnumbered transcripts through episode pages when numeric transcript search has no results', async t => {
  const transcriptURL = `${base}/transcripts/${show}/transcript-mbmbam-am-i-the-sphincter/`;
  const episodeURL = `${base}/episodes/${show}/mbmbam-677-am-i-the-sphincter/`;
  const pages = results(677, []);
  pages.set(`${base}/episodes/?_podcast=${show}&_search=677`, `<a href="${episodeURL}">MBMBaM 677: Am I the Sphincter?</a><a href="${episodeURL}">Duplicate image link</a><a href="/episodes/${show}/mbmbam-1677-unrelated/">Unrelated result</a>`);
  pages.set(episodeURL, `<h1>MBMBaM 677: Am I the Sphincter?</h1><a href="${transcriptURL}">Read transcript</a>`);
  pages.set(transcriptURL, page(677).replace('TRANSCRIPT MBMBaM 677: A title &amp; more', 'TRANSCRIPT MBMBaM: Am I the Sphincter?'));
  const {store, calls} = await setup(t, pages);
  const transcript = await store.getTranscript(show, 677);
  assert.equal(transcript.episode, 677);
  assert.equal(transcript.sourceUrl, transcriptURL);
  assert.deepEqual(transcript.pdf, pdf);
  assert.deepEqual(calls, [
    `${base}/transcripts/?_podcast=${show}&_search=677`,
    `${base}/episodes/?_podcast=${show}&_search=677`,
    episodeURL, transcriptURL, `${base}/wp-content/uploads/test.pdf`,
  ]);
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

test('parses lists and inclusive ranges after removing spaces and deduplicates overlaps', () => {
  assert.deepEqual([...parseEpisodes(' 1, 5 - 10 ')], [1, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...parseEpisodes('10,5-7,6-9,1,1,05')], [1, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...parseEpisodes('3-3')], [3]);
  assert.equal(parseEpisodes('1,5-10').count, 7);
  const huge = parseEpisodes('1-9007199254740991');
  assert.equal(huge.count, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(huge.ranges, [[1, Number.MAX_SAFE_INTEGER]]);
  assert.deepEqual([...validateBulkTranscriptOptions({show, episodes: '1,5-6', reload: true})], [1, 5, 6]);
});

test('rejects malformed episode selections before any download', async () => {
  for (const value of ['', ' ', '1,', ',1', '1,,2', '1--2', '1-2-3', '5-1', '0', '0-3', '-1', '1.5', '1;2', '1/2', '1–3', '+1', '1e2', '9007199254740992', undefined, 2]) {
    assert.throws(() => parseEpisodes(value), /Malformed episodes option/, String(value));
  }
  const messages = [];
  await respondWithTranscript({data: {options: [{name: 'show', value: show}, {name: 'episodes', value: '1,,5'}]}}, {
    store: {getTranscript: () => assert.fail('Malformed options must not start downloads')},
    edit: async (_, payload) => messages.push(payload),
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Malformed episodes option/);
});

const bulkInteraction = {
  application_id: 'app', token: 'token',
  data: {options: [{name: 'show', value: show}, {name: 'episodes', value: '1,3-5,4'}]},
};

test('announces bulk work before fetching, processes serially, and pauses one second between episodes', async () => {
  const events = [];
  const edits = [];
  await respondWithTranscript(bulkInteraction, {
    store: {getTranscript: async (slug, episode) => {
      assert.equal(slug, show);
      events.push(['fetch', episode]);
      return { pdf };
    }},
    edit: async (_, payload, file) => {
      events.push(['edit']);
      edits.push(payload);
      assert.equal(file, undefined, 'Bulk downloads must not attach transcript PDFs');
      return {id: 'original', channel_id: 'channel'};
    },
    wait: async ms => events.push(['wait', ms]),
  });
  assert.deepEqual(events, [['edit'], ['fetch', 1], ['wait', 1000], ['fetch', 3], ['wait', 1000], ['fetch', 4], ['wait', 1000], ['fetch', 5], ['edit']]);
  assert.equal(edits.length, 2);
  assert.match(edits[0].content, /commenced.*4 episodes/);
  assert.match(edits[1].content, /download complete/);
  assert.match(edits[1].content, /Processed: 4.*: 4\. Failed: 0/);
  assert.match(edits[1].content, /Episodes: 1,3-5,4/);
  assert.match(edits[1].content, /No episodes failed/);
});

test('continues after individual failures and reports every failed episode in the edited summary', async () => {
  const calls = [];
  const messages = [];
  const logs = [];
  await respondWithTranscript(bulkInteraction, {
    store: {getTranscript: async (_, episode) => {
      calls.push(episode);
      if (episode === 3 || episode === 4) throw new TranscriptError('No PDF published');
    }},
    wait: async ms => assert.equal(ms, 1000),
    edit: async (_, payload, file) => { messages.push(payload); assert.equal(file, undefined); },
    logger: {error: (...args) => logs.push(args.join(' '))},
  });
  assert.deepEqual(calls, [1, 3, 4, 5]);
  assert.match(messages.at(-1).content, /Processed: 4.*: 2\. Failed: 2/);
  assert.match(messages.at(-1).content, /Failed episodes: 3-4/);
  assert.match(messages.at(-1).content, /Episodes: 1,3-5,4/);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /episode 3: No PDF published/);
});

test('single-episode requests honor reload without a leading or trailing pause', async () => {
  let received;
  await respondWithTranscript({ ...bulkInteraction, data: {options: [
    {name: 'show', value: show}, {name: 'episodes', value: '835'}, {name: 'reload', value: true},
  ]}}, {
    store: {getTranscript: async (...args) => {
      received = args;
      return {title: 'Episode 835', description: 'Episode description', pdf};
    }},
    edit: async (_, payload, file) => {
      assert.equal(payload.embeds[0].title, 'Episode 835');
      assert.deepEqual(file.pdf, pdf);
    },
    wait: () => assert.fail('Only pause between episodes'),
  });
  assert.deepEqual(received, [show, 835, true, undefined]);
});

test('a selection resolving to one episode returns its metadata and PDF with no bulk announcement', async () => {
  for (const episodes of ['11', ' 11 ', '11-11', '11,11']) {
    const events = [];
    const transcript = {title: 'MBMBaM 11: Episode title', description: 'Episode description', sourceUrl: `${base}/episode-11/`, filename: '11.pdf', pdf};
    await respondWithTranscript({...bulkInteraction, data: {options: [{name: 'show', value: show}, {name: 'episodes', value: episodes}]}}, {
      store: {getTranscript: async (slug, episode) => {
        assert.equal(slug, show);
        assert.equal(episode, 11);
        events.push('fetch');
        return transcript;
      }},
      edit: async (_, payload, file) => {
        events.push('edit');
        assert.deepEqual(payload.embeds, [{title: transcript.title, url: transcript.sourceUrl, description: transcript.description}]);
        assert.equal(payload.content, undefined);
        assert.equal(file, transcript);
        assert.deepEqual(payload.allowed_mentions, {parse: []});
      },
      wait: () => assert.fail('A single episode has no pauses'),
    });
    assert.deepEqual(events, ['fetch', 'edit']);
  }
});

test('single-episode errors return useful messages instead of bulk completion summaries', async () => {
  for (const error of [new TranscriptError('No PDF transcript was found.'), new Error('Network error')]) {
    const messages = [];
    await respondWithTranscript({...bulkInteraction, data: {options: [{name: 'show', value: show}, {name: 'episodes', value: '11'}]}}, {
      store: {getTranscript: async () => {throw error;}},
      edit: async (_, payload, file) => {messages.push(payload); assert.equal(file, undefined);},
      logger: {error() {}},
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, error instanceof TranscriptError ? error.message : 'Unable to retrieve or send the transcript right now. Please try again later.');
    assert.deepEqual(messages[0].attachments, []);
  }
});

test('single-episode requests link PDFs exceeding the attachment limit', async () => {
  await respondWithTranscript({...bulkInteraction, attachment_size_limit: 1, data: {options: [{name: 'show', value: show}, {name: 'episodes', value: '11'}]}}, {
    store: {getTranscript: async () => ({pdf, pdfUrl: `${base}/episode-11.pdf`})},
    edit: async (_, payload, file) => {
      assert.equal(file, undefined);
      assert.match(payload.content, /exceeds Discord's attachment limit/);
      assert.match(payload.content, /https:\/\/maximumfun.org\/episode-11.pdf/);
    },
    logger: {error() {}},
  });
});

test('long failure lists are preserved in a text report without attaching PDFs', async () => {
  let report;
  await respondWithTranscript({ ...bulkInteraction, data: {options: [
    {name: 'show', value: show}, {name: 'episodes', value: '1-2001'},
  ]}}, {
    store: {getTranscript: async (_, episode) => { if (episode % 2) throw new Error('Not found'); }},
    edit: async (_, payload, file) => {
      assert.ok(payload.content.length <= 2000);
      if (file) report = file;
    },
    logger: {error() {}}, wait: async () => {},
  });
  assert.equal(report.filename, 'failed-episodes.txt');
  assert.equal(report.contentType, 'text/plain');
  assert.match(report.pdf.toString(), /Episodes: 1-2001/);
  assert.match(report.pdf.toString(), /Failed episodes: 1,3,5/);
  assert.ok(report.pdf.toString().endsWith('1999,2001.'));
});

test('long-running jobs edit the same channel message when the interaction token has expired', async () => {
  const original = {id: 'original', channel_id: 'channel'};
  const payload = {content: 'Bulk transcript download complete', allowed_mentions: {parse: []}};
  let requests = 0;
  await completeTranscriptResponse(bulkInteraction, payload, original, {
    edit: async () => { throw new Error('Discord response failed (HTTP 401).'); },
    botToken: 'test-bot-token',
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, 'https://discord.com/api/v10/channels/channel/messages/original');
      assert.equal(options.method, 'PATCH');
      assert.equal(options.headers.Authorization, 'Bot test-bot-token');
      assert.deepEqual(JSON.parse(options.body), payload);
      return new Response(JSON.stringify(original));
    },
  });
  assert.equal(requests, 1);
});

const overrideURL = `${base}/transcripts/${show}/transcript-mbmbam-816-pain-is-funny-leaving-the-body/`;

test('URL overrides accept only Maximum Fun transcript episode pages and one requested episode', () => {
  assert.equal(validateTranscriptURL(overrideURL), overrideURL);
  assert.equal(validateTranscriptURL(`${base}/transcripts/unusually-named-episode/`), `${base}/transcripts/unusually-named-episode/`);
  assert.equal(validateTranscriptURL(overrideURL + '#pdf'), overrideURL);
  for (const invalid of [
    '', undefined, 815, 'https://evil.example/transcripts/show/episode/',
    'http://maximumfun.org/transcripts/show/episode/',
    'https://maximumfun.org.evil.example/transcripts/show/episode/',
    'https://maximumfun.org@evil.example/transcripts/show/episode/',
    'https://user:password@maximumfun.org/transcripts/show/episode/',
    'https://maximumfun.org/episodes/show/episode/',
    'https://maximumfun.org/transcripts/',
    'https://maximumfun.org/transcripts/../episodes/show/episode/',
    'https://maximumfun.org/transcripts/%2e%2e/episodes/show/episode/',
    'https://maximumfun.org/transcripts/show/%2e%2e%2f%2e%2e%2fepisodes/',
    'https://maximumfun.org/transcripts/show/evil\\path/',
    ' ' + overrideURL,
  ]) assert.throws(() => validateTranscriptURL(invalid), /Invalid url option/, String(invalid));
  assert.equal(validateBulkTranscriptOptions({show, episodes: '815', url: overrideURL}).count, 1);
  assert.throws(() => validateBulkTranscriptOptions({show, episodes: '815-816', url: overrideURL}), /only be used with one episode/);
});

test('URL override bypasses all episode-number checks, refreshes cached files and records the requested episode', async t => {
  const pages = results(815);
  const warnings = [];
  const replacement = Buffer.from('%PDF-1.4\nCorrected transcript');
  const {store, calls, cacheDir} = await setup(t, pages, {
    logger: {warn: message => warnings.push(message)},
    extractText: async buffer => buffer.equals(pdf) ? 'Original searchable passage' : 'Corrected searchable passage',
  });
  await store.getTranscript(show, 815);
  pages.set(overrideURL, page(816).replace('<a>816</a>', '<a>818</a>'));
  pages.set(`${base}/wp-content/uploads/test.pdf`, replacement);
  const result = await store.getTranscript(show, 815, false, overrideURL);
  assert.deepEqual(calls.slice(3), [overrideURL, `${base}/wp-content/uploads/test.pdf`]);
  assert.equal(result.episode, 815);
  assert.equal(result.title, 'MBMBaM 815: A title & more');
  assert.equal(result.sourceTitle, 'TRANSCRIPT MBMBaM 816: A title & more');
  assert.equal(result.filename, `${show}-815.pdf`);
  assert.equal(result.sourceUrl, overrideURL);
  assert.deepEqual(result.pdf, replacement);
  const directory = path.join(cacheDir, show);
  assert.deepEqual((await readdir(directory)).sort(), ['815.json', '815.pdf', '815.txt']);
  assert.equal(JSON.parse(await readFile(path.join(directory, '815.json'), 'utf8')).episode, 815);
  assert.equal(await readFile(path.join(directory, '815.txt'), 'utf8'), 'Corrected searchable passage');
  assert.match(warnings[0], /as episode 815; URL number: 816, title number: 816, from-episode-number: 818/);
  await store.getTranscript(show, 815);
  assert.equal(calls.length, 5);
  await store.getTranscript(show, 815, false, overrideURL);
  assert.equal(calls.length, 7, 'An explicit URL must fetch again without requiring reload:true');
  assert.equal((await store.searchTranscripts({query: 'Corrected searchable passage'})).matches[0].episode, 815);
});

test('invalid URL overrides are rejected before any HTTP request or cache access', async t => {
  const {store, calls} = await setup(t, new Map());
  await assert.rejects(store.getTranscript(show, 815, false, 'https://evil.example/transcripts/show/episode/'), /Invalid url option/);
  assert.equal(calls.length, 0);
});

test('page redirects cannot escape the allowed transcript prefix or Maximum Fun host', async t => {
  for (const location of ['https://evil.example/page/', `${base}/episodes/show/episode/`]) {
    const pages = new Map([[overrideURL, new Response('', {status: 302, headers: {location}})]]);
    const {store, calls} = await setup(t, pages);
    await assert.rejects(store.getTranscript(show, 815, false, overrideURL), /Unexpected transcript URL|Invalid url option/);
    assert.deepEqual(calls, [overrideURL]);
  }
});

test('same-site transcript redirects are followed and PDF redirects cannot leave Maximum Fun', async t => {
  const redirected = `${base}/transcripts/${show}/redirected-transcript/`;
  const pages = new Map([
    [overrideURL, new Response('', {status: 301, headers: {location: redirected}})],
    [redirected, page(815)],
    [`${base}/wp-content/uploads/test.pdf`, pdf],
  ]);
  const {store, calls} = await setup(t, pages);
  assert.equal((await store.getTranscript(show, 815, false, overrideURL)).episode, 815);
  assert.deepEqual(calls, [overrideURL, redirected, `${base}/wp-content/uploads/test.pdf`]);
  pages.set(`${base}/wp-content/uploads/test.pdf`, new Response('', {status: 302, headers: {location: 'https://evil.example/file.pdf'}}));
  await assert.rejects(store.getTranscript(show, 815, false, overrideURL), /Unexpected transcript URL/);
});

test('an override page without a PDF link fails clearly and preserves the existing cached transcript', async t => {
  const pages = results(815);
  const {store, cacheDir} = await setup(t, pages);
  await store.getTranscript(show, 815);
  pages.set(overrideURL, '<h1>Missing download button</h1>');
  await assert.rejects(store.getTranscript(show, 815, false, overrideURL), /No PDF transcript download link/);
  assert.deepEqual((await store.getTranscript(show, 815)).pdf, pdf);
  assert.deepEqual((await readdir(path.join(cacheDir, show))).sort(), ['815.json', '815.pdf', '815.txt']);
});

test('single-episode Discord requests pass the URL override and return the PDF attachment', async () => {
  let received;
  await respondWithTranscript({...bulkInteraction, data: {options: [
    {name: 'show', value: show}, {name: 'episodes', value: '815'}, {name: 'url', value: overrideURL},
  ]}}, {
    store: {getTranscript: async (...args) => {
      received = args;
      return {title: 'MBMBaM 815: Pain Is Funny Leaving The Body', description: 'Description', pdf};
    }},
    edit: async (_, payload, file) => {
      assert.equal(payload.embeds[0].title, 'MBMBaM 815: Pain Is Funny Leaving The Body');
      assert.deepEqual(file.pdf, pdf);
    },
  });
  assert.deepEqual(received, [show, 815, undefined, overrideURL]);
});
