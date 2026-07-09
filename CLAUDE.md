# CLAUDE.md

## Patch-Stack Fork Workflow

This is a **patch-stack fork** of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), managed by [Saint-work/patch-stack-action](https://github.com/Saint-work/patch-stack-action). Our changes live as small, rebasable patches on top of a read-only mirror of upstream — never as ad-hoc commits on `main`.

### Branch layout

| Branch | What it is |
| --- | --- |
| `base` | Read-only mirror of upstream `main`. Updated automatically by the sync. **Never commit here.** |
| `patch/*` | One branch per logical change, rebased automatically onto `base`. **All real work happens here.** |
| `main` | Integration branch, **rebuilt from scratch on every sync**: `base` + `fork:` commits + each patch squash-merged (prefixed `patch-stack:`). Only `fork:`-prefixed commits and `patch-stack:` squash-merges survive a rebuild. |

### How the sync works

1. **Mirror** — fast-forwards `base` to match upstream `main`.
2. **Rebase** — rebases each `patch/*` branch onto the updated `base`; conflicts resolved automatically via Claude Code.
3. **Rebuild `main`** — starts from `base`, preserves `fork:` commits, then squash-merges each patch in topological order.
4. **Cleanup** — archives a `patch/*` branch once its PR is merged or closed.

### Creating / editing a patch

```bash
# Always branch from base, never main
git checkout -b patch/my-feature origin/base
# ... edit, commit (normal conventional commits) ...
git push origin patch/my-feature
# ALWAYS open a PR targeting base — the sync uses it to track the patch
gh pr create --head patch/my-feature --base base
```

Edit an existing patch by checking out its `patch/*` branch (a worktree under `.data/worktrees/` is handy), committing, and pushing. Encode dependencies in the branch name: `patch/a--depends-on-a`.

### Commit conventions

- **On `patch/*`**: normal conventional commits.
- **On `main`** (auto-generated): `patch-stack: <description> (#PR)`.
- **Fork-specific infra on `main`**: prefix with `fork:` so it survives rebuilds (e.g. `fork: set up patch-stack fork workflow`).

### Current patches

- `patch/set-tab-title` — restores the `set_tab_title` tool upstream removed in `251a8d9` (live per-phase tab labels for tracking parallel subagents). PR [#2](https://github.com/DJRHails/pi-interactive-subagents/pull/2).
- `patch/headless-guard` — skips tool registration when no multiplexer session is live, so a headless-capable subagent extension can own the `subagent` tool name (`pi -p`, gantry, CI). PR [#3](https://github.com/DJRHails/pi-interactive-subagents/pull/3).

### What NOT to do

- Never commit to `base` or push non-`fork:` commits to `main` (dropped on rebuild).
- Never merge `patch/*` into `main` manually, or rebase `main` onto `base` manually — the action does this.
- Never force-push `main` or `base` during normal operation (the action owns `main` rebuilds).
- Every `patch/*` branch must have a PR **targeting `base`** (never `main`).

### Required secrets

| Secret | Value |
| --- | --- |
| `PATCH_STACK_APP_ID` | App ID of the patch-stack GitHub App. |
| `PATCH_STACK_APP_PRIVATE_KEY` | Full contents of the app's `.pem` private key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Output of `claude setup-token` (used for automatic conflict resolution). |

### Triggering a sync

```bash
gh workflow run patch-stack-sync.yml                 # real run
gh workflow run patch-stack-sync.yml -f dry_run=true # preview only
git checkout main && git pull --rebase origin main   # after sync, update local main
```
