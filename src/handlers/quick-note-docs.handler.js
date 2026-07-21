const registry = require('./handler-registry');
const googleDocsService = require('../services/google-docs.service');
const googleAuthService = require('../services/google-auth.service');
const logger = require('../utils/logger');

const QUICK_NOTES_DOC_TITLE = 'Ari Quick Notes';

registry.register('quick_note_docs', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;
  const lower = text.toLowerCase().trim();

  try {
    // ── Check Google connection ─────────────────────────────────────
    const connected = await googleAuthService.isConnected(userPhone);
    if (!connected) {
      return '\u26a0\ufe0f Google not connected.\n\nPlease connect Google first: type "connect google"';
    }

    // Canonical agent calls expose append fields directly (no synthetic
    // action/full_text). Consume them before the legacy action-based bridge.
    if (intentParams?.content && !intentParams.action) {
      const documentTitle = String(intentParams.document_title || QUICK_NOTES_DOC_TITLE).trim();
      let docId = await _findQuickNotesDoc(userPhone, documentTitle);
      if (!docId) {
        const createResult = await googleDocsService.createDoc(
          userPhone,
          documentTitle,
          `${documentTitle}\n${'='.repeat(Math.min(documentTitle.length, 120))}\n\n`,
        );
        if (!createResult.success) return `\u26a0\ufe0f ${createResult.error}`;
        docId = createResult.docId;
      }
      const timestamp = new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      });
      const heading = intentParams.heading ? `${String(intentParams.heading).trim()}\n` : '';
      const appendText = `\n[${timestamp}]\n${heading}${intentParams.content}\n`;
      const appendResult = await _appendToDoc(userPhone, docId, appendText);
      if (!appendResult.success) return `\u26a0\ufe0f ${appendResult.error}`;
      return `\ud83d\udcdd Note added to Google Docs!\n━━━━━━━━━━━\nDoc: ${documentTitle}\nNote: ${_truncate(intentParams.content, 80)}\nTimestamp: ${timestamp}`;
    }

    // ── LLM Params-First Routing ────────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'create_doc': {
          if (intentParams.title) {
            const result = await googleDocsService.createDoc(userPhone, intentParams.title, intentParams.content || '');
            if (!result.success) return `\u26a0\ufe0f ${result.error}`;
            let response = `\ud83d\udcdd Document Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `Title: ${result.title}\n`;
            if (intentParams.content) response += `Content: ${_truncate(intentParams.content, 60)}\n`;
            response += `\ud83d\udd17 ${result.link}`;
            return response;
          }
          break;
        }
        case 'append_note': {
          if (intentParams.content) {
            let docId = await _findQuickNotesDoc(userPhone);
            if (!docId) {
              const createResult = await googleDocsService.createDoc(userPhone, QUICK_NOTES_DOC_TITLE, `${QUICK_NOTES_DOC_TITLE}\n${'='.repeat(QUICK_NOTES_DOC_TITLE.length)}\n\n`);
              if (!createResult.success) return `\u26a0\ufe0f ${createResult.error}`;
              docId = createResult.docId;
            }
            const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
            const appendText = `\n[${timestamp}]\n${intentParams.content}\n`;
            const appendResult = await _appendToDoc(userPhone, docId, appendText);
            if (!appendResult.success) return `\u26a0\ufe0f ${appendResult.error}`;
            let response = `\ud83d\udcdd Note added to Google Docs!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
            response += `Doc: ${QUICK_NOTES_DOC_TITLE}\n`;
            response += `Note: ${_truncate(intentParams.content, 80)}\n`;
            response += `Timestamp: ${timestamp}`;
            return response;
          }
          break;
        }
      }
    }

    // ── Regex Fallback ──────────────────────────────────────────────────

    // ── Create new doc ──────────────────────────────────────────────
    if (/\b(?:create|new)\s+(?:doc|document)\b/i.test(lower)) {
      const parsed = _parseNewDoc(text);

      const result = await googleDocsService.createDoc(
        userPhone,
        parsed.title,
        parsed.content
      );

      if (!result.success) {
        return `\u26a0\ufe0f ${result.error}`;
      }

      let response = `\ud83d\udcdd Document Created!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      response += `Title: ${result.title}\n`;
      if (parsed.content) {
        response += `Content: ${_truncate(parsed.content, 60)}\n`;
      }
      response += `\ud83d\udd17 ${result.link}`;
      return response;
    }

    // ── Append to quick notes (default) ─────────────────────────────
    const noteText = _parseNoteText(text);

    if (!noteText) {
      return '\u26a0\ufe0f Please specify a note to add.\nExample: "append to doc: meeting went well"\nor "add to notes: action items from call"';
    }

    // Find existing quick notes doc
    let docId = await _findQuickNotesDoc(userPhone);

    // If no doc found, create one
    if (!docId) {
      const createResult = await googleDocsService.createDoc(
        userPhone,
        QUICK_NOTES_DOC_TITLE,
        `${QUICK_NOTES_DOC_TITLE}\n${'='.repeat(QUICK_NOTES_DOC_TITLE.length)}\n\n`
      );

      if (!createResult.success) {
        return `\u26a0\ufe0f ${createResult.error}`;
      }

      docId = createResult.docId;
    }

    // Append note with timestamp
    const timestamp = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const appendText = `\n[${timestamp}]\n${noteText}\n`;
    const appendResult = await _appendToDoc(userPhone, docId, appendText);

    if (!appendResult.success) {
      return `\u26a0\ufe0f ${appendResult.error}`;
    }

    let response = `\ud83d\udcdd Note added to Google Docs!\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
    response += `Doc: ${QUICK_NOTES_DOC_TITLE}\n`;
    response += `Note: ${_truncate(noteText, 80)}\n`;
    response += `Timestamp: ${timestamp}`;
    return response;

  } catch (error) {
    logger.error('Quick note docs handler error:', error.message);
    return '\u274c Something went wrong with Google Docs. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function _findQuickNotesDoc(userPhone, documentTitle = QUICK_NOTES_DOC_TITLE) {
  try {
    const searchResult = await googleDocsService.searchDocs(userPhone, documentTitle);
    if (!searchResult.success || !searchResult.docs || searchResult.docs.length === 0) {
      return null;
    }

    // Find exact match by title
    const exactMatch = searchResult.docs.find(
      doc => doc.name === documentTitle
    );

    return exactMatch ? exactMatch.id : null;
  } catch (error) {
    logger.error('Find quick notes doc error:', error.message);
    return null;
  }
}

