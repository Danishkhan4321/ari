'use strict';

function speakerLabel(id, names) {
  const configured = names?.[id];
  return String(configured || `Speaker ${id}`).trim();
}

function replaceSpeakerTokens(value, names) {
  if (typeof value !== 'string') return value;
  return value.replace(/\bSpeaker ([A-Z]+)\b/g, (token, id, offset, fullText) => {
    const nextCharacter = fullText[offset + token.length];
    if (nextCharacter && /[A-Z]/.test(nextCharacter)) return token;
    return speakerLabel(id, names);
  });
}

function materializeMeeting({ transcriptSegments = [], report = {} } = {}, names = {}) {
  const transcript = transcriptSegments
    .map((segment) => `${speakerLabel(segment.speakerId, names)}: ${segment.text}`)
    .join('\n\n');
  const actionItems = (report.actionItems || []).map((item) => ({
    ...item,
    text: replaceSpeakerTokens(item.text, names),
    assignee: item.assigneeSpeakerId ? speakerLabel(item.assigneeSpeakerId, names) : null,
  }));
  const suggestedTasks = (report.suggestedTasks || []).map((task) => ({
    ...task,
    title: replaceSpeakerTokens(task.title, names),
    reason: replaceSpeakerTokens(task.reason, names),
    suggestedAssignee: task.suggestedAssigneeSpeakerId
      ? speakerLabel(task.suggestedAssigneeSpeakerId, names)
      : null,
  }));

  return {
    transcript,
    summary: replaceSpeakerTokens(report.summary || '', names),
    decisions: (report.decisions || []).map((value) => replaceSpeakerTokens(value, names)),
    actionItems,
    suggestedTasks,
    topics: report.topics || [],
    reportMarkdown: replaceSpeakerTokens(report.reportMarkdown || '', names),
    attendees: [...new Set(transcriptSegments.map((segment) => speakerLabel(segment.speakerId, names)))],
  };
}

module.exports = { materializeMeeting, replaceSpeakerTokens, speakerLabel };
