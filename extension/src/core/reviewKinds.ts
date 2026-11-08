import type { ReviewItem } from './review';

/**
 * What the HTML renderer needs to know about review blocks, without the review module itself: the markdown-it
 * plugin renders them too, and must not pull in query, the agent view and markdown-it with it.
 */

/** Containers that are responses, not content. */
export const REVIEW_CONTAINERS: readonly string[] = Object.freeze(['comment', 'suggestion']);

export type ReviewType = 'comment' | 'suggestion';

/** The states that close an item. Anything else (including no status) is open. */
export const CLOSED_STATES: Readonly<Record<ReviewType, readonly string[]>> = Object.freeze({
  comment: Object.freeze(['resolved']),
  suggestion: Object.freeze(['accepted', 'rejected', 'withdrawn']),
});

const REVIEW_LINE = /^[ \t]*:{3,}[ \t]*(?:comment|suggestion)\b/im;

/** Whether a text may hold a review block (a fast check before parsing it). */
export function hasReviewBlocks(text: string): boolean {
  return REVIEW_LINE.test(text);
}

let reader: ((text: string) => ReviewItem[]) | undefined;

/** The review module registers how to read a document's items (targets, revisions, staleness). */
export function setReviewReader(read: (text: string) => ReviewItem[]): void {
  reader = read;
}

/** A document's review items, or none when only the plugin is loaded: review boxes then render without staleness. */
export function readReviewItems(text: string): ReviewItem[] {
  return reader ? reader(text) : [];
}