async function _appendToDoc(userPhone, docId, text) {
  return googleDocsService.appendText(userPhone, docId, text);
}

function _parseNoteText(text) {
  const patterns = [
    /\b(?:append|add)\s+(?:to\s+)?(?:my\s+)?(?:notes?\s+)?(?:doc|document|docs)[:\s]+(.+)/i,
    /\b(?:append|add)\s+(?:to\s+)?(?:my\s+)?(?:notes|note)[:\s]+(.+)/i,
    /\bnote[:\s]+(.+)/i,
    /\bquick\s+note[:\s]+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const note = match[1].trim();
      if (note.length >= 2) return note;
    }
  }

  return null;
}

function _parseNewDoc(text) {
  let title = 'Untitled Document';
  let content = '';

  // "create doc: project plan" or "new doc titled project plan"
  const titlePatterns = [
    /\b(?:create|new)\s+(?:doc|document)\s+(?:titled|called|named)[:\s]+(.+?)(?:\s+(?:with|content)[:\s]|$)/i,
    /\b(?:create|new)\s+(?:doc|document)[:\s]+(.+?)(?:\s+(?:with|content)[:\s]|$)/i,
    /\b(?:create|new)\s+(?:doc|document)\s+(?:from\s+)?(?:today'?s?\s+)?notes?\b/i,
  ];

  for (const pattern of titlePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      title = match[1].trim();
      break;
    } else if (match) {
      title = `Notes - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      break;
    }
  }

  // Extract content if provided: "... with content: blah blah"
  const contentMatch = text.match(/\b(?:with|content)[:\s]+(.+)$/i);
  if (contentMatch) {
    content = contentMatch[1].trim();
  }

  return { title, content };
}

function _truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
