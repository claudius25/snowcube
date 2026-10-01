# Snowcube — seven modeled tiles

Actual 3D mesh assets, manually reconstructed from the simplified tile concepts and the snowy game reference. This is a stylized recreation, not an exact scan of the images.

## Files

- `tile_fox.glb` — yellow fox
- `tile_peacock.glb` — purple peacock
- `tile_boar.glb` — orange boar
- `tile_lava.glb` — red flame / lava emblem
- `tile_siren.glb` — blue mermaid
- `tile_serpent.glb` — green snake
- `tile_snow.glb` — blue icy body and rounded frosted cap
- `all-seven-tiles.glb` — all models arranged for inspection
- `all-seven-tiles.obj` + `.mtl` — fallback mesh format (GLB preserves materials better)
- `tile-models-preview.png` — software render of the individual exported GLBs
- `snow_frost_basecolor.png` — procedural frost texture, also embedded in GLBs
- `build_tiles.py` — editable mesh generator (Python, NumPy and Pillow)
- `render_preview.py` — reads, checks and renders the exported GLBs
- `mesh-stats.json` — triangle and part counts

## Scale and orientation

GLB/OBJ use Y-up. Each individual model is centered on X/Z, with bottom Y=0.
Colored footprint: 1 x 1 unit. Snow cap: 1.004 x 1.004 units.
Heights: approximately 0.25–0.28 units. Suggested grid pitch: 1.03 units.
Individual GLBs have no layout offset; use these for the game. The combined GLB has layout offsets on its root nodes.

## Geometry and materials

Bases, rims, recessed floors, emblems and snow cap are separate named meshes.
The symbols are actual extruded geometry, with small rounded bevels, not painted textures.
Each tile has named PBR materials; colors and roughness can be changed independently.
The boar's nostrils are dark shallow inlays, not boolean holes.
The default tile is stylized opaque blue ice with a white frosted cap. It does not use transmission/refraction or displacement; the cap texture is subtle color grain. Use an environment light and your renderer's shadows for the polished game appearance.
Mesh parts can overlap slightly at attachments. Assets are intended for rendering/game use, not as certified watertight 3D-printing solids.

## Editing

Import GLB in Blender or your preferred DCC tool. No Blender-specific dependencies are required to use the models.
To regenerate, install NumPy and Pillow, then run `python build_tiles.py` in this folder. It rewrites the generated model files.
The original silhouettes, bevels, scale and colors are editable in the generator.

## Validation

Every exported individual GLB was read back and checked for valid indices, finite vertex data, normalized normals, GLB headers and length. The preview was rendered from that exported data. All seven models total 18,496 triangles. A full engine-specific integration or performance test was not performed.
