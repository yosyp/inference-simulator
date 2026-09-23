import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Runtime rules from docs/04-stack.md §5. Each list is reused so the engine block can extend it
// (a later config object replaces a rule's options wholesale for the files it matches).

const noNetworkOrStorage = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'localStorage',
  'sessionStorage',
  'indexedDB',
].map((name) => ({
  name,
  message: 'No runtime network calls or browser storage (04-stack §5; CSP connect-src none).',
}));

const noNetworkOrStorageProps = ['window', 'globalThis', 'self'].flatMap((object) =>
  ['fetch', 'localStorage', 'sessionStorage', 'indexedDB'].map((property) => ({
    object,
    property,
    message: 'No runtime network calls or browser storage (04-stack §5).',
  })),
);

const bannedPackages = {
  paths: [
    { name: 'three', message: 'No three.js (04-stack §1).' },
    { name: 'gsap', message: 'No GSAP (04-stack §2).' },
    { name: 'react-router', message: 'No client-side routing (04-stack §5).' },
    { name: 'react-router-dom', message: 'No client-side routing (04-stack §5).' },
    {
      name: 'd3-transition',
      message: 'Tween data with d3-interpolate/d3-timer; React renders (K13).',
    },
    { name: 'd3-selection', message: 'React owns the DOM; use d3 for math only (K13).' },
  ],
  patterns: [
    {
      group: ['three/*', 'gsap/*', '@tanstack/*router*'],
      message: 'Banned dependency (04-stack).',
    },
  ],
};

const noDefaultExport = [
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Named exports only (04-stack §5).',
  },
  {
    selector: "ExportSpecifier[exported.name='default']",
    message: 'Named exports only (04-stack §5).',
  },
  {
    selector: 'ImportDeclaration[source.value=/[?&](worker|sharedworker)/]',
    message:
      "Bundle workers as files with new Worker(new URL(...), { type: 'module' }); inline workers break the CSP (04-stack §3).",
  },
];

const engineOnlyGlobals = [
  'window',
  'document',
  'self',
  'globalThis',
  'navigator',
  'postMessage',
  'addEventListener',
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
  'Date',
  'performance',
  'crypto',
].map((name) => ({
  name,
  message:
    'src/engine is pure and deterministic: no DOM, worker globals, timers, or wall clock (04-stack §5). Put host concerns in src/worker.',
}));

export default defineConfig(
  {
    ignores: [
      '.claude',
      'dist',
      'coverage',
      'node_modules',
      'spikes',
      'benchmarks',
      'infra',
      'test-results',
      'playwright-report',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-globals': ['error', ...noNetworkOrStorage],
      'no-restricted-properties': ['error', ...noNetworkOrStorageProps],
      'no-restricted-imports': ['error', bannedPackages],
      'no-restricted-syntax': ['error', ...noDefaultExport],
    },
  },
  {
    files: ['src/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/**/fixtures/**'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', ...noNetworkOrStorage, ...engineOnlyGlobals],
      'no-restricted-properties': [
        'error',
        ...noNetworkOrStorageProps,
        {
          object: 'Math',
          property: 'random',
          message: 'Use keyed draws from src/engine/rng (02-simulator §12, K6).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: bannedPackages.paths,
          patterns: [
            ...bannedPackages.patterns,
            {
              group: [
                '**/ui/**',
                '**/sim-view/**',
                '**/charts/**',
                '**/playback/**',
                '**/worker/**',
                '**/scenarios/**',
                '**/data/**',
                'react',
                'react-dom',
                'react-dom/*',
                'd3-*',
                'motion',
                'motion/*',
              ],
              message:
                'src/engine may import only src/engine; it takes scenarios and calibration as parameters (04-stack §5).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'e2e/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
