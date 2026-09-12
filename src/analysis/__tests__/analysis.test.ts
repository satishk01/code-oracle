import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RequirementAnalyzer } from '../requirement-analyzer.js';
import { ImpactAnalyzer } from '../impact.js';
import { GraphStore } from '../../graph/store.js';

describe('Analysis Suite (Impact & Requirements)', () => {
  let store: GraphStore;
  let reqAnalyzer: RequirementAnalyzer;
  let impactAnalyzer: ImpactAnalyzer;

  beforeAll(async () => {
    store = new GraphStore('.');
    await store.init();
    reqAnalyzer = new RequirementAnalyzer(store);
    impactAnalyzer = new ImpactAnalyzer(store);
  });

  afterAll(async () => {
    await store.close();
  });

  describe('ImpactAnalyzer (Code-Based)', () => {
    it('analyzes exact file paths without LLM', async () => {
      const report = await impactAnalyzer.analyzeChanges([
        { filePath: 'src/api/server.ts', type: 'modified' },
      ]);

      expect(report.changedFiles).toContain('src/api/server.ts');
      expect(report.riskScore).toBeGreaterThan(0);
      const totalImpacts = report.directImpacts.length + report.transitiveImpacts.length + report.affectedEndpoints.length;
      expect(totalImpacts).toBeGreaterThan(0);
    });

    it('handles partial file names (e.g. server.ts instead of full path)', async () => {
      const report = await impactAnalyzer.analyzeChanges([
        { filePath: 'server.ts', type: 'modified' },
      ]);

      expect(report.riskScore).toBeGreaterThan(0);
      const totalImpacts = report.directImpacts.length + report.transitiveImpacts.length + report.affectedEndpoints.length;
      expect(totalImpacts).toBeGreaterThan(0);
    });

    it('gracefully handles natural language prompts in code-based impact', async () => {
      const prompt = 'what is the impact If I need to add two more sales endpoint';
      const report = await impactAnalyzer.analyzeChanges([
        { filePath: prompt, type: 'modified' },
      ]);

      const totalImpacts = report.directImpacts.length + report.transitiveImpacts.length + report.affectedEndpoints.length;
      expect(totalImpacts).toBeGreaterThan(0);
      expect(report.riskScore).toBeGreaterThan(0);
    });
  });

  describe('RequirementAnalyzer (Requirement-Based)', () => {
    it('analyzes endpoint and performance bottleneck queries with full roadmap', async () => {
      const query = 'If I need to add two more endpoints what is the impact and also can you analyze where we have performance bottlenecks';
      const result = await reqAnalyzer.analyze(query);

      expect(result.requirement).toBe(query);
      expect(result.detectedIntents).toContain('API & Route Management');
      expect(result.detectedIntents).toContain('Performance & Bottleneck Optimization');

      expect(result.matchedEntities.length).toBeGreaterThan(0);
      expect(result.performanceBottlenecks.length).toBeGreaterThan(0);
      expect(result.implementationPlan.length).toBeGreaterThanOrEqual(4);
      expect(result.riskScore).toBeGreaterThan(0);
      expect(result.summary).toContain('Requirement Impact Analysis Summary');
    });

    it('analyzes authentication requirements and flags security domain', async () => {
      const query = 'Add OAuth2 Google and GitHub login support with JWT token validation';
      const result = await reqAnalyzer.analyze(query);

      expect(result.detectedIntents).toContain('Authentication & Security');
      expect(result.implementationPlan.length).toBeGreaterThanOrEqual(3);
    });

    it('analyzes database optimization requirements', async () => {
      const query = 'Implement in-memory caching and query optimization for graph store';
      const result = await reqAnalyzer.analyze(query);

      expect(result.detectedIntents).toContain('Data Layer & Persistence');
      expect(result.performanceBottlenecks.length).toBeGreaterThan(0);
    });
  });
});
