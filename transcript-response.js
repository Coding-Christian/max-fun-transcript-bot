import { TranscriptError, transcriptStore } from './transcripts.js';

export async function editTranscriptResponse(interaction, payload, file, fetchImpl = globalThis.fetch) {
  let body;
  const headers = {};
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
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    { method: 'PATCH', headers, body, signal: AbortSignal.timeout(30_000) },
  );
  // Do not include webhook URLs or interaction tokens in errors/logs.
  if (!response.ok) throw new Error(`Discord response failed (HTTP ${response.status}).`);
}

export async function respondWithTranscript(interaction, {
  store = transcriptStore,
  edit = editTranscriptResponse,
  logger = console,
} = {}) {
  try {
    const options = Object.fromEntries(interaction.data.options.map(({ name, value }) => [name, value]));
    const transcript = await store.getTranscript(options.show, options.episode);
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
    logger.error('Transcript request failed:', error.name);
    const content = error instanceof TranscriptError ? error.message :
      'Unable to retrieve or send the transcript right now. Please try again later.';
    try {
      await edit(interaction, { content, embeds: [], attachments: [], allowed_mentions: { parse: [] } });
    } catch (error) {
      logger.error('Could not send transcript error response:', error.name);
    }
  }
}
