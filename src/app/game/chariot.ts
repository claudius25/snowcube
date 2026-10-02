import { Cell } from './engine';

/** What the chariot needs from the board; `GameEngine` satisfies this structurally. */
export interface ChariotBoard {
  readonly size: number;
  readonly cube: Cell;
  tileAt(x: number, z: number): number;
  blocked(from: Cell, to: Cell): boolean;
}

export interface ChariotMove {
  readonly from: Cell;
  readonly to: Cell;
  /** Tile the chariot came down on, which the engine then clears. */
  readonly crushed: Cell | null;
}

/**
 * A helper cart that hunts one colour: every turn it rolls one square towards the
 * nearest tile of its colour and crushes the tile once it is standing on it.
 */
export class Chariot {
  enabled = true;
  cell: Cell = { x: 0, z: 0 };
  color = 0;

  reset(size: number, color: number, avoid: Cell): void {
    this.color = color;
    const corners: Cell[] = [
      { x: 0, z: 0 },
      { x: size - 1, z: 0 },
      { x: 0, z: size - 1 },
      { x: size - 1, z: size - 1 },
    ];
    const free = corners.filter((cell) => cell.x !== avoid.x || cell.z !== avoid.z);
    this.cell = free[Math.floor(Math.random() * free.length)];
  }

  /** Advances one square. Returns the cell it crushed, if any. */
  step(board: ChariotBoard): ChariotMove | null {
    if (!this.enabled) return null;
    const from = this.cell;

    if (board.tileAt(from.x, from.z) === this.color) {
      return { from, to: from, crushed: from };
    }

    const target = this.nearest(board);
    if (!target) return null;

    const next = this.stepToward(board, target);
    if (!next) return null;

    this.cell = next;
    const crushed = board.tileAt(next.x, next.z) === this.color ? next : null;
    return { from, to: next, crushed };
  }

  private nearest(board: ChariotBoard): Cell | null {
    let best: Cell | null = null;
    let bestDistance = Infinity;
    for (let z = 0; z < board.size; z++) {
      for (let x = 0; x < board.size; x++) {
        if (board.tileAt(x, z) !== this.color) continue;
        const distance = Math.abs(x - this.cell.x) + Math.abs(z - this.cell.z);
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        best = { x, z };
      }
    }
    return best;
  }

  /** Closes the wider axis first, falling back to the other when that square is taken. */
  private stepToward(board: ChariotBoard, target: Cell): Cell | null {
    const dx = Math.sign(target.x - this.cell.x);
    const dz = Math.sign(target.z - this.cell.z);
    const alongX: Cell = { x: this.cell.x + dx, z: this.cell.z };
    const alongZ: Cell = { x: this.cell.x, z: this.cell.z + dz };

    const wideX = Math.abs(target.x - this.cell.x) >= Math.abs(target.z - this.cell.z);
    const order = wideX ? [alongX, alongZ] : [alongZ, alongX];
    for (const candidate of order) {
      if (candidate.x === this.cell.x && candidate.z === this.cell.z) continue;
      if (candidate.x < 0 || candidate.z < 0) continue;
      if (candidate.x >= board.size || candidate.z >= board.size) continue;
      if (candidate.x === board.cube.x && candidate.z === board.cube.z) continue;
      if (board.blocked(this.cell, candidate)) continue;
      return candidate;
    }
    return null;
  }
}
