# Snowcube — center-supported faces

Six original rounded glossy color panels, connected only to a compact icy central hub by six radial stems. No outer frame.

Seven separate meshes: six panels and one continuous hub/stem support. Each panel retains its original dimensions, position, color, and PBR material. The stems overlap the panel backs by 0.02 units to ensure contact.

snowcube.glb: embedded 1024px PBR textures, Y-up, clearcoat materials.
snowcube.step: editable CAD assembly, Z-up.
snowcube.obj + snowcube.mtl: textured mesh fallback, Z-up.
textures/: separate base color, roughness, ORM and normal maps.
build_snowcube.py: reproducible source (Python, cadquery, vtk, numpy, scipy, Pillow).
preview.png and preview-rear.png: actual mesh software renders. In-game gloss depends on environment lighting and renderer support.

Panel width 1.26, thickness 0.12, centers at +/-0.92. Hub diameter 0.29; stem diameter 0.12. All seven CAD solids validate.
