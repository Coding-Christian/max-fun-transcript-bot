import { TRANSCRIPT_COMMAND, SHOWS, validateTranscriptOptions } from './transcript-command.js';
import { normalizeSearchText } from './transcript-text.js';

export const SEARCH_COMMAND = {
  name: 'search',
  description: 'Search the text of downloaded podcast transcripts.',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    { name: 'query', description: 'Text to search for (up to 100 characters).', type: 3, required: true, min_length: 1, max_length: 100 },
    ...TRANSCRIPT_COMMAND.options.map(option => ({ ...option, required: false })),
  ],
};

export function validateSearchOptions({ query, show, episode }) {
  if (typeof query !== 'string' || !query.trim() || [...query].length > 100 || !normalizeSearchText(query)) {
    throw new Error('Query must contain searchable letters or numbers and be 100 characters or less.');
  }
  if (show !== undefined && !Object.hasOwn(SHOWS, show)) throw new Error('Please select a supported show.');
  if (episode !== undefined) validateTranscriptOptions(show ?? Object.keys(SHOWS)[0], episode);
}
