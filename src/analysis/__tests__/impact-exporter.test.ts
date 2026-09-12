import { describe, it, expect } from 'vitest';
import {
  generateCodeImpactMarkdown,
  generateRequirementPlanMarkdown,
  markdownToHtml,
} from '../impact-exporter.js';

describe('ImpactExporter', () => {
  const sampleCodeReport = {
    riskScore: 45,
    directImpacts: [
      { node: { kind: 'Function', name: 'handleAsk', filePath: 'src/api/server.ts', startLine: 270 }, impactScore: 0.8, reason: 'calls target' },
    ],
    transitiveImpacts: [
      { node: { kind: 'Class', name: 'AgentEngine', filePath: 'src/agent/engine.ts' }, reason: 'imported by server.ts' },
    ],
    affectedEndpoints: [
      { node: { name: 'POST /api/ask', filePath: 'src/api/server.ts', startLine: 500 }, impactScore: 0.75, reason: 'exposes route' },
    ],
    affectedPatterns: ['MVC', 'Middleware Pipeline'],
    llmEnrichment: {
      explanation: 'Modifying server.ts impacts API routing directly.',
      severityAssessments: [
        { name: 'handleAsk', severity: 'moderate', reasoning: 'Core entry point' },
      ],
      testSuggestions: ['Run integration test on /api/ask'],
    },
  };

  const sampleReqReport = {
    requirement: 'Add OAuth2 Google and GitHub login support with JWT validation',
    detectedIntents: ['Authentication & Security', 'API & Route Management'],
    riskScore: 55,
    matchedEntities: [
      { node: { kind: 'Module', name: 'server.ts', filePath: 'src/api/server.ts', startLine: 1 }, score: 10, matchReason: 'Main API router' },
    ],
    impactedEntities: [
      { node: { kind: 'Class', name: 'PermissionEngine' }, reason: 'Upstream security guard' },
    ],
    affectedEndpoints: [
      { name: 'POST /api/auth/login', filePath: 'src/api/server.ts', startLine: 100, description: 'Auth endpoint' },
    ],
    performanceBottlenecks: [
      { component: 'store.ts', filePath: 'src/graph/store.ts', type: 'coupling_hub', severity: 'high', metrics: '12 callers', riskExplanation: 'High coupling', recommendation: 'Cache tokens in memory' },
    ],
    implementationPlan: [
      {
        phase: '1. Architecture & Design',
        action: 'configure',
        title: 'Define JWT & OAuth Schemas',
        targetFile: 'src/api/validation.ts',
        description: 'Define validation schemas for auth tokens.',
        details: ['Add oauthTokenSchema', 'Validate scopes'],
      },
      {
        phase: '2. Route & Middleware Wiring',
        action: 'modify',
        title: 'Mount /api/auth/login route',
        targetFile: 'src/api/server.ts',
        description: 'Mount authentication endpoints on router.',
        details: ['Add POST /api/auth/login', 'Attach auth guard middleware'],
      },
    ],
    llmEnrichment: {
      explanation: 'Adding OAuth2 requires mounting auth routes and validating tokens.',
      bottleneckAnalysis: 'Token verification should be cached in Redis/memory to prevent latency.',
      severityAssessments: [{ name: 'server.ts', severity: 'moderate', reasoning: 'Route handler wiring' }],
      testSuggestions: ['Test invalid token rejection (401)', 'Test token expiration'],
    },
  };

  it('generates rich Code-Based Impact Markdown', () => {
    const md = generateCodeImpactMarkdown(sampleCodeReport, 'src/api/server.ts');
    expect(md).toContain('# Code-Based Impact Analysis Report');
    expect(md).toContain('src/api/server.ts');
    expect(md).toContain('45/100');
    expect(md).toContain('POST /api/ask');
    expect(md).toContain('handleAsk');
    expect(md).toContain('AgentEngine');
    expect(md).toContain('LLM Architectural Assessment');
  });

  it('generates rich Requirement-Based Roadmap Markdown', () => {
    const md = generateRequirementPlanMarkdown(sampleReqReport);
    expect(md).toContain('# Requirement Impact & Implementation Roadmap');
    expect(md).toContain('Add OAuth2 Google and GitHub login');
    expect(md).toContain('Step 1: Define JWT & OAuth Schemas `[CONFIGURE]`');
    expect(md).toContain('Step 2: Mount /api/auth/login route `[MODIFY]`');
    expect(md).toContain('Performance Bottlenecks & Coupling Hotspots');
    expect(md).toContain('store.ts');
    expect(md).toContain('HIGH Priority');
    expect(md).toContain('Cache tokens in memory');
  });

  it('converts Markdown to standalone HTML with styles and table support', () => {
    const md = generateRequirementPlanMarkdown(sampleReqReport);
    const html = markdownToHtml(md, 'Requirement Roadmap');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Requirement Roadmap</title>');
    expect(html).toContain('Step-by-Step Implementation Roadmap');
    expect(html).toContain('<table>');
    expect(html).toContain('</html>');
  });
});
