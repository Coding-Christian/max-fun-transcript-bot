import { setTimeout as delay } from 'node:timers/promises';
import { TranscriptError, transcriptStore } from './transcripts.js';
import { SHOWS, validateBulkTranscriptOptions } from './transcript-command.js';

async function editMessage(url, payload, file, fetchImpl, extraHeaders = {}) {
  let body;
  const headers = { ...extraHeaders };
  if (file) {
    const files = Array.isArray(file) ? file : [file];
    body = new FormData();
    body.append('payload_json', JSON.stringify({
      ...payload,
      attachments: files.map((file, id) => ({ id, filename: file.filename })),
    }));
    files.forEach((file, id) => body.append(`files[${id}]`,
      new Blob([file.pdf], { type: file.contentType || 'application/pdf' }), file.filename));
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const response = await fetchImpl(
    url,
    { method: 'PATCH', headers, body, signal: AbortSignal.timeout(30_000) },
  );
  // Do not include webhook URLs or interaction tokens in errors/logs.
  if (!response.ok) throw new Error(`Discord response failed (HTTP ${response.status}).`);
  return response.json();
}

export async function editTranscriptResponse(interaction, payload, file, fetchImpl = globalThis.fetch) {
  return editMessage(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    payload, file, fetchImpl,
  );
}

export async function completeTranscriptResponse(interaction, payload, originalMessage, {
  edit = editTranscriptResponse, file, fetchImpl = globalThis.fetch, botToken = process.env.DISCORD_TOKEN,
} = {}) {
  try {
    return await edit(interaction, payload, file);
  } catch (error) {
    // Interaction tokens expire after 15 minutes. Long jobs can still edit the
    // same public message using the bot's channel permissions and bot token.
    if (!originalMessage?.id || !originalMessage.channel_id || !botToken) throw error;
    return editMessage(
      `https://discord.com/api/v10/channels/${originalMessage.channel_id}/messages/${originalMessage.id}`,
      payload, file, fetchImpl, { Authorization: `Bot ${botToken}` },
    );
  }
}

function episodeList(numbers) {
  const ranges = [];
  for (const number of numbers) {
    const previous = ranges.at(-1);
    if (previous && number === previous[1] + 1) previous[1] = number;
    else ranges.push([number, number]);
  }
  return ranges.map(([first, last]) => first === last ? String(first) : `${first}-${last}`).join(',');
}

export async function respondWithTranscript(interaction, {
  store = transcriptStore,
  edit = editTranscriptResponse,
  logger = console,
  wait = delay,
  fetchImpl = globalThis.fetch,
  botToken = process.env.DISCORD_TOKEN,
} = {}) {
  const options = Object.fromEntries((interaction.data.options || []).map(({ name, value }) => [name, value]));
  let selection;
  try {
    selection = validateBulkTranscriptOptions(options);
  } catch (error) {
    try {
      await edit(interaction, { content: error.message, allowed_mentions: { parse: [] } });
    } catch (responseError) {
      logger.error('Could not send transcript validation response:', responseError.message);
    }
    return;
  }
  if (selection.count === 1) {
    const episode = selection.ranges[0][0];
    try {
      const transcript = await store.getTranscript(options.show, episode, options.reload, options.url);
      if (transcript.pdf.length > (interaction.attachment_size_limit || 10 * 1024 * 1024)) {
        throw new TranscriptError(`This PDF exceeds Discord's attachment limit. Download it from ${transcript.pdfUrl}`);
      }
      await edit(interaction, {
        allowed_mentions: { parse: [] },
        embeds: [{
          title: transcript.title.slice(0, 256),
          url: transcript.sourceUrl,
          description: transcript.description.slice(0, 4096),
        }],
      }, transcript);
    } catch (error) {
      logger.error(`Transcript request failed for ${SHOWS[options.show].name}, episode ${episode}:`, error.message);
      try {
        await edit(interaction, {
          content: error instanceof TranscriptError ? error.message : 'Unable to retrieve or send the transcript right now. Please try again later.',
          embeds: [], attachments: [], allowed_mentions: { parse: [] },
        });
      } catch (responseError) {
        logger.error('Could not send transcript error response:', responseError.message);
      }
    }
    return;
  }
  try {
    const show = SHOWS[options.show].name;
    const originalMessage = await edit(interaction, {
      content: `Bulk transcript download has commenced for ${show}: ${selection.count} episode${selection.count === 1 ? '' : 's'}. ${options.reload ? 'Downloading fresh copies.' : 'Reusing cached transcripts where available.'} This message will be updated when complete.`,
      allowed_mentions: { parse: [] },
    });
    let ready = 0;
    let processed = 0;
    const failed = [];
    for (const episode of selection) {
      if (processed > 0) await wait(1000);
      try {
        await store.getTranscript(options.show, episode, options.reload);
        ready++;
      } catch (error) {
        failed.push(episode);
        logger.error(`Transcript request failed for ${show}, episode ${episode}:`, error.message);
      }
      processed++;
    }
    const counts = `Bulk transcript download complete for ${show}.\nProcessed: ${processed}. Ready (downloaded or already cached): ${ready}. Failed: ${failed.length}.`;
    const summary = `${counts}\nEpisodes: ${options.episodes}`;
    const failures = failed.length ? `Failed episodes: ${episodeList(failed)}.` : 'No episodes failed.';
    const payload = {
      content: `${summary}\n${failures}`,
      embeds: [], attachments: [],
      allowed_mentions: { parse: [] },
    };
    let file;
    if (payload.content.length > 2000) {
      payload.content = `${summary.length <= 1800 ? summary : counts}\nThe requested episodes and complete list of failed episodes are attached as a text report.`;
      file = { filename: 'failed-episodes.txt', pdf: Buffer.from(`${summary}\n${failures}`), contentType: 'text/plain' };
    }
    await completeTranscriptResponse(interaction, payload, originalMessage, { edit, file, fetchImpl, botToken });
  } catch (error) {
    logger.error('Bulk transcript response failed:', error.message);
    try {
      await edit(interaction, { content: 'Unable to start or report the bulk transcript download. Check the server logs for completed downloads and failures.', embeds: [], attachments: [], allowed_mentions: { parse: [] } });
    } catch (error) {
      logger.error('Could not send transcript error response:', error.name);
    }
  }
}
