# File tree: lazy loading and server-side search

The Files tab no longer loads a whole project. It used to fetch the full tree to depth 10
and refused any project with more than 10,000 visible entries (HTTP 413
`FILE_TREE_TOO_LARGE`). That cap existed only because the whole tree was built in memory
on every request. A workspace with many repositories plus thousands of generated files
(for example `.kiro/`) hit it.

## API

| Request | Purpose |
|---|---|
| `GET /api/file-tree/projects/:id/files?path=<dir>&respectGitignore=true` | One directory level. `path` is absolute or project-relative and defaults to the project root. Returns `{ path, entries, truncated }`. Entries never carry `children`. |
| `GET /api/file-tree/projects/:id/files/search?q=&type=file\|directory&limit=&respectGitignore=` | Searches the whole project on the server. Returns `{ results, truncated }`; each result is a tree node plus `relativePath` (`/`-separated). |

`path` must stay inside the project (403 `PATH_OUTSIDE_PROJECT` otherwise), and must be an
existing directory (404 / 400).

## Ignore rules

With `respectGitignore=true`, every `.gitignore` from the project root down to the listed
directory is applied. Patterns are relative to the directory that holds the file, and a
deeper file overrides a shallower one (so `!keep.log` in a sub-folder re-includes a file a
parent ignored). This is what makes a workspace of several repositories work: each
repository's own `.gitignore` applies inside that repository.

When no `.gitignore` applies to a directory, the conventional names (`dist`, `build`,
`target`, `venv`, ...) are hidden instead. `node_modules`, `.git`, `.svn` and `.hg` are always hidden.

## Limits that remain

There is no limit on project size. Two guards bound a single request:

- One directory returns at most 100,000 entries (`truncated: true` beyond that).
- A search returns at most 1,000 results (default 200) and stops after visiting 500,000
  entries or running for 8 seconds, reporting `truncated: true`.

## Client

- `useFileTreeData` fetches the root, then a folder's children the first time it is
  expanded. A refresh reloads the root and every folder opened so far.
- Typing in the search box calls the search endpoint (debounced) and shows the matches with
  their folders open. It no longer filters what happens to be loaded.
- The `@` file mention, the command palette file list and the chat file-reference resolver
  use the same search endpoint.
- A reveal request for a nested folder (`decisions/archive/` from a chat message) opens one
  level per load until the path is settled.

Tests: `server/modules/file-tree/tests`, `src/modules/file-tree/tests`, and `e2e/file-tree.spec.ts`
(a 12,000-file workspace with nested repositories).
