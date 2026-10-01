import { ClampToEdgeWrapping, SRGBColorSpace, Texture, TextureLoader } from 'three';
import { NEUTRAL } from './engine';

export interface AtlasLayout {
  readonly url: string;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Full-colour atlas for the cube. 3072x2048, 3x2 cells of 1024px read
 * left-to-right, top-to-bottom; cells 0-5 map 1:1 onto BoxGeometry's material
 * slots (+X, -X, +Y, -Y, +Z, -Z).
 *
 * Unlike the tile atlas this one carries the hue itself, so the renderer drops
 * the material tint to white once it loads. Cell N must stay in the palette
 * colour `FACE_COLORS[N]` or the cube will no longer read as the face the rules
 * are matching against.
 */
export const CUBE_ATLAS: AtlasLayout = { url: 'textures/cube-atlas.png', columns: 3, rows: 2 };

/**
 * Full-colour atlas for the tiles. 3072x3072, 3x3 cells of 1024px.
 * Cells 0-5 match the colour ids in colors.ts, cell 6 is the neutral snow tile
 * and cells 7-8 are spare.
 *
 * Each cell is only ever shown for its own colour, so like the cube atlas it
 * carries the hue itself and the renderer drops the material tint to white.
 */
export const TILE_ATLAS: AtlasLayout = { url: 'textures/tile-atlas.png', columns: 3, rows: 3 };

const SNOW_CELL = 6;

export function tileAtlasCell(colorId: number): number {
  return colorId === NEUTRAL ? SNOW_CELL : colorId;
}

/**
 * Points `texture` at one atlas cell, inset by half a texel so mip sampling
 * cannot bleed in the neighbouring cell.
 */
export function setAtlasCell(texture: Texture, layout: AtlasLayout, cell: number): void {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const padX = image?.width ? 0.5 / image.width : 0;
  const padY = image?.height ? 0.5 / image.height : 0;
  const column = cell % layout.columns;
  const row = Math.floor(cell / layout.columns);

  texture.repeat.set(1 / layout.columns - 2 * padX, 1 / layout.rows - 2 * padY);
  // three's UV origin is bottom-left while the atlas is authored top-left first.
  texture.offset.set(column / layout.columns + padX, 1 - (row + 1) / layout.rows + padY);
}

/** Clones the atlas (sharing its GPU upload) and frames a single cell. */
export function cellTexture(source: Texture, layout: AtlasLayout, cell: number): Texture {
  const texture = source.clone();
  setAtlasCell(texture, layout, cell);
  texture.needsUpdate = true;
  return texture;
}

/** Loads an atlas; silently does nothing when the file is absent. */
export function loadAtlas(
  layout: AtlasLayout,
  anisotropy: number,
  onLoad: (texture: Texture) => void,
): void {
  new TextureLoader().load(
    layout.url,
    (texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      onLoad(texture);
    },
    undefined,
    () => {
      // no atlas shipped — flat colours are a valid fallback
    },
  );
}
