# Source Control: several repositories and remote access

## Requirements

1. **Several repositories in one project.** A project may be a plain folder that holds
   repositories (for example `D:\code`). The Source Control tab must list the repositories
   inside it, let the user pick one, and then show that repository exactly as it does for a
   project that is a single repository.
2. **Show whether the remote works.** When a repository is shown, tell the user whether the
   credentials git would use can read from and push to its remote, without changing
   anything. This explains failed pushes before the user tries one.

## Choosing a repository

### Discovery

`GET /api/git/repositories?project=<id>[&depth=<1-6>]` returns

```json
{
  "repositories": [{ "path": "services/api", "name": "api", "isProjectRoot": false, "branch": "develop" }],
  "truncated": false
}
```

- `path` is relative to the project folder, `/`-separated. The empty path is the project
  folder itself; it is listed first when the folder is, or sits inside, a work tree.
- The scan is breadth-first to a depth of 3 (default), with a limit of 200 results and a
  4 s time budget. `truncated` is true when a limit stopped it.
- A directory counts as a repository when it has a `.git` directory or file (worktrees and
  submodules use a file). The scan does not descend into a repository.
- It skips hidden directories, symlinks and `node_modules`, `vendor`, `dist`, `build`,
  `target`, `out`, `venv`, `__pycache__`, `bower_components`.
- `branch` is read from `.git/HEAD` without starting git, so a list of many repositories
  stays cheap. It is `null` for a detached HEAD and for worktrees.

### Acting on one repository

Every git route (`/api/git/*`) and worktree route (`/api/worktrees/*`) accepts an optional
`repo`, in the query string or the JSON body. It is a path relative to the project folder.
Without it, behaviour is unchanged.

`resolveRepositoryPath` (`server/shared/repository-path.ts`) confines it to the project:
absolute paths, drive letters, `..` and NUL are refused, and the real path (symlinks and
junctions resolved) must stay inside the project's real path. A missing path is a 404, a
file a 400. Git is only ever started in a directory that passed this check.

### Client

- The chosen repository is stored per project (`localStorage`, key
  `git-active-repository:<projectId>`) in `src/shared/gitRepositorySelection.ts`. `api.git.*`
  and `api.worktrees.*` add it to their requests themselves, so the Source Control tab, the
  command palette and the compare view all follow the same repository without passing it
  around.
- `useGitRepositories` runs the discovery when a project is shown. A remembered repository
  that no longer exists is replaced. The default is the project folder when it is a
  repository, otherwise the first repository found. The tab waits for the discovery before
  its first request, so it never flashes "not a git repository" for a folder of repositories.
- If discovery finds nothing, the tab behaves as before and offers `git init` for the
  project folder. If discovery fails, the project folder is used.
- The selector appears only when there is something to choose: more than one entry, or a
  single entry that is not the project folder. Lists above 8 entries get a search box.
  Switching repository resets the tab's state and remounts the Changes, Compare and
  Worktrees views.
- File paths from git are relative to the repository; the panel prefixes the repository
  path before opening a file in the editor.

## Remote access check

`GET /api/git/remote-access?project=<id>[&repo=<path>][&force=1]`

Probes the upstream remote of the current branch (`origin`, or the first remote, when there
is no upstream):

| Probe | Command | Tells |
|---|---|---|
| Read | `git ls-remote <remote> HEAD` | The remote answers and the credentials can read. |
| Write | `git push --dry-run --no-verify <remote> HEAD:refs/heads/<branch>` | The server accepts the credentials for pushing. A dry run opens the server's receive-pack endpoint, where GitHub, GitLab and Bitbucket reject missing or read-only credentials. Nothing is sent or changed. |
| Public | `git -c credential.helper= ls-remote <url without credentials> HEAD` (http and https only) | The repository is readable anonymously. |

The state shown is one of:

| State | Meaning |
|---|---|
| `read-write` | Read works and the dry-run push was accepted (a non-fast-forward rejection counts: the server accepted the credentials). |
| `read-only` | Read works, push is refused. A public repository with no credentials ends up here, with the note "readable without credentials". |
| `readable` | Read works, push could not be tested: no commits yet, detached HEAD, or the remote did not answer the push probe. |
| `no-access` | The remote rejected the credentials, or none are configured. |
| `not-found` | The repository does not exist or the credentials cannot see it. GitHub answers this way for private repositories. |
| `host-key` | The SSH host key is unknown or changed. |
| `unreachable` | DNS failure, refused or timed-out connection. |
| `no-remote` | The repository has no remote. |
| `error` | Anything else; the last line of git's error output is shown. |

The write result is a strong hint, not a guarantee. Branch protection rules and server-side
hooks are only evaluated by a real push.

### Safety of the probes

- Non-interactive: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and SSH runs with
  `BatchMode=yes -o ConnectTimeout=8` (added to a `GIT_SSH_COMMAND` or `core.sshCommand` the
  user already set). A probe can never wait for a prompt. Each command has a 15 s limit.
- `LC_ALL=C` so the failure patterns match English output.
- `--no-verify` keeps a `pre-push` hook from running.
- Credentials never leave the process: URLs are shown without passwords and git's output is
  scrubbed of `scheme://user:password@` before it is returned.
- Results are cached for 60 s per repository, remote, URL and branch. Concurrent checks of
  the same key share one probe. `force=1` bypasses the cache.
- The check contacts the remote each time a repository opens, like a fetch would. The
  badge's popover has "Check when a repository opens" to turn that off (stored in
  `localStorage` as `git-remote-access-auto-check`); the check can then be run by hand.

### Which credentials are tested

The ones git would use for a push from that repository: the user's credential helpers or
URL for https, and the default SSH identity (or the agent) for ssh. The check does not
configure anything. Managing credentials is not part of this change.

## Not covered

- Choosing credentials per scope (global, project, repository) and the SSH key settings page
  are separate work.
- Commands run by an agent in its own shell are not affected by the selected repository;
  they run wherever the agent's working directory is.
