/**
 * Ids for things the user creates on the canvas.
 *
 * One generator, shared, because ids from two sources have to stay distinct inside
 * one document: a node id, and — since conditionals — a branch id that edges are
 * attached by. The counter makes ids unique within a session even when two are
 * minted in the same millisecond, and the timestamp keeps them from colliding with
 * ids in a document created in an earlier session and loaded into this one.
 */

let counter = 0;

/** A fresh id, prefixed so it reads as what it identifies. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
