import crypto from 'node:crypto';

const CHUNKABLE_TYPES = new Set(['function_definition', 'class_definition']);
const MIN_CHUNK_LINES = 5;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function walk(node, visitor) {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), visitor);
  }
}

function chunkName(node) {
  const nameField = node.childForFieldName('name');
  return nameField?.text ?? null;
}

// Python doesn't have explicit `export` syntax — anything defined at module
// scope is importable from another module. We treat top-level defs/classes
// as "exported"; methods of classes inherit that from their parent.
function isModuleLevel(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'module') return true;
    if (p.type === 'function_definition') return false; // nested
    p = p.parent;
  }
  return false;
}

function isAsync(node) {
  // `async def foo():` — the first child token is the 'async' keyword.
  if (node.type !== 'function_definition') return false;
  return node.text.trimStart().startsWith('async ');
}

function hasExceptHandler(node) {
  let found = false;
  walk(node, (n) => {
    if (!found && (n.type === 'try_statement' || n.type === 'except_clause')) {
      found = true;
    }
  });
  return found;
}

function extractCalls(node) {
  const calls = new Set();
  walk(node, (n) => {
    if (n.type === 'call') {
      const fn = n.childForFieldName('function');
      if (fn) calls.add(fn.text);
    }
  });
  return [...calls];
}

// `import os`, `import os.path as op`, `from foo import bar`
function extractTopLevelImports(rootNode) {
  const imports = new Set();
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);

    if (child.type === 'import_statement') {
      // `import a, b` — pull each dotted_name
      walk(child, (n) => {
        if (n.type === 'dotted_name') imports.add(n.text);
      });
    }
    if (child.type === 'import_from_statement') {
      const moduleName = child.childForFieldName('module_name');
      if (moduleName) imports.add(moduleName.text);
    }
  }
  return [...imports];
}

function determineType(node, parentNode) {
  if (node.type === 'class_definition') return 'class';
  if (node.type === 'function_definition') {
    // A function defined inside a class body is a method.
    if (parentNode?.type === 'block' && parentNode.parent?.type === 'class_definition') {
      return 'method';
    }
    return 'function';
  }
  return 'block';
}

export function chunkPython(source, tree) {
  const root = tree.rootNode;
  const fileImports = extractTopLevelImports(root);
  const chunks = [];

  function visit(node, parent) {
    if (CHUNKABLE_TYPES.has(node.type)) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const lineCount = endLine - startLine + 1;
      const moduleLevel = isModuleLevel(node);

      const tooSmall = lineCount < MIN_CHUNK_LINES && !moduleLevel;
      if (!tooSmall) {
        const content = source.slice(node.startIndex, node.endIndex);
        const name = chunkName(node);

        chunks.push({
          type: determineType(node, parent),
          name,
          content,
          startLine,
          endLine,
          imports: fileImports,
          calls: extractCalls(node),
          exports: moduleLevel && name ? [name] : [],
          metadata: {
            isAsync: isAsync(node),
            isExported: moduleLevel,
            hasErrorHandling: hasExceptHandler(node),
          },
          contentHash: sha256(content),
        });
      }

      // Recurse into classes to catch their methods; skip into functions.
      if (node.type === 'class_definition') {
        for (let i = 0; i < node.childCount; i++) visit(node.child(i), node);
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) visit(node.child(i), node);
  }

  visit(root, null);
  return chunks;
}
