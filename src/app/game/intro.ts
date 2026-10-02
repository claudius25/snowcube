import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { COLORS } from './colors';
import { Cell, DIRECTIONS, Direction, GameEngine, MoveOutcome, NEUTRAL } from './engine';
import { NO_EVENTS } from './events';
import { GameRenderer } from './renderer';

/** Large enough that the scripted intro never triggers a spawn. */
const NO_SPAWN = Number.MAX_SAFE_INTEGER;
/** How long the hand sits on a tile before the cube rolls, unless tapped sooner. */
const HAND_SECONDS = 0.85;
/** Demonstrated camera orbit: a quarter turn, slow enough to read. */
const SPIN_SECONDS = 2.2;
/** One board for the whole script, so the scene never cuts. */
const BOARD = 3;
/** Colour swaps demonstrated in the second chapter. */
const MATCH_DEMOS = 3;

interface Chapter {
  readonly title: string;
  readonly caption: string;
  readonly hint?: string;
}

const CHAPTERS: readonly Chapter[] = [
  {
    title: 'Roll the cube',
    caption: 'Tap a tile right next to the cube and it tips over one square onto it.',
    hint: 'Drag anywhere on the board to spin the camera around it.',
  },
  {
    title: 'Chase the colours',
    caption:
      'Coloured tiles creep onto the board. Roll the cube so the matching colour lands face down and the tile is chased away.',
  },
  {
    title: 'Your turn',
    caption: 'Keep rolling, keep matching — the board freezes over once every tile is coloured.',
  },
];

/** Scripted, camera-locked presentation of the rules; emits `done` when the player moves on. */
@Component({
  selector: 'app-intro',
  templateUrl: './intro.html',
  styleUrl: './intro.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Intro implements AfterViewInit, OnDestroy {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly handRef = viewChild.required<ElementRef<HTMLElement>>('hand');

  readonly done = output<void>();

  readonly chapters = CHAPTERS;
  readonly chapter = signal(0);
  readonly gesture = signal<'tap' | 'drag' | null>(null);
  readonly step = computed(() => CHAPTERS[this.chapter()]);
  readonly finished = computed(() => this.chapter() === CHAPTERS.length - 1);

  private readonly engine = new GameEngine({
    size: BOARD,
    seedTiles: 0,
    spawnInterval: NO_SPAWN,
    eventInterval: NO_EVENTS,
  });
  private renderer?: GameRenderer;
  private target: Cell | null = null;
  private stopped = false;
  private frameId = 0;
  private readonly timers = new Set<number>();
  private readonly pending = new Set<() => void>();
  /** Resolves the hand pause early when the player taps the suggested tile. */
  private tap: (() => void) | null = null;

  ngAfterViewInit(): void {
    const renderer = new GameRenderer(this.canvasRef().nativeElement, this.engine);
    renderer.allowZoom = false;
    renderer.onTileSelect = (cell) => this.onTileSelect(cell);
    renderer.mount();
    this.renderer = renderer;

    this.frameId = requestAnimationFrame(this.trackHand);
    void this.run();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  finish(): void {
    this.stop();
    this.done.emit();
  }

  private async run(): Promise<void> {
    await this.wait(700);

    for (const direction of ['east', 'south', 'west', 'north'] as Direction[]) {
      if (!(await this.demo(direction))) return;
      await this.wait(250);
      if (this.stopped) return;
    }

    this.gesture.set('drag');
    await this.orbit();
    this.gesture.set(null);
    await this.wait(300);
    if (this.stopped) return;

    this.chapter.set(1);
    this.scatter(2);
    await this.wait(700);
    if (this.stopped) return;

    for (let i = 0; i < MATCH_DEMOS; i++) {
      const direction = this.plantMatch();
      if (!direction) break;
      await this.wait(600);
      if (this.stopped) return;
      if (!(await this.demo(direction))) return;
      await this.wait(350);
      if (this.stopped) return;
    }

    this.chapter.set(2);
  }

  /** Points the hand at the tile the cube is about to roll onto, then rolls. */
  private async demo(direction: Direction): Promise<boolean> {
    const preview = this.engine.preview(direction);
    if (!preview.legal) return true;

    this.target = preview.cell;
    this.gesture.set('tap');
    await this.hint();
    this.gesture.set(null);
    this.target = null;
    if (this.stopped) return false;

    const outcome = this.engine.move(direction);
    if (outcome) await this.roll(outcome);
    return !this.stopped;
  }

  /** Colours random tiles so the board does not look empty. */
  private scatter(count: number): void {
    const cubeIndex = this.engine.index(this.engine.cube.x, this.engine.cube.z);
    for (let i = 0; i < count; i++) {
      const free = this.engine.tiles
        .map((_, index) => index)
        .filter((index) => index !== cubeIndex && this.engine.tiles[index] === NEUTRAL);
      if (!free.length) return;
      const index = free[Math.floor(Math.random() * free.length)];
      this.engine.tiles[index] = Math.floor(Math.random() * COLORS.length);
    }
    this.renderer?.refreshTiles();
  }

  /** Paints a neighbouring tile with the colour the cube would land on. */
  private plantMatch(): Direction | null {
    const legal = DIRECTIONS.filter((direction) => this.engine.preview(direction).legal);
    if (!legal.length) return null;

    const direction = legal[Math.floor(Math.random() * legal.length)];
    const preview = this.engine.preview(direction);
    this.engine.tiles[this.engine.index(preview.cell.x, preview.cell.z)] = preview.landingColor;
    this.renderer?.refreshTiles();
    return direction;
  }

  private onTileSelect(cell: Cell): void {
    if (!this.target || cell.x !== this.target.x || cell.z !== this.target.z) return;
    this.tap?.();
  }

  private readonly trackHand = (): void => {
    this.frameId = requestAnimationFrame(this.trackHand);
    const canvas = this.canvasRef().nativeElement;
    let x = canvas.clientWidth / 2;
    let y = canvas.clientHeight * 0.68;

    if (this.target && this.renderer) {
      const point = this.renderer.projectCell(this.target);
      x = point.x;
      y = point.y;
    }
    this.handRef().nativeElement.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  private hint(): Promise<void> {
    return this.defer((resolve) => {
      this.tap = resolve;
      this.timeout(resolve, HAND_SECONDS * 1000);
    });
  }

  private orbit(): Promise<void> {
    return this.defer((resolve) => this.renderer?.playSpin(Math.PI / 2, SPIN_SECONDS, resolve));
  }

  private roll(outcome: MoveOutcome): Promise<void> {
    return this.defer((resolve) => this.renderer?.playMove(outcome, resolve));
  }

  private wait(ms: number): Promise<void> {
    return this.defer((resolve) => this.timeout(resolve, ms));
  }

  /** Promise whose resolver is tracked, so tearing down never leaves the script hanging. */
  private defer(start: (resolve: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = () => {
        if (!this.pending.delete(settle)) return;
        this.tap = null;
        resolve();
      };
      this.pending.add(settle);
      start(settle);
    });
  }

  private timeout(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.frameId);
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const settle of [...this.pending]) settle();
    this.pending.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
