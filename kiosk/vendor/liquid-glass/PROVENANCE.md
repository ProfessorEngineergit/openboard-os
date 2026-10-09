apple-liquid-glass-webgl 2.6.0, MIT.
https://github.com/Oliverrr2424/webgl-apple-liquid-glass
Pinned commit: e8030bd0732bc91652e44b85f84e2ed7aa498679

The integration explicitly selects LiquidGlassWebGLV1, whose fragment shader
uses GLSL refract() with uIOR, RGB IOR dispersion, a meniscus thickness field,
and Schlick Fresnel reflection. The V2 default uses a different optical model.
This is an open-source Apple-inspired reconstruction, not Apple's renderer.

Original sources and license are retained. src/shaders.js derives the Schlick
F0 term from uIOR instead of fixing it at 0.04. Changes to src/dom-content.js:
- Traverse open shadow roots and assigned slots for Home Assistant.
- Exclude the kiosk overlay from the backdrop to avoid feedback.
- A null host paints the underlying document (the kiosk host is outside body).
The DOM painter is an approximation: SVG, pseudo-elements, filters, form controls,
closed shadow roots and cross-origin frames are not captured. GEV and Whiteboard
sample their actual live canvases with a 48px surrounding margin instead.

entry.js bundles the V1 renderer and DOM painter as MegaGlass.
Build: npx esbuild kiosk/vendor/liquid-glass/entry.js --bundle --format=iife \
  --global-name=MegaGlass --minify --outfile=kiosk/vendor/liquid-glass/glass-runtime.js
Rendering is limited to the visible surface at <=7 FPS; hidden pages do no work.
