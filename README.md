# Getting Started app for Discord

## Podcast transcripts

Run this bot with Node.js 18.4 or newer (`nvm use` selects Node 20). Install dependencies with `npm install`,
then run `npm run register` to add `/transcript` and `/search` to your Discord application.
Restart the bot with `npm start` after updating the code.

Example: `/transcript show:My Brother, My Brother and Me episode:838`

Both options are required; `episode` must be an integer greater than 1.
The bot checks its local cache first, then searches Maximum Fun's transcript
index for the requested show and episode. It follows the result's actual page
URL, verifies the episode number, and downloads the PDF from the transcript
download button. The response includes the show, episode number, title,
description, and attached PDF. Missing transcripts and download errors produce
a message in Discord.

PDFs and episode metadata are stored in
`transcripts/my-brother-my-brother-and-me/<episode>.pdf` and `<episode>.json`.
Text is extracted from each PDF into a readable UTF-8 `<episode>.txt` file.
Existing text files are reused, including after a bot restart. Older cached
PDFs are parsed the first time they are fetched or searched. Repeated and
simultaneous requests reuse the same text file.
Set `TRANSCRIPT_DIR` to use a different cache directory. Keep this directory on
persistent storage when deploying so cached transcripts survive restarts.
The bot needs permission to send messages, embed links, and attach files.
PDF downloads are capped at 25 MiB; files exceeding the interaction's Discord
attachment limit are returned as a download link. Run `npm test` for offline
lookup, cache, validation, and response tests.

## Searching downloaded transcripts

Example: `/search query:feed the birds show:My Brother, My Brother and Me episode:838`

Only `query` is required (1–100 characters containing searchable text).
`show` and `episode` are optional and use the same choices and episode minimum
as `/transcript`. Omit them to search all downloaded episodes. Search checks
the transcript text, show name, episode title, and episode number; it does not
download episodes or search the web.

Matching ignores case, accents, differences in punctuation, and repeated spaces
or line breaks. Curly/straight apostrophes, ampersands/“and”, Unicode ligatures,
and hyphens introduced by PDF line wrapping are normalized too. A multiword
query matches a phrase after normalization. Excerpts preserve the original text.

Responses show up to five matching episodes, newest first within each show,
with excerpts replacing the episode descriptions and the matching PDFs attached.
Narrow the query or use the filters when more than five episodes match. PDFs
exceeding attachment limits are linked instead.

If nothing matches, the response lists missing episodes from 2 to just below
the highest downloaded episode **for each selected show**, respecting the
episode filter. Consecutive missing episodes are displayed as inclusive ranges
(for example, `3–7` means episodes 3, 4, 5, 6, and 7). A long list is attached
as `missing-episodes.txt`. An empty library prompts you to download transcripts.
When there are no gaps, the bot reports no results in the searched library;
it does not infer whether newer episodes have been released beyond the highest
downloaded episode. PDF extraction failures are reported as incomplete searches.

This project contains a basic rock-paper-scissors-style Discord app written in JavaScript, built for the [getting started guide](https://discord.com/developers/docs/getting-started).

![Demo of app](https://github.com/discord/discord-example-app/raw/main/assets/getting-started-demo.gif?raw=true)

## Project structure
Below is a basic overview of the project structure:

```
├── examples    -> short, feature-specific sample apps
│   ├── app.js  -> finished app.js code
│   ├── button.js
│   ├── command.js
│   ├── modal.js
│   ├── selectMenu.js
├── .env.sample -> sample .env file
├── app.js      -> main entrypoint for app
├── commands.js -> slash command payloads + helpers
├── game.js     -> logic specific to RPS
├── utils.js    -> utility functions and enums
├── package.json
├── README.md
└── .gitignore
```

## Running app locally

Before you start, you'll need to install [NodeJS](https://nodejs.org/en/download/) and [create a Discord app](https://discord.com/developers/applications) with the proper permissions:
- `applications.commands`
- `bot` (with Send Messages enabled)


Configuring the app is covered in detail in the [getting started guide](https://discord.com/developers/docs/getting-started).

### Setup project

First clone the project:
```
git clone https://github.com/discord/discord-example-app.git
```

Then navigate to its directory and install dependencies:
```
cd discord-example-app
npm install
```
### Get app credentials

Fetch the credentials from your app's settings and add them to a `.env` file (see `.env.sample` for an example). You'll need your app ID (`APP_ID`), bot token (`DISCORD_TOKEN`), and public key (`PUBLIC_KEY`).

Fetching credentials is covered in detail in the [getting started guide](https://discord.com/developers/docs/getting-started).

> 🔑 Environment variables can be added to the `.env` file in Glitch or when developing locally, and in the Secrets tab in Replit (the lock icon on the left).

### Install slash commands

The commands for the example app are set up in `commands.js`. All of the commands in the `ALL_COMMANDS` array at the bottom of `commands.js` will be installed when you run the `register` command configured in `package.json`:

```
npm run register
```

### Run the app

After your credentials are added, go ahead and run the app:

```
node app.js
```

> ⚙️ A package [like `nodemon`](https://github.com/remy/nodemon), which watches for local changes and restarts your app, may be helpful while locally developing.

If you aren't following the [getting started guide](https://discord.com/developers/docs/getting-started), you can move the contents of `examples/app.js` (the finished `app.js` file) to the top-level `app.js`.

### Set up interactivity

The project needs a public endpoint where Discord can send requests. To develop and test locally, you can use something like [`ngrok`](https://ngrok.com/) to tunnel HTTP traffic.

Install ngrok if you haven't already, then start listening on port `3000`:

```
ngrok http 3000
```

You should see your connection open:

```
Tunnel Status                 online
Version                       2.0/2.0
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://1234-someurl.ngrok.io -> localhost:3000

Connections                  ttl     opn     rt1     rt5     p50     p90
                              0       0       0.00    0.00    0.00    0.00
```

Copy the forwarding address that starts with `https`, in this case `https://1234-someurl.ngrok.io`, then go to your [app's settings](https://discord.com/developers/applications).

On the **General Information** tab, there will be an **Interactions Endpoint URL**. Paste your ngrok address there, and append `/interactions` to it (`https://1234-someurl.ngrok.io/interactions` in the example).

Click **Save Changes**, and your app should be ready to run 🚀

## Other resources
- Read **[the documentation](https://discord.com/developers/docs/intro)** for in-depth information about API features.
- Browse the `examples/` folder in this project for smaller, feature-specific code examples
- Join the **[Discord Developers server](https://discord.gg/discord-developers)** to ask questions about the API, attend events hosted by the Discord API team, and interact with other devs.
- Check out **[community resources](https://discord.com/developers/docs/topics/community-resources#community-resources)** for language-specific tools maintained by community members.
