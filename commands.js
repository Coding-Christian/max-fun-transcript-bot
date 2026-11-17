import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';
import { TRANSCRIPT_COMMAND } from './transcript-command.js';
import { SEARCH_COMMAND } from './search-command.js';

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [TEST_COMMAND, TRANSCRIPT_COMMAND, SEARCH_COMMAND];

try {
  const registered = await InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
  console.log(`Registered global commands: ${registered.map(command => `/${command.name}`).join(', ')}`);
} catch (error) {
  console.error(`Command registration failed: ${error.message}`);
  process.exitCode = 1;
}
