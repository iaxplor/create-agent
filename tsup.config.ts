import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  minify: false,
  dts: false,
  splitting: false,
  sourcemap: false,
  // tsup detecta o shebang em src/index.ts e propaga para dist/index.js
  // (marcando o arquivo como executável). Não é preciso configurar `banner`.
});
