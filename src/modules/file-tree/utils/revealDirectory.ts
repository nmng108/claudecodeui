import type { FileTreeNode } from '@/shared/types';

// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The paths to expand, root first, so `reference` becomes visible in the file
 * tree; empty when the reference is not inside the loaded tree.
 *
 * Each level is looked up by name in the tree that is already loaded, rather
 * than composed as a string: an in-chat reference is usually relative
 * (`decisions/`, as the model wrote it) while every node is keyed by the
 * absolute path the server built with its own platform separator. Expansion
 * stops at the last level actually present, so a folder hidden by `.gitignore`
 * or below the walk depth still opens as far as the tree goes.
 */
export function directoryRevealPaths(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): string[] {
  return directoryRevealProgress(files, projectPath, reference).paths;
}

/**
 * Like `directoryRevealPaths`, but also says whether the answer is final.
 *
 * Folders load when they are first expanded, so a deep reference resolves one
 * level at a time: `settled` is false while the walk stopped at a folder whose
 * children have not arrived yet, and the caller should ask again once the tree
 * changes. It is true when every level was found, or when a level that has
 * loaded simply does not contain the next name.
 */
export function directoryRevealProgress(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): { paths: string[]; settled: boolean } {
  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to expand) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return { paths: [], settled: true };
    }
    relative = target.slice(root.length + 1);
  }

  const paths: string[] = [];
  let level = files;
  // The root listing is always loaded; a deeper level is loaded once its folder has `children`.
  let levelLoaded = true;
  for (const segment of relative.split('/').filter(Boolean)) {
    const directory = level.find((node) => node.type === 'directory' && node.name === segment);
    if (!directory) {
      return { paths, settled: levelLoaded };
    }
    paths.push(directory.path);
    levelLoaded = directory.children !== undefined;
    level = directory.children ?? [];
  }

  return { paths, settled: true };
}
