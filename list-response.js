import { SHOWS } from './transcript-command.js';
import { validateListOptions } from './list-command.js';
import { transcriptStore } from './transcripts.js';
import { editTranscriptResponse } from './transcript-response.js';

export async function respondWithList(interaction, {
  store = transcriptStore,
  edit = editTranscriptResponse,
  logger = console,
} = {}) {
  try {
    const options = Object.fromEntries((interaction.data.options || []).map(({ name, value }) => [name, value]));
    validateListOptions(options);
    const episodes = await store.listTranscripts(options.show);
    const show = SHOWS[options.show].name;
    const content = episodes.length
      ? `Downloaded transcripts for ${show} (${episodes.length} episode${episodes.length === 1 ? '' : 's'}):\n${episodes.map(entry => entry.episode).join(', ')}`
      : `No transcripts have been downloaded for ${show} yet. Use /transcript to download episodes.`;
    if (content.length <= 2000) {
      await edit(interaction, { content, allowed_mentions: { parse: [] } });
    } else {
      await edit(interaction, {
        content: `${episodes.length} episodes have downloaded transcripts for ${show}. The complete list is attached.`,
        allowed_mentions: { parse: [] },
      }, { filename: 'downloaded-episodes.txt', pdf: Buffer.from(content), contentType: 'text/plain' });
    }
  } catch (error) {
    logger.error('Transcript list failed:', error.message);
    try {
      await edit(interaction, {
        content: 'Unable to list downloaded transcripts right now. Please try again later.',
        allowed_mentions: { parse: [] },
      });
    } catch (responseError) {
      logger.error('Could not send list error response:', responseError.message);
    }
  }
}
