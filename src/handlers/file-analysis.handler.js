/**
 * File-analysis handler — bridges the analyze_file tool to the file-analysis
 * service. Returns the extracted file content as the tool result so the
 * agent loop can chain it into CRM/task actions ("read the sheet, then
 * create a group per tab").
 */

const registry = require('./handler-registry');
const { fileAnalysisService } = require('../services/file-analysis.service');
const logger = require('../utils/logger');

function createFileAnalysisHandler(options = {}) {
  const analysisService = options.analysisService || fileAnalysisService;
  return async (message, context) => {
    const { userPhone, intentParams } = context;
    const params = intentParams || {};
    const question = String(params.question || params.full_text || '').trim()
      || 'Summarize the file contents.';
    const typedRequest = Boolean(context.agentExecution)
      || Array.isArray(params.artifact_ids)
      || Boolean(params.mode);

    try {
      // Empty artifact_ids deliberately means "all files attached this turn".
      // The service resolves IDs under the active tenant/session; paths from
      // model arguments are never accepted.
      if (typedRequest) {
        const result = await analysisService.analyzeArtifacts(
          userPhone,
          params.artifact_ids || [],
          question,
          { mode: params.mode || 'summarize' },
        );
        const coverage = result.coverage || { requested: 0, analyzed: 0, failed: 0 };
        const status = coverage.analyzed === 0
          ? 'failure'
          : (coverage.failed > 0 ? 'partial' : 'success');
        return {
          status,
          data: result,
          ...(status === 'failure' || status === 'partial' ? {
            error: {
              code: status === 'failure' ? 'file_analysis_failed' : 'file_analysis_incomplete',
              category: 'file_analysis',
              retryable: status === 'failure',
              message: status === 'failure'
                ? 'None of the requested artifacts could be analyzed.'
                : 'Some requested artifact coverage is incomplete.',
            },
          } : {}),
          user_summary: status === 'success'
            ? result.complete === true
              ? `Analyzed ${coverage.analyzed} of ${coverage.requested} requested artifact${coverage.requested === 1 ? '' : 's'}.`
              : `Analyzed ${coverage.analyzed} requested artifact${coverage.requested === 1 ? '' : 's'} as bounded previews; coverage is not complete.`
            : status === 'partial'
              ? `Analyzed ${coverage.analyzed} of ${coverage.requested} artifacts; the result includes incomplete or truncated coverage.`
              : 'I could not analyze the requested artifacts.',
          evidence: result.evidence || [],
        };
      }

      // Compatibility for older single-shot callers that supply only prose
      // and an optional filename hint.
      const result = await analysisService.analyzeDocument(
        userPhone,
        question,
        params.file_name || null,
      );
      if (result.error) return result.message;
      return `Contents of ${result.fileName}:\n${result.text}`;
    } catch (error) {
      logger.error(`[FileAnalysis] handler failed: ${error.message}`);
      return "I couldn't read that file just now. Please try again.";
    }
  };
}

registry.register('file_analyze', createFileAnalysisHandler());

module.exports = { createFileAnalysisHandler };
