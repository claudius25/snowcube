import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { Cell, DEFAULT_OPTIONS, Direction, GameEngine } from './engine';
import { CubeStyle, GameRenderer, ScreenKey } from './renderer';

const BEST_SCORE_KEY = 'snowcube.best';

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
  private modelReady = false;

  readonly boardSizes: readonly number[] = [6, 7, 8, 10];

  readonly score = signal(0);
  readonly moves = signal(0);
  readonly streak = signal(0);
  readonly bestStreak = signal(0);
  readonly cleared = signal(0);
  readonly colored = signal(0);
  readonly gameOver = signal(false);
  readonly best = signal(this.loadBest());

  readonly boardSize = signal(DEFAULT_OPTIONS.size);
  readonly spawnInterval = signal(DEFAULT_OPTIONS.spawnInterval);
  readonly hints = signal(true);
  readonly cubeStyle = signal<CubeStyle>('box');
  readonly modelLoading = signal(false);
  readonly modelFailed = signal(false);

  readonly tileCount = computed(() => this.boardSize() * this.boardSize());
  readonly pressure = computed(() => Math.round((this.colored() / this.tileCount()) * 100));

  ngAfterViewInit(): void {
    this.renderer = new GameRenderer(this.canvasRef().nativeElement, this.engine);
    this.renderer.onTileSelect = (cell) => this.selectTile(cell);
    this.renderer.onCubeModel = (loaded) => {
      this.modelReady = loaded;
      this.modelLoading.set(false);
      this.modelFailed.set(!loaded);
      if (!loaded) this.cubeStyle.set('box');
    };
    this.renderer.mount();
    this.renderer.setHints(this.hints());
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
      this.sync();
      const next = this.queued;
      this.queued = null;
      if (next) this.move(next);
    });
    this.moves.set(this.engine.moves);
  }

  restart(): void {
    this.queued = null;
    this.engine.reset({ size: this.boardSize(), spawnInterval: this.spawnInterval() });
    this.renderer?.rebuild();
    this.sync();
  }

  setBoardSize(size: number): void {
    if (size === this.boardSize()) return;
    this.boardSize.set(size);
    this.restart();
  }

  setSpawnInterval(interval: number): void {
    if (interval === this.spawnInterval()) return;
    this.spawnInterval.set(interval);
    this.restart();
  }

  toggleHints(): void {
    this.hints.update((on) => !on);
    this.renderer?.setHints(this.hints());
  }

  setCubeStyle(style: CubeStyle): void {
    if (style === this.cubeStyle()) return;
    this.cubeStyle.set(style);
    this.modelFailed.set(false);
    this.modelLoading.set(style === 'frame' && !this.modelReady);
    this.renderer?.setCubeStyle(style);
  }

  resetCamera(): void {
    this.renderer?.resetCamera();
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
    } else if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      this.toggleHints();
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

  private sync(): void {
    this.score.set(this.engine.score);
    this.moves.set(this.engine.moves);
    this.streak.set(this.engine.streak);
    this.bestStreak.set(this.engine.bestStreak);
    this.cleared.set(this.engine.neutralized);
    this.colored.set(this.engine.coloredCount);
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
