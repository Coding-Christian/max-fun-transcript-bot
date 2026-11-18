import 'dotenv/config';
import express from 'express';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji } from './utils.js';
import { validateBulkTranscriptOptions } from './transcript-command.js';
import { respondWithTranscript } from './transcript-response.js';
import { validateSearchOptions } from './search-command.js';
import { respondWithSearch } from './search-response.js';
import { validateListOptions } from './list-command.js';
import { respondWithList } from './list-response.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction type and data
  const { type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'transcript' || name === 'search' || name === 'list') {
      const options = Object.fromEntries((data.options || []).map(({ name, value }) => [name, value]));
      try {
        if (name === 'transcript') validateBulkTranscriptOptions(options);
        else if (name === 'search') validateSearchOptions(options);
        else validateListOptions(options);
      } catch (error) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: error.message, flags: 64, allowed_mentions: { parse: [] } },
        });
      }
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
      if (name === 'transcript') void respondWithTranscript(req.body);
      else if (name === 'search') void respondWithSearch(req.body);
      else void respondWithList(req.body);
      return;
    }

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
