/**
 * Impact & Roadmap Report Exporter
 *
 * Formats Code-Based and Requirement-Based Impact Reports into:
 *  - Markdown (.md)
 *  - Standalone styled HTML (.html)
 *
 * Triggers direct browser downloads based on user preference.
 */
export type ExportFormat = 'md' | 'html';
export declare function downloadFile(filename: string, content: string, mimeType: string): void;
export declare function markdownToHtml(md: string, title: string): string;
export declare function generateCodeImpactMarkdown(report: any, filesAnalyzed: string): string;
export declare function generateRequirementPlanMarkdown(report: any): string;
export declare function exportCodeImpact(report: any, filesAnalyzed: string, format: ExportFormat): void;
export declare function exportRequirementPlan(report: any, format: ExportFormat): void;
