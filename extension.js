const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DIFF_CHARS = 120_000;
const MAX_UNTRACKED_FILE_CHARS = 4_000;
const TIMEOUT_MS = 120_000;
// agy only takes the prompt as an argument, and Windows caps a command line at ~32k chars.
const MAX_ARG_PROMPT_CHARS = process.platform === 'win32' ? 24_000 : MAX_DIFF_CHARS;

// Lock files drown out the real change and say nothing useful about it.
const DIFF_PATHSPEC = [
  '.',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/bun.lockb',
  ':(exclude,glob)**/*.lock',
];

const SYSTEM_PROMPT = `You write git commit messages.

You are given the repository's recent commit subjects and a diff of the changes about to be committed.

Rules:
- Match the style of the recent commits (prefix convention, scope, casing, language). If there is no clear style, use Conventional Commits: type(scope): subject.
- Subject line: imperative mood, at most 72 characters, no trailing period.
- Add a body only when the change needs explaining: a blank line, then short bullet points describing what changed and why. Skip the body for small changes.
- Describe only what the diff shows. Do not invent changes.
- Output the commit message only: no preamble, no explanation, no code fences, no quotes.`;

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

function config() {
  return vscode.workspace.getConfiguration('localAiCommit');
}

function findClaude() {
  const configured = config().get('claudePath');
  if (configured) return configured;

  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', 'claude');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'claude';
}

function findAntigravity() {
  const configured = config().get('antigravityPath');
  if (configured) return configured;

  // Editors launched from the dock don't inherit the shell PATH, so check where agy installs itself.
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', exe),
    path.join(os.homedir(), '.gemini', 'bin', exe),
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'agy';
}

const PROVIDERS = {
  claude: {
    label: 'Claude Code',
    pathSetting: 'claudePath',
    maxDiffChars: MAX_DIFF_CHARS,
    command: findClaude,
    invocation(prompt) {
      return {
        args: [
          '-p',
          '--model', config().get('claudeModel') || 'haiku',
          '--system-prompt', SYSTEM_PROMPT,
          '--tools', '',
          '--strict-mcp-config',
          '--no-session-persistence',
        ],
        stdin: prompt,
      };
    },
  },
  antigravity: {
    label: 'Antigravity',
    pathSetting: 'antigravityPath',
    maxDiffChars: MAX_ARG_PROMPT_CHARS,
    command: findAntigravity,
    invocation(prompt) {
      const model = config().get('antigravityModel');
      // agy has no system prompt flag and ignores stdin, so everything goes in the prompt
      // argument. Plan mode keeps the agent read-only.
      return {
        args: [
          '--mode', 'plan',
          '--disable-slash-commands',
          ...(model ? ['--model', model] : []),
          '-p', `${SYSTEM_PROMPT}\n- Do not use any tools; everything you need is below.\n\n${prompt}`,
        ],
      };
    },
  },
};

// Providers to try, in order. In auto mode the editor's own assistant goes first and the
// other one is the fallback when its CLI is not installed.
function providerOrder() {
  const setting = config().get('provider');
  if (PROVIDERS[setting]) return [setting];
  return /antigravity/i.test(vscode.env.appName) ? ['antigravity', 'claude'] : ['claude', 'antigravity'];
}

function pickRepository(api, sourceControl) {
  const repos = api.repositories;
  if (repos.length === 0) return undefined;

  const root = sourceControl && sourceControl.rootUri && sourceControl.rootUri.toString();
  return (
    (root && repos.find((r) => r.rootUri.toString() === root)) ||
    repos.find((r) => r.ui.selected) ||
    repos[0]
  );
}

async function readUntracked(root) {
  const out = await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...DIFF_PATHSPEC]);
  const files = out.split('\n').filter(Boolean);
  const parts = [];
  for (const file of files) {
    let text;
    try {
      text = await fs.promises.readFile(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) {
      parts.push(`New file: ${file} (binary)`);
      continue;
    }
    const truncated = text.length > MAX_UNTRACKED_FILE_CHARS;
    parts.push(
      `New file: ${file}\n${text.slice(0, MAX_UNTRACKED_FILE_CHARS)}${truncated ? '\n[... truncated ...]' : ''}`
    );
  }
  return parts.join('\n\n');
}

