import {
  isManuscriptId, manuscriptLimits, manuscriptNodeTypes, type ManuscriptNode, type ManuscriptNodeKind,
} from '../../../../platform/manuscript/common/manuscript.js';
import {
  buildIndex as buildNavigatorIndex, preorder, type NavigatorIndex, type NavigatorLine as TreeLine, type NavigatorTreeOptions,
} from '../../../common/navigator/navigatorTree.js';

export {
  breadcrumb, dropPositionAt, firstKey, labelOf, moveKey, navigatorLines, OVERSCAN, parentLine, resolveDrop, revealOffset,
  twigParts, TWIG_TEXT, UP_KEY, windowRange, type DropPosition, type TwigPart,
} from '../../../common/navigator/navigatorTree.js';

export type ManuscriptIndex = NavigatorIndex<ManuscriptNode>;
export type NavigatorLine = TreeLine<ManuscriptNode>;

const numberSuffix: Partial<Record<ManuscriptNodeKind, string>> = { part: '부', chapter: '장' };

export const manuscriptTreeOptions: NavigatorTreeOptions<ManuscriptNode> = {
  types: manuscriptNodeTypes,
  maxNodes: manuscriptLimits.nodes,
  isId: isManuscriptId,
  invalidTree: 'The manuscript tree is invalid.',
  label(node, ordinal) {
    const suffix = numberSuffix[node.kind];
    if (!suffix) {
      return node.title || 'Untitled';
    }
    const number = `${ordinal}${suffix}`;
    return node.title ? `${number} - ${node.title}` : number;
  },
};

export function buildIndex(nodes: readonly ManuscriptNode[]): ReturnType<typeof buildNavigatorIndex<ManuscriptNode>> {
  return buildNavigatorIndex(nodes, manuscriptTreeOptions);
}

export function hasDocumentsUnder(nodeId: string, index: ManuscriptIndex): boolean {
  if (index.nodes.get(nodeId)?.kind === 'document') {
    return true;
  }
  for (const node of preorder(nodeId, index)) {
    if (node.kind === 'document') {
      return true;
    }
  }
  return false;
}

export function documentsUnder(nodeId: string | null, index: ManuscriptIndex): string[] {
  if (nodeId !== null && index.nodes.get(nodeId)?.kind === 'document') {
    return [nodeId];
  }
  const documents: string[] = [];
  for (const node of preorder(nodeId, index)) {
    if (node.kind === 'document') {
      documents.push(node.id);
    }
  }
  return documents;
}
