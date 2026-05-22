import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScriptModule from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import path from 'node:path';
import { chunkJsLike } from './jsChunker.js';
import { chunkPython } from './pyChunker.js';

// tree-sitter-typescript exports an object with .typescript and .tsx grammars.
const TypeScript = TypeScriptModule.typescript;
const TSX = TypeScriptModule.tsx;

const LANGUAGE_GRAMMARS = {
  javascript: JavaScript,
  typescript: TypeScript,
  tsx: TSX,
  python: Python,
};

const EXT_TO_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
};

const CHUNKER_FOR_LANGUAGE = {
  javascript: chunkJsLike,
  typescript: chunkJsLike,
  tsx: chunkJsLike,
  python: chunkPython,
};

export function detectLanguage(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

export function isSupportedFile(filepath) {
  return detectLanguage(filepath) !== null;
}

// One parser instance, language reset per call — cheap and avoids holding
// per-language state across the indexer's concurrent file workers.
const parser = new Parser();

export function parseSource(source, language) {
  const grammar = LANGUAGE_GRAMMARS[language];
  if (!grammar) {
    throw new Error(`[parser] unsupported language: ${language}`);
  }
  parser.setLanguage(grammar);
  return parser.parse(source);
}

// High-level entry point used by the indexer service. Returns an array of
// chunk objects ready to be saved as CodeChunk documents (minus repoId/filepath
// which the indexer adds).
export function chunkFile(source, filepath) {
  const language = detectLanguage(filepath);
  if (!language) return [];
  const tree = parseSource(source, language);
  const chunker = CHUNKER_FOR_LANGUAGE[language];
  const chunks = chunker(source, tree);
  // Normalize: stamp language on every chunk so the indexer doesn't have to.
  return chunks.map((c) => ({ ...c, language }));
}
