import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { colorHex, SNOW } from './colors';
import {
  Cell,
  Direction,
  DIRECTIONS,
  DIRECTION_VECTORS,
  FACE_COLORS,
  GameEngine,
  MoveOutcome,
  NEUTRAL,
  TILE,
  UP,
} from './engine';

const ROLL_SECONDS = 0.22;
const BUMP_SECONDS = 0.18;
const TINT_SECONDS = 0.28;
const POP_SECONDS = 0.4;
const DEFAULT_AZIMUTH = Math.PI / 4;
const DEFAULT_ELEVATION = Math.atan(1 / Math.SQRT2); // true isometric
const ORDER: readonly Direction[] = ['north', 'east', 'south', 'west'];

export type ScreenKey = 'up' | 'right' | 'down' | 'left';

interface TileView {
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;
  readonly from: Color;
  readonly to: Color;
  tint: number;
  pop: number;
  hinted: boolean;
}

interface RollState {
  readonly axis: Vector3;
  readonly pivot: Vector3;
  readonly offset: Vector3;
  readonly start: Quaternion;
  readonly outcome: MoveOutcome;
  readonly done: () => void;
  t: number;
}

interface BumpState {
  readonly offset: Vector3;
  t: number;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Owns the three.js scene; reads state from the engine, never changes it. */
export class GameRenderer {
  onTileSelect?: (cell: Cell) => void;

  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  private readonly board = new Group();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly target = new Vector3(0, 0.3, 0);

  private renderer!: WebGLRenderer;
  private keyLight!: DirectionalLight;
  private tiles: TileView[] = [];
  private tileMeshes: Mesh[] = [];
  private cube!: Mesh;
  private tileGeometry?: BufferGeometry;
  private disposables: (BufferGeometry | Material)[] = [];

  private roll: RollState | null = null;
  private bump: BumpState | null = null;

  private azimuth = DEFAULT_AZIMUTH;
  private elevation = DEFAULT_ELEVATION;
  private zoom = 1;
  private elapsed = 0;
  private lastTime = 0;
  private frameId = 0;
  private hints = true;

  private dragging = false;
  private dragged = false;
  private lastPointer = new Vector2();
  private resizeObserver?: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: GameEngine,
  ) {}

  get busy(): boolean {
    return this.roll !== null || this.bump !== null;
  }

  mount(): void {
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.add(this.board);
    this.addLights();
    this.build();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    const host = this.canvas.parentElement ?? this.canvas;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);

