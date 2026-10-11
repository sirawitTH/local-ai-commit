# Local AI Commit

A VS Code extension that generates a commit message from your current git diff using an AI CLI you already have installed on your machine.

This project is AI-generated and intended to help developers create better commit messages without manually writing them for every change.

## What it does

- Adds a ✨ button in the Source Control title bar.
- Reads the staged changes, or falls back to working tree changes if nothing is staged.
- Includes untracked files in the analysis.
- Uses the recent commit history to match the repository's tone and conventions.
- Sends the diff to Claude Code or Antigravity to generate a commit subject and optional body.
- Fills the commit message field so you can review and commit quickly.

## Supported providers

| Provider | CLI | Notes |
| --- | --- | --- |
| Claude Code | `claude` | Used first in VS Code |
| Antigravity | `agy` | Used when `claude` is not installed, or first when running inside the Antigravity IDE |

Both providers work in VS Code. With the default `auto` setting the extension tries one CLI and falls back to the other if it is not found; set `localAiCommit.provider` to `claude` or `antigravity` to always use that one.

### Setting the default AI

Run **Local AI Commit: Set Default AI** from the Command Palette (or the `...` menu in the Source Control title bar) and pick Auto, Claude Code, or Antigravity. The choice is saved to `localAiCommit.provider` in your user settings, so it applies to every project.

## How to use it

1. Open a Git repository in VS Code.
2. Make your changes.
3. Stage them if you want, or leave them unstaged.
4. Open the Source Control panel.
5. Click the ✨ button in the Source Control title bar.
6. The extension generates a commit message and places it in the commit input box.
7. Review the message, edit it if needed, and commit.

## Install and run locally

### Prerequisites

- VS Code
- Git
- One of the supported AI CLIs:
  - `claude`
  - `agy`

### Install from the source code

```bash
git clone https://github.com/<your-username>/local-ai-commit.git
cd local-ai-commit
npm install
```

Then open the project in VS Code and press F5 to run the extension in a new Extension Development Host window.

## Extension settings

| Setting | Default | Description |
| --- | --- | --- |
| `localAiCommit.provider` | `auto` | `auto`, `claude`, or `antigravity` |
| `localAiCommit.instructions` | empty | Extra instructions for the AI model |
| `localAiCommit.claudeModel` | `haiku` | Model used for `claude --model` |
| `localAiCommit.claudePath` | empty | Custom path to a Claude CLI executable |
| `localAiCommit.antigravityModel` | `gemini-3.8-flash-low` | Model used for `agy --model` |
| `localAiCommit.antigravityPath` | empty | Custom path to an Antigravity CLI executable |

## Build and package

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
```

To install the generated VSIX in VS Code:

```bash
code --install-extension local-ai-commit-0.2.1.vsix --force
```

If you previously installed an older extension named `claude-commit`, you can remove it with:

```bash
code --uninstall-extension local.claude-commit
```

## Public GitHub publishing notes

This repository is suitable for public GitHub hosting. Before publishing:

- Replace the example GitHub URL in the install instructions with your own repository.
- Review the project description and screenshots.
- Consider adding a license file if needed.
- Add a `.gitignore` if your local environment creates extra build artifacts.
- Ensure any AI-generated code or templates are clearly disclosed if your team requires it.

## License

MIT

## Disclaimer

This project is AI-assisted and provided as-is for development convenience. It may evolve over time as the underlying AI CLIs and VS Code APIs change.
