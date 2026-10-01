import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { colorCss } from './colors';
import { Cell, Direction, GameEngine, MoveOutcome } from './engine';
import { GameRenderer, ScreenKey } from './renderer';

const BEST_SCORE_KEY = 'snowcube.best';

/** Circles shown before the first move, so the track starts right-aligned and full. */
const TIMELINE_OPENING = 3;
/** The track clips long before this; it only caps how much history we keep. */
const TIMELINE_MAX = 32;

export interface Turn {
  readonly id: number;
  /** Colour that appeared on this turn, or null when nothing was coloured. */
  readonly color: number | null;
  readonly matched: boolean;
}

@Component({
  selector: 'app-game',
  templateUrl: './game.html',
  styleUrl: './game.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Game implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private readonly engine = new GameEngine();
  private renderer?: GameRenderer;
  private queued: Direction | null = null;
  private turnId = 0;

  readonly score = signal(0);
  readonly moves = signal(0);
  readonly streak = signal(0);
  readonly bestStreak = signal(0);
  readonly cleared = signal(0);
  readonly gameOver = signal(false);
  readonly best = signal(this.loadBest());
  readonly turns = signal<readonly Turn[]>(this.openingTurns());

  ngAfterViewInit(): void {
    this.renderer = new GameRenderer(this.canvasRef().nativeElement, this.engine);
    this.renderer.onTileSelect = (cell) => this.selectTile(cell);
    this.renderer.mount();
    this.sync();
  }

  ngOnDestroy(): void {
    this.renderer?.dispose();
  }

  move(direction: Direction): void {
    if (this.engine.gameOver) return;
    if (this.renderer?.busy) {
      this.queued = direction;
      return;
    }
    const outcome = this.engine.move(direction);
    if (!outcome) {
      this.renderer?.playBump(direction);
      return;
    }
    this.renderer?.playMove(outcome, () => {
      this.recordTurn(outcome);
      this.sync();
      const next = this.queued;
      this.queued = null;
      if (next) this.move(next);
    });
    this.moves.set(this.engine.moves);
  }

  /** Fill for a turn circle; the opening slots have no colour yet. */
  turnFill(turn: Turn): string {
    return turn.color === null ? 'rgba(255, 255, 255, 0.1)' : colorCss(turn.color);
  }

  restart(): void {
    this.queued = null;
    this.turnId = 0;
    this.turns.set(this.openingTurns());
    this.engine.reset();
    this.renderer?.rebuild();
    this.sync();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return;

    const key = this.screenKey(event.key);
    if (key) {
      event.preventDefault();
      this.move(this.renderer?.resolveDirection(key) ?? 'north');
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this.restart();
    }
  }

  private screenKey(key: string): ScreenKey | null {
    switch (key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        return 'up';
      case 'ArrowDown':
      case 's':
      case 'S':
        return 'down';
      case 'ArrowLeft':
      case 'a':
      case 'A':
        return 'left';
      case 'ArrowRight':
      case 'd':
      case 'D':
        return 'right';
      default:
        return null;
    }
  }

  /** Clicking an orthogonally adjacent tile rolls the cube onto it. */
  private selectTile(cell: Cell): void {
    const dx = cell.x - this.engine.cube.x;
    const dz = cell.z - this.engine.cube.z;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return;
    if (dx === 1) this.move('east');
    else if (dx === -1) this.move('west');
    else if (dz === 1) this.move('south');
    else this.move('north');
  }

  private openingTurns(): Turn[] {
    return Array.from({ length: TIMELINE_OPENING }, () => ({
      id: this.turnId++,
      color: null,
      matched: false,
    }));
  }

  private recordTurn(outcome: MoveOutcome): void {
    // A match clears instead of spawning, so that turn shows the colour it chased away.
    const turn: Turn = {
      id: this.turnId++,
      color: outcome.spawned?.color ?? (outcome.neutralized ? outcome.landingColor : null),
      matched: outcome.neutralized,
    };
    this.turns.update((list) => [...list, turn].slice(-TIMELINE_MAX));
  }

  private sync(): void {
    this.score.set(this.engine.score);
    this.moves.set(this.engine.moves);
    this.streak.set(this.engine.streak);
    this.bestStreak.set(this.engine.bestStreak);
    this.cleared.set(this.engine.neutralized);
    this.gameOver.set(this.engine.gameOver);

    if (this.engine.score > this.best()) {
      this.best.set(this.engine.score);
      this.saveBest(this.engine.score);
    }
  }

  private loadBest(): number {
    try {
      return Number(localStorage.getItem(BEST_SCORE_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  private saveBest(value: number): void {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(value));
    } catch {
      // storage unavailable — scores simply are not persisted
    }
  }
}
