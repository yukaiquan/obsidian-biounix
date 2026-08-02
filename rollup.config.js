import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default defineConfig({
  input: 'src/main.ts',
  output: {
    dir: 'dist',
    format: 'commonjs',
    sourcemap: false,
    entryFileNames: 'main.js',
  },
  external: ['obsidian'],
  plugins: [
    typescript({ tsconfig: './tsconfig.json' }),
    nodeResolve({ browser: true }),
    commonjs(),
  ],
});
