import { Quaternion, Vector3 } from 'three';
import { COLORS } from './colors';

/** Edge length of a tile — the cube is exactly the same size. */
export const TILE = 1;

/** Colour id used for an untouched / neutralised tile. */
export const NEUTRAL = -1;

export type Direction = 'north' | 'east' | 'south' | 'west';

export const DIRECTIONS: readonly Direction[] = ['north', 'east', 'south', 'west'];

export const UP = new Vector3(0, 1, 0);
export const DOWN = new Vector3(0, -1, 0);

export const DIRECTION_VECTORS: Readonly<Record<Direction, Vector3>> = {
  north: new Vector3(0, 0, -1),
  east: new Vector3(1, 0, 0),
  south: new Vector3(0, 0, 1),
  west: new Vector3(-1, 0, 0),
};

/** Local normals in BoxGeometry material-slot order: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_NORMALS: readonly Vector3[] = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

/** Colour id painted on each material slot; opposite faces carry opposite hues. */
export const FACE_COLORS: readonly number[] = [0, 3, 1, 4, 2, 5];

export interface Cell {
  readonly x: number;
  readonly z: number;
}

export interface SpawnedTile extends Cell {
  readonly color: number;
}

export interface Preview {
  readonly direction: Direction;
  /** The move is inside the board and the game is still running. */
  readonly legal: boolean;
  readonly cell: Cell;
  /** Colour of the face that would end up touching the floor. */
  readonly landingColor: number;
  readonly tileColor: number;
  readonly matches: boolean;
}

export interface MoveOutcome {
  readonly direction: Direction;
  readonly from: Cell;
  readonly to: Cell;
  readonly landingColor: number;
  readonly neutralized: boolean;
  readonly gained: number;
  readonly spawned: SpawnedTile | null;
  readonly gameOver: boolean;
}

export interface GameOptions {
  size: number;
  /** A fresh tile is coloured every N moves. */
  spawnInterval: number;
  /** Tiles already coloured when the game starts. */
  seedTiles: number;
}

export const DEFAULT_OPTIONS: GameOptions = { size: 8, spawnInterval: 2, seedTiles: 3 };

/**
 * Pure game state: the board, the cube's cell and its orientation.
 * Orientation is the single source of truth for which colour faces where,
 * so rendering can never drift out of sync with the rules.
 */
export class GameEngine {
  size = DEFAULT_OPTIONS.size;
  spawnInterval = DEFAULT_OPTIONS.spawnInterval;
  seedTiles = DEFAULT_OPTIONS.seedTiles;

  tiles: number[] = [];
  cube: Cell = { x: 0, z: 0 };
  readonly rotation = new Quaternion();

  score = 0;
  moves = 0;
  streak = 0;
  bestStreak = 0;
  neutralized = 0;
  gameOver = false;

  private movesSinceSpawn = 0;

  constructor(options: Partial<GameOptions> = {}) {
    this.reset(options);
  }

  reset(options: Partial<GameOptions> = {}): void {
    this.size = options.size ?? this.size;
    this.spawnInterval = options.spawnInterval ?? this.spawnInterval;
    this.seedTiles = options.seedTiles ?? this.seedTiles;

    this.tiles = new Array<number>(this.size * this.size).fill(NEUTRAL);
    const middle = Math.floor((this.size - 1) / 2);
    this.cube = { x: middle, z: middle };
    this.rotation.identity();

    this.score = 0;
    this.moves = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.neutralized = 0;
    this.gameOver = false;
    this.movesSinceSpawn = 0;

    for (let i = 0; i < this.seedTiles; i++) {
      this.spawn();
    }
  }

  index(x: number, z: number): number {
    return z * this.size + x;
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.size && z < this.size;
  }

  tileAt(x: number, z: number): number {
    return this.inBounds(x, z) ? this.tiles[this.index(x, z)] : NEUTRAL;
  }

  get coloredCount(): number {
    let n = 0;
    for (const t of this.tiles) {
      if (t !== NEUTRAL) n++;
    }
    return n;
  }

  /** Colour id of the face currently pointing along `worldDir`. */
  colorTowards(worldDir: Vector3): number {
    let slot = 0;
    let best = -Infinity;
    const n = new Vector3();
    for (let i = 0; i < FACE_NORMALS.length; i++) {
      const dot = n.copy(FACE_NORMALS[i]).applyQuaternion(this.rotation).dot(worldDir);
      if (dot > best) {
        best = dot;
        slot = i;
      }
    }
    return FACE_COLORS[slot];
  }

  get bottomColor(): number {
    return this.colorTowards(DOWN);
  }

  get topColor(): number {
    return this.colorTowards(UP);
  }

  /**
   * What would happen moving in `direction`. Rolling over an edge brings the
   * face currently pointing that way down onto the floor.
   */
  preview(direction: Direction): Preview {
    const v = DIRECTION_VECTORS[direction];
    const cell: Cell = { x: this.cube.x + v.x, z: this.cube.z + v.z };
    const legal = !this.gameOver && this.inBounds(cell.x, cell.z);
    const landingColor = this.colorTowards(v);
    const tile = legal ? this.tileAt(cell.x, cell.z) : NEUTRAL;
    return {
      direction,
      legal,
      cell,
      landingColor,
      tileColor: tile,
      matches: legal && tile !== NEUTRAL && tile === landingColor,
    };
  }

  previews(): Record<Direction, Preview> {
    return {
      north: this.preview('north'),
      east: this.preview('east'),
      south: this.preview('south'),
      west: this.preview('west'),
    };
  }

  /** Rolls the cube one tile. Returns null when the move is not allowed. */
  move(direction: Direction): MoveOutcome | null {
    if (this.gameOver) return null;

    const v = DIRECTION_VECTORS[direction];
    const from = this.cube;
    const to: Cell = { x: from.x + v.x, z: from.z + v.z };
    if (!this.inBounds(to.x, to.z)) return null;

    const axis = new Vector3().crossVectors(UP, v).normalize();
    this.rotation.premultiply(new Quaternion().setFromAxisAngle(axis, Math.PI / 2)).normalize();
    this.cube = to;
    this.moves++;

    const landingColor = this.bottomColor;
    const idx = this.index(to.x, to.z);
    const neutralized = this.tiles[idx] === landingColor;
    let gained = 0;

    if (neutralized) {
      this.tiles[idx] = NEUTRAL;
      gained = 1 + this.streak;
      this.score += gained;
      this.streak++;
      this.neutralized++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else {
      this.streak = 0;
    }

    let spawned: SpawnedTile | null = null;
    if (++this.movesSinceSpawn >= this.spawnInterval) {
      this.movesSinceSpawn = 0;
      spawned = this.spawn();
      if (!spawned) this.gameOver = true;
    }

    return {
      direction,
      from,
      to,
      landingColor,
      neutralized,
      gained,
      spawned,
      gameOver: this.gameOver,
    };
  }

  /** Colours one random snow tile. Returns null when the board is full. */
  private spawn(): SpawnedTile | null {
    const cubeIdx = this.index(this.cube.x, this.cube.z);
    const candidates: number[] = [];
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === NEUTRAL && i !== cubeIdx) candidates.push(i);
    }
    if (candidates.length === 0) return null;

    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    const color = Math.floor(Math.random() * COLORS.length);
    this.tiles[idx] = color;
    return { x: idx % this.size, z: Math.floor(idx / this.size), color };
  }
}