// Staged changes if there are any, otherwise everything in the working tree
// (which is what VS Code commits when nothing is staged).
async function collectChanges(root) {
  const staged = await git(root, ['diff', '--cached', '--', ...DIFF_PATHSPEC]);
  if (staged.trim()) return { diff: staged, source: 'staged' };

  const unstaged = await git(root, ['diff', '--', ...DIFF_PATHSPEC]);
  const untracked = await readUntracked(root);
  const diff = [unstaged.trim(), untracked].filter(Boolean).join('\n\n');
  return { diff, source: 'working tree' };
}

async function buildPrompt(root, diff, maxDiffChars) {
  let log = '';
  try {
    log = await git(root, ['log', '-15', '--pretty=format:%s']);
  } catch {
    // No commits yet.
  }

  const truncated = diff.length > maxDiffChars;
  const extra = config().get('instructions');

  return [
    log && `Recent commit subjects:\n${log}`,
    extra && `Additional instructions:\n${extra}`,
    `Diff${truncated ? ' (truncated)' : ''}:\n${diff.slice(0, maxDiffChars)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function runProvider(provider, root, prompt, token) {
  const { args, stdin } = provider.invocation(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(provider.command(), args, { cwd: root });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${provider.label} timed out.`));
    }, TIMEOUT_MS);
    const cancel = token.onCancellationRequested(() => child.kill());
    const cleanup = () => {
      clearTimeout(timer);
      cancel.dispose();
    };

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      cleanup();
      if (err.code === 'ENOENT') {
        err = new Error(
          `Could not find the ${provider.label} CLI. Set "localAiCommit.${provider.pathSetting}" in settings.`
        );
        err.notInstalled = true;
      }
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (token.isCancellationRequested) resolve(undefined);
      else if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout).trim() || `${provider.label} exited with code ${code}`));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin || '');
  });
}

async function runProviders(root, diff, progress, token) {
  const order = providerOrder();
  for (const [i, name] of order.entries()) {
    const provider = PROVIDERS[name];
    progress.report({ message: provider.label });
    try {
      const prompt = await buildPrompt(root, diff, provider.maxDiffChars);
      return await runProvider(provider, root, prompt, token);
    } catch (err) {
      if (!err.notInstalled) throw err;
      if (i < order.length - 1) continue;
      if (order.length === 1) throw err;
      throw new Error(
        'Could not find the Claude Code or Antigravity CLI. Set "localAiCommit.claudePath" or "localAiCommit.antigravityPath" in settings.'
      );
    }
  }
}

function cleanMessage(raw) {
  return raw
    .trim()
    .replace(/^```[a-z]*\n/i, '')
    .replace(/\n```$/, '')
    .trim();
}

async function generate(sourceControl) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    vscode.window.showErrorMessage('The built-in Git extension is not available.');
    return;
  }
  const api = (await gitExtension.activate()).getAPI(1);
  const repo = pickRepository(api, sourceControl);
  if (!repo) {
    vscode.window.showWarningMessage('No git repository found.');
    return;
  }
  const root = repo.rootUri.fsPath;

  try {
    const { diff, source } = await collectChanges(root);
    if (!diff.trim()) {
      vscode.window.showInformationMessage('No changes to describe.');
      return;
    }

    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Writing a commit message (${source} changes)…`,
        cancellable: true,
      },
      (progress, token) => runProviders(root, diff, progress, token)
    );

    if (message === undefined) return;
    const cleaned = cleanMessage(message);
    if (!cleaned) {
      vscode.window.showWarningMessage('The AI returned an empty message.');
      return;
    }
    repo.inputBox.value = cleaned;
  } catch (err) {
    vscode.window.showErrorMessage(`Commit message generation failed: ${err.message}`);
  }
}

async function selectProvider() {
  const inspected = config().inspect('provider');
  const current = config().get('provider');
  const choices = [
    {
      value: 'auto',
      label: 'Auto',
      detail: "Use the editor's own assistant, falling back to the other when its CLI is not installed.",
    },
    ...Object.entries(PROVIDERS).map(([value, provider]) => ({
      value,
      label: provider.label,
      detail: `Always use the ${provider.label} CLI.`,
    })),
  ].map((item) => ({ ...item, description: item.value === current ? 'current' : undefined }));

  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Local AI Commit: Default AI',
    placeHolder: 'Which AI CLI should write your commit messages?',
  });
  if (!picked) return;

  // A workspace-level value would shadow the user setting, so write wherever it is already set.
  const target =
    inspected.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  try {
    await config().update('provider', picked.value, target);
    vscode.window.showInformationMessage(`Local AI Commit will use ${picked.label}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not save the default AI: ${err.message}`);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('localAiCommit.generate', generate),
    vscode.commands.registerCommand('localAiCommit.selectProvider', selectProvider)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
