export const SHOWS = {
  'my-brother-my-brother-and-me': { name: 'My Brother, My Brother and Me' },
};

export const TRANSCRIPT_COMMAND = {
  name: 'transcript',
  description: 'Find and download a podcast episode transcript.',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      name: 'show',
      description: 'The podcast to find a transcript for.',
      type: 3,
      required: true,
      choices: Object.entries(SHOWS).map(([value, { name }]) => ({ name, value })),
    },
    {
      name: 'episode',
      description: 'The episode number (greater than 1).',
      type: 4,
      required: true,
      min_value: 2,
    },
    {
      name: 'reload',
      description: 'Download a fresh copy and replace the cached transcript.',
      type: 5,
      required: false,
    },
  ],
};

export function validateTranscriptOptions(show, episode, reload = false) {
  if (!Object.hasOwn(SHOWS, show)) throw new Error('Please select a supported show.');
  if (!Number.isSafeInteger(episode) || episode <= 1) {
    throw new Error('Episode must be an integer greater than 1.');
  }
  if (typeof reload !== 'boolean') throw new Error('Reload must be true or false.');
}
