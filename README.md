# Booker

**Book the acts your room's crowd already loves.** Taste-matched booking for independent live music venues and the artists who play them, grounded in [Qloo](https://www.qloo.com/)'s taste graph.

Live app: https://booker.meshulam791.workers.dev · MCP endpoint for agents: `https://booker.meshulam791.workers.dev/mcp`

## The problem

An independent venue lives or dies by its calendar. Its talent buyer has to decide, week after week, which acts will fill the room, and bookers describe the match in two words: **style and size**. First Avenue's booker puts it this way: they place a band "if we think it fits better style-wise or size-wise", and a new band's first time through plays the small room, "50 to 100 people" ([The Current](https://www.thecurrent.org/feature/2016/07/01/who-plays-where-when-and-why-explaining-the-mysteries-of-live-music-booking)). Today that judgment comes from streaming counts, past ticket sales and instinct; venue software (Prism.fm, Gigwell) manages holds, deals and settlements, not taste. Emerging acts, the ones a small room books most, have the least data.

The other side has the same problem in reverse: an artist or agent routing a tour has to guess which rooms in each city have the right crowd.

## What it does

**For a venue** ("I book a venue"): name the venue with its city and the acts that did well there; optionally paste the acts pitching you.

1. **Finds the room and the acts in Qloo.** The venue is a Qloo place filed as a music venue, a theater, or a bar, pub or club, or, when Qloo gives it no category, named like one (Qloo's Red Rocks Park and Amphitheatre has none); a record store, a cinema, a museum or a golf club with the same name doesn't count. Each act is resolved the way Qloo's harness does, an exact name first, a near-miss only if it resembles what was typed, and "Not it?" lets you pick another candidate by its Qloo ID.
2. **Measures your room's size from your own history.** The acts you named have a Qloo popularity; that range is your room's size. Qloo's popularity bunches up near 1 (in the rooms we checked, acts at 100-300 capacity rooms sat around 0.35-0.55, at 300-800 capacity clubs 0.90-0.97, at theaters 0.98-0.99), so sizes are compared on a log scale. It is Qloo's own measure, not ticket sales or capacity: Morgan Wallen, a stadium act, scores 0.968, inside a rock club's range. So the size verdicts are a guide, and taste is judged separately.
3. **Ranks acts that fit**: artists the fans of your acts love (Qloo affinity), at your size, with your city as a signal, without your own acts. **Openers and next-up acts** come from the same crowd below your range.
4. **Explains each pick**: the act of yours whose fans like it most.
5. **Suggests bills you could announce**: each top act with the opener whose fans overlap most.
6. **Scores your inbox**: each pitch fits your room, fits as an opener, is bigger than your room, or is off your crowd's taste, with the numbers behind it.
7. **Shows the competition**: the rooms in your city whose visitors fit the top act best, and where yours ranks; plus what Qloo says the visitors of your venue itself like.

**For an artist or agent** ("I book an artist"): name the act and up to five cities.

1. Each city is scored by Qloo's affinity for the act there (the city as the signal).
2. In each city, Qloo ranks the live music venues and concert halls whose visitors' taste fits the act's fans. The rooms go on a map.

Every result has a **How we know** panel: each Qloo call with its parameters, status, result count and time; then Booker's own rules, labeled apart from Qloo's numbers; then the limits of the answer.

It works as a web app and as two **MCP tools** for agents (`find_acts_for_venue`, `find_rooms_for_artist`).

## Why it only works with Qloo

Streaming dashboards say how big an act is. Qloo says whose fans overlap with whose, across music and places: which acts the crowd of *your* best shows also loves, which rooms in a city are visited by people with an act's taste, and how strongly a city's taste leans toward an act. Remove Qloo and Booker has nothing to rank.

## Qloo workflows used

| Step | Endpoint and parameters | Why |
|---|---|---|
| Find the venue | `GET /search?query=<venue city>&types=urn:entity:place&take=8` | The room as a Qloo place, with its categories, address and city |
| Find the acts | `GET /search?query=<name>&types=urn:entity:artist&take=5`; a picked ID: `GET /entities?entity_ids=<id>` | Qloo artist IDs and their popularity |
| Acts that fit | `GET /v2/insights?filter.type=urn:entity:artist&signal.interests.entities=<your acts>&signal.location.query=<city>&filter.popularity.min/max=<your size>&filter.exclude.entities=<your acts>[&bias.trends=high]&take=12` | Artists your acts' fans love, in your city, at your size |
| Why, bills, inbox | the same with `filter.results.entities=<a given list>` and one act as the signal | Score a given list: closest act, fan overlap of a bill, each pitch |
| Your room's visitors | `signal.interests.entities=<the venue>` | What people who like the venue itself like |
| Rooms that fit an act | `GET /v2/insights?filter.type=urn:entity:place&filter.tags=urn:tag:category:place:live_music_venue,urn:tag:category:place:concert_hall&operator.filter.tags=union&filter.location.query=<city>&signal.interests.entities=<act>` | Venues whose visitors' taste fits the act |
| A city's taste for an act | `GET /v2/insights?filter.type=urn:entity:artist&signal.location.query=<city>&filter.results.entities=<act>` | Rank the cities on a route |

A venue search makes about 20 Qloo calls in about 9 seconds; an artist search with four cities about 9 calls. Calls are paced one every 340 ms with one bounded retry after a 429 (Qloo rejects the sixth call within about a second, measured), every external call is counted against Cloudflare's free-plan limit of 50 per request, results are cached for a day, and each address gets 20 new searches an hour on each of the venue search, the artist search and the MCP tools (answers from the day's cache don't count).

### What the live API taught us (measured 2026-10-03, scripts in `scripts/`)

- Artists accept `signal.location.query` although the parameter guide doesn't list it: it works for cities ("Chicago", "Austin": local acts rise) and comes back empty for neighborhoods ("East Austin", "Williamsburg"). An unknown city is a 400 ("unable to resolve to a valid locality"); Booker then asks again without it and says so.
- With a city as the signal, a scored list (`filter.results.entities`) leaves some off-taste artists out entirely, so the inbox is scored by taste alone, next to three of Qloo's own picks as a yardstick.
- Qloo's popularity for artists bunches near 1 (see above), hence the log scale.
- Venue-based place search with the live-music-venue tag returns the right rooms per city: indie rock's Wednesday gets Schubas, The Empty Bottle and Beat Kitchen in Chicago, Hotel Vegas and Mohawk in Austin; country's Charley Crockett gets the Saxon Pub and Antone's.
- A city's affinity for an act tracks its home crowd: Wednesday scores 0.996 in Asheville, its hometown, ahead of Chicago (0.964).
- Demographics (`urn:demographics`) came back for only some artists and looked noisy for small acts, so Booker doesn't use them.

## Use it from an agent

`https://booker.meshulam791.workers.dev/mcp` is Booker's own MCP server (Streamable HTTP, no sign-in). It calls Qloo's REST API on the server; the event key never reaches the agent.

- Claude Code: `claude mcp add --transport http booker https://booker.meshulam791.workers.dev/mcp`
- Claude, ChatGPT and other clients that accept a remote MCP URL: add it as a custom connector.
- Any HTTP client:

```bash
curl -s https://booker.meshulam791.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_rooms_for_artist","arguments":{"artist":"Wednesday","cities":["Chicago, Illinois","Austin, Texas"]}}}'
```

When a name was only a closest match, the tool's answer says so and lists the alternatives with their Qloo IDs; the tool description tells the agent to ask the person which one they meant and call again with that `id`. The full result is in `structuredContent`.

## Request to result (a real run, 2026-10-03)

**Input:** Mohawk, Austin. Acts that did well: Black Pumas, Shakey Graves, The Black Angels, Parquet Courts. Pitches: Wet Leg, Khruangbin, Morgan Wallen.

1. **Venue:** Mohawk Austin, 912 Red River St (Qloo place; Bar, Event venue, Live music venue). All four acts exact.
2. **Size:** the acts sit between 0.973 and 0.993 on Qloo's popularity scale; acts that fit are looked for in 0.9655 to 0.9949, openers below.
3. **Acts that fit** (fans of your acts, in Austin, at your size; the first 8 of 12): Allah-Las, The Arcs, King Gizzard & The Lizard Wizard, Kevin Morby, Khruangbin, The Growlers, White Denim, Courtney Barnett. **Openers** (the first 5 of 8): Benjamin Booker, Ron Gallo, Golden Dawn Arkestra, The Nude Party, Brittany Howard.
4. **Bills:** Allah-Las with Kikagaku Moyo; The Arcs with Ron Gallo; King Gizzard & The Lizard Wizard with The Nude Party.
5. **Inbox:** Khruangbin fits your room; Wet Leg fits your room; Morgan Wallen is off your crowd's taste (0.83, below 0.84).
6. **Competition:** Qloo's top room in Austin for Allah-Las's fans is Mohawk Austin itself, then Swan Dive and Hotel Vegas.

20 Qloo calls, all answered 200; the page lists each one.

## Known limitations

- Qloo measures taste, not money: it doesn't know ticket prices, fees, routing, holds, radius clauses or who is on tour. Booker shortlists; the booker still makes the offer.
- Popularity is Qloo's measure across all artists, not ticket sales or capacity (Morgan Wallen, a stadium act, scores 0.968, inside a rock club's range); your own acts set the scale, so a room that names only its biggest nights gets bigger suggestions, and the size verdicts are a guide.
- The city is a signal when Qloo can place it (cities work, neighborhoods don't).
- In the artist view, Qloo knows each room's taste, not its capacity: check that a room's size fits before pitching it.
- "What Qloo says your room's visitors like" is Qloo's view of people who like the venue, which can differ from who buys tickets.
- Names that aren't an exact Qloo name are used only if they resemble what was typed; anything else is reported as not found.
- Results are cached for a day per identical request, and each address can run 20 new searches an hour per search type, to respect the shared event quota. No personal data is sent to Qloo: only names of artists, venues and cities.

## Run it yourself

You need Node.js 22.18 or newer (it runs the TypeScript files directly) and a free Cloudflare account (Workers and KV are on the free plan).

```bash
git clone https://github.com/danielhagever/booker && cd booker
npm ci
npm test                                          # tests against a mock Qloo shaped like the live API, no key needed
npx wrangler login
npx wrangler kv namespace create booker-cache     # put the id in wrangler.jsonc
npx wrangler secret put QLOO_API_KEY             # your hackathon key, server-side only
npx wrangler deploy
```

Locally: put `QLOO_API_KEY=...` in `.dev.vars` (git-ignored) and run `npx wrangler dev`, or run the pipelines in Node: `node scripts/run.ts venue "The Empty Bottle, Chicago" "Wednesday, Hovvdy, Snail Mail"` and `node scripts/run.ts artist "Wednesday" "Chicago, Illinois; Austin, Texas"`.

## Built with

Cloudflare Workers and KV, Qloo's API (search, entities, insights for artists and places), Open-Meteo geocoding, Leaflet with OpenStreetMap tiles, and an MCP server (`@modelcontextprotocol/server` 2.2.0, Streamable HTTP). No language model: every step is a Qloo call or a labeled rule.

## License

MIT
