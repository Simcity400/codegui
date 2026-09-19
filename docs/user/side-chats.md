# Side chats

Use `/side` in an existing Codex or Claude conversation to ask something aside without disturbing the main thread. Use `/side your question` to send the first message immediately. Keep the original provider selected; side chats cannot cross provider instances. Other providers do not support this command.

A side chat inherits everything the main thread knows, but it is told that inherited work is reference only. It answers questions and inspects the workspace; it does not carry on the main thread's task, use subagents, or edit files unless you explicitly ask it to in the side chat. Promoting it to a thread lifts these limits.

Side chats share the original project and worktree, so any edits you do request affect the same workspace. Attach files after opening the side chat.

Side chats never appear in the thread list. They live only beside the thread they came from until you promote or delete them.

On desktop and wide browser windows, `/side` opens a tab beside the conversation. You can also start one from the right panel's **+** menu. Closing the tab keeps the side chat; reopen it from the **+** menu. The tab header has **Promote to thread**, which turns it into a normal thread, and **Delete side chat**. Use **Open full view** for attachments, approvals, or questions that need your answer.

On mobile, `/side` opens a full-screen conversation. Use **Side chats** above the composer to return to the related list; swipe a row to promote or delete it. Leaving a side chat keeps it. In narrow browser windows, side chats also open full-screen, with their actions above the transcript.

Deleting a parent thread promotes its side chats, so they stay available in the thread list. If the first message cannot be submitted, its text remains in the side chat's composer so you can retry.