    this.resize();
    this.lastTime = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.clearBoard();
    this.renderer?.dispose();
  }

  /** Rebuilds the board meshes, e.g. after the board size changed. */
  rebuild(): void {
    this.roll = null;
    this.bump = null;
    this.build();
    this.resize();
  }

  setHints(enabled: boolean): void {
    this.hints = enabled;
    this.refreshHints();
  }

  resetCamera(): void {
    this.azimuth = DEFAULT_AZIMUTH;
    this.elevation = DEFAULT_ELEVATION;
    this.zoom = 1;
    this.resize();
  }

  /** Maps a screen-relative key to a board direction for the current camera angle. */
  resolveDirection(key: ScreenKey): Direction {
    const quarter = Math.round((this.azimuth - DEFAULT_AZIMUTH) / (Math.PI / 2));
    const base = { up: 0, right: 1, down: 2, left: 3 }[key];
    return ORDER[(((base - quarter) % 4) + 4) % 4];
  }

  /** Animates an executed move, then applies the resulting tile changes. */
  playMove(outcome: MoveOutcome, done: () => void): void {
    const v = DIRECTION_VECTORS[outcome.direction];
    const from = this.worldPosition(outcome.from.x, outcome.from.z).setY(TILE / 2);
    const pivot = from.clone().addScaledVector(v, TILE / 2).setY(0);
    this.roll = {
      axis: new Vector3().crossVectors(UP, v).normalize(),
      pivot,
      offset: from.clone().sub(pivot),
      start: this.cube.quaternion.clone(),
      outcome,
      done,
      t: 0,
    };
  }

  /** Small nudge used when a move would leave the board. */
  playBump(direction: Direction): void {
    if (this.busy) return;
    this.bump = { offset: DIRECTION_VECTORS[direction].clone().multiplyScalar(0.16), t: 0 };
  }

  private addLights(): void {
    this.scene.add(new HemisphereLight(0xdfefff, 0x2b3244, 0.62));

    // Lit from behind-right so the cast shadow falls towards the camera.
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(6, 14, -7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 2.5;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.keyLight = key;

    const fill = new DirectionalLight(0x9fc4ff, 0.55);
    fill.position.set(-5, 6, 9);
    this.scene.add(fill);
  }

  private build(): void {
    this.clearBoard();

    const size = this.engine.size;
    const geometry = new BoxGeometry(TILE * 0.92, 0.22, TILE * 0.92);
    this.tileGeometry = geometry;

    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const material = new MeshStandardMaterial({
          color: SNOW.hex,
          roughness: 0.68,
          metalness: 0.04,
          emissive: 0x000000,
          emissiveIntensity: 0,
        });
        const mesh = new Mesh(geometry, material);
        mesh.position.copy(this.worldPosition(x, z)).setY(-0.11);
        mesh.receiveShadow = true;
        mesh.userData['index'] = this.engine.index(x, z);
        this.board.add(mesh);
        this.tiles.push({
          mesh,
          material,
          from: new Color(SNOW.hex),
          to: new Color(SNOW.hex),
          tint: 1,
          pop: 0,
          hinted: false,
        });
        this.tileMeshes.push(mesh);
      }
    }

    const baseGeometry = new BoxGeometry(size * TILE + 0.7, 0.55, size * TILE + 0.7);
    const baseMaterial = new MeshStandardMaterial({ color: 0x1b2433, roughness: 0.9, metalness: 0.1 });
    const base = new Mesh(baseGeometry, baseMaterial);
    base.position.set(0, -0.5, 0);
    base.receiveShadow = true;
    this.board.add(base);
    this.disposables.push(baseGeometry, baseMaterial);

    const cubeGeometry = new BoxGeometry(TILE, TILE, TILE);
    const cubeMaterials = FACE_COLORS.map(
      (id) =>
        new MeshStandardMaterial({
          color: colorHex(id),
          roughness: 0.34,
          metalness: 0.12,
          emissive: colorHex(id),
          emissiveIntensity: 0.07,
        }),
    );
    this.cube = new Mesh(cubeGeometry, cubeMaterials);
    this.cube.castShadow = true;
    this.disposables.push(cubeGeometry, ...cubeMaterials);

    const edgeGeometry = new EdgesGeometry(cubeGeometry);
    const edgeMaterial = new LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.45 });
    this.cube.add(new LineSegments(edgeGeometry, edgeMaterial));
    this.disposables.push(edgeGeometry, edgeMaterial);

    this.board.add(this.cube);

    const shadowSpan = size * 0.85 + 2;
    this.keyLight.shadow.camera.left = -shadowSpan;
    this.keyLight.shadow.camera.right = shadowSpan;
    this.keyLight.shadow.camera.top = shadowSpan;
    this.keyLight.shadow.camera.bottom = -shadowSpan;
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 60;
    this.keyLight.shadow.camera.updateProjectionMatrix();

    this.syncTiles(true);
    this.syncCube();
    this.refreshHints();
  }

  private clearBoard(): void {
    for (const tile of this.tiles) {
      this.board.remove(tile.mesh);
      tile.material.dispose();
    }
    this.tiles = [];
    this.tileMeshes = [];
    this.tileGeometry?.dispose();
    this.tileGeometry = undefined;
    for (const item of this.disposables) item.dispose();
    this.disposables = [];
    this.board.clear();
  }

  private worldPosition(x: number, z: number): Vector3 {
    const offset = (this.engine.size - 1) / 2;
    return new Vector3((x - offset) * TILE, 0, (z - offset) * TILE);
  }

  private syncCube(): void {
    this.cube.position.copy(this.worldPosition(this.engine.cube.x, this.engine.cube.z)).setY(TILE / 2);
    this.cube.quaternion.copy(this.engine.rotation);
  }

  private syncTiles(instant: boolean): void {
    for (let i = 0; i < this.tiles.length; i++) {
      this.setTileColor(i, this.engine.tiles[i], instant, false);
    }
  }

  private setTileColor(index: number, colorId: number, instant: boolean, pop: boolean): void {
    const tile = this.tiles[index];
    const hex = colorId === NEUTRAL ? SNOW.hex : colorHex(colorId);
    tile.from.copy(tile.material.color);
    tile.to.setHex(hex);
    tile.tint = instant ? 1 : 0;
    if (instant) tile.material.color.setHex(hex);
    if (pop) tile.pop = 1;
  }

  private refreshHints(): void {
    for (const tile of this.tiles) {
      tile.hinted = false;
      tile.material.emissiveIntensity = 0;
      tile.material.emissive.setHex(0x000000);
    }
    if (!this.hints) return;

    for (const direction of DIRECTIONS) {
      const preview = this.engine.preview(direction);
      if (!preview.matches) continue;
      const tile = this.tiles[this.engine.index(preview.cell.x, preview.cell.z)];
      tile.hinted = true;
      tile.material.emissive.setHex(colorHex(preview.tileColor));
    }
  }

  private readonly tick = (now: number): void => {
    this.frameId = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;

    this.updateRoll(dt);
    this.updateBump(dt);
    this.updateTiles(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateRoll(dt: number): void {
    const roll = this.roll;
    if (!roll) return;

    roll.t = Math.min(1, roll.t + dt / ROLL_SECONDS);
    const angle = easeInOutQuad(roll.t) * (Math.PI / 2);
    const q = new Quaternion().setFromAxisAngle(roll.axis, angle);
    this.cube.position.copy(roll.offset).applyQuaternion(q).add(roll.pivot);
    this.cube.quaternion.copy(roll.start).premultiply(q);

    if (roll.t < 1) return;

    this.roll = null;
    this.syncCube();

    const outcome = roll.outcome;
    if (outcome.neutralized) {
      this.setTileColor(this.engine.index(outcome.to.x, outcome.to.z), NEUTRAL, false, true);
    }
    if (outcome.spawned) {
      const spawned = outcome.spawned;
      this.setTileColor(this.engine.index(spawned.x, spawned.z), spawned.color, false, true);
    }
    this.refreshHints();
    roll.done();
  }

  private updateBump(dt: number): void {
    const bump = this.bump;
    if (!bump) return;

    bump.t = Math.min(1, bump.t + dt / BUMP_SECONDS);
    const push = Math.sin(bump.t * Math.PI);
    this.syncCube();
    this.cube.position.addScaledVector(bump.offset, push);

    if (bump.t >= 1) {
      this.bump = null;
      this.syncCube();
    }
  }

  private updateTiles(dt: number): void {
    const pulse = 0.22 + 0.2 * (0.5 + 0.5 * Math.sin(this.elapsed * 5.5));
    for (const tile of this.tiles) {
      if (tile.tint < 1) {
        tile.tint = Math.min(1, tile.tint + dt / TINT_SECONDS);
        tile.material.color.lerpColors(tile.from, tile.to, easeInOutQuad(tile.tint));
      }
      if (tile.pop > 0) {
        tile.pop = Math.max(0, tile.pop - dt / POP_SECONDS);
        const lift = Math.sin(tile.pop * Math.PI);
        tile.mesh.scale.set(1 + lift * 0.1, 1 + lift * 1.1, 1 + lift * 0.1);
      }
      if (tile.hinted) {
        tile.material.emissiveIntensity = pulse;
      }
    }
  }

  private resize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);

    const aspect = width / height;
    const needHalfWidth = this.engine.size * 0.78;
    const needHalfHeight = this.engine.size * 0.52;
    const half = (Math.max(needHalfHeight, needHalfWidth / aspect) * 1.06) / this.zoom;

    this.camera.left = -half * aspect;
    this.camera.right = half * aspect;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.near = 0.1;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  private updateCamera(): void {
    const radius = Math.max(this.engine.size, 8) * 3;
    this.camera.position.set(
      Math.cos(this.elevation) * Math.sin(this.azimuth),
      Math.sin(this.elevation),
      Math.cos(this.elevation) * Math.cos(this.azimuth),
    );
    this.camera.position.multiplyScalar(radius).add(this.target);
    this.camera.lookAt(this.target);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.dragging = true;
    this.dragged = false;
    this.lastPointer.set(event.clientX, event.clientY);
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;
    this.lastPointer.set(event.clientX, event.clientY);

    this.azimuth -= dx * 0.006;
    this.elevation = clamp(this.elevation - dy * 0.005, 0.22, 1.45);
    this.updateCamera();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (this.dragged || !this.onTileSelect) return;

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.tileMeshes, false)[0];
    if (!hit) return;

    const index = hit.object.userData['index'] as number;
    this.onTileSelect({ x: index % this.engine.size, z: Math.floor(index / this.engine.size) });
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoom = clamp(this.zoom * (1 - event.deltaY * 0.0012), 0.6, 2.4);
    this.resize();
  };
}
