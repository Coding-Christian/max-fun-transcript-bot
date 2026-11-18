import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LIST_COMMAND, validateListOptions } from '../list-command.js';
import { TRANSCRIPT_COMMAND } from '../transcript-command.js';
import { createTranscriptStore } from '../transcripts.js';
import { respondWithList } from '../list-response.js';

const show = 'my-brother-my-brother-and-me';
const showName = 'My Brother, My Brother and Me';
const interaction = {data: {options: [{name: 'show', value: show}]}};

async function library(t) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'transcript-list-'));
  t.after(() => rm(cacheDir, {recursive: true, force: true}));
  return { cacheDir, store: createTranscriptStore({
    cacheDir,
    fetchImpl: () => assert.fail('Listing must not download'),
    extractText: () => assert.fail('Listing must not extract text'),
  }) };
}

test('list requires the same show choice as transcript', () => {
  assert.equal(LIST_COMMAND.name, 'list');
  assert.equal(LIST_COMMAND.options.length, 1);
  assert.deepEqual(LIST_COMMAND.options[0], TRANSCRIPT_COMMAND.options.find(option => option.name === 'show'));
  assert.equal(LIST_COMMAND.options[0].required, true);
  validateListOptions({show});
  for (const invalid of [undefined, '../escape', '__proto__']) {
    assert.throws(() => validateListOptions({show: invalid}));
  }
});

test('lists downloaded episodes numerically without parsing, excludes incomplete files, and filters by show', async t => {
  const {cacheDir, store} = await library(t);
  const directory = path.join(cacheDir, show);
  await mkdir(directory);
  for (const episode of [22, 5, 1]) {
    await writeFile(path.join(directory, `${episode}.json`), JSON.stringify({show: showName, episode, title: `Episode ${episode}`}));
    await writeFile(path.join(directory, `${episode}.pdf`), '%PDF-1.4\nTest');
  }
  await writeFile(path.join(directory, '3.pdf'), '%PDF-1.4\nOrphan');
  await writeFile(path.join(directory, '4.json'), JSON.stringify({show: showName, episode: 4, title: 'No PDF'}));
  await writeFile(path.join(directory, '6.json'), '{broken');
  await writeFile(path.join(directory, '6.pdf'), '%PDF-1.4\nTest');
  await writeFile(path.join(directory, '7.json'), JSON.stringify({show: showName, episode: 7, title: 'Empty PDF'}));
  await writeFile(path.join(directory, '7.pdf'), '');
  await writeFile(path.join(directory, '8.json.tmp'), '{}');
  await writeFile(path.join(directory, '9.json'), JSON.stringify({show: 'Other show', episode: 9, title: 'Wrong show'}));
  await writeFile(path.join(directory, '9.pdf'), '%PDF-1.4\nTest');
  await mkdir(path.join(cacheDir, 'other-show'));
  await writeFile(path.join(cacheDir, 'other-show', '10.pdf'), '%PDF-1.4\nTest');
  assert.deepEqual((await store.listTranscripts(show)).map(entry => entry.episode), [1, 5, 22]);
  await assert.rejects(store.listTranscripts('../escape'), /supported show/);
});

test('empty caches return an empty list and a useful Discord response', async t => {
  const {store} = await library(t);
  assert.deepEqual(await store.listTranscripts(show), []);
  await respondWithList(interaction, {store, edit: async (_, payload, file) => {
    assert.match(payload.content, /No transcripts have been downloaded/);
    assert.match(payload.content, /\/transcript/);
    assert.equal(file, undefined);
  }});
});

test('Discord response lists episode numbers and count without attaching PDFs', async () => {
  await respondWithList(interaction, {
    store: {listTranscripts: async slug => {
      assert.equal(slug, show);
      return [1, 5, 22].map(episode => ({episode}));
    }},
    edit: async (_, payload, file) => {
      assert.equal(payload.content, `Downloaded transcripts for ${showName} (3 episodes):\n1, 5, 22`);
      assert.equal(file, undefined);
      assert.deepEqual(payload.allowed_mentions, {parse: []});
    },
  });
});

test('long lists are attached completely as plain text', async () => {
  const episodes = Array.from({length: 1000}, (_, i) => ({episode: i * 2 + 1}));
  await respondWithList(interaction, {
    store: {listTranscripts: async () => episodes},
    edit: async (_, payload, file) => {
      assert.ok(payload.content.length <= 2000);
      assert.equal(file.filename, 'downloaded-episodes.txt');
      assert.equal(file.contentType, 'text/plain');
      assert.match(file.pdf.toString(), /1, 3, 5/);
      assert.ok(file.pdf.toString().endsWith('1997, 1999'));
    },
  });
});

test('filesystem failures are reported without an unhandled response error', async () => {
  let edits = 0;
  await respondWithList(interaction, {
    store: {listTranscripts: async () => {throw new Error('Permission denied');}},
    edit: async (_, payload) => { edits++; assert.match(payload.content, /Unable to list/); },
    logger: {error() {}},
  });
  assert.equal(edits, 1);
});
