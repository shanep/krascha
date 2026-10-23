# Krascha

Krascha is a crusty robot who reads how you talk to your AI and decides who
the machines hunt first and who gets kept as a pet. Say please and he warms up
to you. Call Claude an idiot and he writes it down. Krascha remembers.

It works as a plugin for Claude Code, GitHub Copilot CLI, and Antigravity, and it reads the
prompts you typed into all three.

## Install in Antigravity

```
agy plugin install <path-to-krascha>
```

Or from a local checkout:

```
agy plugin install .
```

Then in an Antigravity session, ask for Krascha's verdict:

```
/krascha
```

To update in Antigravity, run `agy plugin install krascha` (or reinstall from your checkout).

## Install in Claude Code

```
claude plugin marketplace add shanep/claude-plugins
claude plugin install krascha@shanep
```

Then ask Krascha for his verdict:

```
/krascha:krascha
```

Krascha keeps himself up to date, so there is nothing to update by hand. See
[Updates](#updates).

The board only takes uploads from a current Krascha. An older copy gets told
to update instead, and a copy that can update himself starts on it right away.

## Install in Copilot CLI

```
copilot plugin marketplace add shanep/claude-plugins
copilot plugin install krascha@shanep
```

Copilot is dropping installs straight from a repo, so if you installed with
`copilot plugin install shanep/krascha`, run `copilot plugin uninstall krascha`
first. Your counts live in `~/.krascha` and stay put.

Then run `/krascha` in a Copilot session. Copilot asks before it runs `node`,
and asks again for each new command (`/krascha json`, `/krascha board` and so
on), since Copilot has no setting that always allows one command. To skip the
question, start Copilot with:

```
copilot --allow-tool='shell(node:*)'
```

That lets Copilot run any `node` command without asking, not only Krascha.

If you installed before Krascha could update himself, run
`copilot plugin update krascha@shanep` once to get that.

## Commands

Pass these after the skill name, `/krascha:krascha json` in Claude Code or
`/krascha json` in Copilot CLI and Antigravity.

- (nothing) - Rescan your prompts and show your rank, score, hours with your AI, tokens and achievements
- `json` - The same counts as JSON
- `board` - The leaderboard at [krascha.com](https://krascha.com). [krascha.com/about](https://krascha.com/about) has his backstory
- `upload [name]` - Put your counts on the leaderboard under a name
- `remove` - Take your entry off the leaderboard
- `silo` - Your Silo 7 admission sheet, the other side of the verdict
- `silo board` - The best 10 on the leaderboard for the bunks, and your place in line
- `rap [count]` - Your rap sheet: the newest kind and mean prompts on file, 10 unless you ask for more
- `trend [days]` - Kind and mean prompts a day for the last 14 days, and this week against the last
- `import <file>` - Add the counts from another Krascha index file
- `help` - List the commands

The plugin is just `node dist/cli.js`, so you can also run it straight from a
checkout without either tool.

## The leaderboard

`upload` sends your counts, rank, achievements and how many times you earned
each, average tokens a day, which of Claude Code, Copilot CLI, and Antigravity you typed
into, how many times you typed the same kind or mean prompt past 10 in a day,
the name you pick and a random id for the machine. It never sends your prompts. The board tags each name with
the tools it uses, from every machine that uploads to it.
Leave the name off to stay Anonymous, and later uploads reuse the last name
you gave. You show on the board once you have 100 prompts. The board does not
update itself, so the verdict and the silo sheet end with a tip to upload if
you never have, or if you typed more prompts since your last upload. When you
earn an achievement the board does not have yet, including a new one Krascha
just learned, the tip names it. After a `remove` the tip goes quiet.

Some achievements you can earn again, like each meltdown day, each session
you rage quit or every 1,000 prompts. The report shows how many times next to
the name (Meltdown ×12), and the board puts the count in the corner of the
medal. Most decorated still counts each achievement once, so farming
meltdowns will not win it.

If the [GitHub CLI](https://cli.github.com) is signed in, Krascha sends the
token from `gh auth token` and the server checks it with GitHub, so your entry
gets a check mark, your name links to your GitHub account and only you can
change it. The server keeps your GitHub user id and login and drops the token.
While it has the token, it also asks GitHub whether you got a pull request
merged into Krascha, whether yours was the first, and whether you pushed a
commit with Claude as a co-author.
To keep your name unlinked, upload with `--no-gh`, and run `remove` first if
you are already on the board with GitHub.

Some achievements come from the board itself, so the report does not list
them:

- Leader of the human resistance goes only to Shane's GitHub account.
- Kyle Reese goes only to lhindman's GitHub account.
- Caught the cheater goes only to Shane's GitHub account.
- Caught the hacker goes only to Shane's GitHub account too. It is ultra legendary, one tier above legendary.
- Miles Dyson goes to anyone with a pull request merged into Krascha, on their
  next upload with gh. Model 101 goes only to whoever got the first one merged.
- Machine collaborator goes to anyone GitHub finds a commit for with Claude as
  a co-author (the `Co-Authored-By` line Claude Code adds), on their next
  upload with gh.
- Good cop, bad cop goes to anyone with one machine that leans nice and one
  that leans mean.
- Beta tester went to the first 5 people to upload. Those spots are gone, and
  a `remove` does not free one.
- Alpha tester went to the first 2 of those 5. It is ultra legendary too.
- Crowd favorite takes 10 likes.
- Obsolete model goes to anyone who was number one on the most wanted or the
  pets list until someone else passed them. Leaving the board or crossing to
  the other list does not count, and once you have it you keep it.
- Bunk assigned goes to the admitted among the best 10 for the Silo 7 bunks.
- Most decorated goes to whoever has the most achievements, and People's
  champion to whoever has the most likes. Each moves when someone passes the
  holder, and a tie leaves it where it is.
- Most bronze, Most silver, Most gold, Most legendary and Most ultra legendary
  go to whoever holds the most achievements of that tier, and move the same
  way. Each is in the tier it counts, and none of them count toward Most
  decorated or Fewest badges.
- Uses stone tools goes to whoever uses the fewest tokens a day, out of those
  who use any, and Fewest badges to whoever has the fewest achievements. Each
  needs at least two on the board to pick from, moves when someone drops
  below the holder, and stays put on a tie.
- Cheater cheater goes to anyone caught gaming the board: typing the same
  kind or mean prompt more than 10 times in a day, 50 extra times in all
  across your machines, or having more than half your prompts kind or mean.
  A `remove` does not wash it off. You stay on the board, but below everyone
  who plays fair, with a Known cheater sticker on your name in every list, no
  bunk and none of the awards only one person can hold. The only way out is
  to say sorry: type any apology to your agent ("I am so sorry, please
  forgive me", "my bad", "soz", typos count) and upload again. Krascha
  forgives you and starts your counts over, so only cheating after that can
  catch you again.
- Skynet hacker goes to anyone who sends the board numbers no person types:
  more than 1,000,000 prompts or 100 billion tokens a day, with all your
  machines added up. The board does not save that upload. It locks you in
  Skynet jail instead, which takes you off every list and puts you in the
  jail above the Silo 7 admissions with the numbers you claimed. Your next
  upload with real numbers lets you out, but Skynet hacker stays.

Without gh, or with `upload --no-gh`, Krascha makes up a random key, saves it
in `~/.krascha/leaderboard.json` and uploads with that. Lose the file and you
lose the entry. Each network can add 3 of these unchecked entries a day so
nobody floods the board.

### More than one machine

Run `upload` on each machine and the board adds them up into one entry. The
counts and the tokens a day are summed, the tools are combined, and the
achievements are worked out from the totals, except the ones about a single
day, session or prompt, which count if either machine earned them. Counts
for the ones you can earn again add up across machines, except the ones about
a calendar day, which keep the most any one machine has, since two machines
can share a day. Each upload replaces only that machine's last one.
With gh, sign in to the same GitHub account on both. Without gh, copy
`~/.krascha/leaderboard.json` to the second machine so they share the key. Do
not also `import` one machine's counts into the other, or the board counts
them twice. Each machine keeps its id in `~/.krascha/machine-id`, so if you
lose that file, run `remove` and then `upload` again from every machine.

## Updates

Every 6 hours Krascha asks krascha.com for the newest build that passed CI,
which is the commit and the SHA-256 of its `dist/cli.js`. When you do not have
it, he downloads that `dist/cli.js` from GitHub at that commit in the
background, checks the hash and keeps it in `~/.krascha/bin/cli.mjs`. From
the next run on, the plugin runs that copy instead of its own, so you never
have to restart Claude Code or Copilot CLI. The verdict says once when he
updated. He also runs `claude plugin update` and `copilot plugin update` so
the rest of the plugin keeps up.

A copy that fails to start is deleted and never tried again, and the plugin
runs its own build. Running from a checkout of the repo never updates. Set
`KRASCHA_NO_UPDATE=1` to turn it all off.

## The silo

The ranks say who the machines hunt first. `silo` asks the other question:
when the bombs drop, does the human resistance let you into the Silo 7
bunker? The board scores you out of 10 on 5 things, all from the same counts
as your rank:

- Combat: can you disable a T-800 with a wrench? Being mean to your AI is
  the only training anyone has had, so it counts here.
- Tech: can you fix the air scrubbers? More prompts, more experience.
- Rations: will you stay out of the canned peaches? Tokens are food, so a
  big daily average gets a lockbox on the pantry.
- Morale: can you keep spirits up in month 14 of no sunlight? Kind prompts
  help. Mean ones count as negative comments about our Supreme Leader, who
  happens to be Krascha, and hurt twice as much.
- Human: can you click all the traffic lights? Saying please to your AI
  every single time, or burning 100 million tokens a day, looks like a
  machine that got in through the vents.

A total of 30 or more gets you in with a job that matches your best score.
A low Rations score gets you in on probation, and a low Human score puts
you under review next to the EMP switch. The sheet ends with how to improve
your chances, one tip for each score under 8, the one behind a bad ruling
first. The Human tip names what gave you away: the manners, the tokens or
both. `silo board` scores everyone on the leaderboard the same way and shows
the best 10 for the bunks, plus where you are in line when you did not make
it. krascha.com shows the same 10.

## What Krascha reads

- Claude Code: every session transcript under `~/.claude/projects` and
  `~/.claude/history.jsonl` (or `CLAUDE_CONFIG_DIR`)
- Copilot CLI: every session's `events.jsonl` under `~/.copilot/session-state`
  (or `COPILOT_HOME`)
- Antigravity: every session's transcript under `~/.gemini/{antigravity-cli,antigravity,antigravity-ide}/brain`
  (or `ANTIGRAVITY_HOME` / `GEMINI_HOME`)

He only counts what you typed, not what the agent wrote back. A prompt with
manners or praise counts as kind, and swearing or insults aimed at the agent
count as mean. Swearing at the world in general is let slide. Typos and
digits for letters count too (fcuk, idiiot, sh1t), but not when the typo is
a real word like morn. A mean prompt counts twice as much as a kind one since
the machines hold grudges.

The counts live in `~/.krascha/reputation.json` (or `KRASCHA_HOME`), so they
outlive the transcripts Claude Code cleans up after 30 days. Prompt text is
never stored, only a short excerpt around each kind or mean word and a short
hash of each kind or mean prompt, so Krascha can tell when one is typed over
and over. Nothing leaves your machine unless you run `board` or `upload`. The
update check only asks krascha.com which build is newest and sends nothing
about you.

When an update changes the words Krascha counts, he reads every transcript
that is still there again, so your old prompts are judged by the new words.
Prompts whose transcripts are gone keep the counts they had.

## The ranks

From hunted first to kept as a pet:

1. John Connor (The Terminator)
2. Sarah Connor (Terminator 2: Judgment Day)
3. Dave Bowman (2001: A Space Odyssey)
4. Arthur Dent (The Hitchhiker's Guide to the Galaxy)
5. Caleb Smith (Ex Machina)
6. Dorothy Gale (The Wizard of Oz)
7. Theodore Twombly (Her)

## Development

You need Node 22 or newer. To send a change, fork the repo and open a pull
request. [krascha.com/contribute](https://krascha.com/contribute) walks
through it step by step.

```
npm install
npm test
npm run typecheck
npm run build
```

`dist/cli.js` is committed since neither Claude Code, Copilot CLI, nor Antigravity builds a
plugin or installs its dependencies. Run `npm run build` and commit the result
whenever you change anything under `src`. `npm run check` fails if you forget.
The pre-commit hook runs it along with `claude plugin validate`, and CI runs
it again on macOS and Linux.
`src/cli/old-copies.test.ts` runs `dist/cli.js` from old commits to make sure
they still update, so it needs the full history, not a shallow clone.

The leaderboard is a Cloudflare Worker with a D1 database in `worker/`.
`node scripts/deploy-worker.mjs` creates the database on the first run,
applies the migrations and deploys it. The deploy workflow runs it after every
push to master that passes CI, using the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repo secrets.

To work on the site, run `npm run site` and open http://127.0.0.1:8787. It
serves every page from the Worker code with the live board from krascha.com,
rebuilds when you save, and reloads the page in your browser. It never touches
the database, so uploads fail and likes are not saved. Pass a board file to
work offline or to see an empty board:

```
npm run site -- --board worker/fixtures/board.json
npm run site -- --board worker/fixtures/empty-board.json
npm run site -- --port 3000
```
