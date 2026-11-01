import type { TFunction } from 'i18next';

import type { FileTreeNode, FileTreeSearchHit } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

const compareTreeNodes = (left: FileTreeNode, right: FileTreeNode) => {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
};

/**
 * Arranges flat server search hits into a tree so they render with the usual
 * folder rows. Folders that only lead to a hit are synthesized from the hit's
 * relative path; their absolute path is the hit's absolute path with the
 * trailing segments removed, so the platform's separator never has to be known.
 */
export function buildSearchTree(hits: FileTreeSearchHit[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const nodesByPath = new Map<string, FileTreeNode>();

  for (const hit of hits) {
    const segments = hit.relativePath.split('/').filter(Boolean);
    const prefixLength = hit.path.length - hit.relativePath.length;
    if (segments.length === 0 || prefixLength < 1) {
      continue;
    }
    const separator = hit.path[prefixLength - 1];
    const rootPath = hit.path.slice(0, prefixLength - 1);

    let siblings = roots;
    let currentPath = rootPath;
    segments.forEach((segment, index) => {
      currentPath = `${currentPath}${separator}${segment}`;
      const isLast = index === segments.length - 1;
      let node = nodesByPath.get(currentPath);

      if (!node) {
        node = isLast
          ? { ...hit, children: hit.type === 'directory' ? [] : undefined }
          : { name: segment, type: 'directory', path: currentPath, children: [] };
        nodesByPath.set(currentPath, node);
        siblings.push(node);
      } else if (isLast) {
        // The folder was created as an ancestor of an earlier hit; fill in its own details.
        Object.assign(node, hit, { children: node.children });
      }

      siblings = node.children ?? siblings;
    });
  }

  const sortRecursively = (nodes: FileTreeNode[]) => {
    nodes.sort(compareTreeNodes);
    nodes.forEach((node) => node.children && sortRecursively(node.children));
  };
  sortRecursively(roots);
  return roots;
}

// During search we auto-expand every directory present in the filtered subtree.
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

