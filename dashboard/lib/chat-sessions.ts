export type SessionMessage = {
  id: number;
  role: string;
  content: string;
  created_at: string;
  title?: string | null;
};

export type ChatSession = {
  id: number;
  startId: number;
  endId: number;
  content: string;
  title?: string | null;
};

const SESSION_GAP_MS = 45 * 60 * 1000;

export function groupMessagesIntoSessions(messages: SessionMessage[]): ChatSession[] {
  const sessions: ChatSession[] = [];
  let group: SessionMessage[] = [];
  let previousTime = Number.NaN;

  const finish = () => {
    if (group.length === 0) return;
    const titleMessage = group.find((message) => message.role === "user") || group[0];
    sessions.push({
      id: titleMessage.id,
      startId: group[0].id,
      endId: group[group.length - 1].id,
      content: titleMessage.content,
      title: titleMessage.title,
    });
    group = [];
  };

  for (const message of messages.filter((message) => message.id > 0)) {
    const currentTime = Date.parse(message.created_at);
    if (group.length > 0 && Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime - previousTime > SESSION_GAP_MS) finish();
    group.push(message);
    previousTime = currentTime;
  }
  finish();
  return sessions;
}
