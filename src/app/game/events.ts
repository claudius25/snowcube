import { Cell } from './engine';

/** Moves between two consecutive events. */
export const EVENT_INTERVAL = 20;
/** Hand this to `GameEngine` to turn the director off (the intro does). */
export const NO_EVENTS = Number.MAX_SAFE_INTEGER;

export const WALL_MOVES = 5;

/** Walls run along one board line; 2-3 segments read clearly without boxing anything in. */
const WALL_MIN_LENGTH = 2;
const WALL_MAX_LENGTH = 3;
const PLACEMENT_TRIES = 40;

export type EventKind = 'wall';

/**
 * A wall sits on the east or south edge of cell `x,z`, so it separates
 * `(x,z)` from `(x+1,z)` or from `(x,z+1)`.
 */
export interface WallEdge {
  readonly x: number;
  readonly z: number;
  readonly side: 'east' | 'south';
}

export interface WallEvent {
  readonly id: number;
  readonly kind: 'wall';
  readonly duration: number;
  readonly edges: readonly WallEdge[];
  movesLeft: number;
}

export type GameEvent = WallEvent;

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

/** Schedules the timed board events and answers whether the cube may cross a given edge. */
export class EventDirector {
  interval = EVENT_INTERVAL;
  active: GameEvent[] = [];

  private nextId = 1;
  private movesSince = 0;

  reset(): void {
    this.active = [];
    this.nextId = 1;
    this.movesSince = 0;
  }

  /** True when a wall stands between two orthogonally adjacent cells. */
  blocks(from: Cell, to: Cell): boolean {
    const x = Math.min(from.x, to.x);
    const z = Math.min(from.z, to.z);
    const side = from.x === to.x ? 'south' : 'east';
    for (const event of this.active) {
      for (const edge of event.edges) {
        if (edge.x === x && edge.z === z && edge.side === side) return true;
      }
    }
    return false;
  }

  /** Ages the running events and may start a new one. Call once per completed move. */
  advance(size: number, cube: Cell): GameEvent | null {
    this.active = this.active.filter((event) => --event.movesLeft > 0);

    if (++this.movesSince < this.interval) return null;
    this.movesSince = 0;

    const event = this.createWall(size, cube);
    if (event) this.active.push(event);
    return event;
  }

  /** Edges never touch the cube's cell, so a wall can never trap it where it stands. */
  private createWall(size: number, cube: Cell): WallEvent | null {
    if (size < 3) return null;

    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      const vertical = Math.random() < 0.5;
      const length = WALL_MIN_LENGTH + randomInt(WALL_MAX_LENGTH - WALL_MIN_LENGTH + 1);
      if (length > size) continue;

      const line = randomInt(size - 1);
      const start = randomInt(size - length + 1);
      const edges: WallEdge[] = [];
      for (let i = 0; i < length; i++) {
        edges.push(
          vertical
            ? { x: line, z: start + i, side: 'east' }
            : { x: start + i, z: line, side: 'south' },
        );
      }

      const touchesCube = edges.some((edge) =>
        edge.side === 'east'
          ? edge.z === cube.z && (edge.x === cube.x || edge.x + 1 === cube.x)
          : edge.x === cube.x && (edge.z === cube.z || edge.z + 1 === cube.z),
      );
      if (touchesCube) continue;
      if (edges.some((edge) => this.blocks({ x: edge.x, z: edge.z }, this.neighbour(edge)))) {
        continue;
      }

      return {
        id: this.nextId++,
        kind: 'wall',
        duration: WALL_MOVES,
        movesLeft: WALL_MOVES,
        edges,
      };
    }
    return null;
  }

  private neighbour(edge: WallEdge): Cell {
    return edge.side === 'east' ? { x: edge.x + 1, z: edge.z } : { x: edge.x, z: edge.z + 1 };
  }
}
