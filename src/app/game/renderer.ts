import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  Quaternion,
  Raycaster,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
import { cellTexture, CUBE_ATLAS, loadAtlas } from './textures';

const ROLL_SECONDS = 0.22;
const BUMP_SECONDS = 0.18;
const TINT_SECONDS = 0.28;
const POP_SECONDS = 0.4;
/** Emissive intensity a tile flashes to when its model is swapped. */
const TILE_FLASH = 0.85;
const BEAM_SECONDS = 0.9;
/** Short enough that the falloff finishes before the ortho frustum clips it. */
const BEAM_HEIGHT = 4.5;
/** Enough beams for a streak to overlap without reusing one mid-flight. */
const BEAM_POOL = 4;
const DEFAULT_AZIMUTH = Math.PI / 4;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.4;
/** Fixed camera pitch — the view only orbits horizontally. */
const ELEVATION = Math.atan(1 / Math.SQRT2); // true isometric
const ORDER: readonly Direction[] = ['north', 'east', 'south', 'west'];
/** Lowest and highest points in the scene: underside of the base slab, top of a standing cube. */
const SCENE_BOTTOM = -0.78;
const SCENE_TOP = TILE;

export type ScreenKey = 'up' | 'right' | 'down' | 'left';

const CUBE_MODEL_URL = 'snowcube/snowcube.glb';
/** The authored model spans 2 units; the board works in TILE-sized cubes. */
const CUBE_MODEL_SIZE = 2;

const TILE_MODEL_BASE = 'snowcube-7-tiles/';
/** Indices match the colour ids in colors.ts; the last entry is the neutral snow tile. */
const TILE_MODEL_FILES = [
  'tile_lava.glb',
  'tile_boar.glb',
  'tile_fox.glb',
  'tile_serpent.glb',
  'tile_siren.glb',
  'tile_peacock.glb',
  'tile_snow.glb',
];
const SNOW_MODEL = TILE_MODEL_FILES.length - 1;
/** Authored footprint is exactly 1x1; shrink a touch so neighbours keep a visible gap. */
const TILE_MODEL_SCALE = 0.96;

function tileModelIndex(colorId: number): number {
  return colorId === NEUTRAL ? SNOW_MODEL : colorId;
}

function collectMaterials(root: Object3D): MeshStandardMaterial[] {
  const found: MeshStandardMaterial[] = [];
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) found.push(material as MeshStandardMaterial);
  });
  return found;
}

/** Maps a panel's offset from the cube centre onto a BoxGeometry material slot. */
function slotForOffset(offset: Vector3): number {
  const ax = Math.abs(offset.x);
  const ay = Math.abs(offset.y);
  const az = Math.abs(offset.z);
  const max = Math.max(ax, ay, az);
  if (max < 0.5) return -1;
  if (max === ax) return offset.x > 0 ? 0 : 1;
  if (max === ay) return offset.y > 0 ? 2 : 3;
  return offset.z > 0 ? 4 : 5;
}

interface TileView {
  readonly group: Group;
  /** Flat fallback slab, shown only until the tile models resolve. */
  readonly pad: Mesh;
  readonly padMaterial: MeshStandardMaterial;
  model?: Object3D;
  materials: MeshStandardMaterial[];
  colorId: number;
  pop: number;
  flash: number;
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

interface BeamView {
  readonly mesh: Mesh;
  readonly material: MeshBasicMaterial;
  /** Counts 1 down to 0; 0 means the beam is free for reuse. */
  life: number;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Vertical falloff for the beam: solid at the floor, gone by the top. */
function createBeamTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.05)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new CanvasTexture(canvas);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Owns the three.js scene; reads state from the engine, never changes it. */
export class GameRenderer {
  onTileSelect?: (cell: Cell) => void;

  /** The intro locks the camera so its DOM overlays stay glued to the board. */
  allowZoom = true;
  allowRotate = true;

  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  private readonly board = new Group();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly target = new Vector3(0, (SCENE_TOP + SCENE_BOTTOM) / 2, 0);

  private renderer!: WebGLRenderer;
  private keyLight!: DirectionalLight;
  private fillLight!: DirectionalLight;
  /** Light placements at the default azimuth; both orbit with the camera. */
  private readonly keyLightHome = new Vector3(6, 14, -7);
  private readonly fillLightHome = new Vector3(-5, 6, 9);
  private tiles: TileView[] = [];
  private tileGroups: Group[] = [];
  private tileModels: (Object3D | undefined)[] = [];
  private cubeRoot = new Group();
  private cube!: Mesh;
  private cubeMaterials: MeshStandardMaterial[] = [];
  private cubeModel?: Group;
  private modelRequested = false;
  private cubeAtlas?: Texture;
  private tileGeometry?: BufferGeometry;
  private disposables: (BufferGeometry | Material)[] = [];

