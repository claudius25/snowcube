# Snowcube — hollow frame and six floating panels

A real 3D reconstruction of the supplied concept image. Geometry and materials are matched by eye; a single generated image does not specify exact dimensions or physically consistent lighting. Preview images are rendered from the actual mesh, not AI concept art.

## Files
- snowcube.glb: recommended game asset, seven named mesh nodes, embedded 1024×1024 PBR textures, glTF 2.0 clearcoat extension. Origin at cube center; Y up; total size 2 units.
- snowcube.step: editable precision CAD assembly with seven solids, Z up. Materials are supplied separately.
- snowcube.obj / snowcube.mtl: textured fallback, Z up. OBJ carries base colors/specular settings only; use GLB for full PBR.
- textures/: separate PNG base color, roughness, normal and packed ORM maps.
- preview.png and preview-rear.png: actual geometry previews with simplified studio lighting.
- build_snowcube.py: reproducible geometry, texture, export and preview source. Requires Python 3.12, cadquery, vtk, numpy, scipy, Pillow. Run in a directory containing this script; no Blender required.
- validation.json: mesh statistics and geometry checks.

## Structure
One continuous rounded frame, with no face surfaces, glass, supports or rods. Six separate solid panels float inside the openings. Panel backs are colored too. Rear colors appear through the gaps where the viewing angle allows it; opaque panels correctly occlude one another.

Outer frame: 2×2×2. Openings: 1.54×1.54. Frame edge rounding: 0.085. Panels: 1.26×1.26×0.12 with 0.16 corner radius and 0.045 edge fillet. Panels sit at ±0.92 from the center, leaving 0.14 clearance from the frame on each side.

GLB face mapping: orange +Y, purple −Y, yellow +Z, blue −Z, red +X, green −X. All vertices are in the parent cube coordinate system, so rotate the Snowcube root to roll the complete object. Meshes remain independently selectable and replaceable.

## Materials
Icy_Glossy_Frame: pale blue-white frost texture with small crystalline speckles, variable roughness and subtle normal detail; clearcoat 0.5, clearcoat roughness 0.12.
Glossy_[color]: separate colored base-color texture for each face, shared panel roughness/normal/ORM maps; clearcoat 0.9, clearcoat roughness 0.08.
All materials are nonmetallic and opaque. The empty openings are real geometry, not transparency.

Base-color textures are sRGB. Normal/roughness/ORM textures are linear data. Normals use OpenGL (+Y) convention. ORM packs ambient occlusion in R (white/unbaked), roughness in G, metallic in B (black). Standalone roughness maps are included for engines using individual texture slots. Texture wrapping is Repeat. Fine texture detail is procedural and tileable, not a baked screenshot.

Use a studio environment map or broad area lights for glossy reflections in your engine. Enable shadows and ambient occlusion as appropriate. The GLB carries the asset only, not lights, camera, floor, or background. Rendering will vary by engine and lighting.
