/**
 * Filesystem Context Reader
 *
 * Reads real files from the repository root to enrich generated documentation
 * with information that isn't (and shouldn't be) stored in the knowledge graph:
 *  - README / CONTRIBUTING / AGENTS.md narrative content
 *  - Full package.json (scripts, engines, peerDeps, type field)
 *  - .env.example → environment variable table
 *  - docker-compose / Dockerfile → deployment section
 *  - tsconfig / vitest / jest / eslint config → toolchain
 *  - LICENSE → license summary
 *  - Source file snippets → inline code examples for key entities
 *
 * All reads are defensive: missing files return null/empty rather than throwing,
 * so doc generation never fails because an optional file is absent.
 */

import fs from 'fs';
import path from 'path';

export interface PackageJsonFull {
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  author?: string | { name?: string; email?: string };
  license?: string;
  homepage?: string;
  repository?: string | { type?: string; url?: string };
  keywords?: string[];
  private?: boolean;
}

export interface EnvVarEntry {
  name: string;
  defaultValue: string;
  description: string;
  required: boolean;
}

export interface FsContext {
  repoRoot: string;
  readme: string | null;
  readmeFile: string | null;
  contributing: string | null;
  agentsMd: string | null;
  license: string | null;
  licenseType: string | null;
  packageJsons: { filePath: string; pkg: PackageJsonFull }[];
  rootPackageJson: PackageJsonFull | null;
  envExample: EnvVarEntry[];
  envExampleRaw: string | null;
  dockerCompose: string | null;
  dockerfile: string | null;
  tsconfig: any | null;
  vitestConfig: string | null;
  eslintConfig: string | null;
  hasTests: boolean;
  testFramework: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function tryReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function tryReadJson<T = any>(filePath: string): T | null {
  const raw = tryReadFile(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function findFirstFile(dir: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const full = path.join(dir, c);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function findFirstFileRecursive(dir: string, candidates: string[], maxDepth = 2): string | null {
  // Check current dir first
  const found = findFirstFile(dir, candidates);
  if (found) return found;
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const sub = path.join(dir, entry.name);
        const result = findFirstFileRecursive(sub, candidates, maxDepth - 1);
        if (result) return result;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ── .env.example parsing ─────────────────────────────────────────────

/**
 * Parse a .env.example / .env.sample file into structured entries.
 * Handles:
 *  - KEY=value
 *  - # comment lines (treated as description for the next var)
 *  - inline comments after value
 *  - quoted values
 *  - empty values (marked as required with no default)
 */
function parseEnvExample(content: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  const lines = content.split('\n');
  let pendingDescription = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      pendingDescription = '';
      continue;
    }
    // Comment line — collect as description
    if (line.startsWith('#')) {
      const commentText = line.replace(/^#+\s*/, '').trim();
      if (commentText) {
        pendingDescription = pendingDescription
          ? `${pendingDescription} ${commentText}`
          : commentText;
      }
      continue;
    }
    // KEY=value or KEY="value"
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const name = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip inline comment (only if value is unquoted)
    let description = pendingDescription;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const endQ = value.indexOf(quote, 1);
      if (endQ > 0) {
        value = value.slice(1, endQ);
        const after = value.slice(endQ + 1).trim();
        if (after.startsWith('#')) {
          const inline = after.replace(/^#+\s*/, '').trim();
          if (inline) description = description ? `${description} ${inline}` : inline;
        }
      }
    } else {
      const hashIdx = value.indexOf('#');
      if (hashIdx >= 0) {
        const inline = value.slice(hashIdx + 1).replace(/^#+\s*/, '').trim();
        value = value.slice(0, hashIdx).trim();
        if (inline) description = description ? `${description} ${inline}` : inline;
      }
    }
    pendingDescription = '';
    const required = value === '' || value === 'your-xxx-here' || value === 'changeme' ||
      value.includes('xxx') || value.includes('TODO') || value.includes('<');
    entries.push({ name, defaultValue: value, description, required });
  }
  return entries;
}

// ── License type detection ───────────────────────────────────────────

function detectLicenseType(content: string): string | null {
  const lower = content.toLowerCase();
  if (lower.includes('mit license') || lower.includes('permission is hereby granted, free of charge')) return 'MIT';
  if (lower.includes('apache license') && lower.includes('version 2.0')) return 'Apache-2.0';
  if (lower.includes('gnu general public license') && lower.includes('version 3')) return 'GPL-3.0';
  if (lower.includes('gnu general public license') && lower.includes('version 2')) return 'GPL-2.0';
  if (lower.includes('bsd 3-clause') || lower.includes('neither the name')) return 'BSD-3-Clause';
  if (lower.includes('bsd 2-clause') || lower.includes('redistribution and use in source and binary forms')) return 'BSD-2-Clause';
  if (lower.includes('mozilla public license')) return 'MPL-2.0';
  if (lower.includes('is hereby granted, free of charge, to any person')) return 'MIT';
  if (lower.includes('the unlicense')) return 'Unlicense';
  return 'Custom/Proprietary';
}

// ── Main entry: gather filesystem context ────────────────────────────

export function gatherFsContext(repoRoot: string): FsContext {
  // README — try common variants at root and one level down
  const readmeCandidates = ['README.md', 'README.MD', 'README.rst', 'README.txt', 'README', 'readme.md'];
  const readmeFile = findFirstFile(repoRoot, readmeCandidates);
  const readme = readmeFile ? tryReadFile(readmeFile) : null;

  // CONTRIBUTING
  const contributingFile = findFirstFile(repoRoot, ['CONTRIBUTING.md', 'CONTRIBUTING.MD', 'CONTRIBUTING', 'docs/CONTRIBUTING.md']);
  const contributing = contributingFile ? tryReadFile(contributingFile) : null;

  // AGENTS.md
  const agentsMd = tryReadFile(path.join(repoRoot, 'AGENTS.md'));

  // LICENSE
  const licenseFile = findFirstFile(repoRoot, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md']);
  const license = licenseFile ? tryReadFile(licenseFile) : null;
  const licenseType = license ? detectLicenseType(license) : null;

  // package.json — root + nested (monorepo)
  const rootPkg = tryReadJson<PackageJsonFull>(path.join(repoRoot, 'package.json'));
  const packageJsons: { filePath: string; pkg: PackageJsonFull }[] = [];
  if (rootPkg) {
    packageJsons.push({ filePath: 'package.json', pkg: rootPkg });
  }
  // Look for nested package.json in common monorepo locations (limited depth)
  try {
    const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const nestedPkgPath = path.join(repoRoot, entry.name, 'package.json');
        const nestedPkg = tryReadJson<PackageJsonFull>(nestedPkgPath);
        if (nestedPkg) {
          packageJsons.push({ filePath: path.join(entry.name, 'package.json'), pkg: nestedPkg });
        }
      }
    }
  } catch {
    // ignore
  }

  // .env.example
  const envExampleFile = findFirstFile(repoRoot, ['.env.example', '.env.sample', '.env.template', 'env.example', '.env.local.example']);
  const envExampleRaw = envExampleFile ? tryReadFile(envExampleFile) : null;
  const envExample = envExampleRaw ? parseEnvExample(envExampleRaw) : [];

  // Docker
  const dockerComposeFile = findFirstFile(repoRoot, [
    'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
    'docker-compose.dev.yml',
  ]);
  const dockerCompose = dockerComposeFile ? tryReadFile(dockerComposeFile) : null;
  const dockerfileFile = findFirstFile(repoRoot, ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.prod', 'docker/Dockerfile']);
  const dockerfile = dockerfileFile ? tryReadFile(dockerfileFile) : null;

  // tsconfig
  const tsconfig = tryReadJson(path.join(repoRoot, 'tsconfig.json'));

  // Test framework detection
  const vitestConfig = findFirstFile(repoRoot, ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs']);
  const jestConfig = findFirstFile(repoRoot, ['jest.config.ts', 'jest.config.js', 'jest.config.json', 'jest.config.mjs']);
  const eslintConfig = findFirstFile(repoRoot, ['.eslintrc.cjs', '.eslintrc.js', '.eslintrc.json', '.eslintrc', 'eslint.config.js', 'eslint.config.mjs']);
  const hasTests = !!(vitestConfig || jestConfig || findFirstFileRecursive(repoRoot, ['*.test.ts', '*.spec.ts'], 3));
  const testFramework = vitestConfig ? 'Vitest' : jestConfig ? 'Jest' : hasTests ? 'Unknown' : null;

  return {
    repoRoot,
    readme,
    readmeFile: readmeFile ? path.basename(readmeFile) : null,
    contributing,
    agentsMd,
    license,
    licenseType,
    packageJsons,
    rootPackageJson: rootPkg,
    envExample,
    envExampleRaw,
    dockerCompose,
    dockerfile,
    tsconfig,
    vitestConfig: vitestConfig ? tryReadFile(vitestConfig) : null,
    eslintConfig: eslintConfig ? tryReadFile(eslintConfig) : null,
    hasTests,
    testFramework,
  };
}

// ── Source snippet reader ────────────────────────────────────────────

/**
 * Read a snippet of source code from a file, centered on the given start line.
 * Returns the raw lines (with line numbers) or null if the file can't be read.
 *
 * @param repoRoot   Absolute path to the repo root
 * @param filePath   Relative file path (as stored in the graph)
 * @param startLine  1-based start line of the entity
 * @param endLine    1-based end line of the entity (optional)
 * @param maxLines   Maximum number of lines to include (default 15)
 */
export function readSourceSnippet(
  repoRoot: string,
  filePath: string,
  startLine: number,
  endLine?: number,
  maxLines: number = 15,
): { lines: string[]; startLine: number; truncated: boolean } | null {
  // Resolve the file path — it may be relative or absolute
  let absPath: string;
  if (path.isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    absPath = path.join(repoRoot, filePath);
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }

  const allLines = content.split('\n');
  const start = Math.max(0, startLine - 1); // 0-based
  const entityLength = endLine ? endLine - startLine + 1 : maxLines;
  const snippetLength = Math.min(entityLength, maxLines);
  const snippetLines = allLines.slice(start, start + snippetLength);
  const truncated = endLine ? (endLine - startLine + 1) > maxLines : snippetLength >= maxLines;

  return {
    lines: snippetLines,
    startLine,
    truncated,
  };
}

/**
 * Format a source snippet as a fenced code block with line numbers.
 */
export function formatSnippet(
  snippet: { lines: string[]; startLine: number; truncated: boolean } | null,
  language: string = 'typescript',
): string | null {
  if (!snippet || snippet.lines.length === 0) return null;
  const padWidth = String(snippet.startLine + snippet.lines.length).length;
  const numbered = snippet.lines.map((line, i) => {
    const lineNum = String(snippet.startLine + i).padStart(padWidth, ' ');
    return `${lineNum} │ ${line}`;
  });
  let block = '```' + language + '\n' + numbered.join('\n');
  if (snippet.truncated) {
    block += `\n// … (truncated, see source for full body)`;
  }
  block += '\n```';
  return block;
}
