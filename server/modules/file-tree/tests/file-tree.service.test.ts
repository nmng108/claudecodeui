import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

type VirtualDirectory = { [name: string]: string | VirtualDirectory };

/**
 * A read-only filesystem built from a nested object: a string is a file with
 * that content, an object is a directory. Keeps listing and search tests
 * describing real layouts (several repos, nested `.gitignore` files) in a few
 * lines instead of hand-written path switches.
 */
function createVirtualFileSystem(root: string, tree: VirtualDirectory) {
  const openedDirectories: string[] = [];

  const lookup = (candidatePath: string): string | VirtualDirectory | undefined => {
    const relativePath = path.relative(root, candidatePath);
    const segments = relativePath ? relativePath.split(path.sep) : [];
    let node: string | VirtualDirectory | undefined = tree;
    for (const segment of segments) {
      if (typeof node !== 'object' || !(segment in node)) return undefined;
      node = node[segment];
    }
    return node;
  };
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    stat: async (candidatePath) => {
      const node = lookup(candidatePath);
      if (node === undefined) throw missing();
      return createStats(typeof node === 'object', 0o644);
    },
    lstat: async (candidatePath) => {
      const node = lookup(candidatePath);
      if (node === undefined) throw missing();
      return createStats(typeof node === 'object', 0o644);
    },
    readTextFile: async (filePath) => {
      const node = lookup(filePath);
      if (typeof node !== 'string') throw missing();
      return node;
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      openedDirectories.push(directoryPath);
      const node = lookup(directoryPath);
      if (typeof node !== 'object') return [];
      return Object.entries(node).map(([name, child]) => createDirectoryEntry(name, typeof child === 'object'));
    }),
  });

  return { fileSystem, openedDirectories };
}

const names = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);

test('listDirectory returns a single level without children and applies the root gitignore', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem, openedDirectories } = createVirtualFileSystem(projectRoot, {
    '.git': { HEAD: 'ref' },
    node_modules: { dep: { 'index.js': '' } },
    '.gitignore': '*.log',
    'debug.log': '',
    'README.md': '',
    docs: { 'guide.md': '' },
    src: { 'index.ts': '' },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listDirectory('project-1', { respectGitignore: true });

  assert.equal(listing.path, projectRoot);
  assert.equal(listing.truncated, false);
  assert.deepEqual(names(listing.entries), ['docs', 'src', '.gitignore', 'README.md']);
  assert.ok(listing.entries.every((entry) => entry.children === undefined));
  assert.equal(listing.entries[0]?.permissions, '644');
  assert.deepEqual(openedDirectories, [projectRoot]);
});

test('listDirectory reads the requested subdirectory and rejects paths outside the project', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    src: { 'index.ts': '', lib: { 'a.ts': '' } },
    'README.md': '',
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const relative = await service.listDirectory('project-1', { directoryPath: 'src' });
  assert.deepEqual(names(relative.entries), ['lib', 'index.ts']);
  assert.equal(relative.path, path.join(projectRoot, 'src'));

  const absolute = await service.listDirectory('project-1', {
    directoryPath: path.join(projectRoot, 'src', 'lib'),
  });
  assert.deepEqual(names(absolute.entries), ['a.ts']);

  await assert.rejects(
    service.listDirectory('project-1', { directoryPath: path.resolve('elsewhere') }),
    (error: unknown) => error instanceof AppError && error.code === 'PATH_OUTSIDE_PROJECT',
  );
  await assert.rejects(
    service.listDirectory('project-1', { directoryPath: path.join(projectRoot, 'README.md') }),
    (error: unknown) => error instanceof AppError && error.code === 'FILE_TREE_NOT_A_DIRECTORY',
  );
  await assert.rejects(
    service.listDirectory('project-1', { directoryPath: 'missing' }),
    (error: unknown) => error instanceof AppError && error.code === 'FILE_TREE_ENTRY_NOT_FOUND',
  );
});

test('listDirectory falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    build: { 'out.js': '' },
    dist: {},
    docs: { 'guide.md': '' },
    node_modules: {},
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listDirectory('project-1', { respectGitignore: true });

  assert.deepEqual(names(listing.entries), ['docs']);
});

test('listDirectory applies each nested repository gitignore inside a multi-repo workspace', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    '.kiro': { specs: { 'a.md': '' } },
    'repo-a': {
      '.gitignore': 'generated/\n*.tmp',
      generated: { 'x.ts': '' },
      dist: { 'bundle.js': '' },
      'keep.ts': '',
      'scratch.tmp': '',
    },
    'repo-b': {
      generated: { 'y.ts': '' },
      dist: { 'bundle.js': '' },
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const workspaceRoot = await service.listDirectory('project-1', { respectGitignore: true });
  assert.deepEqual(names(workspaceRoot.entries), ['.kiro', 'repo-a', 'repo-b']);

  // repo-a has a .gitignore, so only its rules apply: `dist` is not named there and stays visible.
  const repoA = await service.listDirectory('project-1', {
    directoryPath: 'repo-a',
    respectGitignore: true,
  });
  assert.deepEqual(names(repoA.entries), ['dist', '.gitignore', 'keep.ts']);

  // repo-b has none, so the conventional-name fallback hides `dist` but not `generated`.
  const repoB = await service.listDirectory('project-1', {
    directoryPath: 'repo-b',
    respectGitignore: true,
  });
  assert.deepEqual(names(repoB.entries), ['generated']);
});

