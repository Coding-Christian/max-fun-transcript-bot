# Podcast Transcript Bot for Discord

## Podcast transcripts

Run this bot with Node.js 18.4 or newer (`nvm use` selects Node 20). Install dependencies with `npm install`,
then run `npm run register` to add `/transcript`, `/search`, and `/list` to your Discord application.
Restart the bot with `npm start` after updating the code.

Example: `/transcript show:My Brother, My Brother and Me episodes:1,5-10`

Both `show` and `episodes` are required. `episodes` is a string of positive
episode numbers and inclusive ranges, using only commas and hyphens as
separators. Spaces are removed before validation: `1, 5 - 10` is accepted.
Empty entries, descending ranges, zero, decimal numbers, and other separators
are rejected with a malformed-option response before any download begins.
Overlapping ranges and duplicates are merged and processed in ascending order.

When the selection resolves to **one episode** (for example, `episodes:11`),
the bot fetches or reuses that episode and responds with its title, description,
and PDF attachment. There is no bulk announcement or pause. A single-episode
range such as `11-11` or duplicate selection such as `11,11` works the same way.
PDFs exceeding Discord's attachment limit are returned as download links.

For **multiple episodes**, the bot announces that the bulk download has commenced, then edits the same
message when complete with the supplied `episodes` value, success/failure counts, and all failed episode
numbers (consecutive failures are shown as ranges). If the failure list is too
long for a Discord message, it is attached as a plain-text report. Transcript
PDFs are saved locally and are not attached to bulk responses. The bot waits
one second between episodes, including after a failure, and continues with the
remaining episodes when an individual request fails.

For jobs exceeding Discord's interaction-token lifetime, the bot attempts to
edit that same message using its bot token and channel permissions. Keep the
bot running until the batch completes; unfinished batches do not survive a restart.

The optional boolean `reload` defaults to false. Set `reload:true` to search
Maximum Fun again and download a fresh copy, even when the episode is cached:
`/transcript show:My Brother, My Brother and Me episodes:835-838 reload:true`.
A successful refresh replaces the PDF, episode metadata, and searchable text.
The previous files remain available if the search, download, or extraction fails.

For an incorrectly numbered transcript page, supply the optional `url` string
with **one requested episode**:

```
/transcript show:My Brother, My Brother and Me episodes:815 url:https://maximumfun.org/transcripts/my-brother-my-brother-and-me/transcript-mbmbam-816-pain-is-funny-leaving-the-body/
```

The bot fetches that page directly, bypassing search and all episode-number
matching. It saves the PDF, metadata, and extracted text under the requested
episode number (815 here), corrects the episode number in the displayed title,
and preserves the original heading as `sourceTitle` in the metadata. Mismatched
numbers are logged as server warnings. Providing `url` always fetches a fresh
copy, even without `reload:true`; failed fetches or extraction preserve the
previous cache. A URL override cannot be combined with multiple episodes.

Only episode-page URLs beginning with `https://maximumfun.org/transcripts/`
are accepted. Redirects cannot leave that transcript path or the Maximum Fun
host; PDF downloads also cannot redirect to another host.

For each episode the bot checks its local cache first, then searches Maximum Fun's transcript
index for the requested show and episode. It follows the result's actual page
URL, verifies the episode number, and downloads the PDF from the transcript
download button. Missing transcripts and download errors are included in the
completion summary and logged with episode numbers and error messages.
If the episode number in the transcript page URL agrees with its heading, that
number takes precedence over a conflicting `from-episode-number` field. The
bot logs a warning on the server with the conflicting values and returns the
transcript. Pages whose URL and heading disagree are skipped.
If the URL or heading has no episode number, the bot uses `from-episode-number`
instead, including when that field contains plain text rather than a link.
If numeric transcript search cannot find the page, the bot searches the show's
episode pages and follows their transcript links, then verifies the episode
number on the transcript page using the same rules.

PDFs and episode metadata are stored in
`transcripts/my-brother-my-brother-and-me/<episode>.pdf` and `<episode>.json`.
Text is extracted from each PDF into a readable UTF-8 `<episode>.txt` file.
Existing text files are reused, including after a bot restart. Older cached
PDFs are parsed the first time they are fetched or searched. Repeated and
simultaneous requests reuse the same text file.
Set `TRANSCRIPT_DIR` to use a different cache directory. Keep this directory on
persistent storage when deploying so cached transcripts survive restarts.
The bot needs permission to send messages, embed links, and attach files.
PDF downloads are capped at 25 MiB. Single-episode `/transcript` requests and `/search` return links for PDFs exceeding
Discord's attachment limit. Run `npm test` for offline
lookup, cache, validation, and response tests.

## Listing downloaded transcripts

Example: `/list show:My Brother, My Brother and Me`

`show` is required and uses the same choices as `/transcript`. The response
lists downloaded episode numbers in ascending order with a total count.
When more than 10 episodes are listed, consecutive numbers are abbreviated
as ranges such as `3 - 10`. Lists of 10 or fewer episodes stay fully expanded.
Only episodes with valid cached metadata and a nonempty PDF are included;
text extraction is not required. Listing does not download or parse files.
An empty library returns a message inviting you to download episodes. Lists
too long for a Discord message are attached as `downloaded-episodes.txt`.

## Searching downloaded transcripts

Example: `/search query:feed the birds show:My Brother, My Brother and Me episode:838`

Only `query` is required (1–100 characters containing searchable text).
`show` and `episode` are optional. `show` uses the same choices as `/transcript`;
`episode` remains a single integer greater than 1. Omit them to search all
downloaded episodes, including episode 1. Search checks
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

If nothing matches, the response lists missing episodes from 1 to just below
the highest downloaded episode **for each selected show**, respecting the
episode filter. Consecutive missing episodes are displayed as inclusive ranges
(for example, `3–7` means episodes 3, 4, 5, 6, and 7). A long list is attached
as `missing-episodes.txt`. An empty library prompts you to download transcripts.
When there are no gaps, the bot reports no results in the searched library;
it does not infer whether newer episodes have been released beyond the highest
downloaded episode. PDF extraction failures are reported as incomplete searches.

## Project structure
Below is a basic overview of the project structure:

```
├── examples    -> short, feature-specific sample apps
│   ├── button.js
│   ├── command.js
│   ├── modal.js
│   ├── selectMenu.js
├── .env.sample -> sample .env file
├── app.js      -> main entrypoint for app
├── commands.js -> slash command payloads + helpers
├── transcript-command.js -> /transcript options and validation
├── transcripts.js -> transcript downloads, caching, and local search
├── transcript-text.js -> PDF extraction and text matching
├── transcript-response.js -> transcript responses and attachments
├── search-command.js -> /search options and validation
├── search-response.js -> excerpts and missing-episode responses
├── list-command.js -> /list options and validation
├── list-response.js -> downloaded episode lists
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

The registered commands are `/test`, `/transcript`, `/search`, and `/list`. They are set up in `commands.js`. All commands in its `ALL_COMMANDS` array will be installed when you run:

```
npm run register
```

### Run the app

After your credentials are added, go ahead and run the app:

```
node app.js
```

> ⚙️ A package [like `nodemon`](https://github.com/remy/nodemon), which watches for local changes and restarts your app, may be helpful while locally developing.

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