  private roll: RollState | null = null;
  private bump: BumpState | null = null;
  private beams: BeamView[] = [];
  private beamTexture?: CanvasTexture;

  private azimuth = DEFAULT_AZIMUTH;
  private zoom = 1;
  private elapsed = 0;
  private lastTime = 0;
  private frameId = 0;
  private hints = true;

  private dragging = false;
  private dragged = false;
  private lastPointer = new Vector2();
  private readonly pointers = new Map<number, Vector2>();
  private pinchGap = 0;
  private aspect = 1;
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
    this.loadTextures();
    this.loadCubeModel();
    this.loadTileModels();

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
    this.cubeAtlas?.dispose();
    this.beamTexture?.dispose();
    this.disposeModel();
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

  /** Re-reads the tile colours from the engine, e.g. after a scripted setup. */
  refreshTiles(instant = false): void {
    this.syncTiles(instant);
    this.refreshHints();
  }

  /** Canvas-space pixel position of a cell's centre, for DOM overlays. */
  projectCell(cell: Cell): Vector2 {
    const point = this.worldPosition(cell.x, cell.z).project(this.camera);
    return new Vector2(
      (point.x * 0.5 + 0.5) * this.canvas.clientWidth,
      (point.y * -0.5 + 0.5) * this.canvas.clientHeight,
    );
  }

  /** Swaps in the authored cube once it resolves; the box is the fallback until then. */
  private applyCubeVisual(): void {
    this.cube.visible = !this.cubeModel;
    if (this.cubeModel) this.cubeModel.visible = true;
  }

  private attachModel(): void {
    if (this.cubeModel) this.cubeRoot.add(this.cubeModel);
    this.applyCubeVisual();
  }

