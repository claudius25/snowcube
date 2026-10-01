export interface TileColor {
  readonly name: string;
  readonly hex: number;
  readonly css: string;
}

/** The six playable colours. Index into this array is a "colour id". */
export const COLORS: readonly TileColor[] = [
  { name: 'Ruby', hex: 0xe6394a, css: '#e6394a' },
  { name: 'Amber', hex: 0xf5912b, css: '#f5912b' },
  { name: 'Citrine', hex: 0xf0d244, css: '#f0d244' },
  { name: 'Jade', hex: 0x35c07a, css: '#35c07a' },
  { name: 'Azure', hex: 0x3d8bfd, css: '#3d8bfd' },
  { name: 'Violet', hex: 0x9b5de5, css: '#9b5de5' },
];

export const SNOW: TileColor = { name: 'Snow', hex: 0xeaf1f8, css: '#eaf1f8' };

export function tileColor(id: number): TileColor {
  return id < 0 || id >= COLORS.length ? SNOW : COLORS[id];
}

export function colorHex(id: number): number {
  return tileColor(id).hex;
}

export function colorCss(id: number): string {
  return tileColor(id).css;
}
