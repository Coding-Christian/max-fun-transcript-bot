export const SHOWS = {
  'my-brother-my-brother-and-me': { name: 'My Brother, My Brother and Me' },
};

export const TRANSCRIPT_COMMAND = {
  name: 'transcript',
  description: 'Download and index transcripts for a list or range of episodes.',
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
      name: 'episodes',
      description: 'Episode numbers and inclusive ranges, separated by commas (for example, 1,5-10).',
      type: 3,
      required: true,
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
  if (!Number.isSafeInteger(episode) || episode < 1) {
    throw new Error('Episode must be a positive integer.');
  }
  if (typeof reload !== 'boolean') throw new Error('Reload must be true or false.');
}

export function parseEpisodes(value) {
  const malformed = () => new Error('Malformed episodes option. Use positive episode numbers separated only by commas and hyphens, for example: 1,5-10. Ranges must be ascending.');
  if (typeof value !== 'string') throw malformed();
  const compact = value.replace(/\s/g, '');
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(compact)) throw malformed();
  const ranges = compact.split(',').map(part => {
    const [first, last = first] = part.split('-').map(Number);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw malformed();
    return [first, last];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [first, last] of ranges) {
    const previous = merged.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  const count = merged.reduce((sum, [first, last]) => sum + (last - first + 1), 0);
  if (!Number.isSafeInteger(count)) throw malformed();
  // Iterate lazily so validating a large range doesn't allocate every episode.
  return {
    ranges: merged,
    count,
    *[Symbol.iterator]() {
      for (const [first, last] of merged) {
        for (let episode = first; episode <= last; episode++) yield episode;
      }
    },
  };
}

export function validateBulkTranscriptOptions({ show, episodes, reload }) {
  const selection = parseEpisodes(episodes);
  validateTranscriptOptions(show, selection.ranges[0][0], reload);
  return selection;
}
