// Explicit V1 export: the package's V2 default does not expose IOR.
export { LiquidGlassWebGLV1 as WebGLGlass } from './src/index.js';
export { paintPageContent, invalidatePageContent } from './src/dom-content.js';
export const IOR_RENDERER = 'snell-v1';
