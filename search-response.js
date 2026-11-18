import { readFile } from 'node:fs/promises';
import { transcriptStore, TranscriptError } from './transcripts.js';
import { editTranscriptResponse } from './transcript-response.js';

const escapeMarkdown = text => text.replace(/[\\`*_{}\[\]()<>|~]/g, '\\$&');

export function noResultsMessage(result) {
  const lines = ['No results found in the downloaded transcripts matching your filters.'];
  for (const { show, highest, ranges, episode } of result.missing) {
    if (highest === undefined) {
      lines.push(`${show}: No transcripts are downloaded yet. Use /transcript to download an episode.`);
    } else if (ranges.length) {
      lines.push(`${show} — Episodes not downloaded below episode ${highest}: ${ranges.map(([first, last]) => first === last ? String(first) : `${first}–${last}`).join(', ')}.`);
    } else if (episode !== undefined) {
      lines.push(`${show}: No missing episodes below ${highest} match the episode filter.`);
    } else {
      lines.push(`${show}: All episodes from 1 through ${highest} are downloaded and searched; no matches found.`);
    }
  }
  lines.push('Search only covers downloaded transcripts; episodes above the highest downloaded number have not been checked.');
  return lines.join('\n\n');
}

export async function respondWithSearch(interaction, {
  store = transcriptStore,
  edit = editTranscriptResponse,
  readPDF = readFile,
  logger = console,
} = {}) {
  try {
    const options = Object.fromEntries((interaction.data.options || []).map(({ name, value }) => [name, value]));
    const result = await store.searchTranscripts(options);
    if (!result.matches.length) {
      const message = noResultsMessage(result);
      if (message.length <= 2000) {
        await edit(interaction, { content: message, allowed_mentions: { parse: [] } });
      } else {
        await edit(interaction, {
          content: 'No results found. The full list of episodes not downloaded is attached. Use /transcript to download them, then search again.',
          allowed_mentions: { parse: [] },
        }, { filename: 'missing-episodes.txt', pdf: Buffer.from(message), contentType: 'text/plain' });
      }
      return;
    }
    const files = [];
    const embeds = [];
    let totalBytes = 0;
    for (const match of result.matches.slice(0, 5)) {
      const pdf = await readPDF(match.pdfPath);
      const embed = {
        title: match.title.slice(0, 256),
        url: match.sourceUrl,
        description: escapeMarkdown(match.excerpt).slice(0, 700),
        footer: { text: `${match.show} — Episode ${match.episode}`.slice(0, 150) },
      };
      if (pdf.length <= (interaction.attachment_size_limit || 10 * 1024 * 1024) && totalBytes + pdf.length <= 25 * 1024 * 1024) {
        files.push({ filename: match.filename, pdf });
        totalBytes += pdf.length;
      } else if (match.pdfUrl) {
        embed.fields = [{ name: 'PDF', value: `[Download transcript](${match.pdfUrl}) (attachment limit exceeded)` }];
      }
      embeds.push(embed);
    }
    await edit(interaction, {
      content: `Found ${result.matches.length} matching episode${result.matches.length === 1 ? '' : 's'}.${result.matches.length > 5 ? ' Showing the first 5; narrow your query or use the show and episode filters for more specific results.' : ''}`,
      embeds,
      allowed_mentions: { parse: [] },
    }, files.length ? files : undefined);
  } catch (error) {
    logger.error('Transcript search failed:', error.name);
    try {
      await edit(interaction, {
        content: error instanceof TranscriptError ? error.message : 'Unable to search downloaded transcripts right now. Please try again later.',
        embeds: [], attachments: [], allowed_mentions: { parse: [] },
      });
    } catch (error) {
      logger.error('Could not send search error response:', error.name);
    }
  }
}
