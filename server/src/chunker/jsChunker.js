import crypto from 'node:crypto';

// Tree-sitter node types that we extract as standalone chunks.
const CHUNKABLE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'generator_function_declaration',
  'class_declaration',
  'method_definition',
]);

const MIN_CHUNK_LINES = 5;

// --- helpers ------------------------------------------------------------

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Walk every descendant of a node, depth-first.
function walk(node, visitor) {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), visitor);
  }
}

// The chunk's identifier. Source varies by AST shape:
//  - function_declaration / class_declaration / method_definition: child 'name' field
//  - arrow_function / function_expression bound to a variable: parent is variable_declarator
function chunkName(node) {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  if (node.parent?.type === 'variable_declarator') {
    return node.parent.childForFieldName('name')?.text ?? null;
  }
  if (node.parent?.type === 'pair' || node.parent?.type === 'property_identifier') {
    return node.parent.childForFieldName('key')?.text ?? null;
  }
  return null;
}

// True if any ancestor is an export_statement (covers `export function`,
// `export default`, `export { ... }` re-export patterns up to a chunk).
function isExported(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'export_statement') return true;
    if (p.type === 'program') return false;
    p = p.parent;
  }
  return false;
}

function isAsync(node) {
  // Some grammars expose async as a child token; others as a property.
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === 'async') return true;
  }
  // Fall back to source check for arrow functions.
  return node.text.trimStart().startsWith('async ');
}

function hasTryCatch(node) {
  let found = false;
  walk(node, (n) => {
    if (!found && n.type === 'try_statement') found = true;
  });
  return found;
}

function extractCalls(node) {
  const calls = new Set();
  walk(node, (n) => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) {
        // For `obj.method()` we grab the full `obj.method`; for `f()` just `f`.
        // Keeps the callgraph informative without being too noisy.
        calls.add(fn.text);
      }
    }
  });
  return [...calls];
}

// File-level imports: ES `import ... from 'pkg'`, plus CommonJS `require('pkg')`.
function extractTopLevelImports(rootNode) {
  const imports = new Set();
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);

    if (child.type === 'import_statement') {
      const src = child.childForFieldName('source');
      if (src) imports.add(src.text.replace(/['"]/g, ''));
      continue;
    }
    // const x = require('foo'); — scan text for require() patterns.
    if (
      child.type === 'lexical_declaration' ||
      child.type === 'variable_declaration' ||
      child.type === 'expression_statement'
    ) {
      let m;
      while ((m = requireRe.exec(child.text)) !== null) imports.add(m[1]);
    }
  }
  return [...imports];
}

function determineType(node) {
  switch (node.type) {
    case 'class_declaration':
      return 'class';
    case 'method_definition':
      return 'method';
    case 'function_declaration':
    case 'function_expression':
    case 'arrow_function':
    case 'generator_function_declaration':
      return 'function';
    default:
      return 'block';
  }
}

// --- main entry ---------------------------------------------------------

export function chunkJsLike(source, tree) {
  const root = tree.rootNode;
  const fileImports = extractTopLevelImports(root);
  const chunks = [];

  function visit(node) {
    if (CHUNKABLE_TYPES.has(node.type)) {
      const startLine = node.startPosition.row + 1; // 1-indexed for humans
      const endLine = node.endPosition.row + 1;
      const lineCount = endLine - startLine + 1;
      const exported = isExported(node);

      // Skip tiny non-exported callbacks — they pollute the index.
      const tooSmall = lineCount < MIN_CHUNK_LINES && !exported;

      if (!tooSmall) {
        const content = source.slice(node.startIndex, node.endIndex);
        const name = chunkName(node);

        chunks.push({
          type: determineType(node),
          name,
          content,
          startLine,
          endLine,
          imports: fileImports,
          calls: extractCalls(node),
          exports: exported && name ? [name] : [],
          metadata: {
            isAsync: isAsync(node),
            isExported: exported,
            hasErrorHandling: hasTryCatch(node),
          },
          contentHash: sha256(content),
        });
      }

      // For class declarations, recurse so we also emit each method as its
      // own chunk. For functions, skip recursion — nested helpers inside a
      // function body aren't usually retrieval-worthy on their own.
      if (node.type === 'class_declaration') {
        for (let i = 0; i < node.childCount; i++) visit(node.child(i));
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  }

  visit(root);
  return chunks;
}
