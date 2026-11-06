// Remove only retired browser chat storage. Never inspect its contents or touch Pi sessions.
export function purgeLegacyChatHistory() {
  localStorage.removeItem("menshen.chat-history.v1");
}
