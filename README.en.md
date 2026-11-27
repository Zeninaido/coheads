# Coheads

[日本語](README.md)

> **Work in progress.** We plan the official release at milestone M3; until then the design will change. **Please do not use it for real work yet.** To try it, use the demo data or documents made for testing.

Coheads gives AI your team's *currently valid decisions*.

Ask an AI to write a quote email and it may use a price from an old proposal or email. Coheads keeps the decisions your team has approved, with the approval date and the period they apply to, and gives them to the AI before it writes anything for a client. Old values in your documents are marked "not current". Even before a team has recorded any decision, it points out when documents disagree on an amount.

- Works with: Claude Desktop (chat, Cowork) and Claude Code. ChatGPT and others later.
- Setup: install one Claude Desktop extension, then choose a documents folder and your name. No terminal needed.
- Data: stays on your computer. For a team, the decision records live in a shared folder (Google Drive and the like).
- Made by WalkOn (株式会社銭内堂). Licensed under Apache-2.0.

## What it does today

- **Checks the team's decisions before the AI writes.** When you ask for a quote or an email, the AI first looks up the prices and other decisions your team approved and writes with them. It does not present old values, or open items such as a delivery date, as settled.
- **Reads your documents folder.** Word, PDF and text files. It tells you when documents disagree on an amount.
- **People approve decisions.** The AI only proposes candidates. People approve or reject them on an approval page that opens on your own computer.
- **The approval page also lets you** choose who may approve, copy a ready-to-paste summary for other AIs (ChatGPT and so on), see what was recently given to the AI, and find how to stop using it and delete its data from this computer.
- **Try it as a team.** When everyone chooses the same shared folder, a decision one person approves reaches everyone's AI.

Tested on Mac. Not yet tested on Windows.

## What comes next

1. **Make sure it works on Windows** ([#7](../../issues/7)). Most company computers run Windows.
2. **Decide how new versions reach users** ([#1](../../issues/1)). Today a new version does not install itself.
3. **Check whether the ChatGPT desktop app can use it** ([#21](../../issues/21)), so the same team decisions work beyond Claude.
4. **Suggest decisions from documents** ([#11](../../issues/11)). When a new document's amount differs from the approved one, show it to the approvers as a candidate. Text marked as a draft or under discussion stays an open item.

## Try it

1. Download `coheads.mcpb` from [Releases](../../releases), double-click it and press "Install".
2. In the settings, choose a documents folder. Each folder inside it becomes one project (for example `A社/`, `B社/`). Leave it empty to try the fictional demo data.
3. For a team, create one Claude project and paste the [project instructions](docs/setup/project-instructions.md) (Japanese). Chats in that project are where the AI is connected to the team's decisions.
4. To use it in Cowork or Claude Code too, also install the plugin `coheads-plugin.zip`.

The AI can propose decisions during a conversation. People approve them on the approval page (http://127.0.0.1:4319/), which only opens on your own computer.

## Development

Principles and workflow are in [CLAUDE.md](CLAUDE.md) and [docs/development.md](docs/development.md) (Japanese).

```bash
cd core && bun install
bun run test            # automated tests
bun run build           # builds the extension and plugin into dist/
bun run eval --dry      # checks the behavior-eval files (no cost)
```