test('listDirectory lets a deeper gitignore re-include what a shallower one ignored', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    '.gitignore': '*.log',
    'root.log': '',
    logs: {
      '.gitignore': '!keep.log',
      'keep.log': '',
      'drop.log': '',
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listDirectory('project-1', {
    directoryPath: 'logs',
    respectGitignore: true,
  });

  assert.deepEqual(names(listing.entries), ['.gitignore', 'keep.log']);
});

test('listDirectory has no whole-project entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const largeDirectory: VirtualDirectory = {};
  for (let index = 0; index < 15_000; index += 1) {
    largeDirectory[`file-${index}.txt`] = '';
  }
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    first: largeDirectory,
    second: { ...largeDirectory },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const first = await service.listDirectory('project-1', { directoryPath: 'first' });
  const second = await service.listDirectory('project-1', { directoryPath: 'second' });

  assert.equal(first.entries.length, 15_000);
  assert.equal(second.entries.length, 15_000);
  assert.equal(first.truncated, false);
});

test('listDirectory stops reading a directory stream once the per-directory cap is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the listing has to stop consuming the stream itself.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listDirectory('project-1');

  assert.equal(listing.truncated, true);
  assert.equal(listing.entries.length, 100_000);
  assert.equal(streamedEntries, 100_001);
});

test('searchProjectFiles finds nested matches across repositories and skips hard exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    '.kiro': { specs: { 'deploy-notes.md': '' } },
    node_modules: { 'deploy.js': '' },
    'repo-a': { src: { 'deploy.ts': '' }, '.git': { 'deploy.pack': '' } },
    'repo-b': { 'README.md': '' },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const response = await service.searchProjectFiles('project-1', { query: 'deploy' });

  assert.equal(response.truncated, false);
  assert.deepEqual(
    response.results.map((result) => result.relativePath),
    ['.kiro/specs/deploy-notes.md', 'repo-a/src/deploy.ts'],
  );
  assert.equal(response.results[1]?.path, path.join(projectRoot, 'repo-a', 'src', 'deploy.ts'));
  assert.equal(response.results[1]?.type, 'file');
});

test('searchProjectFiles matches folder segments in the path and honors the type filter', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    docs: { 'api.md': '', guides: { 'start.md': '' } },
    src: { 'docs.ts': '' },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const directories = await service.searchProjectFiles('project-1', { query: 'docs', type: 'directory' });
  assert.deepEqual(directories.results.map((result) => result.relativePath), ['docs', 'docs/guides']);

  const files = await service.searchProjectFiles('project-1', { query: 'docs', type: 'file' });
  // The file whose name matches ranks ahead of files that match only through their folder.
  assert.deepEqual(
    files.results.map((result) => result.relativePath),
    ['src/docs.ts', 'docs/api.md', 'docs/guides/start.md'],
  );
});

test('searchProjectFiles applies nested gitignore rules per repository', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    'repo-a': {
      '.gitignore': 'generated/',
      generated: { 'schema.ts': '' },
      'schema.ts': '',
    },
    'repo-b': {
      generated: { 'schema.ts': '' },
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const respecting = await service.searchProjectFiles('project-1', {
    query: 'schema',
    respectGitignore: true,
  });
  assert.deepEqual(
    respecting.results.map((result) => result.relativePath).sort(),
    ['repo-a/schema.ts', 'repo-b/generated/schema.ts'],
  );

  const everything = await service.searchProjectFiles('project-1', { query: 'schema' });
  assert.equal(everything.results.length, 3);
});

test('searchProjectFiles caps results at the limit and reports truncation', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const tree: VirtualDirectory = {};
  for (let index = 0; index < 30; index += 1) {
    tree[`note-${String(index).padStart(2, '0')}.md`] = '';
  }
  const { fileSystem } = createVirtualFileSystem(projectRoot, tree);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const response = await service.searchProjectFiles('project-1', { query: 'note', limit: 10 });

  assert.equal(response.results.length, 10);
  assert.equal(response.truncated, true);
});

test('searchProjectFiles with an empty query lists files breadth first', async () => {
  const projectRoot = path.resolve('file-tree-test-workspace');
  const { fileSystem } = createVirtualFileSystem(projectRoot, {
    'top.md': '',
    deep: { deeper: { 'bottom.md': '' } },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const response = await service.searchProjectFiles('project-1', { query: '', type: 'file' });

  assert.deepEqual(response.results.map((result) => result.relativePath), ['top.md', 'deep/deeper/bottom.md']);
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});
