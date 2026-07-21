/**
 * Caption extraction for document messages.
 *
 * A document can arrive WITH an instruction in the same message
 * ("here's the lead sheet — create a group named greencardguide").
 * Historically both webhook paths saved the file and dropped the text,
 * so the instruction was silently ignored. The controller now routes an
 * actionable caption through normal intent detection after the save.
 *
 * WhatsApp puts the caption in message.document.caption; the dashboard
 * sends it as message.text. A caption that merely echoes the filename
 * ("lead.xlsx", "Attached: lead.xlsx") is not an instruction.
 */

'use strict';

function extractActionableCaption(message) {
  if (!message || !message.document) return null;
  const caption = String(message.document.caption || message.text || '').trim();
  if (!caption) return null;

  const documentName = String(
    message.document.filename || message.document.fileName || ''
  ).trim();
  if (documentName) {
    const normalized = caption.toLowerCase();
    const nameLower = documentName.toLowerCase();
    if (normalized === nameLower || normalized === `attached: ${nameLower}`) return null;
  }
  return caption;
}

module.exports = { extractActionableCaption };
