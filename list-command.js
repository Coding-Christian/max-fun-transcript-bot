import { SHOWS, TRANSCRIPT_COMMAND } from './transcript-command.js';

export const LIST_COMMAND = {
  name: 'list',
  description: 'List downloaded transcript episodes for a show.',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [{ ...TRANSCRIPT_COMMAND.options.find(option => option.name === 'show') }],
};

export function validateListOptions({ show }) {
  if (!Object.hasOwn(SHOWS, show)) throw new Error('Please select a supported show.');
}