  private disposeModel(): void {
    this.cubeModel?.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        material.dispose();
      }
    });
    this.cubeModel = undefined;
  }

  private loadCubeModel(): void {
    if (this.modelRequested) return;
    this.modelRequested = true;

    new GLTFLoader().load(
      CUBE_MODEL_URL,
      (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(TILE / CUBE_MODEL_SIZE);
        this.repaintModel(model);
        model.traverse((child) => {
          if (child instanceof Mesh) child.castShadow = true;
        });
        this.cubeModel = model;
        this.cubeRoot.add(model);
        this.applyCubeVisual();
      },
      undefined,
      () => {
        this.modelRequested = false;
      },
    );
  }

  /**
   * Repaints each panel from the engine's palette. The authored colours are close
   * but not in the rules' order, and a mismatch would show one colour while
   * scoring another, so the panel's own base map is dropped.
   */
  private repaintModel(model: Object3D): void {
    const centre = new Vector3();
    model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.geometry.computeBoundingBox();
      child.geometry.boundingBox?.getCenter(centre);
      const slot = slotForOffset(centre);
      if (slot < 0) return;

      const material = child.material as MeshStandardMaterial;
      material.map = null;
      material.color.setHex(colorHex(FACE_COLORS[slot]));
      material.needsUpdate = true;
    });
  }

  resetCamera(): void {
    this.azimuth = DEFAULT_AZIMUTH;
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
    const pivot = from
      .clone()
      .addScaledVector(v, TILE / 2)
      .setY(0);
    this.roll = {
      axis: new Vector3().crossVectors(UP, v).normalize(),
      pivot,
      offset: from.clone().sub(pivot),
      start: this.cubeRoot.quaternion.clone(),
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
    key.position.copy(this.keyLightHome);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 2.5;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.keyLight = key;

    const fill = new DirectionalLight(0x9fc4ff, 0.55);
    fill.position.copy(this.fillLightHome);
    this.scene.add(fill);
    this.fillLight = fill;
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
        const pad = new Mesh(geometry, material);
        pad.position.setY(-0.11);
        pad.receiveShadow = true;

        const group = new Group();
        group.position.copy(this.worldPosition(x, z));
        group.userData['index'] = this.engine.index(x, z);
        group.add(pad);
        this.board.add(group);

        this.tiles.push({
          group,
          pad,
          padMaterial: material,
          materials: [],
          colorId: Number.NaN,
          pop: 0,
          flash: 0,
          hinted: false,
        });
        this.tileGroups.push(group);
      }
    }

    const baseGeometry = new BoxGeometry(size * TILE + 0.7, 0.55, size * TILE + 0.7);
    const baseMaterial = new MeshStandardMaterial({
      color: 0x1b2433,
      roughness: 0.9,
      metalness: 0.1,
    });
    const base = new Mesh(baseGeometry, baseMaterial);
    base.position.set(0, -0.5, 0);
    base.receiveShadow = true;
    this.board.add(base);
    this.disposables.push(baseGeometry, baseMaterial);

    const cubeGeometry = new BoxGeometry(TILE, TILE, TILE);
    this.cubeMaterials = FACE_COLORS.map(
      (id) =>
        new MeshStandardMaterial({
          color: colorHex(id),
          roughness: 0.34,
          metalness: 0.12,
          emissive: colorHex(id),
          emissiveIntensity: 0.07,
        }),
    );
    this.cube = new Mesh(cubeGeometry, this.cubeMaterials);
    this.cube.castShadow = true;
    this.disposables.push(cubeGeometry, ...this.cubeMaterials);

    const edgeGeometry = new EdgesGeometry(cubeGeometry);
    const edgeMaterial = new LineBasicMaterial({
      color: 0x0f172a,
      transparent: true,
      opacity: 0.45,
    });
    this.cube.add(new LineSegments(edgeGeometry, edgeMaterial));
    this.disposables.push(edgeGeometry, edgeMaterial);

    this.cubeRoot = new Group();
    this.cubeRoot.add(this.cube);
    this.board.add(this.cubeRoot);
    this.attachModel();

    this.buildBeams();

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
    this.applyAtlases();
  }

  private loadTextures(): void {
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    loadAtlas(CUBE_ATLAS, anisotropy, (texture) => {
      this.cubeAtlas = texture;
      this.applyAtlases();
    });
  }

  /** Hands every cube material its own view onto the shared atlas image. */
  private applyAtlases(): void {
    if (!this.cubeAtlas) return;
    this.cubeMaterials.forEach((material, slot) => {
      material.map = cellTexture(this.cubeAtlas!, CUBE_ATLAS, slot);
      // The cube atlas is already in colour; the flat tint is only a no-texture fallback.
      material.color.setHex(0xffffff);
      material.needsUpdate = true;
    });
  }

  /** Pool of reusable light columns, one fired per neutralised tile. */
  private buildBeams(): void {
    this.beamTexture ??= createBeamTexture();
    const geometry = new CylinderGeometry(0.58, 0.34, BEAM_HEIGHT, 24, 1, true);
    geometry.translate(0, BEAM_HEIGHT / 2, 0);
    this.disposables.push(geometry);

    for (let i = 0; i < BEAM_POOL; i++) {
      const material = new MeshBasicMaterial({
        map: this.beamTexture,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        // Additive FX should keep its punch rather than be rolled off by ACES.
        toneMapped: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.board.add(mesh);
      this.disposables.push(material);
      this.beams.push({ mesh, material, life: 0 });
    }
  }

  private fireBeam(cell: Cell, colorId: number): void {
    const beam =
      this.beams.find((candidate) => candidate.life <= 0) ??
      this.beams.reduce((oldest, candidate) => (candidate.life < oldest.life ? candidate : oldest));
    if (!beam) return;

    beam.mesh.position.copy(this.worldPosition(cell.x, cell.z));
    beam.mesh.rotation.y = Math.random() * Math.PI;
    beam.mesh.visible = true;
    beam.material.color.setHex(colorHex(colorId));
    beam.life = 1;
  }

  private updateBeams(dt: number): void {
    for (const beam of this.beams) {
      if (beam.life <= 0) continue;

      beam.life = Math.max(0, beam.life - dt / BEAM_SECONDS);
      const t = 1 - beam.life;
      const shoot = easeOutCubic(Math.min(1, t / 0.18));

      beam.mesh.scale.set(1 + t * 0.45, 0.12 + shoot * 0.88, 1 + t * 0.45);
      beam.mesh.rotation.y += dt * 1.6;
      beam.material.opacity = Math.pow(beam.life, 1.5);

      if (beam.life === 0) beam.mesh.visible = false;
    }
  }

  private clearBoard(): void {
    for (const tile of this.tiles) {
      this.board.remove(tile.group);
      tile.padMaterial.dispose();
      for (const material of tile.materials) material.dispose();
    }
    this.tiles = [];
    this.tileGroups = [];
    this.beams = [];
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
    this.cubeRoot.position
      .copy(this.worldPosition(this.engine.cube.x, this.engine.cube.z))
      .setY(TILE / 2);
    this.cubeRoot.quaternion.copy(this.engine.rotation);
  }

  private loadTileModels(): void {
    const loader = new GLTFLoader();
    let pending = TILE_MODEL_FILES.length;

    const settle = () => {
      if (--pending > 0) return;
      // Re-run the colour pass so every cell picks up its model.
      if (this.tileModels.some(Boolean)) this.syncTiles(true);
    };

    TILE_MODEL_FILES.forEach((file, index) => {
      loader.load(
        TILE_MODEL_BASE + file,
        (gltf) => {
          this.tileModels[index] = this.prepareTileModel(gltf.scene);
          settle();
        },
        undefined,
        settle,
      );
    });
  }

  /** Scales to the board pitch and drops the model so its top sits on the play surface. */
  private prepareTileModel(model: Object3D): Object3D {
    model.scale.setScalar(TILE_MODEL_SCALE);
    model.updateMatrixWorld(true);
    model.position.y = -new Box3().setFromObject(model).max.y;
    model.traverse((child) => {
      if (child instanceof Mesh) child.receiveShadow = true;
    });
    return model;
  }

  /** Clones a prototype with its own materials, so hints stay local to one tile. */
  private instantiateTile(colorId: number): Object3D | undefined {
    const prototype = this.tileModels[tileModelIndex(colorId)];
    if (!prototype) return undefined;

    const clone = prototype.clone(true);
    clone.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => material.clone())
        : child.material.clone();
    });
    return clone;
  }

  private setTileEmissive(tile: TileView, hex: number, intensity: number): void {
    for (const material of tile.materials) {
      material.emissive.setHex(hex);
      material.emissiveIntensity = intensity;
    }
    tile.padMaterial.emissive.setHex(hex);
    tile.padMaterial.emissiveIntensity = intensity;
  }

  private syncTiles(instant: boolean): void {
    for (let i = 0; i < this.tiles.length; i++) {
      this.setTileColor(i, this.engine.tiles[i], instant, false);
    }
  }

  private setTileColor(index: number, colorId: number, instant: boolean, pop: boolean): void {
    const tile = this.tiles[index];
    const changed = tile.colorId !== colorId;
    tile.colorId = colorId;
    tile.padMaterial.color.setHex(colorId === NEUTRAL ? SNOW.hex : colorHex(colorId));

    if (changed || !tile.model) {
      const next = this.instantiateTile(colorId);
      if (next) {
        if (tile.model) {
          tile.group.remove(tile.model);
          for (const material of tile.materials) material.dispose();
        }
        tile.model = next;
        tile.materials = collectMaterials(next);
        tile.group.add(next);
      }
      tile.pad.visible = !tile.model;
    }

    tile.flash = instant || !changed ? 0 : 1;
    if (pop) tile.pop = 1;
  }

  private refreshHints(): void {
    for (const tile of this.tiles) {
      tile.hinted = false;
      if (tile.flash <= 0) this.setTileEmissive(tile, 0x000000, 0);
    }
    if (!this.hints) return;

    for (const direction of DIRECTIONS) {
      const preview = this.engine.preview(direction);
      if (!preview.matches) continue;
      this.tiles[this.engine.index(preview.cell.x, preview.cell.z)].hinted = true;
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
    this.updateBeams(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateRoll(dt: number): void {
    const roll = this.roll;
    if (!roll) return;

    roll.t = Math.min(1, roll.t + dt / ROLL_SECONDS);
    const angle = easeInOutQuad(roll.t) * (Math.PI / 2);
    const q = new Quaternion().setFromAxisAngle(roll.axis, angle);
    this.cubeRoot.position.copy(roll.offset).applyQuaternion(q).add(roll.pivot);
    this.cubeRoot.quaternion.copy(roll.start).premultiply(q);

    if (roll.t < 1) return;

    this.roll = null;
    this.syncCube();

    const outcome = roll.outcome;
    if (outcome.neutralized) {
      this.setTileColor(this.engine.index(outcome.to.x, outcome.to.z), NEUTRAL, false, true);
      // A match means the tile's colour equalled the landing face.
      this.fireBeam(outcome.to, outcome.landingColor);
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
    this.cubeRoot.position.addScaledVector(bump.offset, push);

    if (bump.t >= 1) {
      this.bump = null;
      this.syncCube();
    }
  }

  private updateTiles(dt: number): void {
    const pulse = 0.22 + 0.2 * (0.5 + 0.5 * Math.sin(this.elapsed * 5.5));
    for (const tile of this.tiles) {
      if (tile.pop > 0) {
        tile.pop = Math.max(0, tile.pop - dt / POP_SECONDS);
        const lift = Math.sin(tile.pop * Math.PI);
        tile.group.position.y = lift * 0.14;
        tile.group.scale.set(1 + lift * 0.05, 1, 1 + lift * 0.05);
      }
      if (tile.flash > 0) {
        tile.flash = Math.max(0, tile.flash - dt / TINT_SECONDS);
        this.setTileEmissive(tile, 0xffffff, tile.flash * TILE_FLASH);
      } else if (tile.hinted) {
        this.setTileEmissive(tile, colorHex(tile.colorId), pulse);
      }
    }
  }

  private resize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.aspect = width / height;
    this.updateProjection();
  }

  private updateProjection(): void {
    const aspect = this.aspect;
    // Half the board's diagonal, which is its widest span on screen in isometric.
    const reach = ((this.engine.size * TILE) / 2) * Math.SQRT2;
    const needHalfWidth = reach;
    const needHalfHeight =
      reach * Math.sin(ELEVATION) + ((SCENE_TOP - SCENE_BOTTOM) / 2) * Math.cos(ELEVATION);
    const half = Math.max(needHalfHeight, needHalfWidth / aspect) / this.zoom;

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
      Math.cos(ELEVATION) * Math.sin(this.azimuth),
      Math.sin(ELEVATION),
      Math.cos(ELEVATION) * Math.cos(this.azimuth),
    );
    this.camera.position.multiplyScalar(radius).add(this.target);
    this.camera.lookAt(this.target);

    // Spin the rig with the view so the lit faces and shadow direction never change.
    const spin = this.azimuth - DEFAULT_AZIMUTH;
    this.keyLight.position.copy(this.keyLightHome).applyAxisAngle(UP, spin);
    this.fillLight.position.copy(this.fillLightHome).applyAxisAngle(UP, spin);
  }

  /** Screen distance between the first two active pointers. */
  private pointerSpread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? a.distanceTo(b) : 0;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A cancel can race the down event; capture is an optimisation, not a requirement.
    }
    this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));

    if (this.pointers.size === 1) {
      this.dragging = true;
      this.dragged = false;
      this.lastPointer.set(event.clientX, event.clientY);
    } else if (this.pointers.size === 2) {
      this.pinchGap = this.pointerSpread();
      // A two-finger gesture is never a tap.
      this.dragged = true;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    tracked.set(event.clientX, event.clientY);

    if (this.pointers.size >= 2) {
      const gap = this.pointerSpread();
      if (this.allowZoom && this.pinchGap > 0 && gap > 0) {
        this.zoom = clamp(this.zoom * (gap / this.pinchGap), MIN_ZOOM, MAX_ZOOM);
        this.updateProjection();
      }
      this.pinchGap = gap;
      return;
    }

    if (!this.dragging) return;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;
    this.lastPointer.set(event.clientX, event.clientY);

    if (!this.allowRotate) return;
    this.azimuth -= dx * 0.006;
    this.updateCamera();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (this.pointers.size === 1) {
      // Pinch ended but a finger remains: hand it back to rotation cleanly.
      this.lastPointer.copy([...this.pointers.values()][0]);
      this.pinchGap = 0;
      return;
    }
    if (this.pointers.size > 0) return;

    this.pinchGap = 0;
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragged || !this.onTileSelect) return;

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.tileGroups, true)[0];
    if (!hit) return;

    let node: Object3D | null = hit.object;
    while (node && node.userData['index'] === undefined) node = node.parent;
    if (!node) return;

    const index = node.userData['index'] as number;
    this.onTileSelect({ x: index % this.engine.size, z: Math.floor(index / this.engine.size) });
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (!this.allowZoom) return;
    this.zoom = clamp(this.zoom * (1 - event.deltaY * 0.0012), MIN_ZOOM, MAX_ZOOM);
    this.updateProjection();
  };
}
